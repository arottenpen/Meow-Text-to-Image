import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeneratedImagePreviews,GENERATED_PREVIEW_LIMIT,GENERATED_PREVIEW_BYTES} from '../src/images/generated-image-previews.js';

function fixture(options={}){
    const blobs=new Map(),revoked=[];let next=0;
    const urlAPI={createObjectURL(blob){const url='blob:preview-'+(++next);blobs.set(url,blob);return url;},revokeObjectURL(url){revoked.push(url);blobs.delete(url);}};
    return {cache:createGeneratedImagePreviews({urlAPI,...options}),blobs,revoked};
}
const image=()=>({dataset:{}});

test('fresh preview URLs retain the exact image bytes and eviction restores durable sources',()=>{
    const f=fixture(),png=new Blob(['png metadata'],{type:'image/png'}),first=image(),second=image();
    f.cache.remember('/first.png',png);first.src=f.cache.source('/first.png',first);
    assert.equal(f.blobs.get(first.src),png);
    f.cache.remember('/second.jpg',new Blob(['jpg'],{type:'image/jpeg'}));second.src=f.cache.source('/second.jpg',second);
    const old=first.src;f.cache.remember('/third.png',png);
    assert.equal(GENERATED_PREVIEW_LIMIT,2);assert.equal(f.blobs.size,2);assert.equal(first.src,'/first.png');
    assert.equal(first.dataset.miaoReadSource,'server');assert.deepEqual(f.revoked,[old]);assert.ok(second.src.startsWith('blob:'));
    assert.equal(f.cache.source('/first.png',image()),'/first.png');
});

test('byte budget is enforced and oversized images do not allocate a preview or evict a usable entry',()=>{
    const f=fixture(),half=GENERATED_PREVIEW_BYTES/2;
    assert.equal(GENERATED_PREVIEW_BYTES,8*1024*1024);
    f.cache.remember('/one.png',{size:half+1});f.cache.remember('/two.png',{size:half+1});
    assert.equal(f.blobs.size,1);assert.equal(f.revoked.length,1);
    f.cache.remember('/oversized.png',{size:GENERATED_PREVIEW_BYTES+1});
    assert.equal(f.blobs.size,1);assert.equal(f.revoked.length,1);assert.equal(f.cache.accepts(GENERATED_PREVIEW_BYTES+1),false);
    assert.ok([...f.blobs.values()].reduce((sum,blob)=>sum+blob.size,0)<=GENERATED_PREVIEW_BYTES);
});

test('least recently used preview is released without retargeting a rebound image',()=>{
    const f=fixture(),blob=new Blob(['fixture']),first=image(),second=image();
    f.cache.remember('/first.png',blob);first.src=f.cache.source('/first.png',first);
    f.cache.remember('/second.png',blob);second.src=f.cache.source('/second.png',second);
    f.cache.source('/first.png',first);second.src='/different.png';
    f.cache.remember('/third.png',blob);
    assert.equal(second.src,'/different.png');assert.equal(f.cache.source('/second.png',image()),'/second.png');
    assert.ok(first.src.startsWith('blob:'));f.cache.forget('/first.png');f.cache.forget('/first.png');
    assert.equal(first.src,'/first.png');assert.equal(f.blobs.size,1);assert.equal(f.revoked.length,2);
});

test('unsupported or rejected object URLs keep the existing server path usable',()=>{
    const imageElement=image(),blob=new Blob(['fixture']);
    const unsupported=createGeneratedImagePreviews({urlAPI:null});unsupported.remember('/image.png',blob);
    assert.equal(unsupported.enabled,false);assert.equal(unsupported.source('/image.png',imageElement),'/image.png');
    const rejected=createGeneratedImagePreviews({urlAPI:{createObjectURL(){throw Error('unavailable');},revokeObjectURL(){assert.fail('nothing allocated');}}});
    assert.doesNotThrow(()=>rejected.remember('/image.png',blob));assert.equal(rejected.source('/image.png',imageElement),'/image.png');
});
