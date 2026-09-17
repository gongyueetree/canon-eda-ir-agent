import { atom, childValue, directChildren, firstChild, head, parseSExpression, rootExpression, type SExpr, type SList } from '../eda/sexpr';
import { sha256 } from '../eda/util';
import type { AssetKind } from './types';
const span={start:0,end:0,line:1,column:1};
export const a=(value:string,quoted=false):SExpr=>({kind:'atom',value,quoted,span});
export const list=(...items:SExpr[]):SList=>({kind:'list',items,span});
export function parse(text:string):SList { const root=rootExpression(parseSExpression(text,{maxTokens:8_000_000}));if(!root)throw Error('EMPTY_LIBRARY');return root; }
export function serialize(n:SExpr):string {return n.kind==='atom'?(n.quoted?JSON.stringify(n.value):n.value):`(${n.items.map(serialize).join(' ')})`;}
export function clone(n:SList):SList{return structuredClone(n);}
const ignored=new Set(['uuid','tstamp','tedit','version','generator','generator_version']);
/** Conservative structural identity, retaining pin names/numbers, pad geometry and model transforms. */
function canonical(n:SExpr,root=false):unknown {
 if(n.kind==='atom')return n.quoted?n.value.replace(/\$\{KICAD\d+_3DMODEL_DIR\}/g,'${KICAD_3DMODEL_DIR}'): /^[-+]?\d+(\.\d+)?$/.test(n.value)?Number(n.value):n.value;
 const h=head(n);const values=n.items.filter(v=>v.kind!=='list'||!ignored.has(head(v)??''));
 const normalized=values.map((v,i)=>i===1&&(root||h==='symbol')?'@'+(root?'':(atom(v)?.match(/_(\d+_\d+)$/)?.[1]??'body')):canonical(v));
 // Child order does not define library identity; point order and scalar order do.
 if(['symbol','footprint','module'].includes(h??''))return [...normalized.filter((_,i)=>values[i].kind==='atom'),...normalized.filter((_,i)=>values[i].kind==='list').sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)))];
 return normalized;
}
export async function fingerprint(kind:AssetKind,bytes:Uint8Array):Promise<string>{
 if(kind==='model'){const header=new TextDecoder().decode(bytes.slice(0,256)).trimStart();if(!header.startsWith('ISO-10303-21;')&&!header.startsWith('#VRML V2.0'))throw Error('INVALID_3D_FILE');return sha256(bytes);}
 const text=new TextDecoder().decode(bytes);
 if(kind==='symbol'&&text.startsWith('EESchema-LIBRARY')){const defs=text.match(/^DEF [\s\S]*?^ENDDEF\s*$/gm)??[];if(defs.length!==1)throw Error('文件必须包含一个独立符号定义');return sha256(new TextEncoder().encode(defs[0].split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')).join('\n')));}
 const root=parse(text);
 if(kind==='symbol'&&(head(root)!=='kicad_symbol_lib'||directChildren(root,'symbol').length!==1))throw Error('文件必须包含一个独立符号定义');
 if(kind==='footprint'&&!['footprint','module'].includes(head(root)??''))throw Error('INVALID_FOOTPRINT_LIBRARY');
 const body=head(root)==='kicad_symbol_lib'?directChildren(root,'symbol')[0]:root;
 if(!body)throw Error('MISSING_LIBRARY_ENTITY');
 return sha256(new TextEncoder().encode(JSON.stringify(canonical(body,true))));
}
export function symbolDefinition(root:SList,name:string,seen=new Set<string>()):SList|undefined{
 if(seen.has(name))throw Error('SYMBOL_INHERITANCE_CYCLE');seen.add(name);
 const node=directChildren(root,'symbol').find(n=>atom(n.items[1])===name);if(!node)return;
 const result=clone(node),parent=childValue(result,'extends');
 if(parent){const base=symbolDefinition(root,parent,seen);if(!base)throw Error('SYMBOL_PARENT_MISSING: '+parent);
 const ownProps=new Set(directChildren(result,'property').map(n=>atom(n.items[1])));
 const ownHeads=new Set(directChildren(result).filter(n=>!['property','extends'].includes(head(n)!)).map(head));
 const inherited=directChildren(base).filter(n=>head(n)==='property'?!ownProps.has(atom(n.items[1])):!ownHeads.has(head(n)));
 result.items=result.items.filter(n=>head(n)!=='extends');result.items.push(...inherited);
 }
 const entry=name.split(':').at(-1)!;result.items[1]=a(entry,true);
 for(const sub of directChildren(result,'symbol')){const suffix=atom(sub.items[1])?.match(/_(\d+_\d+)$/)?.[1];if(suffix)sub.items[1]=a(`${entry}_${suffix}`,true);}
 return result;
}
export function symbolFile(body:SList,version='20211014'):string{return `(kicad_symbol_lib (version ${version}) (generator refir) ${serialize(body)})`;}
/** Restore library orientation, then unflip the back side around X, as KiCad FootprintSave does. */
export function footprintFile(input:SList,version='20240108'):string{
 const node=clone(input),back=childValue(node,'layer')?.startsWith('B.')??false;

 const angle=Number(childValue(node,'at',3)??0);node.items[1]=a((atom(node.items[1])??'Extracted').split(':').at(-1)!,true);
 const remove=new Set(['at','path','sheetname','sheetfile','uuid','tstamp','tedit','version','generator','generator_version','group','embedded_fonts']);
 node.items=node.items.filter(n=>n.kind==='atom'?atom(n)!=='locked':!remove.has(head(n)??''));
 function clean(n:SList){n.items=n.items.filter(v=>v.kind!=='list'||!['uuid','tstamp','net','pinfunction','pintype'].includes(head(v)??''));for(const sub of directChildren(n))clean(sub);}
 clean(node);
 for(const child of directChildren(node)){
  const kind=head(child),name=atom(child.items[1]);
  if(kind==='property'&&['Sheetname','Sheetfile','ki_path','MPN','Manufacturer','DNP','Description','Datasheet'].includes(name??'')){node.items=node.items.filter(n=>n!==child);continue;}
  if(kind==='property'&&name==='Reference')child.items[2]=a('REF**',true);
  if(kind==='property'&&name==='Value')child.items[2]=a(atom(node.items[1])??'Extracted',true);
  if(kind==='fp_text'&&name==='reference')child.items[2]=a('REF**',true);
  if(kind==='fp_text'&&name==='value')child.items[2]=a(atom(node.items[1])??'Extracted',true);
  if(['pad','fp_text','property','fp_text_box'].includes(kind??'')){
   const at=firstChild(child,'at');if(at){const rot=Number(atom(at.items[3])??0)-angle;at.items[3]=a(String((rot%360+360)%360));}
  }
 }
 if(back)unflip(node);
 if(head(node)!=='module')node.items.splice(2,0,list(a('version'),a(version)),list(a('generator'),a('refir')));
 return serialize(node);
}
function unflip(node:SList){
 const forbidden=new Set(['zone','dimension','image','padstack','fp_text_box']);
 function visit(n:SList){const h=head(n)??'';
  if(h==='model')return; // Model offsets are already in the footprint's local 3D frame.
  if(forbidden.has(h))throw Error('背面封装含尚未支持的镜像记录：'+h+'；请补充原始封装库');
  if(['at','start','mid','end','center','xy','offset','rect_delta'].includes(h)&&n.items[2]?.kind==='atom')n.items[2]=a(String(-Number(atom(n.items[2]))));
  if(h==='at'&&n.items[3]?.kind==='atom')n.items[3]=a(String((360-Number(atom(n.items[3])))%360));
  if(h==='angle'&&n.items[1]?.kind==='atom')n.items[1]=a(String(-Number(atom(n.items[1]))));
  if(['layer','layers','private_layers'].includes(h))for(let i=1;i<n.items.length;i++){const value=atom(n.items[i]);if(value?.startsWith('F.'))n.items[i]=a('B.'+value.slice(2),true);else if(value?.startsWith('B.'))n.items[i]=a('F.'+value.slice(2),true);}
  if(h==='chamfer')for(let i=1;i<n.items.length;i++){const v=atom(n.items[i]);if(v)n.items[i]=a(v.startsWith('top_')?v.replace('top_','bottom_'):v.replace('bottom_','top_'));}
  for(const child of directChildren(n))visit(child);
  if(h==='fp_text'||h==='property'){
   const effects=firstChild(n,'effects');if(effects){let justify=firstChild(effects,'justify');if(!justify){justify=list(a('justify'));effects.items.push(justify);}const mirrored=justify.items.some(v=>atom(v)==='mirror');justify.items=justify.items.filter(v=>atom(v)!=='mirror');if(!mirrored)justify.items.push(a('mirror'));if(justify.items.length===1)effects.items=effects.items.filter(v=>v!==justify);}
  }
 }
 visit(node);
}
/** Read only direct sections, avoiding allocation for all PCB tracks and zones. */
export function* sections(source:string,heads:Set<string>):Generator<SList>{
 let depth=0,start=0,quoted=false,escaped=false,comment=false;
 for(let i=0;i<source.length;i++){const c=source[i];if(comment){if(c==='\n')comment=false;continue;}if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c===';'){comment=true;continue;}if(c==='"'){quoted=true;continue;}
 if(c==='('){depth++;if(depth===2)start=i;}else if(c===')'){if(depth===2){const h=source.slice(start+1,start+60).match(/^\s*([^\s()]+)/)?.[1];if(h&&heads.has(h))yield parse(source.slice(start,i+1));}depth--;if(depth<0)throw Error('INVALID_SOURCE');}}
 if(depth||quoted)throw Error('INVALID_SOURCE');
}
