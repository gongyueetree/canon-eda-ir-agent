import assert from "node:assert/strict";
import test from "node:test";
import * as CFB from "cfb";
import { altiumBlocks, altiumProperties } from "../lib/eda/altium-native";
import { parseEdaProject } from "../lib/eda/parse";

function block(text: string) {
  const bytes = Buffer.from(text + "\0"); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
function document(records: string[]) {
  const c = CFB.utils.cfb_new();
  CFB.utils.cfb_add(c, "FileHeader", Buffer.concat(records.map(block)));
  return new Uint8Array(CFB.write(c, { type: "buffer" }));
}
test("AD native schematic: ownership, active display mode and pin endpoint", async () => {
  const bytes = document([
    "|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0",
    "|RECORD=1|LibReference=IC|CurrentPartId=1|DisplayMode=1|Location.X=100|Location.Y=100",
    "|RECORD=34|OwnerIndex=0|Name=Designator|Text=U1|Location.X=100|Location.Y=110",
    "|RECORD=2|OwnerIndex=0|OwnerPartId=1|OwnerPartDisplayMode=1|PinConglomerate=0|PinLength=20|Location.X=100|Location.Y=100|Designator=1|Name=OUT",
    "|RECORD=2|OwnerIndex=0|OwnerPartId=1|OwnerPartDisplayMode=0|PinLength=10|Designator=2",
    "|RECORD=27|LocationCount=2|X1=120|Y1=100|X2=140|Y2=100",
    "|RECORD=25|Location.X=140|Location.Y=100|Text=SIGNAL",
  ]);
  const bundle = await parseEdaProject([{ path: "demo.SchDoc", bytes }]);
  assert.equal(bundle.parser.adapterId, "altium-cfb-records");
  assert.equal(bundle.parts[0].reference, "U1");
  assert.equal(bundle.schematics[0].pins.length, 1);
  assert.deepEqual(bundle.schematics[0].pins[0].position, { x: "30.48", y: "-25.4", unit: "mm" });
  assert.ok(bundle.nets.some(n => n.canonicalName === "SIGNAL" && n.endpoints.some(e => e.type === "symbol_pin")));
  assert.equal(bundle.fidelity.overallStatus, "partial");
  assert.equal(bundle.diagnostics.filter(d => d.severity === "error" || d.severity === "fatal").length, 0);
});
test("AD records reject truncation and properties cannot mutate object prototypes", () => {
  assert.throws(() => altiumBlocks(new Uint8Array([100, 0, 0, 0, 1])));
  assert.throws(() => altiumBlocks(new Uint8Array([1])));
  const props = altiumProperties(Buffer.from("|NAME=R1|VALUE=a=b|__proto__=unsafe"));
  assert.equal(props.VALUE, "a=b"); assert.equal(Object.getPrototypeOf(props), null);
});
test("malformed AD containers do not emit fabricated geometry", async () => {
  const bytes = document(["|HEADER=test", "|RECORD=1"]);
  const bundle = await parseEdaProject([{ path: "bad.PcbDoc", bytes }]);
  assert.equal(bundle.pcbs.length, 0);
  assert.ok(bundle.diagnostics.some(d => d.code === "ALTIUM_NATIVE_UNSUPPORTED"));
});

test("AD PCB preserves explicit nets, binary units and unattached pads", async () => {
  const c = CFB.utils.cfb_new();
  CFB.utils.cfb_add(c, "Board6/Data", block("|VX0=0mil|VY0=0mil|VX1=100mil|VY1=0mil|VX2=100mil|VY2=100mil"));
  CFB.utils.cfb_add(c, "Nets6/Data", block("|NAME=GND"));
  const payload = Buffer.alloc(114); payload[0] = 1;
  payload.writeUInt16LE(65535, 7); // Not owned by a component.
  payload.writeInt32LE(100000, 13); payload.writeInt32LE(200000, 17);
  payload.writeInt32LE(10000, 21); payload.writeInt32LE(10000, 25);
  payload[49] = 1;
  const binaryBlock = (b: Buffer) => { const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
  CFB.utils.cfb_add(c, "Pads6/Data", Buffer.concat([Buffer.from([2]), ...[Buffer.from([1, 49]), Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0), payload, Buffer.alloc(0)].map(binaryBlock)]));
  const bundle = await parseEdaProject([{ path: "board.PcbDoc", bytes: new Uint8Array(CFB.write(c, { type: "buffer" })) }]);
  assert.equal(bundle.pcbs.length, 1);
  assert.equal(bundle.pcbs[0].pads[0].footprintId, undefined);
  assert.equal(bundle.pcbs[0].pads[0].netName, "GND");
  assert.deepEqual(bundle.pcbs[0].pads[0].position, { x: "0.254", y: "-0.508", unit: "mm" });
  assert.equal(bundle.diagnostics.filter(d => d.severity === "error" || d.severity === "fatal").length, 0);
});

test('Altium source geometries export reviewable KiCad symbol and footprint assets',async()=>{
 const {extractDesignAssets}=await import('../lib/design-assets/extract');
 const sch=document(['|HEADER=Protel','|RECORD=1|LibReference=LED_red|CurrentPartId=1|Location.X=100|Location.Y=100','|RECORD=34|OwnerIndex=0|Name=Designator|Text=D1','|RECORD=41|OwnerIndex=0|Name=MPN|Text=LTST-C150EKT','|RECORD=2|OwnerIndex=0|OwnerPartId=1|PinConglomerate=0|PinLength=20|Location.X=100|Location.Y=100|Designator=1|Name=A','|RECORD=13|OwnerIndex=0|Location.X=100|Location.Y=100|Corner.X=110|Corner.Y=110']);
 const c=CFB.utils.cfb_new();CFB.utils.cfb_add(c,'Board6/Data',block('|VX0=0mil|VY0=0mil|VX1=100mil|VY1=0mil|VX2=100mil|VY2=100mil'));
 CFB.utils.cfb_add(c,'Components6/Data',block('|SOURCEDESIGNATOR=D1|PATTERN=LED_0603|X=10mm|Y=20mm|ROTATION=90|LAYER=TOP'));
 const payload=Buffer.alloc(114);payload[0]=1;payload.writeUInt16LE(0,7);payload.writeUInt16LE(65535,3);payload.writeInt32LE(Math.round(10/.00000254),13);payload.writeInt32LE(Math.round(21/.00000254),17);payload.writeInt32LE(200000,21);payload.writeInt32LE(100000,25);payload[49]=2;payload.writeDoubleLE(90,52);
 const chunks=[Buffer.from([1,49]),Buffer.alloc(0),Buffer.alloc(0),Buffer.alloc(0),payload,Buffer.alloc(0)].map(b=>{const h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);});CFB.utils.cfb_add(c,'Pads6/Data',Buffer.concat([Buffer.from([2]),...chunks]));
 const inputs=[{path:'test.SchDoc',bytes:sch},{path:'test.PcbDoc',bytes:new Uint8Array(CFB.write(c,{type:'buffer'}))}];
 const bundle=await parseEdaProject(inputs),assets=await extractDesignAssets(bundle,inputs);const symbol=assets.find(a=>a.kind==='symbol')!,fp=assets.find(a=>a.kind==='footprint')!;
 assert.ok(symbol.file);assert.ok(fp.file);assert.ok(symbol.warnings.some(w=>w.includes('Altium')));
 const st=new TextDecoder().decode(symbol.file!.bytes);assert.match(st,/\(pin unspecified line/);assert.match(st,/\(number "1"/);assert.match(st,/\(length 5.08\)/);
 const ft=new TextDecoder().decode(fp.file!.bytes);assert.match(ft,/\(pad "1" smd rect/);assert.ok(!ft.includes('(net '));
 const parsed=await parseEdaProject([{path:'converted.kicad_pcb',bytes:new TextEncoder().encode('(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal)) '+ft+')')}]);assert.equal(parsed.pcbs[0].pads.length,1);assert.equal(parsed.pcbs[0].pads[0].size?.x,'0.508');
 // A folder full of KiCad libraries must not displace the actual AD drawings.
 const libraries=Array.from({length:5},(_,i)=>({path:`lib${i}.kicad_sym`,bytes:symbol.file!.bytes}));assert.equal((await parseEdaProject([...inputs,...libraries])).project.sourceFormat,'altium');
});

test('AD Comment/value, pin type and designator appear beside symbol body',async()=>{
 const bytes=document([
  '|HEADER=Protel',
  '|RECORD=1|LibReference=R|CurrentPartId=1|Location.X=100|Location.Y=100',
  '|RECORD=34|OwnerIndex=0|Name=Designator|Text=R1|Location.X=85|Location.Y=95',
  '|RECORD=41|OwnerIndex=0|Name=Comment|Text=10k|Location.X=85|Location.Y=105',
  '|RECORD=14|OwnerIndex=0|Location.X=95|Location.Y=95|Corner.X=105|Corner.Y=105',
  '|RECORD=2|OwnerIndex=0|Electrical=4|PinConglomerate=0|PinLength=10|Location.X=95|Location.Y=100|Designator=1|Name=~',
 ]);
 const bundle=await parseEdaProject([{path:'resistors.SchDoc',bytes}]);const part=bundle.parts[0],sch=bundle.schematics[0];
 assert.equal(part.reference,'R1');assert.equal(part.value,'10k');assert.equal(sch.pins[0].electricalType,'passive');
 assert.ok(sch.texts!.find(t=>t.kind==='reference'&&t.text==='R1'&&Number(t.position.x)>26));
 assert.ok(sch.texts!.find(t=>t.kind==='value'&&t.text==='10k'&&Number(t.position.x)>26));
 const {extractDesignAssets}=await import('../lib/design-assets/extract');
 const assets=await extractDesignAssets(bundle,[{path:'resistors.SchDoc',bytes}]);
 assert.match(new TextDecoder().decode(assets.find(a=>a.kind==='symbol')!.file!.bytes),/\(pin passive line/);
});

test('AD embedded PCB model resolves to the same actual STEP asset as the board viewer',async()=>{
 const {zlibSync}=await import('fflate');const {embeddedModels,resolveModelPath}=await import('../lib/models/footprints');
 const c=CFB.utils.cfb_new();
 CFB.utils.cfb_add(c,'Board6/Data',block('|VX0=0mil|VY0=0mil|VX1=100mil|VY1=0mil|VX2=100mil|VY2=100mil'));
 CFB.utils.cfb_add(c,'Components6/Data',block('|SOURCEDESIGNATOR=C1|SOURCELIBREFERENCE=C|PATTERN=Capacitor_SMD:C_0603|X=10mm|Y=20mm|ROTATION=0|LAYER=TOP'));
 CFB.utils.cfb_add(c,'Models/Data',block('|ID={A}|NAME=c0603.step|EMBED=TRUE'));
 CFB.utils.cfb_add(c,'Models/0',zlibSync(Buffer.from('ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;')));
 const props=block('|MODELID={A}|MODEL.EMBED=TRUE|MODEL.2D.X=10mm|MODEL.2D.Y=20mm|MODEL.3D.DZ=0mm|BODYPROJECTION=0');
 const body=Buffer.concat([Buffer.alloc(18),props]),header=Buffer.alloc(5);header[0]=12;header.writeUInt32LE(body.length,1);
 CFB.utils.cfb_add(c,'ComponentBodies6/Data',Buffer.concat([header,body]));
 const input={path:'board/project.PcbDoc',bytes:new Uint8Array(CFB.write(c,{type:'buffer'}))},bundle=await parseEdaProject([input]);
 const fp=bundle.pcbs[0].footprints[0];assert.equal(fp.reference,'C1');assert.ok(fp.models?.[0]);
 const boardModel=resolveModelPath(fp.models![0].path,bundle.pcbs[0],embeddedModels(input));assert.ok(boardModel.asset);
 const {extractDesignAssets}=await import('../lib/design-assets/extract');const extracted=await extractDesignAssets(bundle,[input]);
 const model=extracted.find(a=>a.kind==='model'&&a.file);assert.ok(model);assert.deepEqual(model.file!.bytes,boardModel.asset!.bytes);
});
