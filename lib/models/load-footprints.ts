import {Group,Mesh,MathUtils} from 'three';
import type {InputAsset,PcbIr} from '../eda/types';
import {embeddedModels,resolveModelPath} from './footprints';
import {validateVrml} from './assets';
import {createStepAssembly} from './step';
import {convertStep} from './step-pool';
import {modelCacheFor, type ModelData} from './model-cache';
import {boundedBody} from '../allegro-http';

export function disposeModels(group:Group){const resources=new Set<{dispose:()=>void}>();group.traverse(o=>{if(o instanceof Mesh){resources.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material])resources.add(m);}});resources.forEach(r=>r.dispose());}
export function placeFootprintModel(model:Group,fp:PcbIr['footprints'][number],ref:NonNullable<PcbIr['footprints'][number]['models']>[number],thickness:number){
 const local=new Group();local.add(model);model.scale.multiply({x:ref.scale[0],y:ref.scale[1],z:ref.scale[2]});
 model.rotation.set(...ref.rotation.map(v=>-MathUtils.degToRad(v)) as [number,number,number],'ZYX');
 model.position.set(ref.offset[0],ref.offset[1],ref.offset[2]);
 if(fp.side==='back')local.rotation.x=Math.PI;
 const placed=new Group();placed.add(local);placed.position.set(Number(fp.position?.x??0),-Number(fp.position?.y??0),fp.side==='back'?0:thickness);placed.rotation.z=MathUtils.degToRad(Number(fp.rotation));placed.name=fp.reference;return placed;
}

export type MissingModel = {path:string;reason:string;references:string[]};
type Options = {onGroup?:(group:Group)=>void;decodeStep?:typeof convertStep;fetchModel?:typeof fetch};

export async function loadFootprintModels(pcb:PcbIr,assets:InputAsset[],signal:AbortSignal,onProgress:(text:string)=>void,options:Options={}){
 const output=new Group(),cache=modelCacheFor(assets);
 let loaded=0,finished=0;
 const failures:MissingModel[]=[];
 options.onGroup?.(output);
 const source=assets.find(a=>a.path===pcb.sourceRefs[0]?.path);
 let embedded:InputAsset[]=[];
 try{if(source)embedded=embeddedModels(source);}catch(e){failures.push({path:'嵌入模型',reason:e instanceof Error?e.message:String(e),references:[]});}
 const all=[...assets,...embedded];
 const refs=pcb.footprints.flatMap(fp=>(fp.models??[]).filter(m=>!m.hidden).map(ref=>({fp,ref})));
 const jobs=new Map<string,typeof refs>();
 for(const item of refs){const group=jobs.get(item.ref.path)??[];group.push(item);jobs.set(item.ref.path,group);}
 const entries=[...jobs.entries()];
 let cursor=0;
 const update=()=>onProgress(`器件模型 ${loaded}/${refs.length} 个引用已加载 · ${finished}/${entries.length} 种模型已处理`);
 update();
 const run=async()=>{
  while(cursor<entries.length&&!signal.aborted){
   const [path,instances]=entries[cursor++];
   let template:Group|undefined,attached=false;
   try{
    const resolved=resolveModelPath(path,pcb,all);
    const key=resolved.asset?`${pcb.sourceRefs[0]?.path}:${resolved.asset.path}`:resolved.official?`kicad:${resolved.official}`:resolved.espressif?`espressif:${resolved.espressif}`:`${pcb.id}:${path}`;
    const data=await cache.get(key,signal,async():Promise<ModelData>=>{
     let asset=resolved.asset;
     if(!asset&&(resolved.official||resolved.espressif)){
      const vendor=resolved.official?'kicad':'espressif';
      const response=await (options.fetchModel??fetch)(`/api/models/${vendor}?path=${encodeURIComponent(resolved.official??resolved.espressif!)}`,{signal:AbortSignal.any([signal,AbortSignal.timeout(25000)])});
      if(!response.ok)throw Error(response.status===404?'官方库未提供此精确文件（404）；请随工程补充模型':`模型服务 HTTP ${response.status}`);
      asset={path:resolved.official??resolved.espressif!,bytes:await boundedBody(response.body,20*1024*1024)};
     }
     if(!asset)throw Error('模型文件未随工程提供');
     if(/\.wrl$/i.test(asset.path)){const text=new TextDecoder().decode(asset.bytes);validateVrml(text);return {kind:'wrl',text};}
     return {kind:'step',meshes:await (options.decodeStep??convertStep)(asset.bytes,signal)};
    });
    if(signal.aborted)throw Error('cancelled');
    if(data.kind==='wrl'){
     const {VRMLLoader}=await import('three/examples/jsm/loaders/VRMLLoader.js');
     if(signal.aborted)throw Error('cancelled');
     template=new Group();template.add(new VRMLLoader().parse(data.text,''));template.scale.setScalar(2.54);
    }else template=createStepAssembly(data.meshes);
    for(const {fp,ref} of instances){output.add(placeFootprintModel(template.clone(true),fp,ref,Number(pcb.physicalDimensions?.thickness??1.6)));attached=true;loaded++;}
   }catch(error){
    if(template&&!attached)disposeModels(template);
    if(!signal.aborted)failures.push({path,reason:error instanceof Error?error.message:String(error),references:instances.map(i=>i.fp.reference)});
   }
   finished++;if(!signal.aborted)update();
  }
 };
 // Bounded downloads plus a smaller reusable STEP worker pool. Cache owns CPU data only.
 await Promise.all(Array.from({length:Math.min(4,entries.length)},run));
 if(signal.aborted){disposeModels(output);throw Error('cancelled');}
 return {group:output,loaded,total:refs.length,failures,missing:failures.map(f=>`${f.references.join(', ') || '工程'}: ${f.path} — ${f.reason}`)};
}
