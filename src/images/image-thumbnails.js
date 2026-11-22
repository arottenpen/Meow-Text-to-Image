import {sha256} from '../platform/browser-crypto.js';

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
export function blobBase64(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(blob);});}
