"use client";
import { useEffect, useRef, useState } from "react";
import type { PcbIr, IrPoint } from "../lib/eda/types";
import { arcPoints, type XY } from "../lib/eda/view-geometry";

export function BoardScene({ pcb }: { pcb: PcbIr }) {
  const host = useRef<HTMLDivElement>(null);
  const reset = useRef(() => {});
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    async function draw() {
      const THREE = await import("three");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if(cancelled || !host.current) return;
      const rounded=(w:number,h:number,r:number)=>{const path=new THREE.Shape();const x=w/2,y=h/2;r=Math.min(r,x,y);path.moveTo(-x+r,-y);path.lineTo(x-r,-y);path.absarc(x-r,-y+r,r,-Math.PI/2,0,false);path.lineTo(x,y-r);path.absarc(x-r,y-r,r,0,Math.PI/2,false);path.lineTo(-x+r,y);path.absarc(-x+r,y-r,r,Math.PI/2,Math.PI,false);path.lineTo(-x,-y+r);path.absarc(-x+r,-y+r,r,Math.PI,Math.PI*1.5,false);path.closePath();return path;};
      const point=(p:unknown):XY|undefined=>{const v=p as IrPoint|undefined;return v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) ? {x:Number(v.x),y:-Number(v.y)} : undefined;};
      const segments:XY[][]=[];
      for(const edge of pcb.boardOutline){
        const a=point(edge.geometry.start),b=point(edge.geometry.end),m=point(edge.geometry.mid),c=point(edge.geometry.center);
        if(edge.kind==="line" && a && b) segments.push([a,b]);
        if(edge.kind==="arc") {if(!a||!b||!m)throw new Error("该板框圆弧缺少中点，请用新版解析器重新导入源文件。");segments.push(arcPoints(a,m,b));}
        if(edge.kind==="rectangle" && a && b) segments.push([a,{x:b.x,y:a.y},b,{x:a.x,y:b.y},a]);
        if(edge.kind==="circle" && (c||a) && b){const center=(c||a)!;const r=Math.hypot(b.x-center.x,b.y-center.y);segments.push(Array.from({length:97},(_,i)=>({x:center.x+r*Math.cos(i*Math.PI/48),y:center.y+r*Math.sin(i*Math.PI/48)})));}
      }
      const near=(a:XY,b:XY)=>Math.hypot(a.x-b.x,a.y-b.y)<.01;
      const loops:XY[][]=[];
      while(segments.length){const chain=segments.shift()!;while(!near(chain[0],chain[chain.length-1])){const end=chain[chain.length-1];const i=segments.findIndex(s=>near(s[0],end)||near(s[s.length-1],end));if(i<0)throw new Error("板框不完整或包含未支持的圆弧，无法生成可靠的 3D 板体。请重新导入完整 KiCad PCB。");let next=segments.splice(i,1)[0];if(!near(next[0],end))next=next.reverse();chain.push(...next.slice(1));}loops.push(chain);}
      if(!loops.length)throw new Error("没有闭合的 Edge.Cuts 板框，无法生成 3D 板体。");
      const area=(p:XY[])=>p.reduce((sum,v,i)=>{const n=p[(i+1)%p.length];return sum+v.x*n.y-n.x*v.y;},0)/2;
      loops.sort((a,b)=>Math.abs(area(b))-Math.abs(area(a)));
      const inside=(p:XY,polygon:XY[])=>{let yes=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;};
      const shapes:Array<{loop:XY[];shape:InstanceType<typeof THREE.Shape>}> = [];
      for(const loop of loops){const parent=shapes.find(s=>inside(loop[0],s.loop));const points=loop.map(p=>new THREE.Vector2(p.x,p.y));if(parent)parent.shape.holes.push(new THREE.Path(points));else shapes.push({loop,shape:new THREE.Shape(points)});}
      for(const drill of [...pcb.pads.filter(p=>p.drill).map(p=>({position:p.position,x:Number(p.drill!.x),y:Number(p.drill!.y),rotation:Number(p.rotation??0)})),...pcb.vias.map(v=>({position:v.position,x:Number(v.drill??0),y:Number(v.drill??0),rotation:0}))]){
        const p=point(drill.position);if(!p||drill.x<=0||drill.y<=0)continue;const target=shapes.find(s=>inside(p,s.loop));if(!target)continue;
        const r=drill.rotation*Math.PI/180;const pts=rounded(drill.x,drill.y,Math.min(drill.x,drill.y)/2).getPoints(24).map(v=>new THREE.Vector2(p.x+v.x*Math.cos(r)-v.y*Math.sin(r),p.y+v.x*Math.sin(r)+v.y*Math.cos(r)));target.shape.holes.push(new THREE.Path(pts));
      }
      const scene=new THREE.Scene();scene.background=new THREE.Color("#dde5df");
      const group=new THREE.Group();scene.add(group);
      const resources:Array<{dispose:()=>void}>=[];
      cleanup=()=>{resources.forEach(r=>r.dispose());};
      const material=new THREE.MeshStandardMaterial({color:0x175b3d,roughness:.7,side:THREE.DoubleSide});resources.push(material);
      const thickness=Number(pcb.physicalDimensions?.thickness??1.6);
      for(const {shape} of shapes){const geometry=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false,curveSegments:24});resources.push(geometry);group.add(new THREE.Mesh(geometry,material));}
      const gold=new THREE.MeshStandardMaterial({color:0xc6a24d,metalness:.65,roughness:.4,side:THREE.DoubleSide});resources.push(gold);
      for(const pad of pcb.pads){const p=point(pad.position);if(!p||pad.padType==="np_thru_hole")continue;const w=Number(pad.size?.x??0),h=Number(pad.size?.y??0);if(w<=0||h<=0)continue;
        const radius=pad.shape==="circle"||pad.shape==="oval"?Math.min(w,h)/2:pad.shape==="roundrect"?Math.min(w,h)*.2:0;
        const shape=rounded(w,h,radius);
        if(pad.drill)shape.holes.push(rounded(Number(pad.drill.x),Number(pad.drill.y),Math.min(Number(pad.drill.x),Number(pad.drill.y))/2));
        const geometry=new THREE.ShapeGeometry(shape);resources.push(geometry);
        for(const side of ["F.Cu","B.Cu"]){if(!pad.layers.includes(side)&&!pad.layers.includes("*.Cu"))continue;const mesh=new THREE.Mesh(geometry,gold);mesh.position.set(p.x,p.y,side==="F.Cu"?thickness+.015:-.015);mesh.rotation.z=Number(pad.rotation??0)*Math.PI/180;group.add(mesh);}
      }
      const box=new THREE.Box3().setFromObject(group), center=box.getCenter(new THREE.Vector3()), size=box.getSize(new THREE.Vector3());group.position.sub(center);
      const distance=Math.max(size.x,size.y,1)*1.4;
      const camera=new THREE.PerspectiveCamera(45,1,.01,distance*20);camera.position.set(distance*.45,-distance*.7,distance);
      scene.add(new THREE.HemisphereLight(0xffffff,0x61796a,3));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(0,-distance,distance);scene.add(light);
      const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.current.appendChild(renderer.domElement);
      const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.update();controls.saveState();reset.current=()=>controls.reset();
      const resize=new ResizeObserver(()=>{if(!host.current)return;const w=host.current.clientWidth,h=host.current.clientHeight;renderer.setSize(w,h);camera.aspect=w/Math.max(h,1);camera.updateProjectionMatrix();});resize.observe(host.current);
      renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
      cleanup=()=>{resize.disconnect();renderer.setAnimationLoop(null);controls.dispose();resources.forEach(r=>r.dispose());renderer.dispose();renderer.domElement.remove();};
    }
    draw().catch(e=>{cleanup();if(!cancelled)setError(e instanceof Error?e.message:"3D 初始化失败；请检查浏览器 WebGL 支持。");});
    return()=>{cancelled=true;cleanup();};
  },[pcb]);
  return <div style={{position:"relative"}}><button type="button" onClick={()=>reset.current()} style={{position:"absolute",top:12,right:12,zIndex:1}}>重置视角</button>{error && <p role="alert" style={{padding:24}}>{error}</p>}<div ref={host} aria-label="PCB 三维视图" style={{height:600,width:"100%",display:error?"none":"block"}}/></div>;
}
