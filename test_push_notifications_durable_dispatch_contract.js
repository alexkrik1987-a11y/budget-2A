'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const sql=fs.readFileSync(__dirname+'/push-notifications-durable-dispatch.sql','utf8');
const signatures=[["enqueue_notification_dispatch","p_event_key text,p_event_type text,p_title text,p_body text,p_source_entity text,p_source_entity_id text,p_deep_link text,p_created_by uuid","disposition text,job_id uuid,event_id uuid,job_stage text,event_status text"],["acquire_notification_dispatch_job","p_job_id uuid,p_worker_id uuid,p_operation_id uuid,p_expected_epoch bigint,p_limit integer default 25","disposition text,job_id uuid,event_id uuid,job_stage text,lease_epoch bigint,lease_until timestamptz,batch_id uuid,batch_limit integer,settle_operation_id uuid"],["prepare_notification_dispatch_batch","p_job_id uuid,p_worker_id uuid,p_lease_epoch bigint,p_batch_id uuid","disposition text,job_id uuid,event_id uuid,batch_id uuid,batch_count integer,snapshot_at timestamptz,job_stage text,event_status text"],["begin_notification_dispatch_send","p_job_id uuid,p_worker_id uuid,p_lease_epoch bigint,p_attempt_id uuid,p_operation_id uuid,p_timeout_ms integer default 8000","permit_granted boolean,current_stage text,attempt_id uuid,claim_token uuid,send_deadline_at timestamptz,endpoint text,p256dh text,auth text,event_id uuid,event_type text,title text,body text,deep_link text"],["release_notification_dispatch_attempt","p_job_id uuid,p_worker_id uuid,p_lease_epoch bigint,p_attempt_id uuid,p_operation_id uuid,p_reason text","disposition text,attempt_id uuid,attempt_stage text,released_attempt_count integer,delivery_status text,delivery_attempt_count integer,next_attempt_at timestamptz,event_status text,job_stage text"],["record_notification_dispatch_result","p_attempt_id uuid,p_worker_id uuid,p_send_epoch bigint,p_claim_token uuid,p_operation_id uuid,p_outcome text,p_http_status integer default null,p_retry_after_seconds integer default null,p_error_code text default null","disposition text,attempt_id uuid,attempt_stage text,provider_outcome text,delivery_status text,delivery_attempt_count integer,next_attempt_at timestamptz,event_status text,job_stage text"],["settle_notification_dispatch_job","p_job_id uuid,p_worker_id uuid,p_lease_epoch bigint,p_operation_id uuid,p_reason text default 'yield'","disposition text,job_id uuid,job_stage text,event_status text,next_run_at timestamptz,queued_count bigint,sending_count bigint,sent_count bigint,expired_count bigint,failed_count bigint,skipped_count bigint,ambiguous_count bigint"],["get_notification_dispatch_state","p_job_id uuid default null,p_batch_id uuid default null,p_attempt_id uuid default null,p_after_id uuid default null,p_limit integer default 25","row_kind text,job_id uuid,event_id uuid,job_stage text,event_status text,lease_epoch bigint,lease_owner uuid,lease_until timestamptz,next_run_at timestamptz,snapshot_at timestamptz,batch_id uuid,batch_prepared boolean,batch_count integer,settle_operation_id uuid,attempt_id uuid,delivery_id uuid,attempt_stage text,prepared_epoch bigint,attempt_no integer,claim_token uuid,begin_operation_id uuid,record_operation_id uuid,ambiguity_operation_id uuid,release_operation_id uuid,send_owner uuid,send_epoch bigint,send_deadline_at timestamptz,ambiguity_after timestamptz,delivery_status text,delivery_attempt_count integer,delivery_next_attempt_at timestamptz,provider_outcome text,result_recorded_at timestamptz,ambiguity_at timestamptz,released_at timestamptz"]];
for(const [name,args,returns] of signatures){
 const b=sql.split('create function public.'+name+'(')[1].split('$rpc$;')[0];
 const compact=x=>x.replace(/\s+/g,'').toLowerCase();
 assert(compact(b).startsWith(compact(args+')')));
 assert(b.includes('returns table('+returns+')'));
}
const bodies=sql.match(/as \$rpc\$[\s\S]*?\$rpc\$;/g).join('\n');
assert(!/public\.(?:claim_notification_delivery_batch|record_notification_delivery_result|release_notification_delivery_claim)\s*\(/.test(bodies));
assert.equal((bodies.match(/return query select true,/g)||[]).length,1);
for(const s of ['begin_requested_timeout_ms=p_timeout_ms','release_reason=v_logical',
 'provider_retry_after_seconds=p_retry_after_seconds',"'late_retryable_after_ambiguity'",
 "'delivery_ambiguous'","interval '90 seconds'","interval '3 seconds'","interval '5 seconds'",
 'when 1 then 30 when 2 then 60 when 3 then 120 when 4 then 240',
 'greatest(30,least(86400,p_retry_after_seconds))','v_j.batch_prepared_at is not null',
 'OPERATION_SUPERSEDED','RECOVERY_REQUIRED','ATTEMPT_ALREADY_RELEASED','OPERATION_ARGUMENT_CONFLICT'
]) assert(sql.includes(s),s);
assert(sql.includes('stage=\'send_started\''));
assert(!/pg_sleep\s*\(/i.test(bodies));
assert(sql.includes("stage='released',release_reason=v_logical,begin_requested_timeout_ms=p_timeout_ms"));
assert(!sql.includes('set begin_requested_timeout_ms=p_timeout_ms where'));
console.log('Durable RPC static contract PASS');
