import {sha256} from '../platform/browser-crypto.js';
import {decodeImage} from './image-export.js';

export const THUMBNAIL_FOLDER='miao-nai-thumbnails';
export function localImagePath(url,base=location.href){
    const source=new URL(url,base),host=new URL(base),path=decodeURIComponent(source.pathname);
    if(source.origin!==host.origin||!path.startsWith('/user/images/')||path.includes('\\')||path.split('/').some(part=>part==='.'||part==='..'))throw Error('请选择当前酒馆保存的图片');
    return path;
}
export async function thumbnailName(url,base){return `thumb-${await sha256(localImagePath(url,base))}.jpg`;}
export async function thumbnailURL(url,base){return `/user/images/${THUMBNAIL_FOLDER}/${await thumbnailName(url,base)}`;}
export function imageBlob(data){
    const raw=String(data).replace(/^data:image\/[\w.+-]+;base64,/,''),binary=atob(raw),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return new Blob([bytes],{type:'image/png'});
}
export async function makeThumbnail(blob){
    const image=await decodeImage(blob),canvas=document.createElement('canvas');
    try{
        const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
        if(!width||!height)throw Error('图片尺寸无效');
        const scale=Math.min(1,384/Math.max(width,height));canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
        const context=canvas.getContext('2d');if(!context)throw Error('浏览器无法生成缩略图');
        context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
        return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?.type==='image/jpeg'?resolve(blob):reject(Error('缩略图生成失败')),'image/jpeg',0.76));
    }finally{image.close?.();canvas.width=canvas.height=0;}
}
export function blobBase64(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(blob);});}
export function createThumbnails({fetchImage,saveImage,base=()=>location.href,onReady=()=>{},convert=makeThumbnail,encode=blobBase64,concurrency=2}){
    if(!Number.isInteger(concurrency)||concurrency<1)throw Error('缩略图并发数必须为正整数');
    const pending=new Map(),deleting=new Map(),waiting=[];let active=0;
    const work=async task=>{
        const name=await thumbnailName(task.path,task.base),target=`/user/images/${THUMBNAIL_FOLDER}/${name}`;
        if(task.cancelled)return null;
        let source=task.source;task.source=null;
        if(!source){
            const cached=await fetchImage(target);if(task.cancelled)return null;if(cached.ok)return target;
            const response=await fetchImage(task.path);if(task.cancelled)return null;
            if(!response.ok)throw Error('原图读取失败');source=await response.blob();
        }
        if(task.cancelled)return null;
        const thumb=await convert(source);source=null;if(task.cancelled)return null;
        const data=await encode(thumb);if(task.cancelled)return null;
        await saveImage(data,THUMBNAIL_FOLDER,name.replace(/\.jpg$/,''),'jpg');
        return task.cancelled?null:target;
    };
    const pump=()=>{
        while(active<concurrency&&waiting.length){
            const task=waiting.shift();task.started=true;active++;
            const finish=()=>{task.source=null;pending.delete(task.path);active--;pump();};
            void work(task).then(target=>{
                finish();
                if(target&&!task.cancelled){try{onReady(task.path,target);}catch{}}
                task.resolve(target);
            },error=>{finish();task.reject(error);});
        }
    };
    return {
        async ensure(url,source){
            const origin=base(),path=localImagePath(url,origin);
            if(deleting.has(path)){await deleting.get(path);return null;}
            if(pending.has(path))return pending.get(path).promise;
            const task={path,base:origin,source,started:false,cancelled:false};
            task.promise=new Promise((resolve,reject)=>{task.resolve=resolve;task.reject=reject;});
            pending.set(path,task);waiting.push(task);pump();return task.promise;
        },
        async remove(url,removeOriginal){
            const origin=base(),path=localImagePath(url,origin);
            if(deleting.has(path))return deleting.get(path);
            // Lock the path before yielding. Queued work drops its source;
            // in-flight uploads finish before deletion, so they cannot recreate it.
            const task=pending.get(path);if(task){task.cancelled=true;task.source=null;}
            if(task&&!task.started){waiting.splice(waiting.indexOf(task),1);pending.delete(path);task.resolve(null);}
            const removal=Promise.resolve().then(async()=>{
                try{await task?.promise;}catch{}
                const target=(await thumbnailURL(path,origin)).slice(1);
                await removeOriginal();return target;
            });
            deleting.set(path,removal);
            try{return await removal;}finally{deleting.delete(path);}
        },
    };
}
export function bindThumbnail(image,url){
    image.dataset.originalUrl=url;image.loading='lazy';image.decoding='async';
    image.onerror=()=>{image.dataset.thumbnailState='missing';image.alt='缩略图未生成，可点开放大查看原图';};
    image.onload=()=>{image.dataset.thumbnailState='ready';};
    thumbnailURL(url).then(src=>{if(image.dataset.originalUrl===url){image.dataset.thumbnailUrl=src;image.src=src;}}).catch(()=>{image.dataset.thumbnailState='missing';image.alt='此图片暂不支持缩略图';});
}
