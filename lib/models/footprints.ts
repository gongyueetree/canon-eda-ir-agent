import type {InputAsset,PcbIr} from '../eda/types';
import {decompress} from 'fzstd';
export function embeddedModels(source:InputAsset):InputAsset[]{
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
export function resolveModelPath(path:string,pcb:PcbIr,assets:InputAsset[]):{asset?:InputAsset;official?:string}{
 const dir=(pcb.sourceRefs[0]?.path??'').replace(/[^/]+$/,'');
 if(path.startsWith('kicad-embed://'))return {asset:assets.find(a=>a.path===path)};
 const official=path.match(/^\$\{(?:KICAD(?:\d+)?_3DMODEL_DIR|KISYS3DMOD)\}\/([^/]+\.3dshapes\/.+)$/)?.[1];
 if(official)return {asset:assets.find(a=>a.path.endsWith('/'+official)||a.path===official),official};
 const local=normalize(path.replace(/^\$\{KIPRJMOD\}\//,dir));
 return {asset:assets.find(a=>normalize(a.path)===local)??assets.find(a=>normalize(a.path)===normalize(dir+path))};
}
