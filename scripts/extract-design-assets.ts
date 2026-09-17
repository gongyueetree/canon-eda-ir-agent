/** Each ZIP is one project. Dry run by default; staging never approves assets. */
import { readdir,readFile,mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { filesToInputAssets } from '../lib/eda/archive';
import { parseEdaProject } from '../lib/eda/parse';
import { extractDesignAssets,mergeAssets } from '../lib/design-assets/extract';
import { checkOfficial } from '../lib/design-assets/official';
import { setApiToken } from '../lib/client-api';
import type { ExtractedAsset } from '../lib/design-assets/types';
const args=process.argv.slice(2),input=args[0],output=args[1],stage=args.includes('--stage');
if(!input||!output)throw Error('Usage: node --import tsx scripts/extract-design-assets.ts <zip-directory> <output-directory> [--stage]');
const url=process.env.EDA_BASE_URL,token=process.env.EDA_API_TOKEN;
if(stage&&(!url||!token))throw Error('Staging requires EDA_BASE_URL and EDA_API_TOKEN');
setApiToken(token??'');await mkdir(output,{recursive:true});await mkdir(join(output,'files'),{recursive:true});
// Node fetch requires absolute URLs; only route this script\'s relative application requests.
const fetchOriginal=globalThis.fetch;
if(stage)globalThis.fetch=(resource,init)=>fetchOriginal(typeof resource==='string'&&resource.startsWith('/')?new URL(resource,url).toString():resource,init);
const {stageCandidate}=await import('../lib/design-assets/client');
const failures:Array<{file:string;error:string}>=[];let projects=0,staged=0,duplicates=0,unconfirmed=0;const manifest:ExtractedAsset[]=[];
for(const entry of await readdir(input)){if(!/\.(zip|epro)$/i.test(entry))continue;
 try{const bytes=await readFile(join(input,entry));const {assets}=await filesToInputAssets([new File([bytes],entry)]);const bundle=await parseEdaProject(assets);const rows=await extractDesignAssets(bundle,assets);
 for(const a of rows){if(stage)a.official=await checkOfficial(a.kind,a.name,a.file?a.fingerprint:undefined);if(a.file&&a.official?.status!=='match'){await writeFile(join(output,'files',a.fileHash!+'.'+a.format),a.file.bytes);}if(stage&&a.identityConfirmed&&(a.file||a.official?.status==='found')){const result=await stageCandidate(a,['match','found'].includes(a.official?.status??'')?'official':'file');staged++;if(result.duplicate)duplicates++;}else if(!a.identityConfirmed)unconfirmed++;
 const {file:_,...meta}=a;void _;manifest.push(meta);}
 projects++;console.log(JSON.stringify({project:entry,candidates:rows.length,projects}));
 }catch(e){failures.push({file:entry,error:String(e)});}
 // A checkpoint after every project permits a safe idempotent rerun after interruption.
 await writeFile(join(output,'manifest.json'),JSON.stringify({version:1,projects,staged,duplicates,unconfirmed,assets:mergeAssets(manifest),failures},null,2));
}
console.log(JSON.stringify({output:resolve(output),projects,staged,duplicates,unconfirmed,failed:failures.length}));if(failures.length)process.exitCode=1;
