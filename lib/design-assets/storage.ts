import { neon,type NeonQueryFunction } from '@neondatabase/serverless';
import { sha256 } from '../eda/util';
import { candidateId } from './extract';
import { fingerprint } from './kicad';
import { checkOfficial } from './official';
import { originKey, type AssetRecord, type DesignAsset } from './types';
const HASH=/^[a-f0-9]{64}$/;
export const CHUNK_SIZE=1024*1024;
export function validHash(hash:string){if(!HASH.test(hash))throw Error('INVALID_HASH');}
export function validateAsset(value:unknown):asserts value is DesignAsset{
 const a=value as DesignAsset;
 if(!a||!['symbol','footprint','model'].includes(a.kind)||typeof a.mpn!=='string'||!a.mpn.trim()||a.mpn.length>200||typeof a.manufacturer!=='string'||a.manufacturer.length>200||a.identityConfirmed!==true)throw Error('MPN_CONFIRMATION_REQUIRED');
 if(typeof a.name!=='string'||a.name.length>400||!HASH.test(a.fingerprint)||!Array.isArray(a.origins)||!a.origins.length||a.origins.length>500)throw Error('INVALID_ASSET');
 for(const o of a.origins)if(!o||['project','bundleId','path','sourceHash','reference'].some(k=>typeof o[k as keyof typeof o]!=='string')||!HASH.test(o.sourceHash))throw Error('SOURCE_PROVENANCE_REQUIRED');
 if(a.dependencies&&(!Array.isArray(a.dependencies)||a.dependencies.length>100||a.dependencies.some(d=>typeof d.path!=='string'||d.path.length>400||d.fileHash&&!HASH.test(d.fileHash)||[d.offset,d.scale,d.rotation].some(v=>!Array.isArray(v)||v.length!==3||v.some(n=>typeof n!=='number'||!Number.isFinite(n))))))throw Error('INVALID_MODEL_DEPENDENCY');
 if(a.fileHash&&(!HASH.test(a.fileHash)||!Number.isInteger(a.size)||a.size!<=0||a.size!>50*CHUNK_SIZE||typeof a.fileName!=='string'||! /\.(kicad_sym|kicad_mod|lib|step|stp|wrl)$/i.test(a.fileName)))throw Error('INVALID_FILE');
}
export function createDesignAssetStore(provider:()=>NeonQueryFunction<false,false>=()=>{if(!process.env.DATABASE_URL)throw Error('DATABASE_NOT_CONFIGURED');return neon(process.env.DATABASE_URL);}){
let schema:Promise<void>|undefined;
const sql=provider;
async function ensure(){if(!schema)schema=(async()=>{const q=sql();
 await q`CREATE TABLE IF NOT EXISTS eda_design_chunks (tenant_id TEXT NOT NULL, hash TEXT NOT NULL, idx INTEGER NOT NULL, chunk_hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant_id,hash,idx))`;
 await q`CREATE TABLE IF NOT EXISTS eda_design_files (tenant_id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(tenant_id,hash))`;
 await q`CREATE TABLE IF NOT EXISTS eda_design_assets (tenant_id TEXT NOT NULL, id TEXT NOT NULL, mpn TEXT NOT NULL, manufacturer TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CANDIDATE', revision INTEGER NOT NULL DEFAULT 0, asset JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id))`;
 await q`CREATE INDEX IF NOT EXISTS eda_design_identity ON eda_design_assets(tenant_id,mpn,manufacturer,kind)`;
 await q`CREATE TABLE IF NOT EXISTS eda_design_origins (tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, origin_id TEXT NOT NULL, origin JSONB NOT NULL, PRIMARY KEY(tenant_id,asset_id,origin_id), FOREIGN KEY(tenant_id,asset_id) REFERENCES eda_design_assets(tenant_id,id))`;
 await q`CREATE TABLE IF NOT EXISTS eda_design_reviews (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, action TEXT NOT NULL, revision INTEGER NOT NULL, snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
 })().catch(e=>{schema=undefined;throw e;});await schema;}

async function putChunk(tenant:string,hash:string,index:number,bytes:Uint8Array){
 validHash(hash);if(!Number.isInteger(index)||index<0||index>=50||!bytes.length||bytes.length>CHUNK_SIZE)throw Error('INVALID_CHUNK');
 await ensure();const q=sql(),chunkHash=await sha256(bytes);
 const rows=await q`INSERT INTO eda_design_chunks(tenant_id,hash,idx,chunk_hash,data) VALUES(${tenant},${hash},${index},${chunkHash},${Buffer.from(bytes).toString('base64')}) ON CONFLICT(tenant_id,hash,idx) DO UPDATE SET chunk_hash=eda_design_chunks.chunk_hash RETURNING chunk_hash`;
 if(rows[0].chunk_hash!==chunkHash)throw Error('CHUNK_CONFLICT');return {hash,index};
}
async function verifyFile(tenant:string,asset:DesignAsset){
 const hash=asset.fileHash!;validHash(hash);const q=sql();
 const known=await q`SELECT size,kind,fingerprint FROM eda_design_files WHERE tenant_id=${tenant} AND hash=${hash}`;
 if(known[0]?.size===asset.size&&known[0]?.kind===asset.kind&&known[0]?.fingerprint===asset.fingerprint)return;
 const chunks=await q`SELECT idx,data FROM eda_design_chunks WHERE tenant_id=${tenant} AND hash=${hash} ORDER BY idx`;
 if(!chunks.length||chunks.some((r,i)=>r.idx!==i))throw Error('FILE_CHUNKS_MISSING');
 const bytes=new Uint8Array(Buffer.concat(chunks.map(r=>Buffer.from(r.data,'base64'))));
 if(bytes.length!==asset.size||await sha256(bytes)!==hash)throw Error('FILE_HASH_MISMATCH');
 if(await fingerprint(asset.kind,bytes)!==asset.fingerprint)throw Error('ASSET_FINGERPRINT_MISMATCH');
 await q`INSERT INTO eda_design_files(tenant_id,hash,size,chunks,kind,fingerprint) VALUES(${tenant},${hash},${bytes.length},${chunks.length},${asset.kind},${asset.fingerprint}) ON CONFLICT DO NOTHING`;
}

async function stageAsset(tenant:string,input:DesignAsset,storage:'file'|'official'){
 validateAsset(input);if(!['file','official'].includes(storage))throw Error('INVALID_STORAGE');await ensure();
 const asset:DesignAsset={id:'',kind:input.kind,name:input.name,mpn:input.mpn.trim(),manufacturer:input.manufacturer.trim(),identityConfirmed:true,fingerprint:input.fingerprint,origins:input.origins,warnings:[],format:input.format,dependencies:input.dependencies};
 if(storage==='official'){
  const official=await checkOfficial(asset.kind,asset.name,undefined,input.official?.revision??'master');if(!['found','match'].includes(official.status)||!official.fingerprint)throw Error('OFFICIAL_REFERENCE_NOT_VERIFIED');
  if(input.official?.fingerprint&&input.official.fingerprint!==official.fingerprint)throw Error('OFFICIAL_VERSION_CHANGED');
  asset.official=official;asset.fingerprint=official.fingerprint;asset.format='official-reference';
 }else{
  if(!input.fileHash)throw Error('EXTRACT_FILE_FIRST');asset.fileHash=input.fileHash;asset.fileName=input.fileName;asset.size=input.size;
  await verifyFile(tenant,asset);
  asset.official=await checkOfficial(asset.kind,asset.name,asset.fingerprint);
 }
 asset.id=await candidateId(asset);const q=sql();
 const snapshot:AssetRecord={...asset,origins:[],storage,status:'CANDIDATE',revision:0,sourceUrl:'',license:'',reviewNote:''};
 const existing=await q`SELECT id FROM eda_design_assets WHERE tenant_id=${tenant} AND id=${asset.id}`;
 const origins=await Promise.all(asset.origins.map(async o=>({o,id:await sha256(new TextEncoder().encode(originKey(o)))})));
 await q.transaction([
  q`INSERT INTO eda_design_assets(tenant_id,id,mpn,manufacturer,kind,asset) VALUES(${tenant},${asset.id},${asset.mpn.toUpperCase()},${asset.manufacturer.toUpperCase()},${asset.kind},${JSON.stringify(snapshot)}::jsonb) ON CONFLICT DO NOTHING`,
  ...origins.map(({o,id})=>q`INSERT INTO eda_design_origins(tenant_id,asset_id,origin_id,origin) VALUES(${tenant},${asset.id},${id},${JSON.stringify(o)}::jsonb) ON CONFLICT DO NOTHING`)
 ]);
 return {id:asset.id,duplicate:!!existing.length};
}
async function listAssets(tenant:string,query:string,offset:number){
 await ensure();if(!Number.isInteger(offset)||offset<0)throw Error('INVALID_OFFSET');const q=sql();
 const rows=await q`SELECT a.asset,a.status,a.revision,(SELECT count(*)::int FROM eda_design_assets v WHERE v.tenant_id=a.tenant_id AND v.mpn=a.mpn AND v.manufacturer=a.manufacturer AND v.kind=a.kind) AS variants,(SELECT count(*)::int FROM eda_design_origins o WHERE o.tenant_id=a.tenant_id AND o.asset_id=a.id) AS occurrences,COALESCE((SELECT jsonb_agg(x.origin) FROM (SELECT o.origin FROM eda_design_origins o WHERE o.tenant_id=a.tenant_id AND o.asset_id=a.id ORDER BY o.origin_id LIMIT 40) x),'[]'::jsonb) AS origins FROM eda_design_assets a WHERE a.tenant_id=${tenant} AND (${query}='' OR a.mpn LIKE ${'%'+query.toUpperCase()+'%'}) ORDER BY a.mpn,a.manufacturer,a.kind,a.id LIMIT 101 OFFSET ${offset}`;
 return {assets:rows.slice(0,100).map(r=>({...r.asset,status:r.status,revision:r.revision,origins:r.origins,occurrences:r.occurrences,variants:r.variants})),nextOffset:rows.length>100?offset+100:null};
}
async function fileInfo(tenant:string,hash:string){validHash(hash);await ensure();const rows=await sql()`SELECT size,chunks FROM eda_design_files WHERE tenant_id=${tenant} AND hash=${hash}`;return rows[0];}
async function fileChunk(tenant:string,hash:string,index:number){validHash(hash);await ensure();const q=sql();if(!Number.isInteger(index)||index<0||index>=50)throw Error('INVALID_CHUNK');
 const rows=await q`SELECT c.data,f.size,f.chunks FROM eda_design_chunks c JOIN eda_design_files f ON c.tenant_id=f.tenant_id AND c.hash=f.hash WHERE c.tenant_id=${tenant} AND c.hash=${hash} AND c.idx=${index}`;
 if(!rows.length)throw Error('FILE_NOT_FOUND');return rows[0];
}
async function reviewAsset(tenant:string,id:string,revision:number,action:string,details:{sourceUrl:string;license:string;reviewNote:string;acknowledge:boolean}){
 validHash(id);if(!Number.isInteger(revision)||!['approve','reject'].includes(action))throw Error('INVALID_REVIEW');
 if(!details||typeof details.reviewNote!=='string'||details.reviewNote.length>2000||typeof details.sourceUrl!=='string'||details.sourceUrl.length>2000||typeof details.license!=='string'||details.license.length>200)throw Error('INVALID_REVIEW');
 if(action==='approve'&&(!details.acknowledge||!details.license.trim()||!details.sourceUrl.trim()))throw Error('REVIEW_SOURCE_AND_LICENSE_REQUIRED');
 await ensure();const q=sql();const status=action==='approve'?'APPROVED':'REJECTED';const patch={sourceUrl:details.sourceUrl,license:details.license,reviewNote:details.reviewNote,status,revision:revision+1};
 const changed=await q`WITH changed AS (UPDATE eda_design_assets SET status=${status},revision=revision+1,asset=asset || ${JSON.stringify(patch)}::jsonb,updated_at=now() WHERE tenant_id=${tenant} AND id=${id} AND revision=${revision} RETURNING id,revision,asset) INSERT INTO eda_design_reviews(tenant_id,asset_id,action,revision,snapshot) SELECT ${tenant},id,${action},revision,asset FROM changed RETURNING revision`;
 if(!changed.length)throw Error('REVISION_CONFLICT');return {status,revision:changed[0].revision};
}

return {putChunk,stageAsset,listAssets,fileChunk,fileInfo,reviewAsset};
}
export const {putChunk,stageAsset,listAssets,fileChunk,fileInfo,reviewAsset}=createDesignAssetStore();
