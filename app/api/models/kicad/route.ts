export const runtime = 'nodejs';
export const maxDuration = 30;
// Public library assets only. No caller-provided hosts, redirects or credentials.
export async function GET(request:Request) {
 const params=new URL(request.url).searchParams,path=params.get('path')??'',revision=params.get('revision')??'master';
 if(!/^[\w.-]+\.3dshapes\/[\w.+()-]+\.(?:step|stp|wrl)$/i.test(path)) return new Response('Invalid model path',{status:400});
 if(revision!=='master'&&!/^[a-f0-9]{40}$/.test(revision))return new Response('Invalid revision',{status:400});
 try {
  const encoded=path.split('/').map(encodeURIComponent).join('/');
  const url=`https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/${revision}/`+encoded;
  const mirrorUrl='https://raw.githubusercontent.com/KiCad/kicad-packages3D/master/'+encoded;
  let upstream:Response|undefined;
  try{upstream=await fetch(url,{signal:AbortSignal.timeout(18000),redirect:'error',next:{revalidate:86400}});}catch{ /* Try the official GitHub mirror on transient GitLab errors. */ }
  let mirror=false;
  if((!upstream||!upstream.ok)&&revision==='master'){
   await upstream?.body?.cancel();
   upstream=await fetch(mirrorUrl,{signal:AbortSignal.timeout(9000),redirect:'error',next:{revalidate:86400}});mirror=true;
  }
  if(!upstream?.ok)return new Response('Official KiCad model unavailable',{status:upstream?.status===404?404:502});
  const read=async(response:Response)=>{const reader=response.body?.getReader();if(!reader)throw Error('empty');const chunks:Uint8Array[]=[];let length=0;
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>20*1024*1024){await reader.cancel();throw Error('Model too large');}chunks.push(value);}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;};
  const valid=(bytes:Uint8Array)=>{const header=new TextDecoder().decode(bytes.subarray(0,80)).trimStart();return header.startsWith('ISO-10303-21;')||header.startsWith('#VRML V2.0');};
  let bytes=await read(upstream);
  if(!valid(bytes)&&revision==='master'&&!mirror){const fallback=await fetch(mirrorUrl,{signal:AbortSignal.timeout(9000),redirect:'error',next:{revalidate:86400}});if(fallback.ok)bytes=await read(fallback);}
  if(!valid(bytes))return new Response('Official model payload invalid',{status:502});
  return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'public, max-age=86400, s-maxage=604800'}});
 }catch(e){return new Response(e instanceof Error&&e.message==='Model too large'?'Model too large':'Official KiCad library request failed',{status:e instanceof Error&&e.message==='Model too large'?413:502});}
}
