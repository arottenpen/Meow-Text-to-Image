import {sha256} from '../platform/browser-crypto.js';
import {prepareImageExport} from './image-export.js';
import {imageBlob} from './image-thumbnails.js';

export const JPEG_FOLDER='miao-nai-jpg';

// Keep original archive URLs separate from the bytes offered by native image menus.
export function createImagePresentation({getFormat,fetchImage,saveJPEG,onError=()=>{},base=()=>location.href,documentImpl=globalThis.document,Observer=globalThis.IntersectionObserver,TreeObserver=globalThis.MutationObserver,convert=prepareImageExport,decodeTimeoutMs=2000}){
    const ready=new Map(),pending=new Map(),bindings=new WeakMap();let active=0;const waiting=[];
    const run=async(work,{priority=false}={})=>{if(active>=2)await new Promise(resolve=>priority?waiting.unshift(resolve):waiting.push(resolve));else active++;try{return await work();}finally{if(waiting.length)waiting.shift()();else active--;}};
    const jpeg=async(url,{source}={})=>{
        if(ready.has(url))return ready.get(url);if(pending.has(url))return pending.get(url);
        const work=run(async()=>{
            const absolute=new URL(url,base());if(absolute.origin!==new URL(base()).origin)throw Error('请选择当前酒馆的图片');
            const name='jpg-'+await sha256(absolute.pathname),target=`/user/images/${JPEG_FOLDER}/${name}.jpg`;
            // A newly generated original already exists in memory and has no cached JPG.
            if(!source){
                const cached=await fetchImage(target);
                if(cached.ok&&cached.headers.get('content-type')?.split(';')[0]==='image/jpeg'){
                    const bytes=new Uint8Array(await (await cached.blob()).slice(0,2).arrayBuffer());if(bytes[0]===255&&bytes[1]===216)return target;
                }
                const response=await fetchImage(url);if(!response.ok)throw Error('原图读取失败：HTTP '+response.status);
                source=await response.blob();
            }
            const {blob}=await convert(source,name+'.png','jpg');source=null;return saveJPEG(blob,JPEG_FOLDER,name);
        },{priority:!!source});pending.set(url,work);
        try{const result=await work;ready.set(url,result);return result;}finally{pending.delete(url);}
    };
    const observer=Observer?new Observer(entries=>{for(const entry of entries){if(entry.target.isConnected===false){observer.unobserve(entry.target);continue;}if(entry.isIntersecting){observer.unobserve(entry.target);const binding=bindings.get(entry.target);if(binding)void present(entry.target,binding);}}}, {rootMargin:'240px'}):null;
    let changes;
    const watchTree=()=>{
        if(changes||!TreeObserver||!documentImpl?.body)return;
        const selector='img[data-miao-image-format="jpg"][data-miao-export-state="loading"]';
        const images=node=>node.nodeType===1?[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]:[];
        changes=new TreeObserver(records=>{for(const record of records){for(const node of record.removedNodes)for(const image of images(node))observer.unobserve(image);for(const node of record.addedNodes)for(const image of images(node)){const binding=bindings.get(image);if(image.isConnected&&binding?.lazy&&!binding.presenting)observer.observe(image);}}});
        changes.observe(documentImpl.body,{childList:true,subtree:true});
    };
    const clock=()=>globalThis.performance?.now?.()??Date.now();
    const setSource=(image,src,binding)=>{
        binding.sourceAt=clock();
        if(binding.decode){image.dataset.miaoPrepareMs=String(Math.round(binding.sourceAt-binding.started));binding.phase('loading');}
        image.src=src;
        if(binding.decode&&image.complete&&image.naturalWidth)binding.loaded();
    };
    const watchLoad=(image,binding)=>{
        let decoding=false,settled=false,timer;binding.started=clock();
        delete image.dataset.miaoDecodeFallback;delete image.dataset.miaoPrepareMs;delete image.dataset.miaoReadMs;delete image.dataset.miaoDecodeMs;
        binding.phase=phase=>{image.dataset.miaoLoadPhase=phase;binding.onState?.(phase);};
        binding.ready=new Promise(resolve=>{
            const finish=state=>{
                if(settled||bindings.get(image)!==binding)return;settled=true;
                image.dataset.miaoLoadState=state;image.removeAttribute('aria-busy');
                if(decoding)image.dataset.miaoDecodeMs=String(Math.round(clock()-binding.loadedAt));
                binding.phase(state);resolve(state==='ready');binding.cleanup();
            };
            const failed=()=>finish('error');
            const loaded=()=>{
                if(decoding||bindings.get(image)!==binding)return;decoding=true;
                binding.loadedAt=clock();image.dataset.miaoReadMs=String(Math.round(binding.loadedAt-(binding.sourceAt??binding.started)));binding.phase('decoding');
                // Only a completed transfer may bypass a stalled WebView decode promise.
                timer=setTimeout(()=>{
                    if(image.complete&&image.naturalWidth){image.dataset.miaoDecodeFallback='true';finish('ready');}else finish('error');
                },decodeTimeoutMs);
                Promise.resolve().then(()=>image.decode?.()).then(()=>finish('ready'),()=>finish(image.complete&&image.naturalWidth?'ready':'error'));
            };
            binding.loaded=loaded;binding.failed=failed;
            binding.cleanup=()=>{clearTimeout(timer);image.removeEventListener('load',loaded);image.removeEventListener('error',failed);resolve(false);};
            image.addEventListener('load',loaded);image.addEventListener('error',failed);
        });
        image.dataset.miaoLoadState='loading';image.setAttribute('aria-busy','true');binding.phase(binding.format==='jpg'?'preparing':'loading');
    };
    const present=async(image,binding)=>{
        if(bindings.get(image)!==binding||binding.format!=='jpg'||getFormat()!=='jpg'||binding.presenting)return;
        binding.presenting=true;
        try{const src=await jpeg(binding.url);if(bindings.get(image)===binding&&getFormat()==='jpg'){setSource(image,src,binding);image.dataset.miaoExportState='ready';}}
        catch(error){if(bindings.get(image)===binding&&getFormat()==='jpg'){binding.failed?.();image.dataset.miaoExportState='error';image.alt='JPG 转换失败，请刷新重试';onError(error);}}
        finally{binding.presenting=false;}
    };
    const bind=(image,url,{lazy=false,decode=false,onState}={})=>{
        const format=getFormat()==='jpg'?'jpg':'png',old=bindings.get(image);
        if(old?.url===url&&old.format===format&&old.decode===decode&&image.dataset.miaoExportState!=='error'&&image.dataset.miaoLoadState!=='error')return;
        old?.cleanup?.();observer?.unobserve(image);const binding={url,format,lazy,decode,onState:onState??old?.onState};bindings.set(image,binding);image.dataset.miaoOriginalUrl=url;image.dataset.miaoImageFormat=format;image.dataset.miaoExportState=format==='png'||ready.has(url)?'ready':'loading';
        if(decode)watchLoad(image,binding);else{delete image.dataset.miaoLoadState;image.removeAttribute('aria-busy');}
        if(lazy){image.loading='lazy';image.decoding='async';}
        if(format==='png'){setSource(image,url,binding);return;}
        // Never expose the PNG, even briefly, while a private JPG is being prepared.
        if(ready.has(url))setSource(image,ready.get(url),binding);else image.removeAttribute('src');
        if(!ready.has(url)){if(lazy&&observer){watchTree();observer.observe(image);}else void present(image,binding);}
    };
    return {bind,jpeg,
        async prepareGenerated(url,data){if(getFormat()==='jpg')return jpeg(url,{source:imageBlob(data)});},
        activate(image){
            const binding=bindings.get(image);if(!binding)return;
            binding.lazy=false;image.loading='eager';image.fetchPriority='high';observer?.unobserve(image);
            if(binding.format==='jpg'&&image.dataset.miaoExportState==='loading')void present(image,binding);
        },
        whenReady:image=>bindings.get(image)?.ready??Promise.resolve(true),
        refresh(root=documentImpl){
            if(getFormat()!=='jpg'){
                changes?.disconnect();changes=undefined;observer?.disconnect?.();
            }
            for(const image of root.querySelectorAll('img[data-miao-original-url]')){const old=bindings.get(image);if(old)bind(image,old.url,{lazy:old.lazy,decode:old.decode,onState:old.onState});}
        },
        async forget(url){try{await pending.get(url);}catch{}ready.delete(url);return `user/images/${JPEG_FOLDER}/jpg-${await sha256(new URL(url,base()).pathname)}.jpg`;},
        async file(image,format=getFormat()){
            let url=format==='jpg'?await jpeg(image.url):image.url,response=await fetchImage(url);
            if(format==='jpg'&&!response.ok){ready.delete(image.url);url=await jpeg(image.url);response=await fetchImage(url);}
            if(!response.ok)throw Error(image.name+' · HTTP '+response.status);
            const source=await response.blob(),mime=format==='jpg'?'image/jpeg':source.type.split(';')[0]||'image/png';
            return {url,blob:source.slice(0,source.size,mime),name:format==='jpg'?image.name.replace(/\.[^.]+$/,'')+'.jpg':image.name};
        }};
}
