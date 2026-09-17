import type { InputAsset } from '../eda/types';
import { atom,childValue,directChildren } from '../eda/sexpr';
import { parse,symbolDefinition,symbolFile,footprintFile } from './kicad';
const enc=new TextEncoder();
export function localLibraries(inputs:InputAsset[]){
 const symbols:Array<{source:InputAsset;name:string;library:string;root:ReturnType<typeof parse>}>=[];
 const footprints:Array<{source:InputAsset;name:string;library:string;root:ReturnType<typeof parse>}>=[];
 const aliases=new Map<string,string[]>();
 for(const source of inputs){
  try{
   if(/(?:^|\/)(?:sym|fp)-lib-table$/i.test(source.path)){
    for(const lib of directChildren(parse(new TextDecoder().decode(source.bytes)),'lib')){const name=childValue(lib,'name'),uri=childValue(lib,'uri');if(name&&uri)aliases.set(name,[...(aliases.get(name)??[]),uri.replace(/\\/g,'/').replace(/^\$\{[^}]+\}\//,'')]);}
   }else if(/\.kicad_sym$/i.test(source.path)){
    const root=parse(new TextDecoder().decode(source.bytes));
    for(const s of directChildren(root,'symbol'))symbols.push({source,root,name:atom(s.items[1])??'',library:source.path.split('/').at(-1)!.replace(/\.kicad_sym$/i,'')});
   }else if(/\.kicad_mod$/i.test(source.path)){
    const root=parse(new TextDecoder().decode(source.bytes));footprints.push({source,root,name:atom(root.items[1])??'',library:source.path.split('/').at(-2)?.replace(/\.pretty$/i,'')??''});
   }
  }catch{/* A broken optional library must not stop extraction of the project. */}
 }
 return {
  symbol(identifier:string){
   const [library,name]=identifier.includes(':')?[identifier.slice(0,identifier.lastIndexOf(':')),identifier.split(':').at(-1)!]:['',identifier];
   const candidates=symbols.filter(s=>s.name===name||s.name===identifier);
   const qualified=candidates.filter(s=>s.library===library||(aliases.get(library)??[]).some(uri=>s.source.path===uri||s.source.path.endsWith('/'+uri)));
   const matches=qualified.length?qualified:candidates;if(matches.length!==1)return undefined;
   const match=matches[0],body=symbolDefinition(match.root,match.name);if(!body)return;
   return {file:{path:name+'.kicad_sym',bytes:enc.encode(symbolFile(body))},source:match.source};
  },
  footprint(identifier:string){
   const [library,name]=identifier.includes(':')?[identifier.slice(0,identifier.lastIndexOf(':')),identifier.split(':').at(-1)!]:['',identifier];
   const candidates=footprints.filter(s=>s.name===name||s.source.path.split('/').at(-1)===name+'.kicad_mod');
   const qualified=candidates.filter(s=>s.library===library||(aliases.get(library)??[]).some(uri=>s.source.path.includes(uri.replace(/\/$/,'')+'/')));
   const matches=qualified.length?qualified:candidates;if(matches.length!==1)return;
   const match=matches[0];return {file:{path:name+'.kicad_mod',bytes:enc.encode(footprintFile(match.root))},source:match.source,root:match.root};
  }
 };
}
