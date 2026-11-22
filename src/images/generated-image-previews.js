export const GENERATED_PREVIEW_LIMIT=2;
export const GENERATED_PREVIEW_BYTES=8*1024*1024;

// Keep only a small handoff cache: archived records always use durable host URLs.
// Weak consumers allow detached cards and dialogs to be collected without a tree observer.
export function createGeneratedImagePreviews({urlAPI=globalThis.URL,maxEntries=GENERATED_PREVIEW_LIMIT,maxBytes=GENERATED_PREVIEW_BYTES,onRestore=()=>{}}={}){
    const entries=new Map();let bytes=0;
    const enabled=!!(urlAPI?.createObjectURL&&urlAPI?.revokeObjectURL&&typeof WeakRef==='function'&&maxEntries>0&&maxBytes>0);
    const forget=url=>{
        const entry=entries.get(url);if(!entry)return;
        entries.delete(url);bytes-=entry.bytes;
        for(const ref of entry.images){
            const image=ref.deref();
            // Restore the persisted file before revoking a preview still used by a native menu.
            if(image?.src===entry.preview){onRestore(image);image.dataset.miaoReadSource='server';image.src=url;}
        }
        urlAPI.revokeObjectURL(entry.preview);
    };
    return {enabled,
        accepts:size=>enabled&&size>0&&size<=maxBytes,
        remember(url,blob){
            if(!enabled||!blob?.size||blob.size>maxBytes)return;
            let preview;try{preview=urlAPI.createObjectURL(blob);}catch{return;}
            forget(url);
            while(entries.size&&(entries.size>=maxEntries||bytes+blob.size>maxBytes))forget(entries.keys().next().value);
            entries.set(url,{preview,bytes:blob.size,images:new Set()});bytes+=blob.size;
        },
        source(url,image){
            const entry=entries.get(url);if(!entry)return url;
            // Reuse the same weak consumer on repeated binds and discard dead consumers.
            let found=false;
            for(const ref of entry.images){const target=ref.deref();if(!target)entry.images.delete(ref);else if(target===image)found=true;}
            if(!found)entry.images.add(new WeakRef(image));
            entries.delete(url);entries.set(url,entry);
            return entry.preview;
        },
        forget,
    };
}
