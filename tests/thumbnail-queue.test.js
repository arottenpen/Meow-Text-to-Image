import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {createThumbnails} from '../src/images/image-thumbnails.js';
const base=()=> 'https://example.test/';
const url=i=>`/user/images/fixture/${i}.png`;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(check){for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('fixture did not reach expected state');}
function fixture(options={}){
    const reads=[],writes=[],ready=[];
    const api=createThumbnails({base,fetchImage:async path=>{reads.push(path);return {ok:!path.includes('miao-nai-thumbnails'),blob:async()=>new Blob([path])};},convert:async blob=>blob,encode:async()=> 'mock',saveImage:async(...args)=>writes.push(args),onReady:(...args)=>ready.push(args),...options});
    return {api,reads,writes,ready};
}
test('thumbnail queue bounds decoding and merges absolute and relative URLs',async()=>{
    const gate=deferred();let active=0,peak=0,started=0;
    const f=fixture({convert:async blob=>{started++;active++;peak=Math.max(peak,active);await gate.promise;active--;return blob;}});
    const jobs=Array.from({length:6},(_,i)=>f.api.ensure(url(i)));
    jobs.push(f.api.ensure(new URL(url(0),base()).href));
    await until(()=>started===2);assert.equal(f.reads.filter(path=>path.includes('/fixture/')).length,2);
    gate.resolve();const result=await Promise.all(jobs);
    assert.equal(peak,2);assert.equal(started,6);assert.equal(f.writes.length,6);assert.equal(f.ready.length,6);assert.equal(result[0],result[6]);
});
test('cached thumbnails skip original downloads and decoding',async()=>{
    let converted=0;const f=fixture({fetchImage:async()=>({ok:true}),convert:async()=>{converted++;}});
    assert.match(await f.api.ensure(url(0)),/thumb-.*\.jpg$/);assert.equal(converted,0);assert.equal(f.writes.length,0);
});
test('failed jobs release their slot and can be retried immediately',async()=>{
    let attempt=0;const f=fixture({concurrency:1,convert:async blob=>{if(++attempt===1)throw Error('decode failed');return blob;}});
    await assert.rejects(f.api.ensure(url(0)),/decode failed/);
    await f.api.ensure(url(0));assert.equal(attempt,2);assert.equal(f.writes.length,1);
});
test('deleting a queued image prevents its download without blocking on other images',async()=>{
    const gate=deferred();let started=0,removed=0;
    const f=fixture({concurrency:1,convert:async blob=>{started++;await gate.promise;return blob;}});
    const first=f.api.ensure(url(0)),queued=f.api.ensure(url(1));await until(()=>started===1);
    const target=await f.api.remove(url(1),async()=>{removed++;});
    assert.equal(await queued,null);assert.equal(removed,1);assert.match(target,/^user\/images\/miao-nai-thumbnails\//);
    assert.equal(f.reads.includes(url(1)),false);gate.resolve();await first;
});
test('deletion waits for an upload and blocks new work until original removal completes',async()=>{
    const upload=deferred(),remove=deferred(),events=[];
    const f=fixture({saveImage:async()=>{events.push('upload-start');await upload.promise;events.push('upload-end');}});
    const job=f.api.ensure(url(0));await until(()=>events.length===1);
    const deletion=f.api.remove(url(0),async()=>{events.push('delete-original');await remove.promise;});
    const duplicate=f.api.ensure(url(0));await delay(5);assert.deepEqual(events,['upload-start']);
    upload.resolve();await until(()=>events.includes('delete-original'));assert.equal(await job,null);assert.equal(f.ready.length,0);
    remove.resolve();await deletion;assert.equal(await duplicate,null);
    assert.deepEqual(events,['upload-start','upload-end','delete-original']);
});
test('a failed original deletion releases the path for later thumbnail retries',async()=>{
    const f=fixture();await assert.rejects(f.api.remove(url(0),async()=>{throw Error('delete failed');}),/delete failed/);
    assert.match(await f.api.ensure(url(0)),/\.jpg$/);assert.equal(f.writes.length,1);
});
test('generated original returns before thumbnail work, queues only URL, and reports background failure',async()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const body=source.slice(source.indexOf('async function saveGeneratedImage('),source.indexOf('\nconst resourceUpdater='));
    let rejectThumbnail;const pending=new Promise((_,reject)=>{rejectThumbnail=reject;});const calls=[],warnings=[];
    const context={inStage:(_name,run)=>run(),saveBase64AsFile:async()=>url(0),thumbnails:{ensure(...args){calls.push(args);return pending;}},notices:{warning:(...args)=>warnings.push(args)}};
    vm.createContext(context);vm.runInContext(body,context);
    assert.equal(await context.saveGeneratedImage('mock-base64','fixture','0'),url(0));
    assert.equal(calls.length,1);assert.deepEqual(calls[0],[url(0)]);assert.equal(warnings.length,0);
    rejectThumbnail(Error('background failure'));await delay(0);assert.equal(warnings.length,1);
});
