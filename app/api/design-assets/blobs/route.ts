import { authorize,authError } from '../../../../lib/auth';
import { fileChunk,fileInfo,putChunk,CHUNK_SIZE } from '../../../../lib/design-assets/storage';
import { boundedBody } from '../../../../lib/allegro-http';
export const runtime='nodejs';
export async function POST(request:Request){try{const tenant=authorize(request),url=new URL(request.url);return Response.json(await putChunk(tenant,url.searchParams.get('hash')??'',Number(url.searchParams.get('index')),await boundedBody(request.body,CHUNK_SIZE)));}catch(e){return authError(e);}}
export async function GET(request:Request){try{const tenant=authorize(request),url=new URL(request.url),r=await fileChunk(tenant,url.searchParams.get('hash')??'',Number(url.searchParams.get('index')));return new Response(Buffer.from(r.data,'base64'),{headers:{'Content-Type':'application/octet-stream','X-File-Chunks':String(r.chunks),'X-File-Size':String(r.size),'Cache-Control':'private, no-store'}});}catch(e){return authError(e);}}

export async function HEAD(request:Request){try{const info=await fileInfo(authorize(request),new URL(request.url).searchParams.get('hash')??'');return new Response(null,{status:info?200:404,headers:{'Cache-Control':'private, no-store'}});}catch(e){return authError(e);}}
