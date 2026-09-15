/** Reproduce source geometry checks without uploading private engineering files. */
import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {createRequire} from 'node:module';
import {Group,Box3,Vector3,Mesh} from 'three';
import {VRMLLoader} from 'three/examples/jsm/loaders/VRMLLoader.js';
import {filesToInputAssets} from '../lib/eda/archive';
import {parseEdaProject} from '../lib/eda/parse';
import {boardAssembly,validateVrml} from '../lib/models/assets';
import {optimizeAssembly} from '../lib/models/optimize';
async function main(){
 const path=process.argv[2];if(!path)throw new Error('Usage: npm run verify:project -- /path/to/project.zip');
 const buffer=await readFile(path);
 const intake=await filesToInputAssets([new File([buffer],basename(path))]);
 const bundle=await parseEdaProject(intake.assets,intake.diagnostics);
 const report:Record<string,unknown>={files:intake.assets.length,parts:bundle.parts.length,sheets:bundle.schematics.length,texts:bundle.schematics.reduce((n,s)=>n+(s.texts?.length??0),0)};
 const pcb=bundle.pcbs[0];if(!pcb){console.log(JSON.stringify(report,null,2));return;}
 const asset=boardAssembly(pcb,intake.assets);
 if(asset&&/\.wrl$/i.test(asset.path)){
  const text=new TextDecoder().decode(asset.bytes);validateVrml(text);const root=new Group();root.add(new VRMLLoader().parse(text,''));
  let meshes=0,triangles=0;root.traverse(o=>{if(o instanceof Mesh){meshes++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;}});
  const before=new Box3().setFromObject(root).getSize(new Vector3());const optimized=optimizeAssembly(root);const after=new Box3().setFromObject(optimized).getSize(new Vector3());
  report.wrl={path:asset.path,meshes,triangles,mergedMeshes:optimized.children.length,before:before.toArray(),after:after.toArray()};
  if(!meshes||before.distanceTo(after)>Math.max(before.length()*1e-5,1e-8))throw new Error('Assembly bounds changed during batching');
 }
 const stem=(pcb.sourceRefs[0]?.path??'').replace(/\.[^.]+$/,'');
 const step=intake.assets.find(a=>a.path===stem+'.step'||a.path===stem+'.stp');
 if(step){const require=createRequire(import.meta.url);const factory=require('occt-import-js') as ()=>Promise<{ReadStepFile:(bytes:Uint8Array,params:Record<string,unknown>)=>{success:boolean;meshes:Array<unknown>}}>;
 const occt=await factory();const result=occt.ReadStepFile(step.bytes,{linearUnit:'millimeter',linearDeflectionType:'bounding_box_ratio',linearDeflection:0.002,angularDeflection:0.5});if(!result.success)throw new Error('STEP conversion failed');report.step={path:step.path,meshes:result.meshes.length};}
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Verification failed');process.exitCode=1;});
