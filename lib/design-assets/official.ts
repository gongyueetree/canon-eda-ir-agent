import { boundedBody } from '../allegro-http';
import { atom,childValue,directChildren } from '../eda/sexpr';
import { fingerprint, footprintFile, parse, symbolDefinition, symbolFile } from './kicad';
import type { AssetKind, OfficialMatch } from './types';
const BASE='https://gitlab.com/api/v4/projects/';
type Target={repo:string;path:string;entry?:string};
export function officialTarget(kind:AssetKind,name:string):Target|undefined{
 if(kind==='model'){
  const path=name.replace(/^\$\{(?:KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}\//,'');
  if(!/^[A-Za-z0-9_.+-]+\.3dshapes\/[A-Za-z0-9_.+()-]+\.(step|stp|wrl)$/i.test(path))return;
  return {repo:'kicad-packages3D',path};
 }
 const split=name.indexOf(':');if(split<1)return;const lib=name.slice(0,split),entry=name.slice(split+1);
 if(!/^[\w.+-]+$/.test(lib)||!entry||entry.length>200||/[\\/\x00-\x1f]/.test(entry)||entry.includes('..'))return;
 return kind==='symbol'?{repo:'kicad-symbols',path:`${lib}.kicad_symdir/${entry}.kicad_sym`,entry}:{repo:'kicad-footprints',path:`${lib}.pretty/${entry}.kicad_mod`};
}
type RepoFile={content?:string;content_sha256:string;commit_id:string};
const cache=new Map<string,{at:number;promise:Promise<RepoFile|null>}>();
async function repositoryFile(target:Target,model:boolean,revision='master'):Promise<RepoFile|null>{
 const url=BASE+encodeURIComponent('kicad/libraries/'+target.repo)+'/repository/files/'+encodeURIComponent(target.path)+'?ref='+encodeURIComponent(revision);
 const key=(model?'HEAD:':'GET:')+url,old=cache.get(key);if(old&&Date.now()-old.at<3600_000)return old.promise;
 const promise=(async()=>{
  const response=await fetch(url,{method:model?'HEAD':'GET',signal:AbortSignal.timeout(15000),redirect:'error'});
  if(response.status===404){await response.body?.cancel();return null;}
  if(!response.ok){await response.body?.cancel();throw Error('官方库查询 HTTP '+response.status);}
  if(model){const hash=response.headers.get('x-gitlab-content-sha256'),commit=response.headers.get('x-gitlab-commit-id');if(!hash||!commit)throw Error('官方库未返回可验证的内容指纹');return {content_sha256:hash,commit_id:commit};}
  const data=JSON.parse(new TextDecoder().decode(await boundedBody(response.body,16*1024*1024))) as RepoFile;
  if(!data.content||!data.content_sha256||!data.commit_id)throw Error('官方库响应不完整');return data;
 })().catch(e=>{cache.delete(key);throw e;});
 cache.set(key,{at:Date.now(),promise});if(cache.size>24)cache.delete(cache.keys().next().value!);return promise;
}
async function resolvedSymbol(target:Target,revision='master'){
 let used=target;let record=await repositoryFile(target,false,revision);
 if(!record){used={...target,path:target.path.split('.kicad_symdir/')[0]+'.kicad_sym'};record=await repositoryFile(used,false,revision);}
 if(!record?.content)return;
 const root=parse(Buffer.from(record.content,'base64').toString('utf8'));
 let current=target.entry!;const seen=new Set<string>();
 for(let depth=0;depth<16;depth++){
  if(seen.has(current))throw Error('SYMBOL_INHERITANCE_CYCLE');seen.add(current);
  const def=directChildren(root,'symbol').find(n=>atom(n.items[1])===current);if(!def)break;
  const parent=childValue(def,'extends');if(!parent)break;
  if(!directChildren(root,'symbol').some(n=>atom(n.items[1])===parent)){
   if(/[\\/]/.test(parent)||parent.includes('..'))throw Error('INVALID_SYMBOL_PARENT');
   const parentTarget={...target,path:target.path.replace(/[^/]+$/,parent+'.kicad_sym'),entry:parent};
   const dependency=await repositoryFile(parentTarget,false,record.commit_id);if(!dependency?.content)throw Error('SYMBOL_PARENT_MISSING');
   root.items.push(...directChildren(parse(Buffer.from(dependency.content,'base64').toString('utf8')),'symbol'));
  }
  current=parent;
 }
 return {record,target:used,root,body:symbolDefinition(root,target.entry!)};
}
export async function checkOfficial(kind:AssetKind,name:string,localFingerprint?:string,revision='master'):Promise<OfficialMatch>{
 if(revision!=='master'&&!/^[a-f0-9]{40}$/.test(revision))return {name,status:'unknown',message:'无效的官方库版本'};
 let target=officialTarget(kind,name);if(!target)return {name,status:'unmapped',message:'没有可核对的 KiCad 官方库标识'};
 try{
  const symbol=kind==='symbol'?await resolvedSymbol(target,revision):undefined;
  const record=kind==='symbol'?symbol?.record:await repositoryFile(target,kind==='model',revision);
  if(!record)return {name,status:'missing',message:'KiCad 官方库未找到此项'};
  let hash=record.content_sha256;
  if(kind==='symbol'){
   if(!symbol?.body)return {name,status:'missing',message:'官方符号库中没有此符号'};
   target=symbol.target;hash=await fingerprint(kind,new TextEncoder().encode(symbolFile(symbol.body,childValue(symbol.root,'version'))));
  }else if(kind==='footprint'){
   const root=parse(Buffer.from(record.content!,'base64').toString('utf8'));
   hash=await fingerprint(kind,new TextEncoder().encode(footprintFile(root,childValue(root,'version'))));
  }
  return {name,status:localFingerprint?(localFingerprint===hash?'match':'different'):'found',fingerprint:hash,sha256:record.content_sha256,revision:record.commit_id,url:`https://gitlab.com/kicad/libraries/${target.repo}/-/blob/${record.commit_id}/${target.path}`,message:localFingerprint&&localFingerprint!==hash?'同名官方资产存在，但工程内容有差异；保留工程版本供审核':undefined};
 }catch(e){return {name,status:'unknown',message:e instanceof Error?e.message:String(e)};}
}
export async function officialFile(kind:AssetKind,name:string,revision:string){
 const target=officialTarget(kind,name);if(!target||! /^[a-f0-9]{40}$/.test(revision))throw Error('INVALID_OFFICIAL_REFERENCE');
 if(kind==='model')return {url:`https://gitlab.com/kicad/libraries/${target.repo}/-/raw/${revision}/${target.path}`};
 if(kind==='symbol'){const result=await resolvedSymbol(target,revision);if(!result?.body)throw Error('OFFICIAL_SYMBOL_MISSING');return {text:symbolFile(result.body,childValue(result.root,'version'))};}
 const record=await repositoryFile(target,false,revision);if(!record?.content)throw Error('OFFICIAL_FILE_MISSING');
 const root=parse(Buffer.from(record.content,'base64').toString('utf8'));return {text:footprintFile(root,childValue(root,'version'))};
}
