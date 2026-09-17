export const runtime = "nodejs";
export const maxDuration = 30;
import { boundedBody } from "../../../../lib/allegro-http";

/** Only the manufacturer's public KiCad model directory; no user-supplied URL/host. */
export async function GET(request:Request) {
 const path=new URL(request.url).searchParams.get('path')??'';
 if(!/^[\w.+()-]+\.(step|stp|wrl)$/i.test(path))return new Response('Invalid model path',{status:400});
 const url=`https://raw.githubusercontent.com/espressif/kicad-libraries/main/3dmodels/espressif.3dshapes/${encodeURIComponent(path)}`;
 const redirect=()=>new Response(null,{status:307,headers:{Location:url,'Cache-Control':'public, max-age=86400'}});
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(20000),redirect:'error',next:{revalidate:86400}});
  if(!response.ok){await response.body?.cancel();return new Response('Manufacturer model unavailable',{status:response.status===404?404:502});}
  // Large STEP files bypass the function response body limit via the allowlisted, CORS-enabled vendor URL.
  const length=Number(response.headers.get('content-length'));
  if(length>20*1024*1024){await response.body?.cancel();return new Response('Model too large',{status:413});}
  if(length>4*1024*1024){await response.body?.cancel();return redirect();}
  const bytes=await boundedBody(response.body,20*1024*1024);
  if(bytes.byteLength>4*1024*1024)return redirect();
  return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'public, max-age=86400, s-maxage=604800'}});
 }catch{return new Response('Manufacturer model request failed',{status:502});}
}
