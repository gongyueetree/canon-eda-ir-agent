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
