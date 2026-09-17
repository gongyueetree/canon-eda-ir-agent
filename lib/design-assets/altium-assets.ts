import type { CanonicalIrBundle,PartIr,PcbIr,InputAsset,IrPoint } from '../eda/types';
import { parse,footprintFile } from './kicad';
const q=JSON.stringify,enc=new TextEncoder();
const n=(value:number)=>{if(!Number.isFinite(value))throw Error('无效源坐标');return String(Number(value.toFixed(7)));};
export const altiumAssetWarning='由 Altium 已解析的源几何转换为 KiCad 候选库；未覆盖的特殊图元、隐藏引脚及电气类型须人工复核，不代表完整工程无损转换。';
export function altiumSymbol(bundle:CanonicalIrBundle,part:PartIr,name:string):InputAsset|undefined{
 if(!part.sourceRefs.some(r=>/\.schdoc$/i.test(r.path)))return;
 const bodies:string[]=[];const bounds:Array<{x:number;y:number}>=[];
 for(const unit of part.symbolUnits){
  const sch=bundle.schematics.find(s=>s.symbolInstanceIds.includes(unit.id));if(!sch)continue;
  const pins=sch.pins.filter(p=>p.symbolUnitId===unit.id);
  if(!pins.length||pins.some(p=>!p.bodyPosition))continue;
  const anchor=unit.position??pins[0].position;
  const local=(p:IrPoint)=>({x:Number(p.x)-Number(anchor.x),y:Number(anchor.y)-Number(p.y)});
  bounds.push(...pins.map(p=>local(p.position)),...(sch.graphics??[]).filter(g=>g.symbolUnitId===unit.id).flatMap(g=>g.points.map(local)));
  const graphics=(sch.graphics??[]).filter(g=>g.symbolUnitId===unit.id&&!pins.some(p=>p.id===g.id)).map(g=>`(polyline (pts ${g.points.map(p=>{const v=local(p);return `(xy ${n(v.x)} ${n(v.y)})`;}).join(' ')}) (stroke (width 0.15) (type default)) (fill (type none)))`);
  const pinNodes=pins.map(p=>{
   const a=local(p.position),b=local(p.bodyPosition!),angle=(Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI+360)%360;
   const length=Math.hypot(b.x-a.x,b.y-a.y);
   return `(pin unspecified line (at ${n(a.x)} ${n(a.y)} ${n(angle)}) (length ${n(length)}) ${p.hidden?'hide':''} (name ${q(p.name||'~')} (effects (font (size 1.27 1.27)))) (number ${q(p.number)} (effects (font (size 1.27 1.27)))))`;
  });
  bodies.push(`(symbol ${q(name+'_'+unit.unit+'_1')} ${graphics.join(' ')} ${pinNodes.join(' ')})`);
 }
 if(!bodies.length)return;
 const top=Math.max(...bounds.map(p=>p.y)),cx=(Math.min(...bounds.map(p=>p.x))+Math.max(...bounds.map(p=>p.x)))/2;
 const reference=part.reference.replace(/\d+$/,'')||'U';
 return {path:name+'.kicad_sym',bytes:enc.encode(`(kicad_symbol_lib (version 20211014) (generator refir) (symbol ${q(name)} (pin_names (offset 0.508)) (property "Reference" ${q(reference)} (at ${n(cx)} ${n(top+3)} 0) (effects (font (size 1.27 1.27)))) (property "Value" ${q(name)} (at ${n(cx)} ${n(top+1.5)} 0) (effects (font (size 1.27 1.27)))) ${bodies.join(' ')}))`)};
}
export function altiumFootprint(pcb:PcbIr,fp:PcbIr['footprints'][number]):InputAsset|undefined{
 if(!/\.pcbdoc$/i.test(fp.sourceRef.path)||!fp.position)return;
 const pads=pcb.pads.filter(p=>p.footprintId===fp.id);if(!pads.length)return;
 const angle=Number(fp.rotation)*Math.PI/180;
 const local=(p:IrPoint)=>{const x=Number(p.x)-Number(fp.position!.x),y=Number(p.y)-Number(fp.position!.y);return {x:x*Math.cos(angle)-y*Math.sin(angle),y:x*Math.sin(angle)+y*Math.cos(angle)};};
 const nodes=pads.map(p=>{
  if(!p.position||!p.size||![p.size.x,p.size.y].every(v=>Number(v)>0)||!['circle','oval','rect'].includes(p.shape))throw Error('封装包含未支持或缺少尺寸的焊盘，无法生成真实候选');
  const v=local(p.position);const through=/thru_hole/.test(p.padType);
  const layers=through?['*.Cu','*.Mask']:p.layers.filter(l=>/^[FB]\.Cu$/.test(l)).flatMap(l=>[l,l.replace('.Cu','.Paste'),l.replace('.Cu','.Mask')]);
  if(!layers.length)throw Error('焊盘铜层未能映射，需原始库文件');
  const drill=p.drill?`(drill ${p.drill.x===p.drill.y?n(Number(p.drill.x)):'oval '+n(Number(p.drill.x))+' '+n(Number(p.drill.y))})`:'';
  return `(pad ${q(p.number)} ${p.padType} ${p.shape} (at ${n(v.x)} ${n(v.y)} ${n(Number(p.rotation??0)-Number(fp.rotation))}) (size ${n(Number(p.size.x))} ${n(Number(p.size.y))}) ${drill} (layers ${layers.map(v=>q(v)).join(' ')}) ${p.shape==='roundrect'?'(roundrect_rratio 0.25)':''})`;
 });
 const models=(fp.models??[]).map(m=>`(model ${q(m.path)} (offset (xyz ${m.offset.map(n).join(' ')})) (scale (xyz ${m.scale.map(n).join(' ')})) (rotate (xyz ${m.rotation.map(n).join(' ')})))`);
 const name=fp.libraryIdentifier||fp.value||fp.reference;
 const root=parse(`(footprint ${q(name)} (layer "${fp.side==='back'?'B':'F'}.Cu") (at 0 0 0) (property "Reference" "REF**" (at 0 -3 0) (layer "F.SilkS")) (property "Value" ${q(name)} (at 0 3 0) (layer "F.Fab")) ${nodes.join(' ')} ${models.join(' ')})`);
 return {path:name.split(':').at(-1)+'.kicad_mod',bytes:enc.encode(footprintFile(root))};
}
