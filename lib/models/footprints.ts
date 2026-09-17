import type {InputAsset,PcbIr} from '../eda/types';
import {decompress} from 'fzstd';
import {altiumEmbeddedModels} from '../eda/altium-models';
const embeddedCache = new WeakMap<InputAsset, InputAsset[]>();
export function embeddedModels(source:InputAsset):InputAsset[]{
 const cached = embeddedCache.get(source); if(cached)return cached;
 const result = readEmbeddedModels(source); embeddedCache.set(source,result); return result;
}
function readEmbeddedModels(source:InputAsset):InputAsset[]{
 if(/\.pcbdoc$/i.test(source.path))return altiumEmbeddedModels(source);
 const text=new TextDecoder().decode(source.bytes),result:InputAsset[]=[];
 // KiCad embeds Base64-encoded Zstandard frames between pipe delimiters.
 const expression=/\(file\s+\(name\s+"([^"\n]+)"\)\s+\(type\s+[^)]+\)\s+\(data\s+\|([A-Za-z0-9+/=\s]+)\|\s*\)/g;
 let total=0;
 for(const match of text.matchAll(expression)){
  if(!/\.(step|stp|wrl)$/i.test(match[1]))continue;
  const base64=match[2].replace(/\s/g,'');if(base64.length>30*1024*1024)throw Error('嵌入模型过大');
  const packed=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  // Reject oversized frames before the decoder allocates output/window buffers.
  if(packed.length<6 || new DataView(packed.buffer).getUint32(0,true)!==0xfd2fb528)throw Error('无效 Zstandard 模型');
  const descriptor=packed[4],single=(descriptor>>5)&1,flag=descriptor>>6;
  let cursor=5;
  if(!single){const window=packed[cursor++];if(2**(10+(window>>3))*(1+(window&7)/8)>50*1024*1024)throw Error('嵌入模型窗口过大');}
  cursor += [0,1,2,4][descriptor&3];
  const count=flag===0?single:2**flag;
  let size=0;for(let i=0;i<count;i++)size+=packed[cursor+i]*2**(8*i);
  if(count===2)size+=256;
  if(!count || !Number.isFinite(size) || size>50*1024*1024 || total+size>150*1024*1024)throw Error('嵌入模型展开体积过大');
  const data=decompress(packed);total+=data.length;if(data.length>50*1024*1024||total>150*1024*1024)throw Error('嵌入模型超出容量限制');
  result.push({path:'kicad-embed://'+match[1],bytes:data});
 }
 return result;
}
function normalize(path:string){const out:string[]=[];for(const p of path.replace(/\\/g,'/').split('/')){if(p==='..')out.pop();else if(p&&p!=='.')out.push(p);}return out.join('/');}
export function resolveModelPath(path:string,pcb:PcbIr,assets:InputAsset[]):{asset?:InputAsset;official?:string;espressif?:string;ambiguous?:boolean;matchedBy?:string}{
 const dir=(pcb.sourceRefs[0]?.path??'').replace(/[^/]+$/,'');
 if(path.startsWith('kicad-embed://')||path.startsWith('altium-embed://'))return {asset:assets.find(a=>a.path===path)};
 const clean=path.replace(/\\/g,'/');
 const official=clean.match(/^\$\{(?:KICAD(?:\d+)?_3DMODEL_DIR|KISYS3DMOD)\}\/([^/]+\.3dshapes\/.+)$/)?.[1];
 const espressif=clean.match(/^\$\{KICAD\d*_3RD_PARTY\}\/3dmodels\/com_github_espressif_kicad-libraries\/espressif\.3dshapes\/([^/]+\.(?:step|stp|wrl))$/i)?.[1];
 const models=assets.filter(a=>/\.(step|stp|wrl)$/i.test(a.path));
 const normalized=(v:string)=>normalize(v).toLowerCase();
 const local=normalized(clean.replace(/^\$\{KIPRJMOD\}\//,dir));
 for(const target of [local,normalized(dir+clean)]){
  const exact=models.filter(a=>normalized(a.path)===target);
  if(exact.length===1)return {asset:exact[0],official,espressif};
  if(exact.length>1)return {ambiguous:true,official,espressif};
 }
 // Search the uploaded project only, from the longest surviving suffix down to
 // the filename. This handles relocated Windows paths and project-local folders.
 const pieces=clean.replace(/^\$\{[^}]+\}\//,'').split('/').filter(Boolean);
 for(let i=0;i<pieces.length;i++){
  const tail=normalized(pieces.slice(i).join('/'));
  const matches=models.filter(a=>normalized(a.path)===tail||normalized(a.path).endsWith('/'+tail));
  if(matches.length===1)return {asset:matches[0],official,espressif,matchedBy:i===pieces.length-1?"filename":"suffix"};
  if(matches.length>1)return {ambiguous:true,official,espressif};
 }
 // STEP and STP are alternative extensions, not different model formats.
 const name=pieces.at(-1)?.replace(/\.(step|stp)$/i,'');
 if(name&&/\.(step|stp)$/i.test(clean)){
  const matches=models.filter(a=>/\.(step|stp)$/i.test(a.path)&&a.path.split('/').at(-1)?.replace(/\.(step|stp)$/i,'').toLowerCase()===name.toLowerCase());
  if(matches.length===1)return {asset:matches[0],official,espressif,matchedBy:"filename"};
  if(matches.length>1)return {ambiguous:true,official,espressif};
 }
 return {official,espressif};
}
