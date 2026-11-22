import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
const require=createRequire(import.meta.url);

test('fresh chat images bypass blocked file reads, slow queue finish and chat saves on ST and TT',{timeout:120000},async()=>{
 const {chromium}=require(process.env.MIAO_PLAYWRIGHT_MODULE||`${homedir()}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);
 const server=spawn(process.execPath,['tests/preview-server.mjs'],{env:{...process.env,MIAO_PREVIEW_PORT:'0'},stdio:['ignore','pipe','pipe']});let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('预览启动超时')),10000);server.stdout.on('data',data=>{const match=String(data).match(/http:\/\/[^\s]+/);if(match){clearTimeout(timer);resolve(match[0]);}});server.on('exit',()=>{clearTimeout(timer);reject(Error('预览启动失败'));});});
  browser=await chromium.launch({channel:process.env.MIAO_BROWSER_CHANNEL||'chrome',headless:true});
  for(const tt of [false,true])for(const format of ['png','jpg'])for(const stalledDecode of [false,true]){
   const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
   try{
    await page.goto(url+'/?settings-smoke&manual-delete&samples-archives'+(tt?'&tt':''));await page.locator('#miao-nai-menu').waitFor();
    await page.locator('#miao-nai-menu').click();await page.locator('.miao-overview').getByRole('button',{name:'生成',exact:true}).click();
    await page.locator('.miao-settings input[type=password]').fill('fixture-delivery-key-not-real');await page.getByRole('button',{name:'保存密钥',exact:true}).click();
    await page.waitForFunction(()=>!!window.preview.settings.keyHash);await page.getByRole('button',{name:'关闭设置',exact:true}).click();
    await page.evaluate(async format=>{
     const p=window.preview;Object.assign(p.settings,{enabled:true,mode:'manual',cloudQueue:true,queueUrl:'https://queue.test',exportFormat:format,eggProfileEnabled:false});
     for(const profile of p.settings.profiles){profile.vibeEnabled=false;profile.vibes=[];}
     p.chat.splice(0,p.chat.length,{name:'Delivery fixture',mes:'image###delivery scene###'});
     document.getElementById('chat').innerHTML='<div class="mes" mesid="0"><div class="mes_text">image###delivery scene###</div></div>';
     p.generatedImageData='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
     // Hold acknowledgement delivery after the real queue RPC, so a timed-out
     // fetch cannot leave this fixture waiting for an already-aborted request.
     const queueFinishGate=new Promise(resolve=>p.releaseQueueFinish=resolve),fetchQueue=window.fetch;
     p.imageSaveGate=new Promise(resolve=>p.releaseImageSave=resolve);p.generatedSourceReads=0;
     p.chatDecodeGate=new Promise(resolve=>p.releaseChatDecode=resolve);
      const nativeDecode=HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode=async function(){
       if(this.closest('.miao-image-card')&&this.dataset.miaoOriginalUrl){p.chatDecodeStarted=true;await p.chatDecodeGate;}
       return nativeDecode.call(this);
      };
      p.slowSave=true;window.fetch=async(url,options)=>{
       if(String(url)==='/fixture-image-save'&&JSON.parse(options.body).folder===p.settings.folder){p.imageSaveStarted=true;await p.imageSaveGate;}
       if((p.imageWrites||[]).some(item=>item.folder===p.settings.folder&&String(url)==='/user/images/'+item.folder+'/'+item.name))p.generatedSourceReads++;
       if(String(url)==='https://queue.test/finish'){
       p.finishBody=JSON.parse(options.body);p.finishStarted=true;
       const response=await fetchQueue(url,options);p.finishResponseReceived=response.ok;
       await queueFinishGate;p.finishAcknowledged=true;return response;
      }
      return fetchQueue(url,options);
     };
     await p.emit('CHAT_CHANGED');await p.emit('CHARACTER_MESSAGE_RENDERED',0);
    },format);
    // A saved-image GET never completes in this fixture. New display must use local bytes.
    const fileReads=[];await page.route('**/user/images/**',route=>{fileReads.push(route.request().url());});
    await page.locator('.miao-image-card').getByRole('button',{name:'生成插图',exact:true}).click();
    await page.waitForFunction(()=>!!window.preview.finishStarted);
    await page.waitForFunction(()=>!!window.preview.imageSaveStarted);
    assert.equal(await page.locator('.miao-image-progress').textContent(),'已生成，保存图片中');
    await page.evaluate(()=>window.preview.releaseImageSave());
    await page.waitForFunction(()=>window.preview.chatDecodeStarted===true);
    const loading=await page.evaluate(()=>{
     const image=document.querySelector('.miao-image-card>img');
     return {complete:image.complete,width:image.naturalWidth,visibility:getComputedStyle(image).visibility,state:image.dataset.miaoLoadState,loading:image.loading,priority:image.fetchPriority,thumbnailWrites:(window.preview.imageWrites||[]).filter(item=>item.folder==='miao-nai-thumbnails').length};
    });
    assert.equal(loading.complete,true);assert.ok(loading.width>0);assert.equal(loading.state,'loading');assert.equal(loading.visibility,'hidden');
    assert.equal(loading.loading,'eager');assert.equal(loading.priority,'high');assert.equal(loading.thumbnailWrites,0,'thumbnail work must yield to foreground decoding');
    assert.equal(await page.locator('.miao-image-load-status').textContent(),'解码图片中');
    assert.equal(await page.evaluate(()=>window.preview.generatedSourceReads),0,'fresh display must not fetch its PNG again before decoding');
    if(!stalledDecode)await page.evaluate(()=>window.preview.releaseChatDecode());
    await page.waitForFunction(()=>{const image=document.querySelector('.miao-image-card>img');return image?.complete&&image.naturalWidth>0&&image.dataset.miaoLoadState==='ready'&&getComputedStyle(image).visibility==='visible';});
    assert.equal(await page.locator('.miao-image-load-status').isVisible(),false);
    if(stalledDecode)assert.equal(await page.locator('.miao-image-card>img').getAttribute('data-miao-decode-fallback'),'true');
     const result=await page.evaluate(()=>{
      const p=window.preview,image=document.querySelector('.miao-image-card>img'),record=p.chat[0].miao_nai_image_swipes[0]['body:0:delivery scene'];
      return {posts:p.calls.length,finishAcknowledged:!!p.finishAcknowledged,outcome:p.finishBody.outcome,savePending:!!p.releaseSave,progress:!!document.querySelector('.miao-image-progress'),src:image.getAttribute('src'),original:record.url,files:p.imageWrites.map(item=>item.folder),generatedSourceReads:p.generatedSourceReads};
     });
     assert.deepEqual(result.files,format==='png'?['miao-nai']:['miao-nai','miao-nai-jpg']);
     assert.equal(result.generatedSourceReads,0,'delivery does not refetch the generated PNG for a thumbnail');
    assert.equal(result.posts,1);assert.equal(result.finishAcknowledged,false);assert.equal(result.outcome,'success');assert.equal(result.savePending,true);assert.equal(result.progress,false);
    assert.ok(result.src.startsWith('blob:'));assert.ok(result.original.endsWith('.png'),'chat archives retain the original PNG');
    assert.equal(await page.locator('.miao-image-card>img').getAttribute('data-miao-read-source'),'memory');
    assert.equal(await page.evaluate(async()=>{const image=document.querySelector('.miao-image-card>img');return (await (await fetch(image.src)).blob()).type;}),format==='jpg'?'image/jpeg':'image/png');
    assert.deepEqual(fileReads,[],'neither PNG nor JPG display may re-download a freshly saved image');
    await page.evaluate(()=>window.preview.releaseSave());
    await page.waitForFunction(()=>window.miaoTestToasts.some(toast=>toast.type==='success'&&toast.message==='生图完成'));
    assert.equal(await page.evaluate(()=>!!window.preview.finishAcknowledged),false,'completion must not require queue acknowledgement');
    await page.waitForFunction(()=>window.preview.finishResponseReceived===true);
    await page.evaluate(()=>window.preview.releaseQueueFinish());
    await page.waitForFunction(()=>window.preview.finishAcknowledged===true);
    assert.equal(await page.evaluate(()=>window.preview.calls.length),1);
    assert.deepEqual(await page.evaluate(()=>window.preview.imageWrites.map(item=>item.folder)),result.files,'settled tasks do not write a background thumbnail');
    assert.equal(await page.evaluate(()=>window.preview.generatedSourceReads),0);
    assert.deepEqual(errors,[]);
   }finally{
    await page.evaluate(()=>{window.preview?.releaseImageSave?.();window.preview?.releaseChatDecode?.();window.preview?.releaseQueueFinish?.();window.preview?.releaseSave?.();}).catch(()=>{});await page.close();
   }
  }
 }finally{await browser?.close();server.kill();}
});
