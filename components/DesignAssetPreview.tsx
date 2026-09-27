"use client";
import { Box,Cpu,CircuitBoard } from 'lucide-react';
import { useEffect,useState } from 'react';
import type { AssetRecord,ExtractedAsset } from '../lib/design-assets/types';
import type { CanonicalIrBundle,InputAsset } from '../lib/eda/types';
import { candidateFile } from '../lib/design-assets/client';
import { a,parse,serialize } from '../lib/design-assets/kicad';
import { allDescendants,atom,childValue,directChildren,firstChild } from '../lib/eda/sexpr';
import { parseEdaProject } from '../lib/eda/parse';
import { SchematicViewer,PcbViewer } from './EdaViewers';
import { AssemblyScene } from './AssemblyScene';
const pinTypeLabels:Record<string,string>={input:'输入',output:'输出',bidirectional:'双向',tri_state:'三态',passive:'无源',free:'自由',unspecified:'未指定',power_in:'电源输入',power_out:'电源输出',open_collector:'开集电极',open_emitter:'开射电极',no_connect:'不连接'};
export function DesignAssetPreview({asset,active=true}:{asset:ExtractedAsset|AssetRecord;active?:boolean}){
 const [unit,setUnit]=useState(1);const [availableUnits,setAvailableUnits]=useState<number[]>([]);
 const [file,setFile]=useState<InputAsset>();const [bundle,setBundle]=useState<CanonicalIrBundle>();const [error,setError]=useState('');const [pins,setPins]=useState<Array<{number:string;name:string;type:string}>>([]);
 useEffect(()=>{let cancelled=false;
 void(async()=>{
 await Promise.resolve();if(cancelled)return;
 setFile(undefined);setBundle(undefined);setError('');setPins([]);setAvailableUnits([]);
 const file=await candidateFile(asset);if(cancelled)return;
 if(asset.kind==='model'){setFile(file);return;}
 const sourceText=new TextDecoder().decode(file.bytes);
 if(asset.kind==='symbol'&&sourceText.startsWith('EESchema-LIBRARY')){const name=sourceText.match(/^DEF\s+(\S+)/m)?.[1];const sch=`EESchema Schematic File Version 4\n$Descr A4 11693 8268\n$EndDescr\n$Comp\nL ${name} U1\nU 1 1 abc\nP 2000 2000\nF 0 \"U1\" H 2200 2100 50 0000 L CNN\nF 1 \"${name}\" H 2200 2000 50 0000 L CNN\n 1 2000 2000\n 1 0 0 -1\n$EndComp\n$EndSCHEMATC`;const parsed=await parseEdaProject([{path:'preview.sch',bytes:new TextEncoder().encode(sch)},{path:'preview-cache.lib',bytes:file.bytes}]);if(!cancelled){setPins((parsed.schematics[0]?.pins??[]).map(p=>({number:p.number,name:p.name,type:p.electricalType??'unspecified'})));setBundle(parsed);}return;}
 const root=parse(sourceText);let text='';let name='';
 if(asset.kind==='symbol'){
  const body=directChildren(root,'symbol')[0];if(!body)throw Error('符号文件为空');const symbolName=atom(body.items[1])!;
  const units=[...new Set(directChildren(body,'symbol').map(n=>Number(atom(n.items[1])?.match(/_(\d+)_\d+$/)?.[1]??1)).filter(n=>n>0))];if(!units.length)units.push(1);
  body.items[1]=a('Extracted:'+symbolName,true);const defs=serialize(body);
  setAvailableUnits(units);const selectedUnit=units.includes(unit)?unit:units[0];
  const instances=[selectedUnit].map((u,i)=>{
   const x=40+i*50,y=50;
   const properties=directChildren(body,'property').filter(p=>['Reference','Value'].includes(atom(p.items[1])??'')).map(p=>{
    const copy=parse(serialize(p)),at=firstChild(copy,'at');
    if(at){at.items[1]=a(String(x+Number(atom(at.items[1])??0)));at.items[2]=a(String(y-Number(atom(at.items[2])??0)));}
    else copy.items.push(parse(`(at ${x+5} ${y-5} 0)`));
    return serialize(copy);
   }).join(' ');
   return `(symbol (lib_id ${JSON.stringify('Extracted:'+symbolName)}) (at ${x} ${y} 0) (unit ${u}) (uuid "preview-${u}") ${properties})`;
  });
  text=`(kicad_sch (version 20250114) (lib_symbols ${defs}) ${instances.join(' ')})`;name='preview.kicad_sch';
 setPins(allDescendants(body,'pin').map(p=>({number:childValue(p,'number')??'',name:childValue(p,'name')??'',type:atom(p.items[1])??'unspecified'})));
 }else{if(!firstChild(root,"at"))root.items.push(parse("(at 0 0 0)"));text=`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) ${serialize(root)})`;name='preview.kicad_pcb';}
 const parsed=await parseEdaProject([{path:name,bytes:new TextEncoder().encode(text)}]);
 if(asset.kind==='symbol'){
  const body=directChildren(root,'symbol')[0];
  const sch=parsed.schematics[0];
  const actualUnit=parsed.parts[0]?.symbolUnits[0]?.unit??1;
  const definitions=directChildren(body,'symbol').filter(n=>{const m=atom(n.items[1])?.match(/_(\d+)_(\d+)$/);return !m||((+m[1]===0||+m[1]===actualUnit)&&+m[2]<=1);}).flatMap(n=>directChildren(n,'pin'));
  const numberSettings=firstChild(body,'pin_numbers'),nameSettings=firstChild(body,'pin_names');
  const hidden=(n:typeof numberSettings)=>!!n&&n.items.some(x=>x.kind==='atom'&&x.value==='hide');
  const offset=Number(nameSettings&&childValue(nameSettings,'offset')||.508);
  const visiblePins=definitions.filter(p=>!p.items.some(x=>x.kind==='atom'&&x.value==='hide'));
  sch.pins=sch.pins.filter(pin=>visiblePins.some(p=>childValue(p,'number')===pin.number));
  sch.texts=sch.texts??[];
  visiblePins.forEach((p,i)=>{
   const at=firstChild(p,'at'),angle=Number(atom(at?.items[3])??0)*Math.PI/180;
   const x=40+Number(atom(at?.items[1])??0),y=50-Number(atom(at?.items[2])??0),len=Number(childValue(p,'length')??0);
   const dx=Math.cos(angle),dy=-Math.sin(angle),vertical=Math.abs(dy)>.5;
   const fontSize=(key:string)=>{const n=firstChild(p,key),effects=n&&firstChild(n,'effects'),font=effects&&firstChild(effects,'font'),size=font&&firstChild(font,'size');return atom(size?.items[1])??'1.27';};
   if(!hidden(numberSettings))sch.texts!.push({id:'preview-number-'+i,text:childValue(p,'number')??'',kind:'PinNumber',position:{unit:"mm",x:String(x+dx*len/2+(vertical?-.6:0)),y:String(y+dy*len/2+(vertical?0:-.6))},rotation:vertical?'90':'0',size:fontSize('number'),align:'middle'});
   const label=childValue(p,'name');
   if(!hidden(nameSettings)&&label&&label!=='~')sch.texts!.push({id:'preview-name-'+i,text:label,kind:'PinName',position:{unit:"mm",x:String(x+dx*(len+offset)),y:String(y+dy*(len+offset))},rotation:vertical?'90':'0',size:fontSize('name'),align:vertical?(dy<0?'start':'end'):(dx>0?'start':'end')});
  });
 }
 if(!cancelled)setBundle(parsed);
 })().catch(e=>{if(!cancelled)setError(String(e));});return()=>{cancelled=true;};},[asset,unit]);
 return <article className={`design-preview design-preview-${asset.kind}`}><h4>{asset.kind==='symbol'?<Cpu/>:asset.kind==='footprint'?<CircuitBoard/>:<Box/>}{asset.kind==='symbol'?'元件符号':asset.kind==='footprint'?'PCB 封装图':'3D 模型'}</h4><div className="design-preview-name" title={asset.name}>{asset.name}</div><small>指纹 {asset.fingerprint.slice(0,16)} · {asset.origins.length} 个来源</small>{error?<p role="alert">{error}</p>:asset.kind==='model'?(file?<AssemblyScene asset={file} active={active} library/>:<p>正在加载模型…</p>):bundle?(asset.kind==='symbol'?<SchematicViewer bundle={bundle} library/>:<PcbViewer bundle={bundle} library/>):<p>正在加载预览…</p>}{availableUnits.length>1&&<label className="design-unit">符号单元 <select aria-label="符号单元" value={availableUnits.includes(unit)?unit:availableUnits[0]} onChange={e=>setUnit(Number(e.target.value))}>{availableUnits.map(u=><option value={u} key={u}>单元 {u}</option>)}</select></label>}{asset.warnings.some(w=>w.includes('Altium')||w.includes('安装变换'))&&<p className="design-preview-notice">{asset.warnings.filter(w=>w.includes('Altium')||w.includes('安装变换')).join(' ')}</p>}{pins.length>0&&<details open className="design-pin-table"><summary>管脚定义与属性（{pins.length}）</summary><table><thead><tr><th>编号</th><th>名称</th><th>电气属性</th></tr></thead><tbody>{pins.map((p,i)=><tr key={i}><td>{p.number}</td><td>{p.name}</td><td><span className="pin-type">{pinTypeLabels[p.type]??p.type}</span></td></tr>)}</tbody></table></details>}</article>;
}
