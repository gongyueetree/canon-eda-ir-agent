import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { createDesignAssetStore } from '../lib/design-assets/storage';
import { fingerprint } from '../lib/design-assets/kicad';
import { sha256 } from '../lib/eda/util';
import type { DesignAsset } from '../lib/design-assets/types';

test('real PostgreSQL storage: deduplication, provenance, variants, review audit, optimistic locking and tenant isolation',async()=>{
 const db=new PGlite();type Query={text:string;values:unknown[];then:Promise<unknown>['then']};
 const query=(strings:TemplateStringsArray,...values:unknown[]):Query=>{const text=strings.reduce((s,p,i)=>s+(i?'$'+i:'')+p,'');return {text,values,then:(yes,no)=>db.query(text,values).then(r=>r.rows).then(yes,no)};};
 const q=Object.assign(query,{transaction:async(queries:Query[])=>db.transaction(async tx=>{const results=[];for(const item of queries)results.push((await tx.query(item.text,item.values)).rows);return results;})}) as unknown as NeonQueryFunction<false,false>;
 const store=createDesignAssetStore(()=>q),enc=new TextEncoder();const original=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:404});
 const bytes=enc.encode('(kicad_symbol_lib (version 20211014) (symbol "Test" (symbol "Test_1_1" (pin input line (at 0 0 0) (length 1) (name "A") (number "1")))))');
 const make=async(data:Uint8Array):Promise<DesignAsset>=>({id:'',name:'StorageTest:Unique',kind:'symbol',mpn:'ABC-123',manufacturer:'Acme',identityConfirmed:true,fingerprint:await fingerprint('symbol',data),fileHash:await sha256(data),fileName:'Test.kicad_sym',size:data.length,format:'kicad_sym',origins:[{project:'Board',bundleId:'b1',path:'board.sch',sourceHash:'a'.repeat(64),reference:'U1'}],warnings:[]});
 try{
  const a=await make(bytes);await store.putChunk('tenant-a',a.fileHash!,0,bytes);const first=await store.stageAsset('tenant-a',a,'file');assert.equal(first.duplicate,false);
  let listed=await store.listAssets('tenant-a','ABC',0);assert.equal(listed.assets.length,1);assert.equal(listed.assets[0].status,'CANDIDATE');assert.equal(listed.assets[0].occurrences,1);
  const details={sourceUrl:'https://example.org/board',license:'CC-BY-SA-4.0',reviewNote:'Pins checked',acknowledge:true};
  await assert.rejects(store.reviewAsset('tenant-a',first.id,0,'approve',{...details,acknowledge:false}),/REVIEW_SOURCE/);
  await store.reviewAsset('tenant-a',first.id,0,'approve',details);await assert.rejects(store.reviewAsset('tenant-a',first.id,0,'reject',details),/REVISION_CONFLICT/);
  const duplicate=await store.stageAsset('tenant-a',{...a,origins:[{...a.origins[0],bundleId:'b2',reference:'U2'}]},'file');assert.equal(duplicate.duplicate,true);
  listed=await store.listAssets('tenant-a','ABC',0);assert.equal(listed.assets[0].status,'APPROVED');assert.equal(listed.assets[0].revision,1);assert.equal(listed.assets[0].occurrences,2);assert.equal(listed.assets[0].origins.length,2);
  const variantBytes=enc.encode(new TextDecoder().decode(bytes).replace('(name "A")','(name "B")')),variant=await make(variantBytes);await store.putChunk('tenant-a',variant.fileHash!,0,variantBytes);await store.stageAsset('tenant-a',variant,'file');
  listed=await store.listAssets('tenant-a','ABC',0);assert.equal(listed.assets.length,2);assert.equal(listed.assets[0].variants,2);
  assert.equal((await store.listAssets('tenant-b','',0)).assets.length,0);await assert.rejects(store.fileChunk('tenant-b',a.fileHash!,0),/FILE_NOT_FOUND/);
  const file=await store.fileChunk('tenant-a',a.fileHash!,0);assert.deepEqual(Buffer.from(file.data,'base64'),Buffer.from(bytes));
  await assert.rejects(store.stageAsset('tenant-a',{...a,fingerprint:'b'.repeat(64)},'file'),/FINGERPRINT/);
  await assert.rejects(store.putChunk('tenant-a',a.fileHash!,0,variantBytes),/CHUNK_CONFLICT/);
  assert.equal((await db.query('SELECT * FROM eda_design_reviews')).rows.length,1);
 }finally{globalThis.fetch=original;await db.close();}
});
