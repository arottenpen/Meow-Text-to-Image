import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
const require=createRequire(import.meta.url);

test('image previews complete favorites protection and JPG export without confirmation interference',{timeout:240000},async t=>{
 const {chromium}=require(process.env.MIAO_PLAYWRIGHT_MODULE||`${homedir()}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);
 const server=spawn(process.execPath,['tests/preview-server.mjs'],{env:{...process.env,MIAO_PREVIEW_PORT:'0'},stdio:['ignore','pipe','pipe']});let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('预览启动超时')),10000);server.stdout.on('data',data=>{const match=String(data).match(/http:\/\/[^\s]+/);if(match){clearTimeout(timer);resolve(match[0]);}});server.on('exit',()=>{clearTimeout(timer);reject(Error('预览启动失败'));});});
  browser=await chromium.launch({channel:process.env.MIAO_BROWSER_CHANNEL||'chrome',headless:true});
  await t.test('native observers stop while idle and preserve detached lazy JPG remounts',async()=>{
   const page=await browser.newPage({viewport:{width:1280,height:900}});
   try{
    await page.goto(url+'/?settings-smoke');await page.locator('#miao-nai-menu').waitFor();
    await page.evaluate(async()=>{
     const {createImagePresentation}=await import('/scripts/extensions/third-party/test/src/images/image-presentation.js');
     const state={starts:0,stops:0,callbacks:0,reads:0,urls:[]};let format='jpg';
     class TreeObserver{
      constructor(callback){this.observer=new MutationObserver(records=>{state.callbacks++;callback(records);});}
      observe(...args){state.starts++;this.observer.observe(...args);}
      disconnect(){state.stops++;this.observer.disconnect();}
     }
     const presentation=createImagePresentation({getFormat:()=>format,TreeObserver,fetchImage:async path=>{state.reads++;return path.includes('miao-nai-jpg')?new Response('',{status:404}):fetch('/user/images/miao-nai/miao-1792737847709.png');},saveJPEG:async blob=>{const url=URL.createObjectURL(blob);state.urls.push(url);return url;}});
     const make=(name,top)=>{const image=document.createElement('img');image.style='position:absolute;width:100px;height:100px;left:20px;top:'+top+'px';presentation.bind(image,'/'+name+'.png',{lazy:true});document.body.append(image);return image;};
     window.lazyPreview={state,presentation,make,setFormat:value=>format=value,first:make('lazy-first',30),second:make('lazy-second',4000)};
    });
    await page.waitForFunction(()=>window.lazyPreview.first.dataset.miaoExportState==='ready');
    assert.deepEqual(await page.evaluate(()=>{const s=window.lazyPreview.state;return [s.starts,s.stops];}),[1,0]);
    await page.evaluate(()=>{window.lazyPreview.beforeRemoval=window.lazyPreview.state.callbacks;window.lazyPreview.second.remove();});
    await page.waitForFunction(()=>window.lazyPreview.state.callbacks>window.lazyPreview.beforeRemoval);
    await page.evaluate(()=>{const image=window.lazyPreview.second;image.style.top='150px';document.body.append(image);});
    await page.waitForFunction(()=>window.lazyPreview.second.dataset.miaoExportState==='ready'&&window.lazyPreview.state.stops===1);
    const idle=await page.evaluate(()=>window.lazyPreview.state.callbacks);
    await page.evaluate(async()=>{for(let i=0;i<20;i++){const node=document.createElement('span');document.body.append(node);node.remove();}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    assert.equal(await page.evaluate(()=>window.lazyPreview.state.callbacks),idle);
    await page.evaluate(()=>{window.lazyPreview.third=window.lazyPreview.make('lazy-third',260);});
    await page.waitForFunction(()=>window.lazyPreview.third.dataset.miaoExportState==='ready');
    assert.deepEqual(await page.evaluate(()=>{const s=window.lazyPreview.state;return [s.starts,s.stops];}),[2,2]);
    await page.evaluate(()=>{const f=window.lazyPreview;f.setFormat('png');f.presentation.refresh();for(const url of f.state.urls)URL.revokeObjectURL(url);});
   }finally{await page.close();}
  });
  await t.test('settings smoke does not auto-confirm a manually controlled TT dialog',async()=>{
   const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
   try{
    await page.goto(url+'/?settings-smoke&tt');await page.locator('#miao-nai-menu').click();
    await page.locator('.miao-overview').getByRole('button',{name:'配置',exact:true}).click();
    const count=await page.evaluate(()=>window.preview.settings.profiles.length);
    await page.getByRole('button',{name:'删除配置',exact:true}).click();await page.locator('.miao-confirmation-layer').waitFor();
    await page.evaluate(async()=>{const node=document.createElement('span');document.body.append(node);node.remove();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    assert.equal(await page.locator('.miao-confirmation-layer').count(),1);assert.equal(await page.evaluate(()=>window.preview.settings.profiles.length),count);
    await page.locator('[data-action=cancel]').click();await page.locator('.miao-confirmation-layer').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.preview.settings.profiles.length),count);assert.equal(await page.evaluate(()=>window.preview.calls.length),0);
   }finally{await page.close();}
  });
  for(const tt of [false,true])for(const scenario of ['favorites','export-update'])await t.test(`${tt?'TT':'ST'} ${scenario}`,async()=>{
   const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   try{
    await page.goto(`${url}/?${scenario}${tt?'&tt':''}`);
    const complete=scenario==='favorites'?'收藏界面没有横向溢出':'实际删除并刷新图库后保持原始位置';
    await page.waitForFunction(label=>{const report=document.getElementById('report').textContent;return report.includes('FAIL ')||report.includes('PASS '+label);},complete,{timeout:50000});
    const report=await page.locator('#report').textContent();
    assert.equal(report.includes('FAIL '),false,report);assert.ok(report.includes('PASS '+complete),report);assert.deepEqual(errors,[]);
   }finally{await page.close();}
  });
 }finally{await browser?.close();server.kill();}
});
