import { zipSync,strToU8 } from 'fflate';
import type { AssetRecord,ExtractedAsset } from './types';
import { candidateFile } from './client';
import { parse,serialize,a } from './kicad';
import { atom,directChildren } from '../eda/sexpr';
type Asset=AssetRecord|ExtractedAsset;
const safe=(name:string)=>name.split(/[\\/:]/).at(-1)!.replace(/[^\p{L}\p{N}_.+-]/gu,'_').slice(0,110)||'asset';
export async function libraryArchive(assets:Asset[]):Promise<Uint8Array>{
 const files:Record<string,Uint8Array>={};
 const loaded=await Promise.all(assets.map(async asset=>{try{return {asset,file:await candidateFile(asset),error:''};}catch(e){return {asset,file:undefined,error:String(e)};}}));
 const models=new Map<string,string>();
 for(const {asset,file} of loaded){if(asset.kind!=='model'||!file)continue;const path=`3dmodels/${asset.fingerprint.slice(0,12)}_${safe(file.path)}`;files[path]=file.bytes;models.set(asset.fileHash??asset.fingerprint,path);}
 const manifest=[];
 for(const {asset,file,error} of loaded){
  if(!file){manifest.push({kind:asset.kind,name:asset.name,error});continue;}
  const path=asset.kind==='model'?models.get(asset.fileHash??asset.fingerprint)!:`${asset.kind==='symbol'?'symbols':'footprints.pretty'}/${asset.fingerprint.slice(0,12)}_${safe(file.path)}`;
  let bytes=file.bytes;const unresolved:string[]=[];
  if(asset.kind==='footprint'){
   const root=parse(new TextDecoder().decode(bytes));root.items[1]=a(path.split('/').at(-1)!.replace(/\.kicad_mod$/i,''),true);
   for(const model of directChildren(root,'model')){
    const name=atom(model.items[1])??'';const dependency=asset.dependencies?.find(d=>d.path===name);
    const byName=loaded.filter(x=>x.asset.kind==='model'&&x.file&&x.asset.name===name);
    const target=dependency?.fileHash?models.get(dependency.fileHash):byName.length===1?models.get(byName[0].asset.fileHash??byName[0].asset.fingerprint):undefined;
    if(target)model.items[1]=a('${KIPRJMOD}/'+target,true);else unresolved.push(name);
   }
   bytes=strToU8(serialize(root));
  }
  files[path]=bytes;manifest.push({kind:asset.kind,name:asset.name,path,origins:asset.origins,warnings:asset.warnings,unresolvedModels:unresolved});
 }
 files['manifest.json']=strToU8(JSON.stringify(manifest,null,2));
 files['README.txt']=strToU8('解压到 KiCad 工程根目录。symbols/ 为符号库，footprints.pretty/ 为封装库，3dmodels/ 为原始模型。已打包模型引用使用 ${KIPRJMOD}/3dmodels/。请查看 manifest.json 中的缺失文件、未解析模型及转换复核说明。Altium 转换资产是候选库，并非完整工程无损转换结果。');
 return zipSync(files,{level:6});
}
