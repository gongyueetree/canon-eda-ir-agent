import { apiFetch } from '../client-api';
import { boundedBody } from '../allegro-http';
import { sha256 } from '../eda/util';
import type { AssetRecord,ExtractedAsset } from './types';
import type { InputAsset } from '../eda/types';
async function json(response:Response){const data=await response.json();if(!response.ok)throw Error(data.error||'REQUEST_FAILED');return data;}
export async function stageCandidate(asset:ExtractedAsset,storage:'file'|'official',progress?:(message:string)=>void):Promise<{id:string;duplicate:boolean}>{
 if(storage==='file'){
  const probe=asset.official??(await json(await fetch('/api/design-assets/official',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([{kind:asset.kind,name:asset.name,fingerprint:asset.file?asset.fingerprint:undefined}])}))).results[0];
  if(probe.status==='match')return stageCandidate({...asset,official:probe},'official',progress);
  if(!asset.file||!asset.fileHash)throw Error('没有可提取的源文件');
  const exists=await apiFetch(`/api/design-assets/blobs?hash=${asset.fileHash}`,{method:'HEAD'});
  if(!exists.ok&&exists.status!==404)throw Error('请检查工作区密钥及数据库配置');
  if(!exists.ok)for(let start=0;start<asset.file.bytes.length;start+=1024*1024){progress?.(`上传 ${Math.min(start+1024*1024,asset.file.bytes.length)}/${asset.file.bytes.length} 字节`);await json(await apiFetch(`/api/design-assets/blobs?hash=${asset.fileHash}&index=${start/(1024*1024)}`,{method:'POST',body:new Blob([asset.file.bytes.slice(start,start+1024*1024) as Uint8Array<ArrayBuffer>])}));}
 }
 const {file:_,...metadata}=asset;void _;
 return json(await apiFetch('/api/design-assets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({asset:metadata,storage})}));
}
export async function candidateFile(asset:ExtractedAsset|AssetRecord):Promise<InputAsset>{
 if('file' in asset&&asset.file)return asset.file;
 if(asset.fileHash){
  const chunks:Uint8Array[]=[];let count=1;
  for(let i=0;i<count;i++){const r=await apiFetch(`/api/design-assets/blobs?hash=${asset.fileHash}&index=${i}`);if(!r.ok)throw Error('资产文件读取失败');count=Number(r.headers.get('X-File-Chunks'));if(!Number.isInteger(count)||count<1||count>50)throw Error('INVALID_CHUNK_COUNT');chunks.push(await boundedBody(r.body,1024*1024));}
  const size=chunks.reduce((n,c)=>n+c.length,0),bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  if(await sha256(bytes)!==asset.fileHash)throw Error('FILE_HASH_MISMATCH');return {path:asset.fileName!,bytes};
 }
 if(asset.kind==='model'&&!asset.official){
  const checked=await json(await fetch('/api/design-assets/official',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([{kind:asset.kind,name:asset.name}])}));
  const official=checked.results?.[0];
  if(official?.revision&&['match','found'].includes(official.status))return candidateFile({...asset,official});
  throw Error(official?.message||'官方库没有可用模型，请补充工程引用的原始 3D 文件');
 }
 if(asset.official?.revision&&['match','found'].includes(asset.official.status)){
  const r=await fetch('/api/design-assets/official?'+new URLSearchParams({kind:asset.kind,name:asset.name,revision:asset.official.revision}));if(!r.ok)throw Error('官方资产下载失败');
  return {path:asset.kind==='model'?asset.name.split('/').at(-1)!:asset.kind==='symbol'?'official.kicad_sym':'official.kicad_mod',bytes:await boundedBody(r.body,50*1024*1024)};
 }
 throw Error('没有可预览的文件，请重新导入源工程或补充缺失文件');
}
export async function downloadCandidate(asset:ExtractedAsset|AssetRecord){const file=await candidateFile(asset);const url=URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>]));const a=document.createElement('a');a.href=url;a.download=file.path.split('/').at(-1)!;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
