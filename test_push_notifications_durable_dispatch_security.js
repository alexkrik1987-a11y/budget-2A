'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const sql=fs.readFileSync(__dirname+'/push-notifications-durable-dispatch.sql','utf8');
const names=[["enqueue_notification_dispatch",5],["acquire_notification_dispatch_job",5],["prepare_notification_dispatch_batch",5],["begin_notification_dispatch_send",3],["release_notification_dispatch_attempt",3],["record_notification_dispatch_result",3],["settle_notification_dispatch_job",5],["get_notification_dispatch_state",3]];
assert.equal((sql.match(/^create function public\./gm)||[]).length,8);
assert(!/create or replace/i.test(sql));
for(const [name,seconds] of names){
 const block=sql.split('create function public.'+name+'(')[1].split('$rpc$;')[0];
 assert(block.includes('security definer'));
 assert(block.includes('set search_path = pg_catalog, public, pg_temp'));
 assert(block.includes("set statement_timeout = '"+seconds+"s'"));
 assert(block.includes("set lock_timeout = '750ms'"));
 assert(sql.includes('alter function public.'+name+'('));
 assert(sql.includes('grant execute on function public.'+name+'('));
}
for(const name of ['notification_dispatch_jobs','notification_dispatch_attempts']){
 assert(sql.includes('alter table public.'+name+' owner to postgres'));
 assert(sql.includes('alter table public.'+name+' enable row level security'));
}
assert(!/^create policy /im.test(sql));
assert(sql.includes('from public,anon,authenticated,service_role'));
assert(sql.includes("raise exception 'DURABLE_DISPATCH_ALREADY_EXISTS'"));
assert(sql.trim().endsWith('commit;'));
assert(!/^create extension/im.test(sql));
assert(!/\b(?:cron\.schedule|vault\.|http_post|pg_net\.)/i.test(sql));
for(const [file,sha] of [
 ['push-notifications.sql','f432eb7d1378c3ebc23c2272e232f1940dd32fb4c1c658ac434eef89519fda66'],
 ['push-notifications-phase2.sql','bd97f39c3f7bbdf5434b9f9b10fac0a72c448e31a403a005b02348115198c1bd'],
 ['push-notifications-phase2a-claim-release.sql','83fad234d5315cb4b3059e5e75356a4f2f8c679ca17e6e85076b1858e00a4acc']
]) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(__dirname+'/'+file)).digest('hex'),sha);
console.log('Durable security static contract PASS');
