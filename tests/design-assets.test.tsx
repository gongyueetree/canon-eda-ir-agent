import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEdaProject } from '../lib/eda/parse';
import { extractDesignAssets,identify,mergeAssets } from '../lib/design-assets/extract';
import { fingerprint,footprintFile,parse,symbolDefinition,symbolFile } from '../lib/design-assets/kicad';
import { validateAsset } from '../lib/design-assets/storage';
import { checkOfficial,officialTarget } from '../lib/design-assets/official';
import { sha256 } from '../lib/eda/util';
const enc=new TextEncoder();
const symbol='(symbol "Custom:Chip" (property "Reference" "U") (symbol "Chip_0_1" (rectangle (start -2 -2) (end 2 2) (stroke (width .1) (type default)) (fill (type none)))) (symbol "Chip_1_1" (pin input line (at -4 0 0) (length 2) (name "IN") (number "1"))))';
function fixture(mpn=true){return [{path:'project.kicad_sch',bytes:enc.encode(`(kicad_sch (version 20250114) (lib_symbols ${symbol}) ${[1,2].map(n=>`(symbol (lib_id "Custom:Chip") (at ${20*n} 30 0) (uuid "s${n}") (unit 1) (property "Reference" "U${n}") (property "Value" "CHIP") ${mpn?'(property "MPN" "ABC-123") (property "Manufacturer" "Acme")':''} (property "Footprint" "Custom:FP"))`).join(' ')})`)},{path:'project.kicad_pcb',bytes:enc.encode(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) ${[1,2].map(n=>`(footprint "Custom:FP" (layer "F.Cu") (at ${n*20} 30 ${n===1?0:90}) (uuid "f${n}") (property "Reference" "U${n}" (at 0 -2 ${n===1?0:90}) (layer "F.SilkS")) (property "Value" "CHIP" (at 0 2 ${n===1?0:90}) (layer "F.Fab")) (pad "1" smd rect (at 1 0 ${n===1?0:90}) (size 1 2) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "N${n}") (uuid "pad${n}")) (model "model.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`).join(' ')})`)},{path:'model.step',bytes:enc.encode('ISO-10303-21;\nEND-ISO-10303-21;')}];}

test('extracts standalone native assets, normalizes placements and keeps provenance across repeats',async()=>{
 const inputs=fixture(),bundle=await parseEdaProject(inputs),assets=await extractDesignAssets(bundle,inputs);
 assert.equal(assets.length,3);for(const a of assets){assert.equal(a.mpn,'ABC-123');assert.equal(a.identityConfirmed,true);assert.equal(a.origins.length,2);assert.ok(a.file);}
 const fp=assets.find(a=>a.kind==='footprint')!;const text=new TextDecoder().decode(fp.file!.bytes);assert.ok(!text.includes('(net '));assert.ok(!text.includes('(uuid '));assert.ok(text.includes('(at 1 0 0)'));assert.ok(!text.includes('U1'));
 const sch=assets.find(a=>a.kind==='symbol')!;assert.ok(new TextDecoder().decode(sch.file!.bytes).startsWith('(kicad_symbol_lib'));validateAsset(sch);
 const inputs2=inputs.map(a=>({...a,path:'second/'+a.path}));const b2=await parseEdaProject(inputs2);const second=await extractDesignAssets(b2,inputs2);const combined=mergeAssets([...assets,...second]);assert.equal(combined.length,3);assert.equal(combined[0].origins.length,4);
});

test('pin/pad differences retain distinct variants and unidentified values do not collapse',async()=>{
 const inputs=fixture(false);const assets=await extractDesignAssets(await parseEdaProject(inputs),inputs);assert.equal(assets.filter(a=>a.kind==='symbol').length,2);assert.ok(assets.every(a=>!a.identityConfirmed));assert.throws(()=>validateAsset(assets[0]),/MPN_CONFIRMATION/);
 const confirmed=await Promise.all(assets.map(a=>identify(a,'ABC-123','Acme')));assert.equal(mergeAssets(confirmed).length,3);
 const base=footprintFile(parse('(footprint "P" (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 2)))'));
 assert.notEqual(await fingerprint('footprint',enc.encode(base)),await fingerprint('footprint',enc.encode(base.replace('(size 1 2)','(size 1 3)'))));
 const back=footprintFile(parse('(footprint "P" (layer "B.Cu") (at 30 20 90) (pad "1" smd rect (at 1 -2 120) (size 1 2) (layers "B.Cu" "B.Mask")))'));assert.match(back,/\(at 1 2 330\)/);assert.match(back,/\(layers "F.Cu" "F.Mask"\)/);
 const a=await identify(assets[0],'ABC-123','Other');assert.notEqual(a.id,confirmed[0].id);
});

test('symbol inheritance is flattened without losing parent geometry; invalid files are rejected',async()=>{
 const root=parse('(kicad_symbol_lib (symbol "Base" (property "Value" "Base") (symbol "Base_1_1" (pin input line (at 0 0 0) (length 2) (name "A") (number "1")))) (symbol "Child" (extends "Base") (property "Value" "Child")))');
 const def=symbolDefinition(root,'Child')!;const text=symbolFile(def);assert.ok(!text.includes('extends'));assert.ok(text.includes('Child_1_1'));assert.equal((text.match(/\(property "Value"/g)??[]).length,1);
 await assert.rejects(fingerprint('symbol',enc.encode('(kicad_symbol_lib (symbol "A") (symbol "B"))')));await assert.rejects(fingerprint('model',enc.encode('not a model')));
});

test('official lookup separates missing, different and network failure, pins commit and rejects arbitrary paths',async()=>{
 assert.equal(officialTarget('model','../../private.step'),undefined);assert.equal(officialTarget('footprint','../Bad:X'),undefined);
 assert.deepEqual(officialTarget('model','${KICAD10_3DMODEL_DIR}/LED_SMD.3dshapes/X.step'),{repo:'kicad-packages3D',path:'LED_SMD.3dshapes/X.step'});
 const original=globalThis.fetch;let calls=0;const official='(footprint "Test" (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 2)))';
 globalThis.fetch=async(input)=>{calls++;if(String(input).includes('Missing'))return new Response(null,{status:404});if(String(input).includes('Failed'))throw Error('network down');return Response.json({content:Buffer.from(official).toString('base64'),content_sha256:await sha256(enc.encode(official)),commit_id:'a'.repeat(40)});};
 try{const hash=await fingerprint('footprint',enc.encode(footprintFile(parse(official))));const matched=await checkOfficial('footprint','TestLibrary:Test',hash);assert.equal(matched.status,'match');assert.equal(matched.revision,'a'.repeat(40));assert.equal((await checkOfficial('footprint','TestLibrary:Test','b'.repeat(64))).status,'different');assert.equal(calls,1);assert.equal((await checkOfficial('footprint','TestLibrary:Missing')).status,'missing');assert.equal((await checkOfficial('footprint','TestLibrary:Failed')).status,'unknown');}
 finally{globalThis.fetch=original;}
});

test('asset UI extracts, confirms identity and reports backend failures without pretending to save',async()=>{
 const {JSDOM}=await import('jsdom');const {act}=await import('react');const {createRoot}=await import('react-dom/client');const {DesignAssetWorkbench}=await import('../components/DesignAssetWorkbench');
 const dom=new JSDOM('<div id="root"></div>');Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const inputs=fixture(false),bundle=await parseEdaProject(inputs),root=createRoot(document.getElementById('root')!);const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:'DATABASE_NOT_CONFIGURED'},{status:400});
 try{await act(async()=>root.render(<DesignAssetWorkbench bundle={bundle} assets={inputs} mappings={{}}/>));const click=async(text:string)=>act(async()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b);b.click();});await click('提取当前工程');for(let i=0;i<60&&!document.body.textContent?.includes('待确认 MPN');i++)await act(async()=>{await new Promise(r=>setTimeout(r,20));});assert.match(document.body.textContent!,/待确认 MPN/);const stages=[...document.querySelectorAll('button')].filter(b=>b.textContent==='从工程提取 → 待审核');assert.ok(stages.every(b=>b.disabled));await click('确认型号与厂商');for(let i=0;i<60&&!document.body.textContent?.includes('MPN 已明确');i++)await act(async()=>{await new Promise(r=>setTimeout(r,20));});assert.ok([...document.querySelectorAll('button')].some(b=>b.textContent==='从工程提取 → 待审核'&&!b.disabled));await click('查询数据库 / 刷新');assert.match(document.querySelector('[role="alert"]')!.textContent!,/DATABASE_URL/);assert.ok(!document.body.textContent!.includes('资产已正式入库'));}
 finally{await act(async()=>root.unmount());globalThis.fetch=original;dom.window.close();}
});

test('official split symbol directories resolve parent dependencies at the same commit',async()=>{
 const original=globalThis.fetch;const urls:string[]=[];const commit='c'.repeat(40);
 globalThis.fetch=async(input)=>{const url=String(input);urls.push(url);const text=url.includes('Child.kicad_sym')?'(kicad_symbol_lib (symbol "Child" (extends "Parent") (property "Value" "Child")))':'(kicad_symbol_lib (symbol "Parent" (symbol "Parent_1_1" (pin input line (at 0 0 0) (length 2) (name "A") (number "1")))))';return Response.json({content:Buffer.from(text).toString('base64'),content_sha256:'a'.repeat(64),commit_id:commit});};
 try{const match=await checkOfficial('symbol','DirectoryTest:Child');assert.equal(match.status,'found');assert.ok(match.url?.includes('DirectoryTest.kicad_symdir/Child.kicad_sym'));assert.ok(urls.some(u=>u.includes('Parent.kicad_sym')&&u.includes('ref='+commit)));}
 finally{globalThis.fetch=original;}
});

test('front and back footprint instances restore identical library pad geometry and layers',async()=>{
 const front=footprintFile(parse('(footprint "P" (layer "F.Cu") (pad "1" smd roundrect (at 1 2 30) (size 1 2) (layers "F.Cu" "F.Mask")) (fp_line (start 1 2) (end 3 4) (stroke (width .1) (type default)) (layer "F.SilkS")))'));
 const back=footprintFile(parse('(footprint "P" (layer "B.Cu") (at 50 40 90) (pad "1" smd roundrect (at 1 -2 60) (size 1 2) (layers "B.Cu" "B.Mask")) (fp_line (start 1 -2) (end 3 -4) (stroke (width .1) (type default)) (layer "B.SilkS")))'));
 assert.equal(await fingerprint('footprint',enc.encode(front)),await fingerprint('footprint',enc.encode(back)));
});
