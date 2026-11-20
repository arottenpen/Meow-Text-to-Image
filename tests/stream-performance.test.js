import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createStreamScheduler,streamOnlyMutations} from '../src/chat/stream-scheduler.js';
import {imageBlob} from '../src/images/image-thumbnails.js';

function clock(){
    let now=0,id=0;const timers=new Map();
    return {timers,setTimer(fn,ms){timers.set(++id,{fn,at:now+ms});return id;},clearTimer(id){timers.delete(id);},async advance(ms){const end=now+ms;while(true){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;timers.delete(next[0]);await next[1].fn();}now=end;}};
}
test('1000 continuous tokens coalesce without starvation and preserve the trailing text',async()=>{
    const c=clock(),seen=[];let text='';const scheduler=createStreamScheduler(()=>seen.push(text),c);
    for(let i=0;i<1000;i++){text+='x';scheduler.schedule();assert.ok(c.timers.size<=1);await c.advance(1);}
    await c.advance(80);assert.equal(seen.length,13);assert.equal(seen.at(-1),text);
});
test('slow async scans never overlap; new tokens request one follow-up and cancel removes it',async()=>{
    const c=clock();let calls=0,release;const scheduler=createStreamScheduler(async()=>{calls++;await new Promise(r=>release=r);},c);
    scheduler.schedule();const pending=c.advance(80);assert.equal(calls,1);
    for(let i=0;i<100;i++)scheduler.schedule();assert.equal(c.timers.size,0);
    release();await pending;assert.equal(c.timers.size,1);
    scheduler.cancel();await c.advance(100);assert.equal(calls,1);
    scheduler.schedule();const second=c.advance(80);assert.equal(calls,2);scheduler.cancel();release();await second;assert.equal(c.timers.size,0);
});
test('cancel discards stale work and failures do not wedge future scanning',async()=>{
    const c=clock(),errors=[];let calls=0;const scheduler=createStreamScheduler(()=>{calls++;throw Error('fixture');},{...c,onError:e=>errors.push(e.message)});
    scheduler.schedule();scheduler.cancel();await c.advance(80);assert.equal(calls,0);
    scheduler.schedule();await c.advance(80);scheduler.schedule();await c.advance(80);assert.equal(calls,2);assert.deepEqual(errors,['fixture','fixture']);
});
test('only stream-floor changes are suppressed, history, chat structure and renumbering still render',()=>{
    const floor={},history={};const node=f=>({closest:()=>f});
    const active={type:'childList',target:node(floor)};
    assert.equal(streamOnlyMutations([active],floor),true);
    assert.equal(streamOnlyMutations([{type:'characterData',target:{nodeType:3,parentElement:node(floor)}}],floor),true);
    for(const records of [[active,{target:node(history)}],[{target:node(null)}],[{type:'attributes',attributeName:'mesid',target:node(floor)}],[]])assert.equal(streamOnlyMutations(records,floor),false);
    assert.equal(streamOnlyMutations([active],null),false);
});
test('actual token listener schedules only stream mode, never renders or queues per-token timers',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const listener=source.match(/c\.eventSource\.on\(c\.eventTypes\.STREAM_TOKEN_RECEIVED,([\s\S]*?)\n    \}\);/);
    assert.ok(listener);let calls=0;
    const context={generationChat:'chat',currentChat:()=> 'chat',streamActive:false,settings:{enabled:true,mode:'stream'},streamScanner:{schedule(){calls++;}}};
    vm.createContext(context);vm.runInContext('var token='+listener[1]+'\n};',context);
    for(let i=0;i<100;i++)context.token();assert.equal(calls,100);assert.equal(context.streamActive,true);
    context.settings.mode='manual';context.token();context.settings.mode='auto';context.token();assert.equal(calls,100);
    context.settings.mode='stream';context.generationChat='other';context.token();assert.equal(calls,100);
});
test('real end, stop and chat-change handlers cancel pending scans and retain their final refresh',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    for(const event of ['GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED']){
        let cancelled=0,rendered=0,generated=0;const handlers={};
        const context={c:{eventSource:{on:(name,fn)=>handlers[name]=fn},eventTypes:{[event]:event}},generationChat:'chat',currentChat:()=> 'chat',streamActive:true,autoSession:{},streamScanner:{cancel(){cancelled++;}},renderAll(){rendered++;},scheduleRender(){rendered++;},autoLatest(){generated++;},settings:{mode:'stream',eggProfileEnabled:false},setTimeout(){},guard:fn=>fn,indexChatImages(){}};
        vm.createContext(context);
        const line=source.split('\n').find(line=>line.includes('c.eventSource.on(c.eventTypes.'+event+','));assert.ok(line);
        vm.runInContext(line,context);handlers[event]();
        assert.equal(cancelled,1);assert.equal(rendered,1);assert.equal(context.streamActive,false);assert.equal(context.generationChat,null);
        assert.equal(generated,event==='CHAT_CHANGED'?0:1);
        if(event==='CHAT_CHANGED')assert.equal(context.autoSession,null);
    }
});
test('thumbnail decoder remains exported and preserves every byte and data URL inputs',async()=>{
    const bytes=Uint8Array.from({length:65537},(_,i)=>i%256),encoded=Buffer.from(bytes).toString('base64');
    for(const input of [encoded,'data:image/png;base64,'+encoded]){const blob=imageBlob(input);assert.equal(blob.type,'image/png');assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);}
});

test('generation start skips history and macros in manual/disabled modes while preserving stream lifecycle',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const start=source.indexOf('    c.eventSource.on(c.eventTypes.GENERATION_STARTED,');
    const end=source.indexOf('\n    });',start)+7;
    assert.ok(start>=0&&end>start);
    for(const mode of ['manual','auto','stream'])for(const enabled of [false,true]){
        let callback,parsed=0,macros=0,cancels=0;
        const context={c:{eventTypes:{GENERATION_STARTED:'start'},eventSource:{on:(_,fn)=>callback=fn}},settings:{mode,enabled,eggProfileEnabled:true},streamScanner:{cancel(){cancels++;}},streamActive:true,generationChat:null,autoSession:{old:true},currentChat:()=> 'chat',ctx:()=>({chat:[{mes:'fixture'}]}),blocks(){parsed++;return [{prompt:'fixture'}];},identity:()=> 'identity',eggMarkerCache:{read(){macros++;return Promise.resolve('marker');}}};
        vm.createContext(context);vm.runInContext(source.slice(start,end),context);
        callback('normal',{},false);
        const automatic=enabled&&mode!=='manual';
        assert.equal(parsed,automatic?1:0);assert.equal(macros,automatic?1:0);assert.equal(cancels,1);
        assert.equal(context.streamActive,false);assert.equal(context.generationChat,'chat');
        assert.equal(context.autoSession===null,!automatic);
    }
});
