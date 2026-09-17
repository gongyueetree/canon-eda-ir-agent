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
