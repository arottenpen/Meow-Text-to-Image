import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGeneration,sendPrepared} from '../src/generation/generation-lifecycle.js';
import {createDirectClient} from '../src/novelai/direct-client.js';
import {runWithQueue} from '../src/queue/cloud-queue.js';
import {LeaseQueue} from '../queue-service/queue.mjs';
import {queueCapabilities} from '../shared/queue-protocol.js';
const keyHash='b'.repeat(64);
const dispatch=q=>async(url,{body})=>url.endsWith('/join-queue')?q.join(body):url.endsWith('/my-turn')?q.turn(body):q.release(body);

test('hung key and Vibe reads time out before joining; ignored abort and late data cannot send',async()=>{
 for(const kind of ['key','vibe']){
  let late,sent=0,joined=0;
  const id='12345678-1234-1234-1234-123456789abc';
  const client=createDirectClient({settings:{vibeLibrary:[{id}]},save(){},getHeaders:()=>({}),getKey:()=>kind==='key'?new Promise(r=>late=r):Promise.resolve('fixture'),unzipPNG:async()=>'',fetchImpl:async url=>{
   if(url.startsWith('/user/files/'))return new Promise(r=>late=r);sent++;return new Response('zip');
  }});
  const operation=async()=>{const prepared=await prepareGeneration(()=>client.prepareGenerate({vibes:kind==='vibe'?[{id}]:[]}),{timeoutMs:5});joined++;return sendPrepared(prepared);};
  await assert.rejects(operation(),/准备超时/);late(kind==='key'?'fixture':Response.json({id,encodings:{}}));
  await new Promise(r=>setImmediate(r));assert.equal(joined,0);assert.equal(sent,0);
 }
});
test('preparation cancellation and clock expiry discard results even before the timeout callback runs',async()=>{
 const controller=new AbortController();
 const pending=prepareGeneration(()=>new Promise(()=>{}),{signal:controller.signal});controller.abort();await assert.rejects(pending,/已取消/);
 let now=0;await assert.rejects(prepareGeneration(async()=>{now=21000;return 'late';},{now:()=>now}),/准备超时/);
});
test('a pause after asynchronous validation is rechecked at the synchronous fetch boundary',async()=>{
 let now=0,sent=0;const q=new LeaseQueue({now:()=>now});
 await assert.rejects(runWithQueue({twoPhase:false,url:'https://fixture.invalid',keyHash,now:()=>now,generationTimeoutMs:30000,requestJSON:dispatch(q),generate:controls=>sendPrepared({source:'nai-generation',send:()=>{sent++;}}, {...controls,beforeSend:async()=>{const budget=await controls.beforeSend();now=30001;return budget;}})}),/未发送/);
 assert.equal(sent,0);
});
test('full response releases before slow ZIP, image save and chat save; local postprocessing has no network deadline',async()=>{
 const events=[];let resume,entered;
 const ready=new Promise(r=>entered=r);
 const pending=sendPrepared({source:'nai-generation',send:async()=>{events.push('body');return 'bytes';},postprocess:async()=>{events.push('zip');entered();await new Promise(r=>resume=r);events.push('image-save','chat-save');return 'image';}},{assertSend:()=>events.push('send'),onResponse:async()=>events.push('release'),timeoutMs:5});
 await ready;assert.deepEqual(events,['send','body','release','zip']);await new Promise(r=>setTimeout(r,10));resume();assert.equal(await pending,'image');
});
test('Vibe encode cache bypasses key lookup and send; uncached encoding releases before local read/write',async()=>{
 const id='12345678-1234-1234-1234-123456789abc',item={id,name:'fixture',image:'YQ==',encodings:{'v4-5full':{'miao-1':{encoding:'YQ==',params:{information_extracted:1}}}}};
 const events=[];
 const client=createDirectClient({settings:{vibeLibrary:[{id}]},save(){},getHeaders:()=>({}),getKey:async()=>{events.push('key');return 'fixture';},unzipPNG:async()=>'',fetchImpl:async url=>{
  if(url.startsWith('/user/files/')){events.push('read');return Response.json(item);}
  if(url.endsWith('encode-vibe')){events.push('encode');return new Response('encoded');}
  events.push('write');return Response.json({path:'user/files/miao-vibe-'+id+'.json'});
 }});
 assert.equal((await client.prepareEncode({id,model:'nai-diffusion-4-5-full',information:1})).cached,true);assert.deepEqual(events,['read']);
 events.length=0;const prepared=await prepareGeneration(()=>client.prepareEncode({id,model:'nai-diffusion-4-5-full',information:.5}));
 await sendPrepared(prepared,{onResponse:async()=>events.push('release'),timeoutMs:180000});
 assert.deepEqual(events,['read','key','encode','release','read','write']);
});

test('complete image responses finish local processing while modern and legacy queue cleanup is pending',{timeout:5000},async()=>{
 for(const twoPhase of [true,false]){
  const q=new LeaseQueue(),events=[],calls=[];let release,entered,settled=false,posts=0;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const job=runWithQueue({url:'https://queue.test',keyHash,twoPhase,requestJSON:async(url,{body}={})=>{
   const path=new URL(url).pathname;calls.push({path,body});
   if(path==='/ping')return {ready:true,capabilities:queueCapabilities};
   if(path==='/join-queue')return q.join(body);
   if(path==='/my-turn')return q.turn(body);
   if(path==='/begin-generation')return q.begin(body);
   if(path==='/finish'||path==='/complete'){events.push('release-start');entered();await gate;events.push('release-end');return twoPhase?q.finish(body):q.release(body);}
   assert.fail('unexpected queue RPC '+path);
  },generate:controls=>sendPrepared({source:'nai-generation',send:async()=>{posts++;return 'bytes';},postprocess:async data=>{assert.equal(data,'bytes');events.push('decode');return 'image';}},controls)});
  job.then(()=>{settled=true;},()=>{settled=true;});
  try{
   await started;await new Promise(resolve=>setImmediate(resolve));
   assert.deepEqual(events,['release-start','decode'],'image processing must not wait for queue acknowledgement');
   assert.equal(settled,true,'the caller must be able to save and display the image immediately');
   assert.equal(await job,'image');assert.equal(posts,1);assert.equal(q.stats().active,1);
   assert.equal(calls.filter(call=>call.path===(twoPhase?'/finish':'/complete')).length,1);
   if(twoPhase)assert.equal(calls.at(-1).body.outcome,'success');
  }finally{release();await job;}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(q.stats().active,0);assert.equal(events.at(-1),'release-end');
 }
});

test('background success cleanup keeps bounded retries and reports failure without replaying generation',{timeout:5000},async()=>{
 let release,entered,reported,attempts=0,posts=0,settled=false;const errors=[],sleeps=[];
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),notified=new Promise(resolve=>reported=resolve);
 const failure=Object.assign(Error('queue offline'),{name:'TypeError'});
 const job=runWithQueue({url:'https://queue.test',keyHash,twoPhase:false,retryDelays:[1000,3000],sleep:async ms=>sleeps.push(ms),
  requestJSON:async(url)=>{if(url.endsWith('/join-queue'))return {your_turn:true,lock_token:'fixture-lock'};assert.ok(url.endsWith('/complete'));attempts++;entered();await gate;throw failure;},
  onReleaseError:error=>{errors.push(error);reported();throw Error('notification failure');},
  generate:controls=>sendPrepared({source:'nai-generation',send:async()=>{posts++;return 'image';}},controls)});
 job.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await started;await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,true);
  assert.equal(await job,'image');assert.equal(errors.length,0);
 }finally{release();await job;}
 await notified;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(attempts,3);assert.deepEqual(sleeps,[1000,1000]);assert.deepEqual(errors,[failure]);assert.equal(posts,1);
});

test('elapsed budget tolerates wall-clock rollback and monotonic clocks stopping during background sleep',async()=>{
 const {elapsedClock}=await import('../src/generation/generation-lifecycle.js');let wall=1000,mono=100;const now=elapsedClock({wall:()=>wall,monotonic:()=>mono});
 wall=900;mono=6100;assert.equal(now(),6000);wall=17000;assert.equal(now(),16000);wall=1;mono=1;assert.equal(now(),16000);
});
