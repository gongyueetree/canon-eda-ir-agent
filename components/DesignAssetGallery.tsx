"use client";
import { useState } from 'react';
import { Box,CircuitBoard,Cpu } from 'lucide-react';
import type { AssetRecord,ExtractedAsset } from '../lib/design-assets/types';
import { DesignAssetPreview } from './DesignAssetPreview';
type Asset = ExtractedAsset | AssetRecord;
const columns = [{kind:'symbol',title:'元件符号',Icon:Cpu},{kind:'footprint',title:'PCB 封装图',Icon:CircuitBoard},{kind:'model',title:'3D 模型',Icon:Box}] as const;
export function DesignAssetGallery({assets,active=true}:{assets:Asset[];active?:boolean}) {
 const [selected,setSelected]=useState<Record<string,string>>({});
 return <div className="design-comparison">{columns.map(({kind,title,Icon})=>{
  const choices=assets.filter(a=>a.kind===kind).sort((a,b)=>Number(!!('file' in b && b.file)||!!b.fileHash)-Number(!!('file' in a && a.file)||!!a.fileHash));
  const asset=choices.find(a=>a.id===selected[kind])??choices[0];
  return <section className="design-gallery-column" key={kind} aria-label={title}>
   {<label className="design-variant">{choices.length>1?`选择版本（${choices.length}）`:"库文件"}<select aria-label={`${title}版本`} disabled={choices.length<2} value={asset?.id??""} onChange={e=>setSelected(old=>({...old,[kind]:e.target.value}))}>{choices.length===0&&<option value="">尚未关联</option>}{choices.map(a=><option key={a.id} value={a.id}>{a.name} · {a.fingerprint.slice(0,8)}</option>)}</select></label>}
   {asset?<DesignAssetPreview key={asset.id+JSON.stringify(asset.official??null)} asset={asset} active={active}/>:<article className={`design-preview design-preview-${kind}`}><h4><Icon/>{title}</h4><div className="design-preview-name">尚未关联</div><small>此器件未找到对应资产</small><div className="design-preview-empty">暂无{title}<span>可从工程中提取或补充库文件</span></div></article>}
  </section>;
 })}</div>;
}
