import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { KnowledgeWorkbench } from "../components/KnowledgeWorkbench";
import { miningFixture } from "../lib/knowledge/fixtures";
import { parseEdaProject } from "../lib/eda/parse";
import { arcPoints } from "../lib/eda/view-geometry";

test("circular arc includes midpoint and stays on circle",()=>{
 const points=arcPoints({x:1,y:0},{x:0,y:1},{x:-1,y:0});
 assert.ok(points.some(p=>Math.abs(p.y-1)<1e-8));
 assert.ok(points.every(p=>Math.abs(Math.hypot(p.x,p.y)-1)<1e-8));
 const major=arcPoints({x:1,y:0},{x:-1,y:0},{x:0,y:1});
 assert.ok(major.some(p=>p.y<-.99));
});

test("member changes are visible, survive selection and are included in export",async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:"http://localhost"});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const bundle=await parseEdaProject([{path:"AD9837.kicad_sch",bytes:new TextEncoder().encode(miningFixture("AD9837"))}]);
 const root=createRoot(document.getElementById("root")!);
 try{
  await act(async()=>{root.render(<KnowledgeWorkbench bundle={bundle}/>);});
  for(let i=0;i<40 && !document.querySelector(".knowledge-layout");i++) await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
  assert.match(document.body.textContent!,/核心 IC · 固定纳入/);
  const select=document.querySelector('select[aria-label="R1 边界"]') as HTMLSelectElement;
  assert.ok(select);const before=select.value;const after=before==="included"?"boundary":"included";
  await act(async()=>{select.value=after;select.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
  assert.equal((document.querySelector('select[aria-label="R1 边界"]') as HTMLSelectElement).value,after);
  assert.match(document.body.textContent!,/未提交修改/);
  const choices=[...document.querySelectorAll(".knowledge-layout aside button")] as HTMLButtonElement[];
  assert.ok(choices.length>1);
  await act(async()=>choices[1].click());await act(async()=>choices[0].click());
  assert.equal((document.querySelector('select[aria-label="R1 边界"]') as HTMLSelectElement).value,after);
  let blob:Blob|undefined;
  const original=URL.createObjectURL;URL.createObjectURL=(value)=>{blob=value as Blob;return "blob:test";};
  dom.window.HTMLAnchorElement.prototype.click=()=>{};
  try {await act(async()=>{([...document.querySelectorAll("button")].find(b=>b.textContent==="导出知识 JSON") as HTMLButtonElement).click();});assert.ok(blob);const exported=JSON.parse(await blob.text());assert.ok(exported.blocks.some((b:{members:Array<{reference:string;decision:string}>})=>b.members.some(m=>m.reference==="R1"&&m.decision===after)));} finally{URL.createObjectURL=original;}
 }finally{await act(async()=>root.unmount());dom.window.close();}
});

test('BOM candidate confirmation updates manufacturer, MPN and exported CSV',async()=>{
 const {BomWorkbench}=await import('../components/BomWorkbench');
 const {useState}=await import('react');
 const {judgeMapping}=await import('../lib/bom/match');
 const dom=new JSDOM('<div id="bom"></div>',{url:'http://localhost'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const bundle=await parseEdaProject([{path:'AD9837.kicad_sch',bytes:new TextEncoder().encode(miningFixture('AD9837'))}]);
 const original=globalThis.fetch,createURL=URL.createObjectURL;let exported:Blob|undefined;
 globalThis.fetch=async(_input,init)=>{const q=JSON.parse(String(init?.body));return Response.json(judgeMapping(q,[{mpn:'AD9837BRMZ',manufacturer:'Analog Devices',package:'MSOP-10',description:'DDS',source:'ezplm',fetchedAt:'2026-09-14'}],[{source:'ezplm',status:'OK',count:1}]));};
 URL.createObjectURL=b=>{exported=b as Blob;return 'blob:bom';};dom.window.HTMLAnchorElement.prototype.click=()=>{};
 function Harness(){const [m,setM]=useState<Record<string,import('../lib/bom/types').BomMapping>>({});return <BomWorkbench bundle={bundle} mappings={m} onMapping={(id,r)=>setM(p=>({...p,[id]:r}))}/>;}
 const root=createRoot(document.getElementById('bom')!);
 try{
 await act(async()=>root.render(<Harness/>));
 const row=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent?.includes('U1'))!;
 await act(async()=>(row.querySelector('button') as HTMLButtonElement).click());
 await act(async()=>{([...document.querySelectorAll('button')].find(b=>b.textContent==='查询 / 重试') as HTMLButtonElement).click();});
 assert.match(document.body.textContent!,/待确认/);
 await act(async()=>{([...document.querySelectorAll('button')].find(b=>b.textContent==='确认此型号') as HTMLButtonElement).click();});
 assert.match(row.textContent!,/Analog Devices/);assert.match(row.textContent!,/AD9837BRMZ/);assert.match(row.textContent!,/人工确认/);
 await act(async()=>{([...document.querySelectorAll('button')].find(b=>b.textContent==='下载映射后 CSV') as HTMLButtonElement).click();});
 assert.ok(exported);assert.match(await exported.text(),/Analog Devices/);assert.match(await exported.text(),/AD9837BRMZ/);
 }finally{await act(async()=>root.unmount());globalThis.fetch=original;URL.createObjectURL=createURL;dom.window.close();}
});

test('schematic preserves power geometry and paper; wheel, drag and reset operate without block captions',async()=>{
 const {SchematicViewer}=await import('../components/EdaViewers');
 const source=`(kicad_sch (version 20250114) (paper "A4") (lib_symbols (symbol "power:GND" (symbol "GND_0_1" (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)))))) (symbol (lib_id "power:GND") (at 50 50 0) (unit 1) (uuid "p") (property "Reference" "#PWR01") (property "Value" "GND" (at 50 54 0))))`;
 const bundle=await parseEdaProject([{path:'power.kicad_sch',bytes:new TextEncoder().encode(source)}]);
 assert.equal(bundle.parts.length,0);assert.equal(bundle.schematics[0].page?.width,297);assert.ok(bundle.schematics[0].graphics?.some(g=>g.points.length===6));
 const dom=new JSDOM('<div id="schematic"></div>',{url:'http://localhost'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.getElementById('schematic')!);
 try {
  await act(async()=>root.render(<SchematicViewer bundle={bundle}/>));
  const svg=document.querySelector('svg[role="img"]')!;
  svg.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,width:1200,height:720,right:1200,bottom:720,toJSON(){}});
  assert.ok(svg.querySelector('.schematic-page-frame'));assert.ok(!document.body.textContent?.includes('打开子页'));
  const wheel=new dom.window.WheelEvent('wheel',{clientX:600,clientY:360,deltaY:-200,bubbles:true,cancelable:true});
  await act(async()=>{svg.dispatchEvent(wheel);});assert.ok(wheel.defaultPrevented);assert.match(document.body.textContent!,/135%/);
  const pointer=(type:string,x:number,y:number)=>{const e=new dom.window.MouseEvent(type,{clientX:x,clientY:y,bubbles:true,button:0});Object.defineProperty(e,'pointerId',{value:1});return e;};
  await act(async()=>{svg.dispatchEvent(pointer('pointerdown',100,100));});
  await act(async()=>{svg.dispatchEvent(pointer('pointermove',180,140));});
  await act(async()=>{svg.dispatchEvent(pointer('pointerup',180,140));});
  assert.ok(svg.querySelector('g[transform="translate(80 40)"]'));
  await act(async()=>{([...document.querySelectorAll('button')].find(b=>b.textContent?.includes('适合窗口'))!).click();});
  assert.ok(svg.querySelector('g[transform="translate(0 0)"]'));assert.match(document.body.textContent!,/100%/);
 }finally{await act(async()=>root.unmount());dom.window.close();}
});

test('rotated power mirror uses sheet axes and hierarchical ports retain electrical shape',async()=>{
 const source=`(kicad_sch (version 20250114) (lib_symbols (symbol "power:+3V3" (symbol "+3V3_0_1" (polyline (pts (xy -1 2) (xy 0 3) (xy 1 2)))))) (symbol (lib_id "power:+3V3") (at 50 50 90) (mirror x) (unit 1) (uuid "power") (property "Reference" "#PWR01") (property "Value" "+3V3")) (hierarchical_label "DC_OUT" (shape output) (at 80 50 0) (effects (font (size 1.016 1.016)))))`;
 const bundle=await parseEdaProject([{path:'ports.kicad_sch',bytes:new TextEncoder().encode(source)}]);
 const sch=bundle.schematics[0];
 assert.deepEqual(sch.graphics?.[0].points.map(p=>[Number(p.x),Number(p.y)]),[[48,49],[47,50],[48,51]]);
 assert.equal(sch.labels.find(l=>l.name==='DC_OUT')?.shape,'output');
 const {hierarchicalPort}=await import('../lib/eda/port-geometry');
 for(const angle of [0,90,180,270])for(const shape of ['input','output','bidirectional','tri_state','passive']){
  const points=hierarchicalPort(shape,2,angle);assert.deepEqual(points[0],points.at(-1));
  assert.ok(points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 }
 assert.ok(hierarchicalPort('input',2,180).every(p=>p.x<=1e-8));
 const {renderToStaticMarkup}=await import('react-dom/server');const {SchematicViewer}=await import('../components/EdaViewers');
 const html=renderToStaticMarkup(<SchematicViewer bundle={bundle}/>);
 assert.match(html,/schematic-hierarchical-port/);assert.match(html,/data-shape="output"/);
});

test('global labels render enclosed ports instead of plain labels',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');const {SchematicViewer}=await import('../components/EdaViewers');
 const bundle=await parseEdaProject([{path:'global.kicad_sch',bytes:new TextEncoder().encode('(kicad_sch (version 20250114) (global_label "USB_DP" (shape bidirectional) (at 50 50 180)))')}]);
 assert.match(renderToStaticMarkup(<SchematicViewer bundle={bundle}/>),/schematic-global-port/);
});

test('embedded Zstd raw frame is extracted without confusing footprint declarations',async()=>{
 const {embeddedModels}=await import('../lib/models/footprints');
 const raw=new TextEncoder().encode('ISO-10303-21;');const size=raw.length;
 const frame=Uint8Array.from([0x28,0xb5,0x2f,0xfd,0x20,size,(size<<3)|1,0,0,...raw]);
 const b64=Buffer.from(frame).toString('base64');
 const bytes=new TextEncoder().encode(`(embedded_files (file (name "wrong.step") (type other) (checksum "x"))) (embedded_files (file (name "right.step") (type other) (data |${b64}|\n)))`);
 const assets=embeddedModels({path:'board.kicad_pcb',bytes});assert.equal(assets.length,1);assert.equal(assets[0].path,'kicad-embed://right.step');assert.deepEqual(assets[0].bytes,raw);
});

test('model placement applies native offset, scale and bottom-side flip',async()=>{
 const {Group,Vector3}=await import('three');const {placeFootprintModel}=await import('../lib/models/load-footprints');
 const fp={reference:'U1',position:{x:'10',y:'20'},rotation:'90',side:'back'} as import('../lib/eda/types').PcbIr['footprints'][number];
 const model=new Group();const placed=placeFootprintModel(model,fp,{path:'x.step',offset:[1,2,3],scale:[2,2,2],rotation:[0,0,0],hidden:false},1.6);placed.updateMatrixWorld(true);
 const p=model.localToWorld(new Vector3(0,0,0));assert.ok(p.distanceTo(new Vector3(12,-19,-3))<1e-6);
});

test('legacy cache-library resistor is rendered from its body and visible source fields',async()=>{
 const lib='EESchema-LIBRARY Version 2.4\nDEF Device_R R 0 0 N Y 1 F N\nDRAW\nS -40 100 40 -100 0 1 10 N\nX ~ 1 0 150 50 D 50 50 1 1 P\nX ~ 2 0 -150 50 U 50 50 1 1 P\nENDDRAW\nENDDEF\n#End Library';
 const sch='EESchema Schematic File Version 4\n$Descr A4 11693 8268\n$EndDescr\n$Comp\nL Device:R R1\nU 1 1 abc\nP 2000 2000\nF 0 "R1" H 2100 2050 50 0000 L CNN\nF 1 "10k" H 2100 1950 50 0000 L CNN\n\t1 2000 2000\n\t1 0 0 -1\n$EndComp\n$EndSCHEMATC';
 const b=await parseEdaProject([{path:'test.sch',bytes:new TextEncoder().encode(sch)},{path:'test-cache.lib',bytes:new TextEncoder().encode(lib)}]);
 assert.equal(b.schematics[0].graphics?.length,3);assert.equal(b.schematics[0].texts?.length,2);
 assert.equal(b.schematics[0].graphics?.[0].points[0].x,'49.784');
});
