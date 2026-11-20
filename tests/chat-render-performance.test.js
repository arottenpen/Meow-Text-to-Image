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
        assert.deepEqual(errors,[]);
    }finally{await browser?.close();server.kill();}
});