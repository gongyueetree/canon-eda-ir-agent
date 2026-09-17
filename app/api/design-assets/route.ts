import { authorize,authError } from '../../../lib/auth';
import { listAssets,stageAsset } from '../../../lib/design-assets/storage';
import { boundedBody } from '../../../lib/allegro-http';
export const runtime='nodejs';export const maxDuration=60;
export async function GET(request:Request){try{const tenant=authorize(request),url=new URL(request.url);return Response.json(await listAssets(tenant,(url.searchParams.get('mpn')??'').slice(0,200),Number(url.searchParams.get('offset')??0)));}catch(e){return authError(e);}}
export async function POST(request:Request){try{const tenant=authorize(request),body=JSON.parse(new TextDecoder().decode(await boundedBody(request.body,2*1024*1024)));return Response.json(await stageAsset(tenant,body.asset,body.storage));}catch(e){return authError(e);}}
