import { identityKey,originKey,type ExtractedAsset } from './types';

export type DesignAssetGroup = {
 key:string;
 items:ExtractedAsset[];
 members:ExtractedAsset[];
 references:string[];
 footprintNames:string[];
};

// Presentation grouping does not promote a candidate value to a confirmed MPN.
// Rebuild occurrences from provenance because confirmed assets may already span
// several placements, packages or projects after content deduplication.
export function groupDesignAssets(assets:ExtractedAsset[]):DesignAssetGroup[]{
 const occurrences=new Map<string,{bundleId:string;reference:string;items:ExtractedAsset[]}>();
 for(const asset of assets){
  const byOccurrence=new Map<string,typeof asset.origins>();
  for(const origin of asset.origins){
   const key=JSON.stringify([origin.bundleId,origin.reference||asset.identityScope||asset.id]);
   byOccurrence.set(key,[...(byOccurrence.get(key)??[]),origin]);
  }
  if(!byOccurrence.size)byOccurrence.set(JSON.stringify(['no-origin',asset.id]),[]);
  for(const [key,origins] of byOccurrence){
   const occurrence=occurrences.get(key)??{bundleId:origins[0]?.bundleId??key,reference:origins[0]?.reference??'',items:[]};
   occurrence.items.push({...asset,origins});occurrences.set(key,occurrence);
  }
 }
 const grouped=new Map<string,DesignAssetGroup>();
 for(const [occurrenceKey,occurrence] of occurrences){
  const first=occurrence.items[0];
  const footprintNames=[...new Set(occurrence.items.filter(a=>a.kind==='footprint').map(a=>a.name.trim()))].sort();
  const packageKey=footprintNames.length&&footprintNames.every(n=>n&&n!=='未关联封装')?footprintNames:occurrenceKey;
  const key=JSON.stringify([occurrence.bundleId,identityKey(first.manufacturer,first.mpn),first.identityConfirmed,packageKey]);
  const group=grouped.get(key)??{key,items:[],members:[],references:[],footprintNames};
  group.members.push(...occurrence.items);
  if(occurrence.reference&&!group.references.includes(occurrence.reference))group.references.push(occurrence.reference);
  grouped.set(key,group);
 }
 for(const group of grouped.values()){
  const rows=new Map<string,ExtractedAsset>();
  for(const asset of group.members){
   const key=JSON.stringify([asset.kind,asset.fingerprint]);const existing=rows.get(key);
   if(existing){existing.origins=[...new Map([...existing.origins,...asset.origins].map(o=>[originKey(o),o])).values()];existing.warnings=[...new Set([...existing.warnings,...asset.warnings])];}
   else rows.set(key,{...asset,origins:[...asset.origins]});
  }
  group.items=[...rows.values()];
  group.references.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
 }
 return [...grouped.values()];
}
