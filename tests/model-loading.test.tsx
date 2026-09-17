import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelDataCache } from '../lib/models/model-cache';
import { StepWorkerPool } from '../lib/models/step-pool';
import { KeepAlivePanel } from '../components/KeepAlivePanel';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

test('model cache deduplicates pending work, retains success after owner unmount and retries failures',async()=>{
 const cache=new ModelDataCache();const controller=new AbortController();let calls=0;
 const load=async()=>{calls++;return {kind:'wrl' as const,text:'model'};};
 const a=cache.get('part',controller.signal,load),b=cache.get('part',controller.signal,load);
 assert.equal(a,b);await a;controller.abort();await cache.get('part',new AbortController().signal,load);assert.equal(calls,1);
 await assert.rejects(cache.get('bad',new AbortController().signal,async()=>{throw Error('404');}));
 assert.equal((await cache.get('bad',new AbortController().signal,load)).kind,'wrl');assert.equal(calls,2);
});

test('aborted cache entry cannot delete replacement and memory budget evicts old data',async()=>{
 const cache=new ModelDataCache(12),a=new AbortController(),b=new AbortController();let finish!:(v:{kind:'wrl';text:string})=>void;
 const pending=cache.get('x',a.signal,()=>new Promise(r=>{finish=r;}));await Promise.resolve();a.abort();
 const replacement=cache.get('x',b.signal,async()=>({kind:'wrl',text:'new'}));finish({kind:'wrl',text:'old'});
 await assert.rejects(pending);await replacement;assert.equal(cache.get('x',b.signal,async()=>{throw Error('unexpected');}),replacement);
 await cache.get('y',b.signal,async()=>({kind:'wrl',text:'longer'}));let reloaded=false;
 await cache.get('x',b.signal,async()=>{reloaded=true;return {kind:'wrl',text:'new'};});assert.ok(reloaded);
});

class FakeWorker {
 onmessage:((event:{data:{meshes:never[]}})=>void)|null=null;onerror:(()=>void)|null=null;terminated=false;posts=0;
 postMessage(){this.posts++;}terminate(){this.terminated=true;}complete(){this.onmessage?.({data:{meshes:[]}});}
}
test('STEP pool bounds concurrency and reuses initialized workers',async()=>{
 const workers:FakeWorker[]=[];const pool=new StepWorkerPool(2,()=>{const w=new FakeWorker();workers.push(w);return w as unknown as Worker;});
 try{const signal=new AbortController().signal;const jobs=[1,2,3,4].map(()=>pool.convert(new Uint8Array([1]),signal));assert.equal(workers.length,2);
 workers[0].complete();workers[1].complete();assert.equal(workers.length,2);assert.equal(workers[0].posts,2);assert.equal(workers[1].posts,2);
 workers[0].complete();workers[1].complete();await Promise.all(jobs);
 }finally{pool.dispose();}assert.ok(workers.every(w=>w.terminated));
});
test('STEP cancellation replaces only affected worker and queue continues',async()=>{
 const workers:FakeWorker[]=[];const pool=new StepWorkerPool(1,()=>{const w=new FakeWorker();workers.push(w);return w as unknown as Worker;});
 try{const abort=new AbortController();const first=pool.convert(new Uint8Array(),abort.signal);const rejected=assert.rejects(first,/cancelled/);
 const second=pool.convert(new Uint8Array(),new AbortController().signal);abort.abort();await rejected;assert.ok(workers[0].terminated);assert.equal(workers.length,2);workers[1].complete();await second;
 }finally{pool.dispose();}
});
test('STEP timeout rejects and releases broken worker',async()=>{
 const w=new FakeWorker();const pool=new StepWorkerPool(1,()=>w as unknown as Worker,5);
 try{await assert.rejects(pool.convert(new Uint8Array(),new AbortController().signal),/超时/);assert.ok(w.terminated);}finally{pool.dispose();}
});
test('3D panel mounts lazily and survives tab switches without effect cleanup',async()=>{
 const dom=new JSDOM('<div id="root"></div>');Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 let mounts=0,unmounts=0;function Scene(){useEffect(()=>{mounts++;return()=>{unmounts++;};},[]);return <span>scene</span>;}
 const root=createRoot(document.getElementById('root')!);const render=(active:boolean)=>act(async()=>root.render(<KeepAlivePanel active={active}><Scene/></KeepAlivePanel>));
 try{await render(false);assert.equal(mounts,0);await render(true);assert.equal(mounts,1);await render(false);assert.ok(document.querySelector('[hidden]'));assert.equal(unmounts,0);await render(true);assert.equal(mounts,1);assert.equal(unmounts,0);}
 finally{await act(async()=>root.unmount());dom.window.close();}assert.equal(unmounts,1);
});

test('repeated footprint references decode once and scene disposal does not invalidate cached mesh data',async()=>{
 const {loadFootprintModels,disposeModels}=await import('../lib/models/load-footprints');
 const assets=[{path:'part.step',bytes:new Uint8Array([1])}];
 const model={path:'part.step',offset:[0,0,0],scale:[1,1,1],rotation:[0,0,0],hidden:false};
 const pcb={id:'board',sourceRefs:[],footprints:[1,2,3].map(n=>({reference:`U${n}`,models:[model],position:{x:'0',y:'0'},rotation:'0',side:'front'}))} as unknown as import('../lib/eda/types').PcbIr;
 let conversions=0;const decodeStep=async()=>{conversions++;return [{attributes:{position:{array:[0,0,0,1,0,0,0,1,0]}},index:{array:[0,1,2]},color:[1,0,0]}];};
 const first=await loadFootprintModels(pcb,assets,new AbortController().signal,()=>{},{decodeStep});assert.equal(first.loaded,3);assert.equal(conversions,1);disposeModels(first.group);
 const second=await loadFootprintModels(pcb,assets,new AbortController().signal,()=>{},{decodeStep});assert.equal(second.loaded,3);assert.equal(conversions,1);disposeModels(second.group);
 const missing=await loadFootprintModels(pcb,[],new AbortController().signal,()=>{},{});assert.equal(missing.failures.length,1);assert.equal(missing.failures[0].references.length,3);
});

test('manufacturer route rejects arbitrary paths and redirects large STEP to fixed official origin',async()=>{
 const {GET}=await import('../app/api/models/espressif/route');
 assert.equal((await GET(new Request('https://local/api/models/espressif?path=../../private.step'))).status,400);
 const original=globalThis.fetch;let fetched='';
 globalThis.fetch=async(input)=>{fetched=String(input);return new Response('',{headers:{'content-length':'13045547'}});};
 try{const r=await GET(new Request('https://local/api/models/espressif?path=ESP32-S31-WROOM-3_V1_1.STEP'));assert.equal(r.status,307);assert.equal(r.headers.get('location'),fetched);assert.ok(fetched.startsWith('https://raw.githubusercontent.com/espressif/kicad-libraries/main/3dmodels/espressif.3dshapes/'));}
 finally{globalThis.fetch=original;}
});
