import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createInputSaveQueue} from '../src/ui/input-save-queue.js';
const source=readFileSync(new URL('../src/ui/ui.js',import.meta.url),'utf8');
function fixture(save){
    let now=0,id=0,draft='',calls=[];const timers=new Map(),errors=[];
    const queue=createInputSaveQueue({save:()=>{calls.push(draft);save?.();},onError:e=>errors.push(e),setTimer:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimer:id=>timers.delete(id)});
    const advance=ms=>{const end=now+ms;for(;;){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=end;};
    const input=value=>queue.input(()=>{draft=value;queue.request();});
    return {queue,timers,calls,errors,advance,input,get draft(){return draft;}};
}
test('typing updates the draft immediately and coalesces host saves after the idle interval',()=>{
    const f=fixture();for(let i=0;i<100;i++){f.input('prompt '+i);f.advance(2);}
    assert.equal(f.draft,'prompt 99');assert.deepEqual(f.calls,[]);assert.equal(f.timers.size,2);
    f.advance(300);assert.deepEqual(f.calls,['prompt 99']);assert.equal(f.timers.size,0);
});
test('continuous non-composing input has a bounded persistence delay',()=>{
    const f=fixture();for(let i=0;i<40;i++){f.input(String(i));f.advance(100);}
    assert.equal(f.calls.length,2);f.queue.flush();assert.equal(f.calls.at(-1),'39');assert.equal(f.timers.size,0);
});
test('IME composition cancels pending timers and saves only after composition finishes',()=>{
    const f=fixture();f.input('before');f.queue.compositionStart();
    for(const value of ['n','ni','你好']){f.input(value);f.advance(2000);}
    assert.equal(f.draft,'你好');assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);
    f.queue.compositionEnd();f.advance(299);assert.equal(f.calls.length,0);f.advance(1);assert.deepEqual(f.calls,['你好']);
});
test('blur, save and pagehide flush the latest value without later duplicate work',()=>{
    const f=fixture();f.input('latest');f.queue.flush();f.queue.flush();f.advance(2000);assert.deepEqual(f.calls,['latest']);
    f.input('next');f.queue.request();f.advance(2000);assert.deepEqual(f.calls,['latest','next']);
});
test('closing during composition flushes once and leaves no timer behind',()=>{
    const f=fixture();f.queue.compositionStart();f.input('中文草稿');f.queue.dispose();f.queue.dispose();f.advance(3000);
    assert.deepEqual(f.calls,['中文草稿']);assert.equal(f.timers.size,0);
});
test('a save failure is reported and the unsaved draft remains retryable',()=>{
    let fail=true;const f=fixture(()=>{if(fail)throw Error('save failed');});f.input('draft');f.advance(300);assert.equal(f.errors.length,1);
    fail=false;f.queue.flush();assert.equal(f.calls.length,2);assert.equal(f.timers.size,0);
});
test('real panel text and number fields defer persistence but select changes remain immediate',()=>{
    const f=fixture();
    const node=tag=>({tag,children:[],listeners:{},append(...items){this.children.push(...items);},addEventListener(name,fn){this.listeners[name]=fn;}});
    const context={node,fieldId:0,inputSaves:f.queue,onError:e=>{throw e;}};
    vm.createContext(context);vm.runInContext(source.slice(source.indexOf('    function field('),source.indexOf('    function section(')),context);
    const parent=node('div');let current;
    const text=context.field(parent,'prompt','',value=>{current=value;f.queue.request();});text.value='即时文字';text.listeners.input();assert.equal(current,'即时文字');assert.equal(f.calls.length,0);
    const numeric=context.field(parent,'steps',28,value=>{current=value;f.queue.request();},{type:'number'});numeric.value='32';numeric.listeners.input();assert.equal(current,32);assert.equal(f.calls.length,0);
    const select=context.field(parent,'model','a',value=>{current=value;f.queue.request();},{options:[['a','A'],['b','B']]});select.value='b';select.listeners.change();assert.equal(current,'b');assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
});
test('panel lifecycle listeners flush drafts and detach pagehide handling when closed',()=>{
    const root=new EventTarget(),win=new EventTarget(),timers=new Map();let id=0,saved=0,pagehideListeners=0;
    const add=win.addEventListener.bind(win),remove=win.removeEventListener.bind(win);
    win.addEventListener=(name,fn)=>{if(name==='pagehide')pagehideListeners++;add(name,fn);};
    win.removeEventListener=(name,fn)=>{if(name==='pagehide')pagehideListeners--;remove(name,fn);};
    root.ownerDocument={defaultView:win};root.querySelector=()=>null;
    const context={root,saveSettings:()=>saved++,onError:e=>{throw e;},createInputSaveQueue:options=>createInputSaveQueue({...options,setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:id=>timers.delete(id)})};
    vm.createContext(context);vm.runInContext(source.slice(source.indexOf('    const inputSaves='),source.indexOf('    const versionLabel=')),context);
    const type=()=>vm.runInContext('inputSaves.input(()=>save());',context);
    type();assert.equal(saved,0);root.dispatchEvent(new Event('focusout'));assert.equal(saved,1);
    type();win.dispatchEvent(new Event('pagehide'));assert.equal(saved,2);
    root.dispatchEvent(new Event('compositionstart'));type();assert.equal(timers.size,0);
    root.disposeSettings();assert.equal(saved,3);assert.equal(pagehideListeners,0);assert.equal(timers.size,0);
});
test('repeated input events do not rewrite an already dirty save indicator',()=>{
    const root=new EventTarget();let label='已保存',writes=0;
    const button={disabled:false,get textContent(){return label;},set textContent(value){label=value;writes++;}};
    root.querySelector=()=>button;const context={root,editRevision:0};vm.createContext(context);
    vm.runInContext(source.split('\n').find(line=>line.includes("for(const event of ['input','change'])root.addEventListener")),context);
    for(let i=0;i<100;i++)root.dispatchEvent(new Event('input'));
    assert.equal(label,'保存');assert.equal(writes,1);
});
test('renaming one profile only writes its own gallery labels',()=>{
    let writes=0;const node=()=>({set textContent(_){writes++;},set alt(_){writes++;},setAttribute(){writes++;}});
    const profiles=Array.from({length:100},(_,i)=>({id:String(i),name:'profile '+i}));
    const context={editing:node(),p:profiles[42],multiple:false,settings:{randomProfileIds:[]},views:profiles.map(profile=>({profile,name:node(),image:node(),tile:node(),edit:node()}))};
    const start=source.indexOf('            const paintNames=');const end=source.indexOf('\n            for(const profile of settings.profiles)',start);
    vm.createContext(context);vm.runInContext(source.slice(start,end)+'\npaintNames(p);',context);
    assert.equal(writes,6,'only the editing heading and selected profile labels should change');
});
test('an explicit save consumes pending automatic work without discarding later edits',()=>{
    const f=fixture();f.input('confirmed explicitly');f.queue.cancelPending();f.advance(2000);
    assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);
    f.input('new edit');f.advance(300);assert.deepEqual(f.calls,['new edit']);
    f.queue.dispose();assert.equal(f.calls.length,1);
});
test('input during a disabled save still advances the modification revision',()=>{
    const root=new EventTarget(),button={disabled:true,textContent:'保存中…'},context={root,editRevision:0};
    root.querySelector=()=>button;vm.createContext(context);
    vm.runInContext(source.split('\n').find(line=>line.includes("for(const event of ['input','change'])root.addEventListener")),context);
    root.dispatchEvent(new Event('input'));assert.equal(context.editRevision,1);assert.equal(button.textContent,'保存中…');
});
