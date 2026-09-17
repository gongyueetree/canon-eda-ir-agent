import {Group,Mesh,MathUtils} from 'three';
import type {InputAsset,PcbIr} from '../eda/types';
import {embeddedModels,resolveModelPath} from './footprints';
import {validateVrml} from './assets';
import {createStepAssembly,type StepMesh} from './step';
export function disposeModels(group:Group){const resources=new Set<{dispose:()=>void}>();group.traverse(o=>{if(o instanceof Mesh){resources.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material])resources.add(m);}});resources.forEach(r=>r.dispose());}
export function placeFootprintModel(model:Group,fp:PcbIr['footprints'][number],ref:NonNullable<PcbIr['footprints'][number]['models']>[number],thickness:number){
 const local=new Group();local.add(model);model.scale.multiply({x:ref.scale[0],y:ref.scale[1],z:ref.scale[2]});
 model.rotation.set(...ref.rotation.map(v=>-MathUtils.degToRad(v)) as [number,number,number],'ZYX');
 model.position.set(ref.offset[0],ref.offset[1],ref.offset[2]);
 if(fp.side==='back')local.rotation.x=Math.PI;
 const placed=new Group();placed.add(local);placed.position.set(Number(fp.position?.x??0),-Number(fp.position?.y??0),fp.side==='back'?0:thickness);placed.rotation.z=MathUtils.degToRad(Number(fp.rotation));placed.name=fp.reference;return placed;
}
function step(bytes:Uint8Array,signal:AbortSignal):Promise<StepMesh[]>{return new Promise((resolve,reject)=>{
 const worker=new Worker('/workers/step.js');const finish=()=>{clearTimeout(timer);worker.terminate();signal.removeEventListener('abort',abort);};
 const abort=()=>{finish();reject(Error('cancelled'));};const timer=setTimeout(()=>{finish();reject(Error('STEP 转换超时'));},60000);
 worker.onmessage=e=>{finish();if(e.data.error)reject(Error(e.data.error));else resolve(e.data.meshes);};worker.onerror=()=>{finish();reject(Error('STEP 转换器加载失败'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}const copy=bytes.slice();worker.postMessage(copy.buffer,[copy.buffer]);
});}
export async function loadFootprintModels(pcb:PcbIr,assets:InputAsset[],signal:AbortSignal,onProgress:(text:string)=>void){
 const output=new Group(),cache=new Map<string,Group|Error>();let loaded=0;const missing:string[]=[];
 const source=assets.find(a=>a.path===pcb.sourceRefs[0]?.path);
 let embedded:InputAsset[]=[];try{if(source)embedded=embeddedModels(source);}catch(e){missing.push(`嵌入模型: ${e instanceof Error?e.message:String(e)}`);}
 const all=[...assets,...embedded],refs=pcb.footprints.flatMap(fp=>(fp.models??[]).filter(m=>!m.hidden).map(ref=>({fp,ref})));
 try{for(const {fp,ref} of refs){
  if(signal.aborted)throw Error('cancelled');
  onProgress(`正在加载器件模型 ${loaded+missing.length}/${refs.length} · ${fp.reference}`);
  let template=cache.get(ref.path);
  if(!template){try{
   const resolved=resolveModelPath(ref.path,pcb,all);let asset=resolved.asset;
   if(!asset&&resolved.official){const response=await fetch('/api/models/kicad?path='+encodeURIComponent(resolved.official),{signal});if(!response.ok)throw Error(`官方库 HTTP ${response.status}`);asset={path:resolved.official,bytes:new Uint8Array(await response.arrayBuffer())};}
   if(!asset)throw Error('模型文件未随工程提供');
   if(/\.wrl$/i.test(asset.path)){const text=new TextDecoder().decode(asset.bytes);validateVrml(text);const {VRMLLoader}=await import('three/examples/jsm/loaders/VRMLLoader.js');template=new Group();template.add(new VRMLLoader().parse(text,''));template.scale.setScalar(2.54);}
   else template=createStepAssembly(await step(asset.bytes,signal));
   cache.set(ref.path,template);
  }catch(e){template=e instanceof Error?e:Error(String(e));cache.set(ref.path,template);}}
  if(template instanceof Error){missing.push(`${fp.reference}: ${ref.path} — ${template.message}`);continue;}
  output.add(placeFootprintModel(template.clone(true),fp,ref,Number(pcb.physicalDimensions?.thickness??1.6)));loaded++;
 }
 if(signal.aborted)throw Error('cancelled');return {group:output,loaded,total:refs.length,missing};
 }catch(e){disposeModels(output);for(const v of cache.values())if(v instanceof Group)disposeModels(v);throw e;}
}
