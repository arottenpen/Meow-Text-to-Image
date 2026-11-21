import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
const require=createRequire(import.meta.url);

test('non-stream replies avoid observer callbacks while host edits, root replacement and finalization still work',{timeout:120000},async()=>{
    const {chromium}=require(process.env.MIAO_PLAYWRIGHT_MODULE||`${homedir()}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);
    const server=spawn(process.execPath,['tests/preview-server.mjs'],{env:{...process.env,MIAO_PREVIEW_PORT:'0'},stdio:['ignore','pipe','pipe']});let browser;
    try{
        const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('preview timeout')),10000);server.stdout.on('data',data=>{const match=String(data).match(/http:\/\/[^\s]+/);if(match){clearTimeout(timer);resolve(match[0]);}});server.on('exit',()=>{clearTimeout(timer);reject(Error('preview exited'));});});
        browser=await chromium.launch({channel:process.env.MIAO_BROWSER_CHANNEL||'chrome',headless:true});
        for(const tt of [false,true])for(const mode of ['manual','auto']){
            const page=await browser.newPage(),errors=[],label=(tt?'TT ':'ST ')+mode;page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
            await page.addInitScript(()=>{
                const NativeObserver=window.MutationObserver;window.chatMutationCallbacks=0;window.chatObserverNames=[];
                window.MutationObserver=class extends NativeObserver{
                    constructor(callback){
                        const tracked=['handleChatMutations','handleChatRootMutations'].includes(callback.name);
                        super((records,observer)=>{
                            if(tracked&&records.some(record=>(record.target.nodeType===1?record.target:record.target.parentElement)?.closest?.('#chat')))window.chatMutationCallbacks++;
                            callback(records,observer);
                        });
                        if(tracked)window.chatObserverNames.push(callback.name);
                    }
                };
            });
            await page.goto(url+'/?settings-smoke'+(tt?'&tt':''));await page.locator('#miao-nai-menu').waitFor();
            if(tt){
                await page.locator('#miao-nai-menu').click();await page.locator('.miao-overview').getByRole('button',{name:'生成',exact:true}).click();
                await page.getByLabel('API Key',{exact:true}).fill('fixture-observer-key-not-real');await page.getByRole('button',{name:'保存密钥',exact:true}).click();
                await page.waitForFunction(()=>!!window.preview.settings.keyHash);await page.getByRole('button',{name:'关闭设置',exact:true}).click();
            }
            await page.evaluate(async mode=>{
                const p=window.preview;Object.assign(p.settings,{mode,enabled:true,cloudQueue:false,eggProfileEnabled:false});
                for(const profile of p.settings.profiles){profile.vibeEnabled=false;profile.vibes=[];}
                p.chat.splice(0,p.chat.length,{name:'History fixture',mes:'image###history###'},{name:'Reply fixture',mes:'reply'});
                const chat=document.getElementById('chat'),wrapper=document.createElement('section');wrapper.id='chat-fixture-parent';chat.replaceWith(wrapper);wrapper.append(chat);
                chat.innerHTML=p.chat.map((m,i)=>`<div class="mes" mesid="${i}"><div class="mes_text">${m.mes}</div></div>`).join('');
                await p.emit('CHAT_CHANGED');
                window.pumpReply=async()=>{
                    window.chatMutationCallbacks=0;
                    for(let i=0;i<100;i++){
                        p.chat[1].mes='reply '+i;const root=document.querySelector('[mesid="1"] .mes_text');
                        if(i%3===0)root.innerHTML='<em>reply</em> '+i;
                        else if(i%3===1)root.textContent='reply '+i;
                        else root.firstChild.data='reply '+i;
                        await new Promise(resolve=>setTimeout(resolve,2));
                    }
                    await new Promise(resolve=>setTimeout(resolve,100));return window.chatMutationCallbacks;
                };
            },mode);
            await page.locator('[mesid="0"] .miao-image-card').waitFor();await page.waitForTimeout(150);
            assert.deepEqual(await page.evaluate(()=>window.chatObserverNames.sort()),['handleChatMutations','handleChatRootMutations'].sort(),label+' instruments both chat observers');
            await page.evaluate(()=>window.preview.emit('GENERATION_STARTED','normal',{}));
            assert.equal(await page.evaluate(()=>window.pumpReply()),0,label+' has zero callbacks from either chat observer during 100 reply mutations');
            assert.equal(await page.evaluate(()=>window.preview.calls.length),0,label+' does not generate mid-reply');
            // A historical edit triggers a card render, whose finally block must
            // retain shallow observation while the current reply is still active.
            await page.evaluate(async()=>{const p=window.preview;p.chat[0].mes='image###edited history###';document.querySelector('[mesid="0"] .mes_text').textContent=p.chat[0].mes;await p.emit('MESSAGE_EDITED',0);});
            await page.waitForFunction(()=>document.querySelector('[mesid="0"] .miao-image-card')?.dataset.miaoPrompt==='edited history');
            assert.equal(await page.evaluate(()=>window.pumpReply()),0,label+' stays shallow after historical card rendering');
            // Replace an ancestor without any host event; root tracking must
            // reconnect and refresh history without resubscribing to reply text.
            await page.evaluate(()=>{
                const old=document.getElementById('chat-fixture-parent'),replacement=old.cloneNode(true);window.preview.chat[0].mes='image###remounted history###';
                replacement.querySelector('[mesid="0"] .mes_text').textContent=window.preview.chat[0].mes;old.replaceWith(replacement);
            });
            await page.waitForFunction(()=>document.querySelector('[mesid="0"] .miao-image-card')?.dataset.miaoPrompt==='remounted history');
            assert.equal(await page.evaluate(()=>window.pumpReply()),0,label+' stays shallow after chat root replacement');
            // Move the same root into an existing sibling, then remount it after
            // an asynchronous gap. Both changes must update the watched ancestors.
            await page.evaluate(async()=>{
                const parent=document.getElementById('chat-fixture-parent'),sibling=document.createElement('section');parent.after(sibling);
                await new Promise(resolve=>setTimeout(resolve,150));sibling.append(document.getElementById('chat'));
                await new Promise(resolve=>setTimeout(resolve,150));
                const chat=document.getElementById('chat');chat.remove();await new Promise(resolve=>setTimeout(resolve,150));
                window.preview.chat[0].mes='image###mounted again###';chat.querySelector('[mesid="0"] .mes_text').textContent=window.preview.chat[0].mes;sibling.append(chat);
            });
            await page.waitForFunction(()=>document.querySelector('[mesid="0"] .miao-image-card')?.dataset.miaoPrompt==='mounted again');
            assert.equal(await page.evaluate(()=>window.pumpReply()),0,label+' stays shallow after moving and remounting the root');
            await page.evaluate(async()=>{const p=window.preview;p.chat[1].mes='image###final reply###';document.querySelector('[mesid="1"] .mes_text').textContent=p.chat[1].mes;await p.emit('GENERATION_ENDED');});
            await page.locator('[mesid="1"] .miao-image-card').waitFor();
            if(mode==='auto')await page.waitForFunction(()=>window.preview.calls.length===1).catch(async error=>{
                const state=await page.evaluate(()=>({mode:window.preview.settings.mode,calls:window.preview.calls.map(call=>call.prompt),notices:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)}));
                throw Error(label+' finalization: '+JSON.stringify(state),{cause:error});
            });
            else assert.equal(await page.evaluate(()=>window.preview.calls.length),0);
            await page.waitForTimeout(150);
            await page.evaluate(()=>{window.chatMutationCallbacks=0;window.preview.chat[0].mes='image###idle edit###';document.querySelector('[mesid="0"] .mes_text').textContent=window.preview.chat[0].mes;});
            await page.waitForFunction(()=>document.querySelector('[mesid="0"] .miao-image-card')?.dataset.miaoPrompt==='idle edit');
            assert.ok(await page.evaluate(()=>window.chatMutationCallbacks)>0,label+' restores idle DOM observation');
            for(const event of ['GENERATION_STOPPED','CHARACTER_MESSAGE_RENDERED','MESSAGE_SWIPED','CHAT_CHANGED']){
                await page.evaluate(async event=>{
                    const p=window.preview;await p.emit('GENERATION_STARTED','normal',{});p.chat[1].mes='image###'+event+'###';document.querySelector('[mesid="1"] .mes_text').textContent=p.chat[1].mes;await p.emit(event,1);
                },event);
                await page.waitForFunction(prompt=>document.querySelector('[mesid="1"] .miao-image-card')?.dataset.miaoPrompt===prompt,event);
                await page.waitForTimeout(150);
                await page.evaluate(event=>{window.preview.chat[0].mes='image###idle '+event+'###';document.querySelector('[mesid="0"] .mes_text').textContent=window.preview.chat[0].mes;},event);
                await page.waitForFunction(prompt=>document.querySelector('[mesid="0"] .miao-image-card')?.dataset.miaoPrompt==='idle '+prompt,event);
            }
            // The settings callback also renders cards; switching during a reply
            // must immediately apply the new observation scope without ending it.
            await page.evaluate(()=>window.preview.emit('GENERATION_STARTED','normal',{}));
            await page.locator('#miao-nai-menu').click();
            await page.locator('.miao-overview').getByRole('button',{name:'生成',exact:true}).click();
            for(const next of ['stream','manual','auto']){
                await page.getByRole('combobox',{name:/^生成模式/}).selectOption(next);await page.waitForTimeout(150);
                const callbacks=await page.evaluate(()=>window.pumpReply());
                if(next==='stream')assert.ok(callbacks>0,label+' enables deep observation in stream mode');
                else assert.equal(callbacks,0,label+' switches observation to '+next+' during generation');
            }
            await page.getByRole('button',{name:'关闭设置',exact:true}).click();
            await page.evaluate(()=>window.preview.emit('GENERATION_ENDED'));
            assert.deepEqual(errors,[],label);await page.close();
        }
    }finally{await browser?.close();server.kill();}
});
