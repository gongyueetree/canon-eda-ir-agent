import {readFile} from 'node:fs/promises';
import {filesToInputAssets} from '../lib/eda/archive';
import {parseEdaProject} from '../lib/eda/parse';
import {embeddedModels,resolveModelPath} from '../lib/models/footprints';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const occt=await require('occt-import-js')();
for(const name of process.argv.slice(2)){
 const bytes=await readFile(name);const intake=await filesToInputAssets([new File([bytes],name.split('/').at(-1)!)]);const bundle=await parseEdaProject(intake.assets,intake.diagnostics);
 console.log(name,JSON.stringify({parts:bundle.parts.length,graphics:bundle.schematics.map(s=>[s.name,s.graphics?.length,s.texts?.length]),global:bundle.schematics.reduce((n,s)=>n+s.labels.filter(l=>l.kind==='global').length,0)}));
 for(const pcb of bundle.pcbs){const source=intake.assets.find(a=>a.path===pcb.sourceRefs[0].path)!;const embedded=embeddedModels(source);console.log('model refs',pcb.footprints.reduce((n,f)=>n+(f.models?.length??0),0),'embedded',embedded.length);
  for(const asset of embedded){const result=occt.ReadStepFile(asset.bytes,{linearUnit:'millimeter'});if(!result.success)throw Error(asset.path);console.log(asset.path,result.meshes.length);}
  const models=pcb.footprints.flatMap(f=>f.models??[]);console.log('unresolved',models.filter(m=>{const r=resolveModelPath(m.path,pcb,[...intake.assets,...embedded]);return !r.asset&&!r.official;}).map(m=>m.path));
 }
}
