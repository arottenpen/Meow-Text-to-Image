import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {persistHostSettings,createSettingsPersistence} from '../src/platform/settings-save.js';
test('save waits for host confirmation and releases its listener',async()=>{
    const source=new EventEmitter();let completed=false;
    await persistHostSettings({source,event:'saved',saveNow:async()=>{await Promise.resolve();source.emit('saved');completed=true;}});
    assert.ok(completed);assert.equal(source.listenerCount('saved'),0);
});
test('a swallowed host error never reports a successful save',async()=>{
    const source=new EventEmitter();
    for(const saveNow of [async()=>{},async()=>false,async()=>{throw Error('offline');}]){
        await assert.rejects(persistHostSettings({source,event:'saved',saveNow}));
        assert.equal(source.listenerCount('saved'),0);
    }
});

test('concurrent explicit saves receive separate confirmations and failure does not block retries',async()=>{
    const source=new EventEmitter(),releases=[];let writes=0,cancelled=0,fail=false;
    const persist=createSettingsPersistence({source,event:'saved',cancelPending:()=>cancelled++,saveNow:async()=>{
        writes++;await new Promise(resolve=>releases.push(resolve));
        if(fail)return false;source.emit('saved');
    }});
    const first=persist(),second=persist();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(writes,1);assert.equal(cancelled,1);assert.equal(source.listenerCount('saved'),1);
    releases.shift()();await first;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(writes,2);assert.equal(cancelled,2);assert.equal(source.listenerCount('saved'),1);
    fail=true;releases.shift()();await assert.rejects(second,/保存失败/);
    assert.equal(source.listenerCount('saved'),0);
    fail=false;const retry=persist();await new Promise(resolve=>setImmediate(resolve));
    releases.shift()();await retry;assert.equal(writes,3);assert.equal(source.listenerCount('saved'),0);
});
