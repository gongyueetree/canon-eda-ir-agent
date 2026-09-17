import * as CFB from "cfb";
import { Unzlib } from "fflate";
import type { InputAsset, PcbIr } from "./types";
import { altiumBlocks, altiumProperties } from "./altium-records";

type Stream = (name: string) => Uint8Array;
const mm = (s = "0") => Number.parseFloat(s) * (/mm$/i.test(s) ? 1 : .0254);
const truth = (s?: string) => s === "TRUE" || s === "T";
const key = (s: string) => s.trim().toUpperCase();
const pathFor = (id: string) => `altium-embed://${encodeURIComponent(key(id))}.step`;

/** Body coordinates are absolute AD coordinates. Normalize them to the same
 * local KiCad convention used by placeFootprintModel, including bottom faces.
 * Format reference: KiCad Altium ComponentBodies6 importer.
 */
export function attachAltiumModels(stream: Stream, pcb: PcbIr) {
  const catalog = new Map(altiumBlocks(stream("Models/Data")).map(altiumProperties).filter(p=>p.ID).map(p=>[key(p.ID),p]));
  const bytes = stream("ComponentBodies6/Data");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pending: Array<{fp: PcbIr["footprints"][number]; model: NonNullable<PcbIr["footprints"][number]["models"]>[number]}> = [];
  let offset = 0, skipped = 0;
  while(offset < bytes.length) {
    if(offset+5>bytes.length || bytes[offset++]!==12) throw Error("无效 ComponentBodies6 记录");
    const length=view.getUint32(offset,true)&0xffffff; offset+=4;
    if(length<22 || offset+length>bytes.length) throw Error("截断的 ComponentBodies6 记录");
    const component=view.getUint16(offset+7,true), propsLength=view.getUint32(offset+18,true)&0xffffff;
    if(propsLength>length-22) throw Error("截断的 Body 属性");
    const p=altiumProperties(bytes.subarray(offset+22,offset+22+propsLength)); offset+=length;
    const fp=pcb.footprints[component], model=catalog.get(key(p.MODELID||""));
    if(!fp || !model || !truth(p["MODEL.EMBED"]) || !truth(model.EMBED)) {skipped++;continue;}
    let dx=mm(p["MODEL.2D.X"])-Number(fp.position?.x??0);
    let dy=mm(p["MODEL.2D.Y"])+Number(fp.position?.y??0);
    let dz=mm(p["MODEL.3D.DZ"]), rx=Number(p["MODEL.3D.ROTX"]||0), rz=Number(p["MODEL.3D.ROTZ"]||0);
    const ry=Number(p["MODEL.3D.ROTY"]||0), bottom=fp.side==="back";
    const angle=Number(fp.rotation)*(bottom?-1:1), radians=-angle*Math.PI/180;
    if(bottom) dy=-dy;
    if((p.BODYPROJECTION==="1")!==bottom){rx+=180;rz=-rz;dz=-Number(pcb.physicalDimensions?.thickness??1.6)-dz;}
    [dx,dy]=[dx*Math.cos(radians)-dy*Math.sin(radians),dx*Math.sin(radians)+dy*Math.cos(radians)];
    const rotation=[-rx,-ry,-rz+Number(p["MODEL.2D.ROTATION"]||0)+angle];
    if(![dx,dy,dz,...rotation].every(Number.isFinite)) throw Error("无效模型坐标");
    pending.push({fp,model:{path:pathFor(p.MODELID),offset:[dx,dy,dz],rotation,scale:[1,1,1],hidden:false}});
  }
  for(const {fp,model} of pending) (fp.models??=[]).push(model);
  return {attached:pending.length,skipped};
}

export function unpackAltiumModel(packed: Uint8Array, limit=32*1024*1024): Uint8Array {
  let size=0; const chunks: Uint8Array[]=[];
  const unzip=new Unzlib(chunk=>{size+=chunk.length;if(size>limit)throw Error("AD 模型展开体积超限");chunks.push(chunk);});
  for(let i=0;i<packed.length;i+=1024) unzip.push(packed.subarray(i,i+1024),i+1024>=packed.length);
  if(!size)throw Error("空 AD 模型");
  const result=new Uint8Array(size);let cursor=0;for(const chunk of chunks){result.set(chunk,cursor);cursor+=chunk.length;}
  if(!new TextDecoder().decode(result.subarray(0,512)).includes("ISO-10303-21"))throw Error("AD 嵌入模型不是受支持的 STEP 文件");
  return result;
}

export function altiumEmbeddedModels(source: InputAsset): InputAsset[] {
  if(source.bytes.length>64*1024*1024)throw Error("AD 容器超过 64 MiB");
  const c=CFB.read(source.bytes,{type:"array"});
  const stream:Stream=name=>{const i=c.FullPaths.findIndex(p=>p.toLowerCase().endsWith("/"+name.toLowerCase()));return i<0?new Uint8Array():new Uint8Array(c.FileIndex[i].content as Uint8Array);};
  let total=0;
  return altiumBlocks(stream("Models/Data")).map(altiumProperties).flatMap((p,index)=>{
    if(!p.ID || !truth(p.EMBED))return [];
    const packed=stream("Models/"+index);if(!packed.length)return [];
    const bytes=unpackAltiumModel(packed,Math.min(32*1024*1024,150*1024*1024-total));total+=bytes.length;
    return [{path:pathFor(p.ID),bytes}];
  });
}
