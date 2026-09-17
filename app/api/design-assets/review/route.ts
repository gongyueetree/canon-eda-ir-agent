import { authorize,authError } from '../../../../lib/auth';
import { reviewAsset } from '../../../../lib/design-assets/storage';
import { boundedBody } from '../../../../lib/allegro-http';
export async function POST(request:Request){try{const tenant=authorize(request),b=JSON.parse(new TextDecoder().decode(await boundedBody(request.body,16000)));return Response.json(await reviewAsset(tenant,b.id,b.revision,b.action,b));}catch(e){return authError(e);}}
