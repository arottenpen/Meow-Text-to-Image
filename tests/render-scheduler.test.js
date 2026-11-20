import test from 'node:test';
import assert from 'node:assert/strict';
import {createRenderScheduler} from '../src/chat/render-scheduler.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('task progress from another chat never resolves or renders a current message',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const body=source.slice(source.indexOf('function renderTask('),source.indexOf('\nfunction handleChatMutations('));
    const message={};let resolved=0,rendered=0;
    const context={currentChat:()=> 'current',liveMessage:()=>{resolved++;return message;},renderMessages:()=>{rendered++;}};
    vm.createContext(context);vm.runInContext(body,context);
    context.renderTask({chat:'old',message});assert.equal(resolved,0);assert.equal(rendered,0);
    context.renderTask({chat:'current',message});assert.equal(resolved,1);assert.equal(rendered,1);
});
function fixture(){
    const a={},b={},c={},scope={key:'one',chat:[a,b,c]},calls=[],timers=new Map();let id=0;
    const scheduler=createRenderScheduler({getScope:()=>scope,render:targets=>calls.push(targets),setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:id=>timers.delete(id)});
    const flush=()=>{const work=[...timers.values()];timers.clear();work.forEach(fn=>fn());};return {a,b,c,scope,calls,timers,scheduler,flush};
}
test('message and mutation events coalesce once without broadening to unrelated history',()=>{
    const f=fixture();for(let i=0;i<100;i++)f.scheduler.schedule(f.b);f.scheduler.schedule(f.c);
    assert.equal(f.timers.size,1);f.flush();assert.deepEqual(f.calls,[[f.b,f.c]]);
});
test('full render supersedes local requests while the next batch starts clean',()=>{
    const f=fixture();f.scheduler.schedule(f.a);f.scheduler.schedule();f.scheduler.schedule(f.b);f.flush();assert.deepEqual(f.calls,[null]);
    f.scheduler.schedule(f.c);f.flush();assert.deepEqual(f.calls,[null,[f.c]]);
});
test('message deletion and replacement cannot redirect old queued updates to a new occupant',()=>{
    const f=fixture();f.scheduler.schedule(f.b);f.scope.chat[1]={};f.flush();assert.deepEqual(f.calls,[]);
    f.scheduler.schedule(f.c);f.scope.chat.shift();f.flush();assert.deepEqual(f.calls,[[f.c]]);
});
test('chat switches and replacement chat arrays discard pending work',()=>{
    for(const change of [f=>f.scope.key='two',f=>f.scope.chat=[f.a,f.b,f.c]]){
        const f=fixture();f.scheduler.schedule(f.a);change(f);f.flush();assert.deepEqual(f.calls,[]);
        f.scheduler.schedule(f.b);f.flush();assert.deepEqual(f.calls,[[f.b]]);
    }
});
test('cancel clears pending batches and continuous requests keep their original deadline',()=>{
    const f=fixture();f.scheduler.schedule(f.a);const timer=[...f.timers.keys()][0];f.scheduler.schedule(f.b);assert.equal([...f.timers.keys()][0],timer);f.scheduler.cancel();f.flush();assert.deepEqual(f.calls,[]);
});