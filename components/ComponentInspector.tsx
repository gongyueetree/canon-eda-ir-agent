"use client";

import { useEffect, useState } from "react";
import type { CanonicalIrBundle, InputAsset } from "../lib/eda/types";
import type { ExtractedAsset, AssetKind } from "../lib/design-assets/types";
import { extractDesignAssets } from "../lib/design-assets/extract";
import { libraryArchive } from "../lib/design-assets/archive";
import { DesignAssetPreview } from "./DesignAssetPreview";

export function ComponentInspector({bundle, inputs, reference, onClose}:{bundle:CanonicalIrBundle;inputs:InputAsset[];reference:string;onClose:()=>void}) {
 const [items,setItems]=useState<ExtractedAsset[]>([]),[loading,setLoading]=useState(true);
 const [category,setCategory]=useState<AssetKind>('symbol'),[error,setError]=useState('');
 const part=bundle.parts.find(p=>p.reference===reference);
 const footprint=bundle.pcbs.flatMap(p=>p.footprints).find(f=>f.reference===reference);
 useEffect(()=>{let cancelled=false;
  extractDesignAssets(bundle,inputs,{},new Set([reference])).then(found=>{if(!cancelled){setItems(found);setLoading(false);}}).catch(e=>{if(!cancelled){setError(String(e));setLoading(false);}});
  return ()=>{cancelled=true;};
 },[bundle,inputs,reference]);
 const chosen=items.find(a=>a.kind===category&&!!a.file)||items.find(a=>a.kind===category);
 const download=async()=>{try{
  setError('');const bytes=await libraryArchive(items);
  const blob=new Blob([new Uint8Array(bytes)],{type:'application/zip'}),url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download=`${reference.replace(/[^\w.-]/g,'_')}-library.zip`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 }catch(e){setError(String(e));}};
 return <aside className="viewer-inspector component-inspector" aria-label={`${reference} 器件详情`}>
  <div className="component-inspector-heading"><strong>{reference} · 器件详情</strong><button type="button" onClick={onClose} aria-label="关闭器件详情">×</button></div>
  <dl><dt>值 / 型号</dt><dd>{part?.value||footprint?.value||'未填写'}</dd><dt>封装</dt><dd>{part?.footprint||footprint?.libraryIdentifier||'未关联'}</dd><dt>厂商</dt><dd>{part?.manufacturerRaw||'未填写'}</dd><dt>MPN</dt><dd>{part?.mpnRaw||'未填写'}</dd></dl>
  <div className="component-asset-tabs" role="group" aria-label="器件库预览">
   {([['symbol','原理图符号'],['footprint','PCB 封装'],['model','3D 模型']] as const).map(([kind,label])=><button type="button" key={kind} aria-pressed={category===kind} onClick={()=>setCategory(kind)}>{label}</button>)}
  </div>
  {loading?<p>正在提取器件库…</p>:chosen?<DesignAssetPreview key={chosen.id} asset={chosen}/>:<p>工程中没有关联的{category==='model'?'3D 模型':category==='symbol'?'原理图符号':'PCB 封装'}。</p>}
  <button className="component-download" type="button" onClick={()=>void download()} disabled={loading||!items.some(a=>a.file)} >下载该器件库 ZIP</button>
  {error&&<p role="alert">{error}</p>}
 </aside>;
}
