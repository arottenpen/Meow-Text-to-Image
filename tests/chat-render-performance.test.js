import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
const require=createRequire(import.meta.url);
test('unchanged and duplicate chat cards retain nodes and handlers while edits and swipes invalidate bindings',{timeout:90000},async()=>{
    const {chromium}=require(process.env.MIAO_PLAYWRIGHT_MODULE||`${homedir()}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);
    const server=spawn(process.execPath,['tests/preview-server.mjs'],{env:{...process.env,MIAO_PREVIEW_PORT:'0'},stdio:['ignore','pipe','pipe']});let browser;
    try{
        const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('preview timeout')),10000);server.stdout.on('data',data=>{const match=String(data).match(/http:\/\/[^\s]+/);if(match){clearTimeout(timer);resolve(match[0]);}});server.on('exit',()=>{clearTimeout(timer);reject(Error('preview exited'));});});
        browser=await chromium.launch({channel:process.env.MIAO_BROWSER_CHANNEL||'chrome',headless:true});
        const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(url+'/?settings-smoke');await page.locator('#miao-nai-menu').waitFor();
        await page.evaluate(async()=>{
            const p=window.preview;Object.assign(p.settings,{mode:'manual',eggProfileEnabled:false,exportFormat:'png'});
            p.chat.splice(0,p.chat.length,{name:'fixture',mes:'image###same### image###same###'});
            document.getElementById('chat').innerHTML='<div class="mes" mesid="0"><div class="mes_text">image###same### image###same###</div></div>';
            await p.emit('CHAT_CHANGED');
        });
        await page.waitForFunction(()=>document.querySelectorAll('.miao-image-card').length===2);
        await page.waitForTimeout(150);
        await page.evaluate(async()=>{
            window.originalCards=[...document.querySelectorAll('.miao-image-card')];
            window.originalControls=window.originalCards.map(c=>[...c.querySelectorAll('button')]);
            const create=document.createElement.bind(document);window.createdElements=0;
            document.createElement=(...args)=>{window.createdElements++;return create(...args);};
            await window.preview.emit('MESSAGE_UPDATED',0);
        });
        await page.waitForTimeout(150);
        assert.deepEqual(await page.evaluate(()=>({created:window.createdElements,same:[...document.querySelectorAll('.miao-image-card')].every((c,i)=>c===window.originalCards[i]&&window.originalControls[i].every(b=>c.contains(b))),occurrences:window.originalCards.map(c=>c.dataset.miaoOccurrence)})),{created:0,same:true,occurrences:['0','1']});
        await page.evaluate(async()=>{
            window.preview.chat[0]={name:'replacement',mes:'image###same### image###same###'};
            await window.preview.emit('MESSAGE_UPDATED',0);
        });
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.miao-image-card')].every((c,i)=>c!==window.originalCards[i])),true);
        await page.evaluate(async()=>{
            const m=window.preview.chat[0];m.swipe_id=1;m.mes='image###changed###';m.swipes=['image###same### image###same###',m.mes];
            document.querySelector('.mes_text').textContent=m.mes;
            await window.preview.emit('MESSAGE_SWIPED',0);
        });
        await page.waitForFunction(()=>document.querySelectorAll('.miao-image-card').length===1&&document.querySelector('.miao-image-card').dataset.miaoPrompt==='changed');
        assert.equal(await page.locator('.miao-image-card').getAttribute('data-miao-occurrence'),'0');
        assert.match(await page.locator('.miao-image-card').getAttribute('data-miao-key'),/^1:/);
        // Count historical source reads, not just mutations: a redundant full
        // scan can leave the same DOM intact and still be expensive.
        await page.evaluate(async()=>{
            const p=window.preview;window.sourceReads=Array(41).fill(0);
            p.chat.splice(0,p.chat.length,...Array.from({length:41},(_,i)=>({name:'fixture '+i,mes:i===40?'reply':'image###scene '+i+'###'})));
            document.getElementById('chat').innerHTML=p.chat.map((m,i)=>`<div class="mes" mesid="${i}"><div class="mes_text">${m.mes}</div></div>`).join('');
            await p.emit('CHAT_CHANGED');
        });
        await page.waitForFunction(()=>document.querySelectorAll('.miao-image-card').length===40);await page.waitForTimeout(150);
        await page.evaluate(async()=>{
            window.preview.chat.forEach((m,i)=>{let text=m.mes;Object.defineProperty(m,'mes',{configurable:true,get(){window.sourceReads[i]++;return text;},set(value){text=value;}});});
            await window.preview.emit('MESSAGE_UPDATED',17);
        });
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(()=>window.sourceReads.filter((_,i)=>i!==17).reduce((a,b)=>a+b,0)),0,'local host event must not read other floors');
        await page.evaluate(()=>{window.sourceReads.fill(0);document.querySelector('[mesid="23"] .mes_text').append(document.createTextNode('edited'));});
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(()=>window.sourceReads.filter((_,i)=>i!==23).reduce((a,b)=>a+b,0)),0,'observer must route a local text mutation only to that floor');
        await page.evaluate(async()=>{
            window.sourceReads.fill(0);await window.preview.emit('GENERATION_STARTED','normal',{});
            for(let i=0;i<100;i++){window.preview.chat[40].mes='reply '+i;document.querySelector('[mesid="40"] .mes_text').textContent='reply '+i;await window.preview.emit('STREAM_TOKEN_RECEIVED');}
        });
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(()=>window.sourceReads.reduce((a,b)=>a+b,0)),0,'manual start and stream must not parse history or the reply');
        await page.evaluate(async()=>{window.preview.chat[40].mes='image###final###';document.querySelector('[mesid="40"] .mes_text').textContent='image###final###';await window.preview.emit('GENERATION_ENDED');});
        await page.locator('[mesid="40"] .miao-image-card').waitFor();
        assert.equal(await page.evaluate(()=>window.sourceReads.slice(0,40).reduce((a,b)=>a+b,0)),0,'finalization only reads the completed reply');
        assert.deepEqual(errors,[]);
    }finally{await browser?.close();server.kill();}
});