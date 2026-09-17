import type { CanonicalIrBundle, InputAsset, PartIr, PcbIr } from '../eda/types';
import type { BomMapping } from '../bom/types';
import { atom, childValue, directChildren } from '../eda/sexpr';
import { sha256 } from '../eda/util';
import { embeddedModels, resolveModelPath } from '../models/footprints';
import { fingerprint, footprintFile, sections, symbolDefinition, symbolFile, type parse } from './kicad';
import { identityKey, originKey, type ExtractedAsset, type Origin, type AssetKind } from './types';
import { parseEdaProject } from '../eda/parse';
import { parse as parseLibrary,serialize } from './kicad';
import { localLibraries } from './local-libraries';
import { altiumSymbol,altiumFootprint,altiumAssetWarning } from './altium-assets';
const enc=new TextEncoder();
export async function candidateId(asset:Pick<ExtractedAsset,'mpn'|'manufacturer'|'kind'|'fingerprint'|'identityConfirmed'|'identityScope'|'origins'>){return sha256(enc.encode(JSON.stringify([asset.identityConfirmed?identityKey(asset.manufacturer,asset.mpn):['unconfirmed',asset.origins[0]?.bundleId,asset.identityScope,asset.mpn],asset.kind,asset.fingerprint])));}
export async function identify(asset:ExtractedAsset,mpn:string,manufacturer:string):Promise<ExtractedAsset>{const updated={...asset,mpn:mpn.trim(),manufacturer:manufacturer.trim(),identityConfirmed:!!mpn.trim()};return {...updated,id:await candidateId(updated)};}
export function mergeAssets(assets:ExtractedAsset[]):ExtractedAsset[]{const out=new Map<string,ExtractedAsset>();for(const a of assets){const old=out.get(a.id);if(!old){out.set(a.id,{...a,origins:[...a.origins]});continue;}const origins=new Map([...old.origins,...a.origins].map(o=>[originKey(o),o]));old.origins=[...origins.values()];old.warnings=[...new Set([...old.warnings,...a.warnings])];}return [...out.values()];}
export async function extractDesignAssets(bundle:CanonicalIrBundle,inputs:InputAsset[],mappings:Record<string,BomMapping>={}):Promise<ExtractedAsset[]>{
 const byPath=new Map(inputs.map(a=>[a.path,a]));
 const libraries=localLibraries(inputs);
 const sourceHashes=new Map(bundle.inventory.map(i=>[i.relativePath,i.sha256]));
 type Node=ReturnType<typeof parse>;
 const docs=new Map<string,{defs?:Node;symbols:Node[];footprints:Node[];version?:string;error?:string}>();
 const needed=new Set([...bundle.parts.flatMap(p=>p.sourceRefs.map(s=>s.path)),...bundle.pcbs.flatMap(p=>p.sourceRefs.map(s=>s.path))]);
 for(const path of needed){const input=byPath.get(path);if(!input||! /\.(kicad_sch|kicad_pcb)$/i.test(path))continue;
  try{const nodes=[...sections(new TextDecoder().decode(input.bytes),new Set(['lib_symbols','symbol','footprint','module','version']))];docs.set(path,{defs:nodes.find(n=>atom(n.items[0])==='lib_symbols'),symbols:nodes.filter(n=>atom(n.items[0])==='symbol'),footprints:nodes.filter(n=>['footprint','module'].includes(atom(n.items[0])??'')),version:nodes.find(n=>atom(n.items[0])==='version')&&atom(nodes.find(n=>atom(n.items[0])==='version')!.items[1])});}
  catch(e){docs.set(path,{symbols:[],footprints:[],error:String(e)});}
 }
 const result:ExtractedAsset[]=[];
 for(const part of bundle.parts){
  const confirmed=Object.values(mappings).find(m=>['VERIFIED','CONFIRMED'].includes(m.status)&&m.selected&&m.query.references.includes(part.reference)&&(!part.footprint||m.query.footprint===part.footprint));
  const mpn=(confirmed?.selected?.mpn||part.mpnRaw||part.value||part.reference).trim();
  const manufacturer=(confirmed?.selected?.manufacturer||part.manufacturerRaw||'').trim();
  const identityConfirmed=!!(confirmed?.selected?.mpn||part.mpnRaw);
  const origin=(path:string,nativeId?:string):Origin=>({project:bundle.project.name,bundleId:bundle.bundleId,path,sourceHash:sourceHashes.get(path)??'',reference:part.reference,nativeId});
  const add=async(kind:AssetKind,name:string,file:InputAsset|undefined,origins:Origin[],warnings:string[]=[])=>{
   const fileHash=file?await sha256(file.bytes):undefined;
   const asset:ExtractedAsset={id:'',kind,name,mpn,manufacturer,identityConfirmed,identityScope:part.id,fingerprint:file?await fingerprint(kind,file.bytes):await sha256(enc.encode(`unavailable:${name}`)),fileHash,fileName:file?.path,size:file?.bytes.length,format:file?.path.split('.').at(-1)??'unavailable',origins,warnings:[...warnings,...(!identityConfirmed?['MPN 仅为候选名称，须由编辑确认或先完成 BOM 映射']:[])],file};
   asset.id=await candidateId(asset);result.push(asset);return asset;
  };
  let symbolAdded=false,symbolName=part.fields['lib_id']||part.value;
  for(const ref of part.sourceRefs){const doc=docs.get(ref.path);if(!doc)continue;
   const instance=doc.symbols.find(n=>childValue(n,'uuid')===ref.nativeId);const name=instance&&childValue(instance,'lib_id');if(!name)continue;symbolName=name;if(!doc.defs)continue;
   try{const definition=symbolDefinition(doc.defs,name);if(!definition)continue;const text=symbolFile(definition,doc.version);
    await add('symbol',name,{path:`${safeName(name)}.kicad_sym`,bytes:enc.encode(text)},[origin(ref.path,ref.nativeId)]);symbolAdded=true;
   }catch(e){await add('symbol',name,undefined,[origin(ref.path,ref.nativeId)],[String(e)]);symbolAdded=true;}
  }
  if(!symbolAdded){
   for(const ref of part.sourceRefs){const input=byPath.get(ref.path);if(!input||! /\.sch$/i.test(ref.path))continue;
    const text=new TextDecoder().decode(input.bytes);const blocks=text.match(/\$Comp[\s\S]*?\$EndComp/g)??[];
    const block=blocks.find(b=>b.split('\n').some(l=>l.startsWith('L ')&&l.trim().split(/\s+/)[2]===part.reference));
    const libraryId=block?.match(/^L\s+(\S+)/m)?.[1];if(!libraryId)continue;symbolName=libraryId;
    const names=new Set([libraryId,libraryId.replace(':','_'),libraryId.split(':').at(-1)!]);
    for(const lib of inputs.filter(a=>/\.lib$/i.test(a.path))){const content=new TextDecoder().decode(lib.bytes);if(!content.startsWith('EESchema-LIBRARY'))continue;
     for(const definition of content.match(/^DEF [\s\S]*?^ENDDEF\s*$/gm)??[]){const name=definition.split(/\s+/)[1];if(!names.has(name))continue;
      await add('symbol',libraryId,{path:safeName(name)+'.lib',bytes:enc.encode('EESchema-LIBRARY Version 2.4\n#encoding utf-8\n'+definition+'\n#End Library\n')},[origin(ref.path,ref.nativeId),origin(lib.path)],["KiCad 旧版原生符号库，保留 .lib 格式；未假定等同于现代官方符号"]);symbolAdded=true;
     }
    }
   }
  }
  if(!symbolAdded){
   const library=libraries.symbol(symbolName);
   if(library){await add('symbol',symbolName,library.file,[...part.sourceRefs.map(r=>origin(r.path,r.nativeId)),origin(library.source.path)],['从工程本地符号库提取']);symbolAdded=true;}
   else {const converted=altiumSymbol(bundle,part,safeName(symbolName));if(converted){await add('symbol',symbolName,converted,part.sourceRefs.map(r=>origin(r.path,r.nativeId)),[altiumAssetWarning]);symbolAdded=true;}}
  }
  if(!symbolAdded)await add('symbol',symbolName,undefined,part.sourceRefs.map(r=>origin(r.path,r.nativeId)),['源文件未包含可独立提取的现代 KiCad 符号定义；不会用 IR 示意框冒充库符号']);
  const fps=linkedFootprints(bundle,part);
  if(!fps.length&&part.footprint){
   const library=libraries.footprint(part.footprint);
   if(library){
    const root=parseLibrary(new TextDecoder().decode(library.file.bytes));root.items.push(parseLibrary('(at 0 0 0)'));
    const converted=await parseEdaProject([{path:'local-library.kicad_pcb',bytes:enc.encode(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) ${serialize(root)})`)}]);
    const pcb=converted.pcbs[0],fp=pcb?.footprints[0];if(fp){fp.reference=part.reference;fp.libraryIdentifier=part.footprint;fp.sourceRef={...fp.sourceRef,path:library.source.path};pcb.sourceRefs=[fp.sourceRef];fps.push({pcb,fp});}
   }
  }
  for(const {pcb,fp} of fps){
   const path=fp.sourceRef.path,doc=docs.get(path);let file:InputAsset|undefined;const warnings:string[]=[];
   try{const node=doc?.footprints.find(n=>(childValue(n,'uuid')||childValue(n,'tstamp'))===fp.sourceRef.nativeId)||doc?.footprints.find(n=>directChildren(n,'property').some(p=>atom(p.items[1])==='Reference'&&atom(p.items[2])===fp.reference)||directChildren(n,'fp_text').some(p=>atom(p.items[1])==='reference'&&atom(p.items[2])===fp.reference));
    if(node)file={path:`${safeName(fp.libraryIdentifier)}.kicad_mod`,bytes:enc.encode(footprintFile(node,doc?.version))};
    else warnings.push('当前源格式的封装库文件提取尚未支持；保留来源，不生成近似封装');
   }catch(e){warnings.push(String(e));}
   const library=libraries.footprint(fp.libraryIdentifier);
   if(!file&&library){file=library.file;warnings.length=0;warnings.push('从工程本地封装库提取');}
   if(!file){try{file=altiumFootprint(pcb,fp);if(file){warnings.length=0;warnings.push(altiumAssetWarning,'当前 Altium 封装候选保留已解析焊盘及模型；丝印、装配边界和特殊焊盘需与原文件核对。');}}catch(e){warnings.push(String(e));}}
   const footprintAsset=await add('footprint',fp.libraryIdentifier,file,[origin(path,fp.sourceRef.nativeId),...(library?[origin(library.source.path)]:[])],warnings);footprintAsset.dependencies=[];
   const modelRefs=[...(fp.models??[])];
   if(!modelRefs.length&&library){
    for(const m of directChildren(library.root,'model')){
     const xyz=(key:string,defaults:number[])=>{const node=directChildren(m,key)[0],value=node&&directChildren(node,'xyz')[0];return value?[1,2,3].map(i=>Number(atom(value.items[i])??defaults[i-1])):defaults;};
     modelRefs.push({path:atom(m.items[1])??'',offset:xyz('offset',[0,0,0]),scale:xyz('scale',[1,1,1]),rotation:xyz('rotate',[0,0,0]),hidden:false});
    }
   }
   if(!modelRefs.length){
    const stem=fp.libraryIdentifier.split(':').at(-1)?.toLowerCase();
    const matches=inputs.filter(a=>/\.(step|stp|wrl)$/i.test(a.path)&&a.path.split('/').at(-1)?.replace(/\.(step|stp|wrl)$/i,'').toLowerCase()===stem);
    if(matches.length===1){modelRefs.push({path:matches[0].path,offset:[0,0,0],scale:[1,1,1],rotation:[0,0,0],hidden:false});footprintAsset.warnings.push('模型按唯一同名本地文件关联；源封装未提供安装变换，装配位置须人工确认。');}
    else if(matches.length>1)footprintAsset.warnings.push('存在多个同名本地模型，未自动选择，请补充确认后的模型文件。');
   }
   const source=byPath.get(path);let models:InputAsset[]=[];try{if(source)models=embeddedModels(source);}catch(e){warnings.push(String(e));}
   for(const model of modelRefs){
    const available=[...inputs,...models];let resolved=resolveModelPath(model.path,pcb,available);
    if(!resolved.asset&&library){const localPcb={...pcb,sourceRefs:[{...fp.sourceRef,path:library.source.path}]};const local=resolveModelPath(model.path,localPcb,available);if(local.asset)resolved=local;}
    const modelWarnings=resolved.asset?(resolved.matchedBy==='filename'?['按工程内唯一模型文件名关联，请核对与封装是否一致']:[]):[resolved.ambiguous?'多个本地模型路径匹配，未自动关联；请补充确认后的模型文件':'工程仅提供模型引用，未提供文件；先查询官方库，找不到时需补充原始模型'];
    const modelAsset=await add('model',model.path,resolved.asset,[origin(path,fp.sourceRef.nativeId),...(resolved.asset&&sourceHashes.has(resolved.asset.path)?[origin(resolved.asset.path)]:[])],modelWarnings);
    footprintAsset.dependencies.push({path:model.path,fileHash:modelAsset.fileHash,offset:model.offset,scale:model.scale,rotation:model.rotation});
   }
   if(modelRefs.length&&footprintAsset.file){
    const root=parseLibrary(new TextDecoder().decode(footprintAsset.file.bytes));
    if(!directChildren(root,'model').length){
     for(const m of modelRefs)root.items.push(parseLibrary(`(model ${JSON.stringify(m.path)} (offset (xyz ${m.offset.join(' ')})) (scale (xyz ${m.scale.join(' ')})) (rotate (xyz ${m.rotation.join(' ')})))`));
     footprintAsset.file={...footprintAsset.file,bytes:enc.encode(serialize(root))};footprintAsset.fileHash=await sha256(footprintAsset.file.bytes);footprintAsset.size=footprintAsset.file.bytes.length;footprintAsset.fingerprint=await fingerprint('footprint',footprintAsset.file.bytes);footprintAsset.id=await candidateId(footprintAsset);
    }
   }
   if(!modelRefs.length)await add('model' ,'未关联 3D',undefined,[origin(path,fp.sourceRef.nativeId)],['封装未关联器件模型；工程内没有唯一同名模型']);

  }
  if(!fps.length){const library=libraries.footprint(part.footprint||'');await add('footprint',part.footprint||'未关联封装',library?.file,part.sourceRefs.map(r=>origin(r.path,r.nativeId)),['未找到唯一对应的已放置 PCB 封装']);await add('model','未关联 3D',undefined,part.sourceRefs.map(r=>origin(r.path,r.nativeId)),['无可提取的封装模型']);}
 }
 return mergeAssets(result);
}
export function linkedFootprints(bundle:CanonicalIrBundle,part:PartIr):Array<{pcb:PcbIr;fp:PcbIr['footprints'][number]}> {
 const ids=new Set([part.footprintInstanceId,...bundle.crossDocumentLinks.filter(l=>l.type==='part_to_footprint'&&l.sourceEntityId===part.id&&['explicit','verified'].includes(l.status)).map(l=>l.targetEntityId)].filter(Boolean));
 const all=bundle.pcbs.flatMap(pcb=>pcb.footprints.map(fp=>({pcb,fp})));
 if(ids.size)return all.filter(({fp})=>ids.has(fp.id));
 const matches=all.filter(({fp})=>fp.reference===part.reference&&(!part.footprint||fp.libraryIdentifier===part.footprint));return matches.length===1?matches:[];
}
export function safeName(name:string){return name.split(/[/:\\]/).at(-1)?.replace(/[^\p{L}\p{N}_.+-]/gu,'_').slice(0,120)||'extracted';}
