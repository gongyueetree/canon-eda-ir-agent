"use client";
import { useEffect,useState } from 'react';
import type { AssetRecord,ExtractedAsset } from '../lib/design-assets/types';
import type { CanonicalIrBundle,InputAsset } from '../lib/eda/types';
import { candidateFile } from '../lib/design-assets/client';
import { a,parse,serialize } from '../lib/design-assets/kicad';
import { allDescendants,atom,childValue,directChildren } from '../lib/eda/sexpr';
import { parseEdaProject } from '../lib/eda/parse';
import { SchematicViewer,PcbViewer } from './EdaViewers';
import { AssemblyScene } from './AssemblyScene';
export function DesignAssetPreview({asset,active=true}:{asset:ExtractedAsset|AssetRecord;active?:boolean}){
 const [file,setFile]=useState<InputAsset>();const [bundle,setBundle]=useState<CanonicalIrBundle>();const [error,setError]=useState('');const [pins,setPins]=useState<Array<{number:string;name:string;type:string}>>([]);
 useEffect(()=>{let cancelled=false;
 void(async()=>{const file=await candidateFile(asset);if(cancelled)return;
 if(asset.kind==='model'){setFile(file);return;}
 const sourceText=new TextDecoder().decode(file.bytes);
 if(asset.kind==='symbol'&&sourceText.startsWith('EESchema-LIBRARY')){const name=sourceText.match(/^DEF\s+(\S+)/m)?.[1];const sch=`EESchema Schematic File Version 4\n$Descr A4 11693 8268\n$EndDescr\n$Comp\nL ${name} U1\nU 1 1 abc\nP 2000 2000\nF 0 \"U1\" H 2200 2100 50 0000 L CNN\nF 1 \"${name}\" H 2200 2000 50 0000 L CNN\n 1 2000 2000\n 1 0 0 -1\n$EndComp\n$EndSCHEMATC`;const parsed=await parseEdaProject([{path:'preview.sch',bytes:new TextEncoder().encode(sch)},{path:'preview-cache.lib',bytes:file.bytes}]);if(!cancelled)setBundle(parsed);return;}
 const root=parse(sourceText);let text='';let name='';
 if(asset.kind==='symbol'){
  const body=directChildren(root,'symbol')[0];if(!body)throw Error('符号文件为空');const symbolName=atom(body.items[1])!;
  const units=[...new Set(directChildren(body,'symbol').map(n=>Number(atom(n.items[1])?.match(/_(\d+)_\d+$/)?.[1]??1)).filter(n=>n>0))];if(!units.length)units.push(1);
  body.items[1]=a('Extracted:'+symbolName,true);const defs=serialize(body);
  text=`(kicad_sch (version 20250114) (lib_symbols ${defs}) ${units.map((u,i)=>`(symbol (lib_id ${JSON.stringify('Extracted:'+symbolName)}) (at ${40+i*50} 50 0) (unit ${u}) (uuid "preview-${u}") (property "Reference" "U${u}" (at ${40+i*50} 25 0)) (property "Value" ${JSON.stringify(asset.mpn)}))`).join(' ')})`;name='preview.kicad_sch';
  setPins(allDescendants(body,'pin').map(p=>({number:childValue(p,'number')??'',name:childValue(p,'name')??'',type:atom(p.items[1])??''})));
 }else{text=`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) ${serialize(root)})`;name='preview.kicad_pcb';}
 const parsed=await parseEdaProject([{path:name,bytes:new TextEncoder().encode(text)}]);if(!cancelled)setBundle(parsed);
 })().catch(e=>{if(!cancelled)setError(String(e));});return()=>{cancelled=true;};},[asset]);
 return <article className="design-preview"><h4>{asset.kind==='symbol'?'原理图符号':asset.kind==='footprint'?'PCB 封装':'3D 模型'} · {asset.name}</h4><small>指纹 {asset.fingerprint.slice(0,16)} · {asset.origins.length} 个来源</small>{error?<p role="alert">{error}</p>:asset.kind==='model'?(file?<AssemblyScene asset={file} active={active}/>:<p>正在加载模型…</p>):bundle?(asset.kind==='symbol'?<SchematicViewer bundle={bundle}/>:<PcbViewer bundle={bundle}/>):<p>正在加载预览…</p>}{pins.length>0&&<details><summary>管脚定义（{pins.length}）</summary><table><thead><tr><th>编号</th><th>名称</th><th>电气类型</th></tr></thead><tbody>{pins.map((p,i)=><tr key={i}><td>{p.number}</td><td>{p.name}</td><td>{p.type}</td></tr>)}</tbody></table></details>}</article>;
}
