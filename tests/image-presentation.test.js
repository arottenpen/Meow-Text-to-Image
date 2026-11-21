import test from 'node:test';
import assert from 'node:assert/strict';
import {createImagePresentation,JPEG_FOLDER} from '../src/images/image-presentation.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const png=new Blob(['original PNG + prompt metadata'],{type:'image/png'}),jpg=new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'});
const image=()=>({dataset:{},alt:'original',removeAttribute(name){delete this[name];}});
function fixture(options={}){
 const files=new Map([['/original.png',png],['/second.png',png]]),reads=[],writes=[];let format='jpg';
 const presentation=createImagePresentation({getFormat:()=>format,base:()=> 'https://tavern.test/',Observer:null,fetchImage:async url=>{reads.push(url);return files.has(url)?new Response(files.get(url)):new Response('',{status:404});},saveJPEG:async(blob,folder,name)=>{const url=`/user/images/${folder}/${name}.jpg`;files.set(url,blob);writes.push({url,blob});return url;},convert:async()=>({blob:jpg}),...options});
 return {presentation,files,reads,writes,setFormat:value=>format=value};
}
test('JPG image sources and exports use a persisted JPEG while PNG export retains the original bytes',async()=>{
 const f=fixture(),element=image();f.presentation.bind(element,'/original.png');assert.equal(element.src,undefined);assert.equal(element.dataset.miaoExportState,'loading');
 const url=await f.presentation.jpeg('/original.png');await tick();assert.equal(element.src,url);assert.match(url,new RegExp(`/user/images/${JPEG_FOLDER}/.*\\.jpg$`));assert.equal(f.writes.length,1);
 const exported=await f.presentation.file({url:'/original.png',name:'original.png'},'jpg');assert.equal(exported.name,'original.jpg');assert.deepEqual(new Uint8Array(await exported.blob.arrayBuffer()),new Uint8Array(await jpg.arrayBuffer()));
 f.setFormat('png');f.presentation.bind(element,'/original.png');assert.equal(element.src,'/original.png');const original=await f.presentation.file({url:'/original.png',name:'original.png'},'png');assert.equal(await original.blob.text(),await png.text());assert.equal(f.writes.length,1);
});
test('switching to PNG or another image while conversion runs cannot apply an old JPEG result',async()=>{
 let release;const f=fixture({convert:async()=>{await new Promise(resolve=>release=resolve);return {blob:jpg};}}),element=image();f.presentation.bind(element,'/original.png');while(!release)await tick();
 f.setFormat('png');f.presentation.bind(element,'/second.png');release();await f.presentation.jpeg('/original.png');await tick();assert.equal(element.src,'/second.png');assert.equal(element.dataset.miaoOriginalUrl,'/second.png');
});
test('conversion failure never falls back to exposing the original PNG in JPG mode',async()=>{
 const errors=[],f=fixture({convert:async()=>{throw Error('encoding failed');},onError:error=>errors.push(error)}),element=image();element.src='/original.png';f.presentation.bind(element,'/original.png');
 while(!errors.length)await tick();assert.equal(element.src,undefined);assert.equal(element.dataset.miaoExportState,'error');assert.match(element.alt,/转换失败/);assert.equal(f.writes.length,0);
});
test('cached JPEGs survive a new presentation instance and concurrent conversions share work and stay bounded',async()=>{
 // Hold the first conversion until the second arrives; crypto completion
 // timing must not determine whether this fixture exercises both slots.
 let release;const gate=new Promise(resolve=>release=resolve);
 let converting=0,peak=0;const f=fixture({convert:async()=>{converting++;peak=Math.max(peak,converting);if(converting===2)release();await gate;await tick();converting--;return {blob:jpg};}});
 for(let i=0;i<6;i++)f.files.set(`/image-${i}.png`,png);
 const results=await Promise.all([...Array.from({length:6},(_,i)=>f.presentation.jpeg(`/image-${i}.png`)),f.presentation.jpeg('/image-0.png')]);assert.equal(peak,2);assert.equal(f.writes.length,6);assert.equal(f.reads.filter(url=>url==='/image-0.png').length,1);
 // Promise.all preserves input order; concurrent writes may finish in any order.
 assert.equal(results[0],results[6]);assert.ok(f.writes.some(item=>item.url===results[0]));
 const cached=fixture({fetchImage:async url=>f.files.has(url)?new Response(f.files.get(url)):new Response('',{status:404}),convert:async()=>{throw Error('should reuse JPEG');}});assert.equal(await cached.presentation.jpeg('/image-0.png'),results[0]);
 await assert.rejects(cached.presentation.jpeg('https://other.test/image.png'),/当前酒馆/);
});
test('lazy images wait until visible and a format refresh updates only bound plugin images',async()=>{
 let observe,watched;class Observer{constructor(callback){observe=callback;}observe(element){watched=element;}unobserve(){}}
 const f=fixture({Observer}),element=image();f.presentation.bind(element,'/original.png',{lazy:true});await tick();assert.equal(watched,element);assert.equal(f.reads.length,0);
 observe([{target:element,isIntersecting:true}]);await f.presentation.jpeg('/original.png');await tick();assert.ok(element.src.endsWith('.jpg'));
 f.setFormat('png');f.presentation.refresh({querySelectorAll:()=>[element,image()]});assert.equal(element.src,'/original.png');
});
test('export MIME types omit HTTP charset parameters and forgetting a deleted original invalidates its JPEG',async()=>{
 const f=fixture({fetchImage:async url=>{const blob=f.files.get(url);return blob?new Response(blob,{headers:{'Content-Type':blob.type+'; charset=utf-8'}}):new Response('',{status:404});}});
 const original=await f.presentation.file({url:'/original.png',name:'original.png'},'png');assert.equal(original.blob.type,'image/png');assert.equal(await original.blob.text(),await png.text());
 const converted=await f.presentation.file({url:'/original.png',name:'original.png'},'jpg');assert.equal(converted.blob.type,'image/jpeg');assert.equal(f.writes.length,1);
 const path=await f.presentation.forget('/original.png');assert.equal('/'+path,converted.url);f.files.delete('/'+path);assert.equal(await f.presentation.jpeg('/original.png'),converted.url);assert.equal(f.writes.length,2);f.files.delete(converted.url);assert.equal((await f.presentation.file({url:'/original.png',name:'original.png'},'jpg')).blob.type,'image/jpeg');assert.equal(f.writes.length,3);
});

class LoadImage extends EventTarget{
 constructor(){super();this.dataset={};this.complete=false;this.naturalWidth=0;this.alt='fixture';}
 setAttribute(name,value){this[name]=value;}
 removeAttribute(name){delete this[name];}
}
test('chat PNG stays loading until transfer and decoding finish without another image fetch',async()=>{
 let release;const element=new LoadImage(),f=fixture();f.setFormat('png');
 element.decode=()=>new Promise(resolve=>release=resolve);
 f.presentation.bind(element,'/original.png',{lazy:true,decode:true});
 const ready=f.presentation.whenReady(element);let done=false;void ready.then(()=>done=true);
 element.naturalWidth=512;await tick();assert.equal(done,false);assert.equal(element.dataset.miaoLoadState,'loading');
 element.complete=true;element.dispatchEvent(new Event('load'));await tick();assert.equal(done,false);assert.equal(element['aria-busy'],'true');
 release();assert.equal(await ready,true);assert.equal(element.dataset.miaoLoadState,'ready');assert.equal(element['aria-busy'],undefined);
 assert.equal(element.src,'/original.png');assert.deepEqual(f.reads,[]);
});
test('an old decoding result cannot reveal a new source or a refreshed format',async()=>{
 let release;const element=new LoadImage(),f=fixture();f.setFormat('png');element.decode=()=>new Promise(resolve=>release=resolve);
 f.presentation.bind(element,'/original.png',{decode:true});const oldReady=f.presentation.whenReady(element);
 element.dispatchEvent(new Event('load'));await tick();f.presentation.bind(element,'/second.png',{decode:true});assert.equal(await oldReady,false);
 release();await tick();assert.equal(element.src,'/second.png');assert.equal(element.dataset.miaoLoadState,'loading');
 f.setFormat('jpg');f.presentation.refresh({querySelectorAll:()=>[element]});await f.presentation.jpeg('/second.png');await tick();
 assert.ok(element.src.endsWith('.jpg'));assert.equal(element.dataset.miaoLoadState,'loading');
 element.decode=async()=>{};element.complete=true;element.naturalWidth=512;element.dispatchEvent(new Event('load'));
 assert.equal(await f.presentation.whenReady(element),true);assert.equal(element.dataset.miaoLoadState,'ready');
});
test('cached images and hosts without image.decode still complete the chat load gate',async()=>{
 const f=fixture();f.setFormat('png');const cached=new LoadImage();cached.complete=true;cached.naturalWidth=64;cached.decode=async()=>{};
 f.presentation.bind(cached,'/original.png',{decode:true});assert.equal(await f.presentation.whenReady(cached),true);
 const legacy=new LoadImage();f.presentation.bind(legacy,'/original.png',{decode:true});legacy.complete=true;legacy.naturalWidth=64;legacy.dispatchEvent(new Event('load'));
 assert.equal(await f.presentation.whenReady(legacy),true);assert.equal(legacy.dataset.miaoLoadState,'ready');
});
test('load errors release thumbnail waits and rebinding can retry the same source',async()=>{
 const f=fixture();f.setFormat('png');const element=new LoadImage();
 f.presentation.bind(element,'/original.png',{decode:true});const failed=f.presentation.whenReady(element);element.dispatchEvent(new Event('error'));
 assert.equal(await failed,false);assert.equal(element.dataset.miaoLoadState,'error');assert.equal(element['aria-busy'],undefined);
 f.presentation.bind(element,'/original.png',{decode:true});assert.equal(element.dataset.miaoLoadState,'loading');
 element.complete=true;element.naturalWidth=64;element.decode=async()=>{throw Error('unsupported decoder');};element.dispatchEvent(new Event('load'));
 assert.equal(await f.presentation.whenReady(element),true);
});
test('JPG conversion errors release the chat gate without exposing original PNG bytes',async()=>{
 const errors=[],f=fixture({convert:async()=>{throw Error('fixture conversion failed');},onError:error=>errors.push(error)}),element=new LoadImage();
 f.presentation.bind(element,'/original.png',{decode:true});assert.equal(await f.presentation.whenReady(element),false);
 assert.equal(element.src,undefined);assert.equal(element.dataset.miaoLoadState,'error');assert.equal(element.dataset.miaoExportState,'error');assert.equal(errors.length,1);
});

test('a stalled decode cannot hide a fully transferred image indefinitely or reveal a partial transfer',async()=>{
 const f=fixture({decodeTimeoutMs:15}),element=new LoadImage();f.setFormat('png');element.decode=()=>new Promise(()=>{});
 f.presentation.bind(element,'/original.png',{decode:true});element.naturalWidth=512;
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(element.dataset.miaoLoadState,'loading');
 element.complete=true;element.dispatchEvent(new Event('load'));
 const result=await Promise.race([f.presentation.whenReady(element),new Promise(resolve=>setTimeout(()=>resolve('stalled'),150))]);
 assert.equal(result,true);assert.equal(element.dataset.miaoLoadState,'ready');assert.equal(element.dataset.miaoDecodeFallback,'true');
});
test('foreground activation starts a lazy JPG without waiting for intersection observation',async()=>{
 let observed=0;class Observer{observe(){observed++;}unobserve(){}}
 const f=fixture({Observer}),element=new LoadImage();element.decode=async()=>{};
 f.presentation.bind(element,'/original.png',{lazy:true,decode:true});assert.equal(observed,1);assert.equal(f.reads.length,0);
 f.presentation.activate(element);await f.presentation.jpeg('/original.png');await tick();
 assert.equal(element.loading,'eager');assert.equal(element.fetchPriority,'high');assert.ok(element.src.endsWith('.jpg'));assert.equal(f.writes.length,1);
 element.complete=true;element.naturalWidth=512;element.dispatchEvent(new Event('load'));assert.equal(await f.presentation.whenReady(element),true);
});
test('fresh JPG preparation reuses generated bytes and persists JPEG without cache or PNG reads',async()=>{
 let converted;const f=fixture({fetchImage:async()=>assert.fail('fresh preparation must not read saved images'),convert:async blob=>{converted=blob;return {blob:jpg};}}),element=image();
 const prepared=f.presentation.prepareGenerated('/original.png',Buffer.from(await png.arrayBuffer()).toString('base64'));
 f.presentation.bind(element,'/original.png');await prepared;await tick();
 assert.equal(await converted.text(),await png.text());assert.equal(f.writes.length,1);assert.equal(element.src,f.writes[0].url);assert.ok(element.src.endsWith('.jpg'));
 f.setFormat('png');await f.presentation.prepareGenerated('/second.png','not needed');assert.equal(f.writes.length,1);
});
test('fresh JPG bypasses queued history reads without exceeding the conversion limit',async()=>{
 let releaseConversions,releaseReads,converting=0,cacheReads=0,active=0,peak=0,timer;
 const conversionGate=new Promise(resolve=>releaseConversions=resolve),readGate=new Promise(resolve=>releaseReads=resolve);
 const f=fixture({fetchImage:async url=>{
  if(url.startsWith('/user/images/')){if(++cacheReads>2)await readGate;return new Response('',{status:404});}
  return new Response(f.files.get(url));
 },convert:async()=>{active++;peak=Math.max(peak,active);if(++converting<=2)await conversionGate;active--;return {blob:jpg};}});
 const backgrounds=Array.from({length:6},(_,i)=>{const path=`/background-${i}.png`;f.files.set(path,png);return f.presentation.jpeg(path);});
 while(converting<2)await tick();
 const fresh=f.presentation.prepareGenerated('/fresh.png',Buffer.from(await png.arrayBuffer()).toString('base64'));
 try{
  releaseConversions();
  const result=await Promise.race([fresh,new Promise(resolve=>{timer=setTimeout(()=>resolve('blocked behind history'),1000);})]);
  assert.notEqual(result,'blocked behind history');assert.ok(result.endsWith('.jpg'));assert.ok(peak<=2);
 }finally{clearTimeout(timer);releaseConversions();releaseReads();await Promise.all([...backgrounds,fresh]);}
});
