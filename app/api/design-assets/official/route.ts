import { checkOfficial,officialFile } from '../../../../lib/design-assets/official';
import { boundedBody } from '../../../../lib/allegro-http';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request:Request){
 try{const input=JSON.parse(new TextDecoder().decode(await boundedBody(request.body,32000)));
 if(!Array.isArray(input)||input.length>12||input.some(x=>!['symbol','footprint','model'].includes(x.kind)||typeof x.name!=='string'||x.name.length>400||x.fingerprint&&!/^[a-f0-9]{64}$/.test(x.fingerprint)))return Response.json({error:'INVALID_REQUEST'},{status:400});
 const results=[];for(let i=0;i<input.length;i+=4)results.push(...await Promise.all(input.slice(i,i+4).map(x=>checkOfficial(x.kind,x.name,x.fingerprint))));return Response.json({results});
 }catch{return Response.json({error:'OFFICIAL_LOOKUP_FAILED'},{status:400});}
}

export async function GET(request:Request){try{const url=new URL(request.url),kind=url.searchParams.get('kind');if(!['symbol','footprint','model'].includes(kind??''))throw Error('INVALID_KIND');const file=await officialFile(kind as import('../../../../lib/design-assets/types').AssetKind,url.searchParams.get('name')??'',url.searchParams.get('revision')??'');return file.url?Response.redirect(file.url,307):new Response(file.text,{headers:{'Content-Type':'text/plain; charset=utf-8'}});}catch(e){return Response.json({error:String(e)},{status:400});}}
