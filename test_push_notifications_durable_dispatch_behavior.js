'use strict';
// Default mode is a static regression guard, not a claim of DB execution.
// Real tests: node test_push_notifications_durable_dispatch_behavior.js --integration
// Hardcoded disposable targets; never accepts a production URL/container.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync,spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const sql=fs.readFileSync(__dirname+'/push-notifications-durable-dispatch.sql','utf8');
if(!process.argv.includes('--integration')){
  for(const invariant of ['SEND_CAPACITY_REACHED','INSUFFICIENT_LEASE_BUDGET','v_now>=v_a.ambiguity_after',
    'ATTEMPT_NOT_RELEASABLE','release_attempt_count=v_d.attempt_count','already_recorded','already_released'])
    assert(sql.includes(invariant),invariant);
  console.log('Durable behavior-path static guards PASS; DB integration is a separate --integration run');
} else {
  Promise.resolve().then(main).catch(e=>{console.error(e.stack);process.exitCode=1;});
}
const container='budget2a-durable-test-db';
const base='http://127.0.0.1:55493';
const lit=x=>x===null?'null':"'"+String(x).replaceAll("'","''")+"'";
function db(sql){
  return execFileSync('docker',['exec','-i',container,'psql','-X','-U','supabase_admin','-d','postgres','-qAt','-v','ON_ERROR_STOP=1'],
    {input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
}
function rows(query){return JSON.parse(db('select coalesce(jsonb_agg(q),\'[]\') from ('+query+') q;'));}
function one(query){const r=rows(query);assert.equal(r.length,1);return r[0];}
async function rpc(name,args,error){
  const r=await fetch(base+'/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  const value=await r.json();
  if(error){assert(!r.ok,name+' unexpectedly succeeded');assert((value.message||value.code||'').includes(error),JSON.stringify(value));return value;}
  if(!r.ok)throw Error(name+': '+JSON.stringify(value));
  assert(Array.isArray(value));return value;
}
async function call(name,args,error){const r=await rpc(name,args,error);return error?r:r[0];}
async function lost(name,args){
  const r=await fetch(base+'/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  assert(r.ok,'upstream must have committed before discarding response');
  await r.arrayBuffer(); // transport shim consumes, application receives no usable RPC response
  return 'SIMULATED_RESPONSE_LOSS_AFTER_COMMIT';
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function fixture(n=1,type='schedule'){
  db('update public.push_subscriptions set enabled=false;');
  const user=randomUUID(),email=user+'@example.invalid';
  db('insert into auth.users(id,email) values('+lit(user)+','+lit(email)+');'+
    'insert into public.class_members(email) values('+lit(email)+');');
  const subs=[];
  for(let i=0;i<n;i++){const id=randomUUID();subs.push(id);db('insert into public.push_subscriptions(id,user_id,endpoint,p256dh,auth) values('+
    [id,user,'https://example.invalid/'+id,'local-test-public','local-test-auth'].map(lit).join(',')+');');}
  return {user,email,subs,type};
}
function enqueueArgs(f){return {p_event_key:'dispatch-test:'+randomUUID(),p_event_type:f.type,p_title:'Local test',p_body:'No external send',
  p_source_entity:f.type==='announcement'?'chat_messages':'class_profile',p_source_entity_id:randomUUID(),p_deep_link:'/',p_created_by:f.user};}
async function enqueue(f){const args=enqueueArgs(f);return {...await call('enqueue_notification_dispatch',args),args};}
async function acquire(j,limit=25,worker=randomUUID(),epoch){
  const expected=epoch??one('select lease_epoch from public.notification_dispatch_jobs where id='+lit(j.job_id)).lease_epoch;
  const args={p_job_id:j.job_id,p_worker_id:worker,p_operation_id:randomUUID(),p_expected_epoch:expected,p_limit:limit};
  return {...await call('acquire_notification_dispatch_job',args),worker,args};
}
const prepareArgs=l=>({p_job_id:l.job_id,p_worker_id:l.worker,p_lease_epoch:l.lease_epoch,p_batch_id:l.batch_id});
async function prepare(l){return call('prepare_notification_dispatch_batch',prepareArgs(l));}
function attempts(l){return rows('select * from public.notification_dispatch_attempts where job_id='+lit(l.job_id)+' and batch_id='+lit(l.batch_id)+' order by id');}
const beginArgs=(l,a,timeout=8000)=>({p_job_id:l.job_id,p_worker_id:l.worker,p_lease_epoch:l.lease_epoch,p_attempt_id:a.id,p_operation_id:a.begin_operation_id,p_timeout_ms:timeout});
const releaseArgs=(l,a,reason='worker_budget')=>({p_job_id:l.job_id,p_worker_id:l.worker,p_lease_epoch:l.lease_epoch,p_attempt_id:a.id,p_operation_id:a.release_operation_id,p_reason:reason});
const settleArgs=(l,reason='yield')=>({p_job_id:l.job_id,p_worker_id:l.worker,p_lease_epoch:l.lease_epoch,p_operation_id:l.settle_operation_id,p_reason:reason});
const recordArgs=(l,a,outcome,http=null,retry=null,code=null)=>({p_attempt_id:a.id,p_worker_id:l.worker,p_send_epoch:l.lease_epoch,p_claim_token:a.claim_token,
  p_operation_id:outcome==='ambiguous'?a.ambiguity_operation_id:a.record_operation_id,p_outcome:outcome,p_http_status:http,p_retry_after_seconds:retry,p_error_code:code});
function delivery(a){return one('select * from public.notification_deliveries where id='+lit(a.delivery_id));}
function job(j){return one('select * from public.notification_dispatch_jobs where id='+lit(j.job_id));}
async function prepared(n=1){const f=await fixture(n),j=await enqueue(f),l=await acquire(j);await prepare(l);return {f,j,l,a:attempts(l)[0],all:attempts(l)};}
function expire(l){db('update public.notification_dispatch_jobs set lease_started_at=clock_timestamp()-interval \'100 seconds\',lease_until=clock_timestamp()-interval \'10 seconds\' where id='+lit(l.job_id));}
function ageSend(a){db('update public.notification_dispatch_attempts set send_started_at=send_started_at-interval \'120 seconds\',send_deadline_at=send_deadline_at-interval \'120 seconds\',ambiguity_after=ambiguity_after-interval \'120 seconds\' where id='+lit(a.id));}
async function main(){
  console.log('Local DB: '+db('show server_version;'));
  assert.equal(db('show server_version;'),'17.6');
  await test('catalog/security: exact new objects, RLS, ACL, signatures/proconfig and protected RPC hashes',async()=>{
    const tables=rows("select c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('notification_dispatch_jobs','notification_dispatch_attempts')");
    assert.equal(tables.length,2);for(const t of tables){assert(t.relrowsecurity);assert(!t.relforcerowsecurity);assert.equal(t.owner,'postgres');}
    assert.equal(db("select count(*) from pg_policy where polrelid in ('public.notification_dispatch_jobs'::regclass,'public.notification_dispatch_attempts'::regclass)"),'0');
    assert.equal(db("select count(*) from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid in ('public.notification_dispatch_jobs'::regclass,'public.notification_dispatch_attempts'::regclass) and a.grantee<>c.relowner"),'0');
    const funcs=rows("select proname,prosecdef,proconfig,pg_get_userbyid(proowner) owner from pg_proc where pronamespace='public'::regnamespace and proname in ('enqueue_notification_dispatch','acquire_notification_dispatch_job','prepare_notification_dispatch_batch','get_notification_dispatch_state','begin_notification_dispatch_send','record_notification_dispatch_result','release_notification_dispatch_attempt','settle_notification_dispatch_job')");
    assert.equal(funcs.length,8);for(const p of funcs){assert(p.prosecdef);assert.equal(p.owner,'postgres');assert(p.proconfig.includes('lock_timeout=750ms'));assert(p.proconfig.includes('search_path=pg_catalog, public, pg_temp'));}
    const legacy=rows("select proname,md5(prosrc) hash from pg_proc where pronamespace='public'::regnamespace and proname in ('claim_notification_delivery_batch','record_notification_delivery_result','release_notification_delivery_claim')");
    assert.deepEqual(legacy.map(x=>x.hash).sort(),['1d6335bf315f67709121e55d5e153505','46eec83b405642f16ecf566ea259a599','a4637e3c9523b115c2ad9f40c1e3a28c'].sort());
    // This isolated PostgREST maps anonymous requests to service_role: denied
    // table access is HTTP 401 (not authenticated-claim HTTP 403), SQLSTATE 42501.
    const r=await fetch(base+'/notification_dispatch_jobs?select=id');assert.equal(r.status,401);
    assert.equal((await r.json()).code,'42501');
  });
  await test('enqueue create / discarded-response replay / altered fields / 20 concurrent duplicates / legacy collision',async()=>{
    const f=await fixture(),args=enqueueArgs(f);
    await lost('enqueue_notification_dispatch',args);
    const j=await call('enqueue_notification_dispatch',args);assert.equal(j.disposition,'existing');
    await call('enqueue_notification_dispatch',{...args,p_title:'altered'},'EVENT_CONFLICT');
    const concurrentArgs=enqueueArgs(f);
    const r=await Promise.all(Array.from({length:20},()=>call('enqueue_notification_dispatch',concurrentArgs)));
    assert.equal(new Set(r.map(x=>x.job_id)).size,1);
    assert.equal(r.filter(x=>x.disposition==='created').length,1);
    const legacy=enqueueArgs(f);
    db('insert into public.notification_events(event_key,event_type,title,body,deep_link) values('+[legacy.p_event_key,'schedule','x','x','/'].map(lit).join(',')+')');
    await call('enqueue_notification_dispatch',legacy,'EVENT_WITHOUT_DISPATCH_JOB');
  });
  await test('acquire CAS, replay no extension, busy, invalid limit, takeover and stale fencing',async()=>{
    const f=await fixture(),j=await enqueue(f),l=await acquire(j,1);
    const r=await call('acquire_notification_dispatch_job',l.args);assert.equal(r.lease_until,l.lease_until);
    assert.equal(r.disposition,'existing_lease');
    await call('acquire_notification_dispatch_job',{...l.args,p_limit:2},'OPERATION_ARGUMENT_CONFLICT');
    await call('acquire_notification_dispatch_job',{...l.args,p_limit:26},'INVALID_ACQUIRE_ARGUMENT');
    assert.equal((await acquire(j)).disposition,'busy');
    expire(l);const b=await acquire(j);assert.equal(b.lease_epoch,l.lease_epoch+1);
    await call('prepare_notification_dispatch_batch',prepareArgs(l),'OPERATION_SUPERSEDED');
  });
  await test('snapshot once / max batch / no added device / prepare response loss',async()=>{
    const f=await fixture(26),j=await enqueue(f),l=await acquire(j,25);
    await lost('prepare_notification_dispatch_batch',prepareArgs(l));
    assert.equal((await prepare(l)).batch_count,25);assert.equal(attempts(l).length,25);
    assert(attempts(l).every(a=>a.attempt_no===1));
    const id=randomUUID();db('insert into public.push_subscriptions(id,user_id,endpoint,p256dh,auth) values('+[id,f.user,'https://example.invalid/'+id,'p','a'].map(lit).join(',')+')');
    await call('settle_notification_dispatch_job',settleArgs(l));
    const b=await acquire(j,1);assert.equal((await prepare(b)).batch_count,1);
    assert.equal(db('select count(*) from public.notification_deliveries where event_id='+lit(j.event_id)),'26');
    const s=await rpc('get_notification_dispatch_state',{p_job_id:j.job_id,p_batch_id:b.batch_id});assert(s.some(x=>x.row_kind==='attempt'));
  });
  await test('preferences three types/default true; disabled/revoked exclusion; zero snapshot terminal',async()=>{
    for(const [type,column] of [['schedule','schedule_enabled'],['memo','memos_enabled'],['announcement','announcements_enabled']]){
      const f=await fixture(1,type);db('insert into public.notification_preferences(user_id,'+column+') values('+lit(f.user)+',false)');
      const j=await enqueue(f),l=await acquire(j),r=await prepare(l);
      assert.equal(r.batch_count,0);assert(r.snapshot_at);assert.equal(r.event_status,'sent');assert.equal(r.job_stage,'completed');
      assert.equal((await prepare(l)).batch_count,0);
    }
    for(const mode of ['disabled','revoked']){
      const f=await fixture();
      db(mode==='disabled'?'update public.push_subscriptions set enabled=false where id='+lit(f.subs[0]):'delete from public.class_members where email='+lit(f.email));
      const l=await acquire(await enqueue(f));assert.equal((await prepare(l)).batch_count,0);
    }
  });
  await test('20 simultaneous begin => exactly one permit and credentials exactly once',async()=>{
    const {l,a}=await prepared();
    const rr=await Promise.all(Array.from({length:20},()=>call('begin_notification_dispatch_send',beginArgs(l,a))));
    assert.equal(rr.filter(x=>x.permit_granted).length,1);
    assert.equal(rr.filter(x=>x.endpoint!==null).length,1);
    await call('begin_notification_dispatch_send',beginArgs(l,a,4000),'OPERATION_ARGUMENT_CONFLICT');
  });
  await test('begin lost response cannot grant second permit; send-started cannot release',async()=>{
    const {l,a}=await prepared();await lost('begin_notification_dispatch_send',beginArgs(l,a));
    const r=await call('begin_notification_dispatch_send',beginArgs(l,a));assert(!r.permit_granted);assert.equal(r.endpoint,null);
    await call('release_notification_dispatch_attempt',releaseArgs(l,a),'ATTEMPT_NOT_RELEASABLE');
  });
  await test('begin auto-release captures timeout; replay and changed-timeout conflict',async()=>{
    for(const mode of ['revoked','credentials']){
      const {f,l,a}=await prepared();
      db(mode==='revoked'?'delete from public.class_members where email='+lit(f.email):'update public.push_subscriptions set auth=\'changed\' where id='+lit(f.subs[0]));
      const r=await call('begin_notification_dispatch_send',beginArgs(l,a,4000));assert(!r.permit_granted);assert.equal(r.current_stage,'released');
      const saved=one('select * from public.notification_dispatch_attempts where id='+lit(a.id));
      assert.equal(saved.begin_requested_timeout_ms,4000);assert.equal(saved.send_timeout_ms,null);
      assert.equal((await call('begin_notification_dispatch_send',beginArgs(l,a,4000))).current_stage,'released');
      await call('begin_notification_dispatch_send',beginArgs(l,a,8000),'OPERATION_ARGUMENT_CONFLICT');
    }
  });
  await test('release attempt5->4 exactly once / requested versus effective / independent release before begin',async()=>{
    const {f,j,l,a}=await prepared();
    db('update public.notification_deliveries set attempt_count=5 where id='+lit(a.delivery_id)+';update public.notification_dispatch_attempts set attempt_no=5 where id='+lit(a.id));
    db('delete from public.class_members where email='+lit(f.email));
    await lost('release_notification_dispatch_attempt',releaseArgs(l,a));
    const r=await call('release_notification_dispatch_attempt',releaseArgs(l,a));assert.equal(r.released_attempt_count,4);
    assert.equal(delivery(a).attempt_count,4);assert.equal(delivery(a).status,'skipped');
    assert.equal(delivery(a).last_error_code,'recipient_revoked');
    assert.equal(one('select release_reason from public.notification_dispatch_attempts where id='+lit(a.id)).release_reason,'worker_budget');
    await call('release_notification_dispatch_attempt',releaseArgs(l,a,'recipient_revoked'),'OPERATION_ARGUMENT_CONFLICT');
    await call('begin_notification_dispatch_send',beginArgs(l,a),'ATTEMPT_ALREADY_RELEASED');
  });
  await test('unconfirmed caller eligibility reason cannot skip eligible recipient',async()=>{
    const {l,a}=await prepared();
    const r=await call('release_notification_dispatch_attempt',releaseArgs(l,a,'recipient_revoked'));
    assert.equal(r.delivery_status,'queued');
  });
  await test('record response loss -> no repeat delivery/subscription/event mutation',async()=>{
    const {l,a,f}=await prepared();await call('begin_notification_dispatch_send',beginArgs(l,a));
    const args=recordArgs(l,a,'retryable',429,1);await lost('record_notification_dispatch_result',args);
    const before=db('select row_to_json(d) from public.notification_deliveries d where id='+lit(a.delivery_id))+
      db('select row_to_json(s) from public.push_subscriptions s where id='+lit(f.subs[0]))+
      db('select row_to_json(e) from public.notification_events e where id='+lit(l.event_id));
    const r=await call('record_notification_dispatch_result',args);assert.equal(r.disposition,'already_recorded');
    const after=db('select row_to_json(d) from public.notification_deliveries d where id='+lit(a.delivery_id))+
      db('select row_to_json(s) from public.push_subscriptions s where id='+lit(f.subs[0]))+
      db('select row_to_json(e) from public.notification_events e where id='+lit(l.event_id));
    assert.equal(after,before);
    await call('record_notification_dispatch_result',{...args,p_retry_after_seconds:30},'OPERATION_ARGUMENT_CONFLICT');
  });
  await test('retry 30/60/120/240, fifth terminal, raw Retry-After min/max, 5xx Retry-After rejected',async()=>{
    for(let n=1;n<=5;n++){
      const {l,a}=await prepared();
      db('update public.notification_deliveries set attempt_count='+n+' where id='+lit(a.delivery_id)+';update public.notification_dispatch_attempts set attempt_no='+n+' where id='+lit(a.id));
      await call('begin_notification_dispatch_send',beginArgs(l,a));
      const r=await call('record_notification_dispatch_result',recordArgs(l,a,'retryable',503));
      assert.equal(r.delivery_status,n===5?'failed':'queued');
      if(n<5){const diff=one('select extract(epoch from(d.next_attempt_at-a.result_recorded_at))::integer seconds from public.notification_deliveries d join public.notification_dispatch_attempts a on a.delivery_id=d.id where a.id='+lit(a.id));assert.equal(diff.seconds,[30,60,120,240][n-1]);}
    }
    for(const [input,delay] of [[1,30],[100000,86400]]){
      const {l,a}=await prepared();await call('begin_notification_dispatch_send',beginArgs(l,a));
      await call('record_notification_dispatch_result',recordArgs(l,a,'retryable',503,1),'INVALID_PROVIDER_RESULT');
      await call('record_notification_dispatch_result',recordArgs(l,a,'retryable',429,input));
      const diff=one('select a.provider_retry_after_seconds raw,extract(epoch from(d.next_attempt_at-a.result_recorded_at))::integer seconds from public.notification_deliveries d join public.notification_dispatch_attempts a on a.delivery_id=d.id where a.id='+lit(a.id));
      assert.equal(diff.raw,input);assert.equal(diff.seconds,delay);
      const s=await call('settle_notification_dispatch_job',settleArgs(l));assert.equal(s.job_stage,'waiting');assert.equal(s.event_status,'sending');
      assert.equal((await acquire({job_id:l.job_id})).disposition,'not_due');
    }
  });
  await test('provider mapping: 2xx /404 /410 /permanent; expired-only event sent',async()=>{
    for(const [outcome,http,status] of [['sent',201,'sent'],['expired',404,'expired'],['expired',410,'expired'],['permanent_failure',403,'failed']]){
      const {l,a}=await prepared();await call('begin_notification_dispatch_send',beginArgs(l,a));
      const r=await call('record_notification_dispatch_result',recordArgs(l,a,outcome,http));
      assert.equal(r.delivery_status,status);assert.equal(r.job_stage,'completed');
      assert.equal(r.event_status,status==='failed'?'failed':'sent');
    }
  });
  await test('five active permit limit / lease reserve',async()=>{
    const {l,all}=await prepared(6);
    for(const a of all.slice(0,5))assert((await call('begin_notification_dispatch_send',beginArgs(l,a))).permit_granted);
    await call('begin_notification_dispatch_send',beginArgs(l,all[5]),'SEND_CAPACITY_REACHED');
    const x=await prepared();db('update public.notification_dispatch_jobs set lease_until=clock_timestamp()+interval \'5 seconds\' where id='+lit(x.l.job_id));
    await call('begin_notification_dispatch_send',beginArgs(x.l,x.a),'INSUFFICIENT_LEASE_BUDGET');
  });
  await test('old prepared recovery requires release; stale epoch cannot begin; counter restored',async()=>{
    const {j,l,a}=await prepared();expire(l);const b=await acquire(j);
    await call('prepare_notification_dispatch_batch',prepareArgs(b),'RECOVERY_REQUIRED');
    await call('begin_notification_dispatch_send',beginArgs(l,a),'OPERATION_SUPERSEDED');
    await call('settle_notification_dispatch_job',settleArgs(b));
    assert.equal(delivery(a).attempt_count,0);
    assert.equal(one('select release_reason from public.notification_dispatch_attempts where id='+lit(a.id)).release_reason,'stale_prepared');
  });
  await test('settle before ambiguity deadline waits without terminalizing; after deadline ambiguous, no new permit',async()=>{
    const {j,l,a}=await prepared();await call('begin_notification_dispatch_send',beginArgs(l,a));
    const r=await call('settle_notification_dispatch_job',settleArgs(l));assert.equal(r.job_stage,'waiting');
    assert.equal(one('select stage from public.notification_dispatch_attempts where id='+lit(a.id)).stage,'send_started');
    ageSend(a);db('update public.notification_dispatch_jobs set next_run_at=clock_timestamp()-interval \'1 second\' where id='+lit(j.job_id));
    const b=await acquire(j);await call('settle_notification_dispatch_job',settleArgs(b));
    assert.equal(delivery(a).last_error_code,'delivery_ambiguous');
    assert(!(await call('begin_notification_dispatch_send',beginArgs(l,a))).permit_granted);
  });
  await test('late worker races both orders; late 2xx/410/permanent/429/5xx refinement never resends',async()=>{
    // A records after takeover but before B recovery.
    let x=await prepared();await call('begin_notification_dispatch_send',beginArgs(x.l,x.a));
    expire(x.l);let b=await acquire(x.j);
    assert.equal((await call('record_notification_dispatch_result',recordArgs(x.l,x.a,'sent',201))).delivery_status,'sent');
    assert.equal((await call('settle_notification_dispatch_job',settleArgs(b))).job_stage,'completed');
    // B records ambiguity first; late concrete result remains admissible.
    for(const [outcome,http,status] of [['sent',201,'sent'],['expired',410,'expired'],['permanent_failure',403,'failed'],['retryable',429,'failed'],['retryable',503,'failed']]){
      x=await prepared();await call('begin_notification_dispatch_send',beginArgs(x.l,x.a));
      expire(x.l);ageSend(x.a);b=await acquire(x.j);await call('settle_notification_dispatch_job',settleArgs(b));
      const r=await call('record_notification_dispatch_result',recordArgs(x.l,x.a,outcome,http));
      assert.equal(r.delivery_status,status);assert.equal(r.job_stage,'completed');assert.equal(r.next_attempt_at,null);
      const a=one('select * from public.notification_dispatch_attempts where id='+lit(x.a.id));
      assert(a.ambiguity_at);assert.equal(a.ambiguity_reason,'send_result_missing');
      if(outcome==='retryable')assert.equal(delivery(x.a).last_error_code,'late_retryable_after_ambiguity');
    }
  });
  await test('explicit ambiguity / preserved reason / fingerprint protects replacement subscription from late 410',async()=>{
    const {f,l,a}=await prepared();await call('begin_notification_dispatch_send',beginArgs(l,a));
    const args=recordArgs(l,a,'ambiguous',null,null,'provider_timeout');
    await call('record_notification_dispatch_result',args);
    db('update public.push_subscriptions set auth=\'replacement\' where id='+lit(f.subs[0]));
    await call('record_notification_dispatch_result',recordArgs(l,a,'expired',410));
    assert(one('select enabled from public.push_subscriptions where id='+lit(f.subs[0])).enabled);
    assert.equal((await call('record_notification_dispatch_result',args)).disposition,'already_resolved');
    await call('record_notification_dispatch_result',{...args,p_error_code:'provider_reset'},'OPERATION_ARGUMENT_CONFLICT');
  });
  await test('blocked/completed and mixed sent/failed aggregation; settle lost response',async()=>{
    let x=await prepared();await lost('settle_notification_dispatch_job',settleArgs(x.l,'configuration_blocked'));
    let r=await call('settle_notification_dispatch_job',settleArgs(x.l,'configuration_blocked'));
    assert.equal(r.job_stage,'blocked');assert.equal(r.event_status,'failed');
    await call('settle_notification_dispatch_job',settleArgs(x.l),'OPERATION_ARGUMENT_CONFLICT');
    x=await prepared(2);for(const a of x.all)await call('begin_notification_dispatch_send',beginArgs(x.l,a));
    await call('record_notification_dispatch_result',recordArgs(x.l,x.all[0],'sent',201));
    r=await call('record_notification_dispatch_result',recordArgs(x.l,x.all[1],'permanent_failure',403));
    assert.equal(r.event_status,'failed');assert.equal(r.job_stage,'completed');
  });
  await test('CHECK rejects partial settle evidence instead of accepting SQL NULL',async()=>{
    const {j}=await prepared();
    assert.throws(()=>db('begin; update public.notification_dispatch_jobs set settled_at=clock_timestamp(),settle_reason=null where id='+lit(j.job_id)+'; rollback;'));
    assert.equal(job(j).settled_at,null);
  });
  await test('concurrent jobs sharing one subscription: no deadlock and exactly-once counters',async()=>{
    const f=await fixture();
    const work=await Promise.all(Array.from({length:8},async()=>{
      const j=await enqueue(f),l=await acquire(j);await prepare(l);return {l,a:attempts(l)[0]};
    }));
    await Promise.all(work.map(({l,a})=>call('begin_notification_dispatch_send',beginArgs(l,a))));
    await Promise.all(work.map(({l,a})=>call('record_notification_dispatch_result',recordArgs(l,a,'retryable',503))));
    assert.equal(one('select failure_count from public.push_subscriptions where id='+lit(f.subs[0])).failure_count,8);
    await Promise.all(work.map(({l,a})=>call('record_notification_dispatch_result',recordArgs(l,a,'retryable',503))));
    assert.equal(one('select failure_count from public.push_subscriptions where id='+lit(f.subs[0])).failure_count,8);
  });
  console.log('DURABLE LOCAL BEHAVIOR PASS='+passed+' FAIL=0');
}
