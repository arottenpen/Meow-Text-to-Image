import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
function fixture(){
    const context={identity:(m,b)=>`${m.swipe_id||0}:${b.bodyIndex}:${b.prompt}`,promptIdentity:s=>s.trim(),state:()=>context.record,taskFor:()=>context.task,imageVersions:r=>r?.versions||[],settings:{rerollClicks:2,exportFormat:'png'},favoritesEnabled:()=>false,record:{selected:0,versions:[{url:'/image.png',tagPrompt:'old',profileName:'profile',request:{width:832,height:1216,vibes:[]}}]},task:null};
    vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function cardView('),source.indexOf('function makeCard(')),context);
    const block={start:0,bodyIndex:0,raw:'image###same###',prompt:'same'},message={swipe_id:0};
    return {context,block,message,view:()=>context.cardView(message,block,[block])};
}
test('card signatures invalidate captured handler data even when the image URL is unchanged',()=>{
    for(const change of [f=>f.context.record.versions[0].tagPrompt='new',f=>f.context.record.versions[0].request.vibes.push({id:'fixture'}),f=>f.context.record.versions[0].profileName='new profile',f=>f.message.swipe_id=1,f=>f.block.start=8,f=>f.context.settings.exportFormat='jpg',f=>f.context.settings.rerollClicks=3]){
        const f=fixture(),before=f.view().signature;change(f);assert.notEqual(f.view().signature,before);
    }
});
test('progress changes retain structural signature, versions and duplicate occurrences remain distinct',()=>{
    const f=fixture();f.context.task={status:'queued'};const before=f.view();f.context.task.status='generating';const after=f.view();
    assert.equal(before.signature,after.signature);assert.equal(before.task,after.task);assert.notEqual(before.status,after.status);
    const second={...f.block,start:30,bodyIndex:1};const view=f.context.cardView(f.message,second,[f.block,second]);assert.equal(view.occurrence,1);assert.notEqual(view.signature,after.signature);
    f.context.record.versions.push({url:'/second.png'});f.context.record.selected=1;assert.notEqual(f.view().signature,after.signature);
});