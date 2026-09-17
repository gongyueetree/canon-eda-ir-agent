export const runtime = 'nodejs';
export const maxDuration = 30;
// Public library assets only. No caller-provided hosts, redirects or credentials.
export async function GET(request:Request) {
 const path=new URL(request.url).searchParams.get('path')??'';
 if(!/^[\w.-]+\.3dshapes\/[\w.+()-]+\.(?:step|stp|wrl)$/i.test(path)) return new Response('Invalid model path',{status:400});
 try {
  const url='https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/master/'+path.split('/').map(encodeURIComponent).join('/');
  const upstream=await fetch(url,{signal:AbortSignal.timeout(20000),redirect:'error',next:{revalidate:86400}});
  if(!upstream.ok)return new Response('Official KiCad model unavailable',{status:upstream.status===404?404:502});
  const reader=upstream.body?.getReader();if(!reader)throw Error('empty');const chunks:Uint8Array[]=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>20*1024*1024){await reader.cancel();return new Response('Model too large',{status:413});}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'public, max-age=86400, s-maxage=604800'}});
 }catch{return new Response('Official KiCad library request failed',{status:502});}
}
