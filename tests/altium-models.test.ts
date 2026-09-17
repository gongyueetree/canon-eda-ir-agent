import assert from "node:assert/strict";
import test from "node:test";
import { zlibSync } from "fflate";
import { Group, Vector3 } from "three";
import { attachAltiumModels, unpackAltiumModel } from "../lib/eda/altium-models";
import { placeFootprintModel } from "../lib/models/load-footprints";
import type { PcbIr } from "../lib/eda/types";

const props=(s:string)=>{const b=Buffer.from(s+"\0"),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);};
function fixture(bottom:boolean){
  const pcb={footprints:[{id:"fp",reference:"U1",position:{x:"10",y:"-20",unit:"mm"},rotation:"90",side:bottom?"back":"front",padIds:[]}]} as unknown as PcbIr;
  const p=props(`|MODELID={A}|MODEL.EMBED=TRUE|MODEL.2D.X=12mm|MODEL.2D.Y=23mm|MODEL.3D.DZ=0.5mm|MODEL.3D.ROTZ=0|BODYPROJECTION=${bottom?1:0}`);
  const body=Buffer.concat([Buffer.alloc(18),p]),h=Buffer.alloc(5);h[0]=12;h.writeUInt32LE(body.length,1);
  const stream=(name:string)=>name==="Models/Data"?props("|ID={A}|NAME=same.step|EMBED=TRUE"):Buffer.concat([h,body]);
  return {pcb,stream};
}
test("AD absolute model positions survive footprint rotation on either board face",()=>{
  for(const bottom of [false,true]){
    const {pcb,stream}=fixture(bottom);assert.equal(attachAltiumModels(stream,pcb).attached,1);
    const fp=pcb.footprints[0],ref=fp.models![0],model=new Group();
    const placed=placeFootprintModel(model,fp,ref,1.6);placed.updateMatrixWorld(true);
    const origin=model.localToWorld(new Vector3());
    assert.ok(origin.distanceTo(new Vector3(12,23,bottom?-.5:2.1))<1e-8);
    const x=model.localToWorld(new Vector3(1,0,0)).sub(origin);
    assert.ok(x.distanceTo(new Vector3(1,0,0))<1e-8,"footprint rotation must not rotate the absolute body twice");
  }
});
test("AD STEP decompression is bounded and rejects other payloads",()=>{
  const step=new TextEncoder().encode("ISO-10303-21;\n"+ "x".repeat(4096));
  assert.deepEqual(unpackAltiumModel(zlibSync(step)),step);
  assert.throws(()=>unpackAltiumModel(zlibSync(step),100),/超限/);
  assert.throws(()=>unpackAltiumModel(zlibSync(new TextEncoder().encode("not STEP"))),/STEP/);
});
test("invalid AD Body cannot attach partial models or alter PCB components",()=>{
  const {pcb,stream}=fixture(false),bad=(name:string)=>name==="Models/Data"?stream(name):stream(name).subarray(0,12);
  assert.throws(()=>attachAltiumModels(bad,pcb),/截断/);
  assert.equal(pcb.footprints.length,1);assert.equal(pcb.footprints[0].models,undefined);
});
