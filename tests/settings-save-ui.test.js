import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);

test('settings acknowledgement, concurrent editing and preview progress stay accurate on ST and TT',{timeout:90000},async()=>{
    const {chromium}=require(process.env.MIAO_PLAYWRIGHT_MODULE||`${homedir()}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);
    const server=spawn(process.execPath,['tests/preview-server.mjs'],{env:{...process.env,MIAO_PREVIEW_PORT:'0'},stdio:['ignore','pipe','pipe']});let browser;
    try{
        const url=await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('隔离预览启动超时')),10000);
            server.stdout.on('data',data=>{const match=String(data).match(/http:\/\/[^\s]+/);if(match){clearTimeout(timer);resolve(match[0]);}});
            server.on('exit',()=>{clearTimeout(timer);reject(Error('隔离预览启动失败'));});
        });
        browser=await chromium.launch({channel:process.env.MIAO_BROWSER_CHANNEL||'chrome',headless:true});
        for(const tt of [false,true]){
            const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
            page.on('pageerror',error=>errors.push(error.message));
            await page.goto(url+'/?settings-smoke&samples-archives'+(tt?'&tt':''));await page.locator('#miao-nai-menu').waitFor();
            await page.evaluate(()=>{const s=window.preview.settings;s.cloudQueue=false;s.samplePrompt='adult cat, flowers';for(const p of s.profiles){p.vibeEnabled=false;p.vibes=[];}});
            await page.locator('#miao-nai-menu').click();
            await page.locator('.miao-overview').getByRole('button',{name:'生成',exact:true}).click();
            await page.getByLabel('API Key',{exact:true}).fill('fixture-save-progress-key');
            await page.getByRole('button',{name:'保存密钥',exact:true}).click();
            await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent==='Key 已就绪');
            await page.locator('.miao-tabs').getByRole('button',{name:'配置',exact:true}).click();
            await page.evaluate(async()=>{
                const {sampleSignature}=await import('/scripts/extensions/third-party/test/src/profiles/profile-previews.js');
                const p=window.preview,s=p.settings,profile=s.profiles[s.active];
                profile.preview={url:'/fixture-image/square.svg',signature:sampleSignature(profile,s.vibeLibrary,s.samplePrompt)};
                p.holdSettingsSave=true;p.autoSaves=0;
                const original=p.context.saveSettingsDebounced;
                p.context.saveSettingsDebounced=function(...args){p.autoSaves++;return original.apply(this,args);};
            });
            const save=page.locator('.miao-save-button'),name=page.getByLabel('配置名称',{exact:true});
            const waitForSave=()=>page.waitForFunction(()=>typeof window.preview.releaseSettingsSave==='function');
            const releaseSave=()=>page.evaluate(()=>{const p=window.preview,release=p.releaseSettingsSave;delete p.releaseSettingsSave;release();});
            await name.fill('fixture saved name');await save.click();await waitForSave();
            assert.equal(await save.isDisabled(),true);assert.equal(await save.textContent(),'保存中…');
            await page.waitForTimeout(400);
            assert.equal(await page.evaluate(()=>window.preview.autoSaves),0,'the explicit write replaces pending input and blur writes');
            if(!tt)await page.waitForFunction(()=>document.querySelector('.miao-save-button').textContent==='等待确认…');
            await releaseSave();await page.waitForFunction(()=>document.querySelector('.miao-save-button').textContent==='已保存');
            assert.equal(await page.evaluate(()=>window.preview.calls.length),0,'unchanged examples must not regenerate');

            await name.fill('fixture first revision');await save.click();await waitForSave();
            await name.fill('fixture newer revision');await releaseSave();
            await page.waitForFunction(()=>document.querySelector('.miao-save-button').textContent==='有新修改');
            assert.equal(await save.isDisabled(),false,'new edits remain explicitly saveable');
            await save.click();await waitForSave();
            await page.locator('.miao-tabs').getByRole('button',{name:'Vibe',exact:true}).click();
            assert.equal(await save.isDisabled(),true);await releaseSave();
            await page.waitForFunction(()=>!document.querySelector('.miao-save-button').disabled);
            assert.equal(await save.textContent(),'保存','an earlier page save cannot certify the newly rendered page');

            const previousSaves=await page.evaluate(()=>window.preview.settingsSaves||0);
            await save.click();await waitForSave();
            await page.getByRole('button',{name:'关闭设置',exact:true}).click();
            await page.locator('#miao-nai-menu').click();
            await page.locator('.miao-overview').getByRole('button',{name:'Vibe',exact:true}).click();
            assert.equal(await save.textContent(),'保存');assert.equal(await save.isDisabled(),false);
            await releaseSave();await page.waitForFunction(before=>window.preview.settingsSaves>before,previousSaves);
            assert.equal(await save.textContent(),'保存','a disposed panel cannot update its replacement');

            await page.evaluate(()=>{window.preview.holdSettingsSave=false;window.preview.failSettingsSave=true;});
            await save.click();await page.waitForFunction(()=>document.querySelector('.miao-save-button').textContent==='保存失败，重试');
            if(!tt)await page.getByRole('button',{name:'完成',exact:true}).click();
            await page.evaluate(()=>window.preview.failSettingsSave=false);await save.click();
            await page.waitForFunction(()=>document.querySelector('.miao-save-button').textContent==='已保存');

            await page.locator('.miao-tabs').getByRole('button',{name:'配置',exact:true}).click();
            await page.evaluate(()=>{
                const p=window.preview,canvas=document.createElement('canvas');canvas.width=canvas.height=512;
                const context=canvas.getContext('2d');context.fillStyle='#647e9a';context.fillRect(0,0,512,512);
                p.generatedImageData=canvas.toDataURL('image/png').split(',')[1];
                p.holdSettingsSave=true;p.holdImage=true;delete p.releaseSettingsSave;
            });
            await page.getByRole('button',{name:'刷新例图',exact:true}).click();
            await page.waitForFunction(()=>typeof window.preview.releaseImage==='function');
            assert.equal(await page.evaluate(()=>typeof window.preview.releaseSettingsSave),'undefined','generation starts without waiting for settings persistence');
            await page.locator('.miao-profile-samples button').first().evaluate(button=>{button.click();button.click();});
            assert.equal(await page.evaluate(()=>window.preview.calls.length),1,'duplicate refresh clicks never submit another generation');
            await page.evaluate(()=>{window.preview.holdImage=false;window.preview.releaseImage();});await waitForSave();
            await page.waitForFunction(()=>[...document.querySelectorAll('.miao-sample-status')].some(n=>n.textContent==='例图已生成，保存中…'));
            assert.ok(await page.evaluate(()=>window.preview.settings.profiles[window.preview.settings.active].preview.url.includes('sample-')));
            await page.waitForFunction(()=>{const image=document.querySelector('.miao-sample-card[data-editing=true] img');return image&&!image.hidden&&image.complete&&image.naturalWidth>0;});
            await mkdir('docs/local',{recursive:true});
            for(const width of [320,1280]){
                await page.setViewportSize({width,height:900});
                const overflow=await page.locator('.miao-panel-body').evaluate(n=>n.scrollWidth-n.clientWidth);assert.ok(overflow<=1);
                await page.screenshot({path:`docs/local/settings-save-${tt?'tt':'st'}-${width}.png`});
            }
            await releaseSave();await page.waitForFunction(()=>[...document.querySelectorAll('.miao-profile-samples button')].some(b=>b.textContent==='刷新例图'&&!b.disabled));
            assert.deepEqual(errors,[]);await page.close();
        }
    }finally{if(browser)await browser.close();server.kill('SIGTERM');}
});
