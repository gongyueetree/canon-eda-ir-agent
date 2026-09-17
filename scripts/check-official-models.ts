import {readFile} from 'node:fs/promises';
import {filesToInputAssets} from '../lib/eda/archive';
import {parseEdaProject} from '../lib/eda/parse';
import {resolveModelPath} from '../lib/models/footprints';
import {GET} from '../app/api/models/kicad/route';
import {createRequire} from 'node:module';
const bytes=await readFile(process.argv[2]);const intake=await filesToInputAssets([new File([bytes],'Labsight.zip')]);const b=await parseEdaProject(intake.assets,intake.diagnostics),pcb=b.pcbs[0];
const paths=[...new Set(pcb.footprints.flatMap(f=>f.models??[]).map(m=>resolveModelPath(m.path,pcb,intake.assets).official).filter((p):p is string=>!!p))];
const require=createRequire(import.meta.url),occt=await require('occt-import-js')();let good=0;
for(const path of paths){const r=await GET(new Request('http://localhost/api/models/kicad?path='+encodeURIComponent(path)));if(!r.ok){console.log('FAIL',r.status,path);continue;}const result=occt.ReadStepFile(new Uint8Array(await r.arrayBuffer()),{linearUnit:'millimeter'});if(result.success){good++;console.log('OK',path,result.meshes.length);}else console.log('CONVERT FAIL',path);}
console.log('Official models verified',good,'/',paths.length);
