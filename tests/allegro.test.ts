import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { inventoryAssets } from "../lib/eda/detect";
import { parseEdaProject } from "../lib/eda/parse";
import { readAllegroManifest } from "../lib/eda/allegro-format";
import { prepareAllegroInputs } from "../lib/eda/allegro-client";
import { sha256 } from "../lib/eda/util";
import { boundedBody } from "../lib/allegro-http";
import { POST } from "../app/api/allegro/route";
import type { InputAsset } from "../lib/eda/types";

const input = (path: string, text: string): InputAsset => ({ path, bytes: new TextEncoder().encode(text) });
// Synthetic header and converted PCB contract fixture, NOT a real Allegro conversion.
const native = (): Uint8Array => { const b = new Uint8Array(512); b[2] = 0x14; b[1] = 9; return b; };
const board = `(kicad_pcb (version 20260101) (generator pcbnew) (general (thickness 1.6))
 (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
 (footprint "R_0603" (layer "F.Cu") (at 10 10) (uuid fp1)
  (property "Reference" "R1") (property "Value" "10k")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))
  (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net "0")))
 (segment (start 10 10) (end 12 12) (width 0.25) (layer "F.Cu") (net "GND") (uuid track1))
 (via (at 12 12) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid via1))
 (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts") (width 0.05)))`;

async function converted(prefix = ""): Promise<InputAsset[]> {
  const source = { path: prefix + "source.brd", bytes: native() }, pcb = input(prefix + "board.kicad_pcb", board);
  const manifest = input(prefix + "refir-allegro.json", JSON.stringify({ format: "refir-allegro", version: 1, source: { path: "source.brd", sha256: await sha256(source.bytes) }, board: { path: "board.kicad_pcb", sha256: await sha256(pcb.bytes) }, converter: { name: "test fixture", version: "10.0" } }));
  return [source, pcb, manifest];
}

test("shared BRD extension uses content signatures and does not guess unknown/EAGLE data", async () => {
  for (const [asset, expected] of [
    [{ path: "a.brd", bytes: native() }, "allegro"],
    [input("b.brd", "PCBNEW-BOARD Version 1"), "kicad"],
    [input("c.brd", '<eagle version="9"><drawing/></eagle>'), "unknown"],
    [input("d.brd", "garbage"), "unknown"],
  ] as const) {
    const result = await inventoryAssets([asset]);
    assert.equal(result.sourceFormat, expected);
    if (expected === "unknown") assert.ok(result.diagnostics.some(d => d.code === "FORMAT_AMBIGUOUS"));
  }
});

test("unconverted BRD and OrCAD CFB never become empty successful KiCad/AD projects", async () => {
  const b = await parseEdaProject([{ path: "a.brd", bytes: native() }]);
  assert.equal(b.pcbs.length, 0);
  assert.ok(b.diagnostics.some(d => d.code === "ALLEGRO_CONVERSION_REQUIRED" && d.severity === "error"));
  assert.equal(b.fidelity.overallStatus, "partial");
  const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const dsn = await parseEdaProject([{ path: "capture.dsn", bytes: cfb }]);
  assert.equal(dsn.project.sourceFormat, "allegro");
  assert.ok(dsn.diagnostics.some(d => d.code === "ALLEGRO_DOCUMENT_UNSUPPORTED"));
});

test("verified conversion maps PCB, PCB-derived BOM, named KiCad 10 nets and provenance", async () => {
  const b = await parseEdaProject(await converted());
  assert.equal(b.project.sourceFormat, "allegro");
  assert.equal(b.pcbs.length, 1); assert.equal(b.parts.length, 1); assert.equal(b.schematics.length, 0);
  assert.deepEqual(b.nets.map(n => n.canonicalName).sort(), ["0", "GND"]);
  const gnd = b.nets.find(n => n.canonicalName === "GND")!;
  assert.equal(gnd.endpoints.length, 3);
  assert.equal(b.pcbs[0].tracks[0].netId, gnd.id);
  assert.equal(b.pcbs[0].vias[0].netId, gnd.id);
  assert.equal(b.pcbs[0].sourceRefs.length, 2);
  assert.equal(b.crossDocumentLinks.filter(l => l.type === "part_to_footprint" && l.status === "verified").length, 1);
  assert.equal(b.diagnostics.filter(d => ["error", "fatal"].includes(d.severity)).length, 0);
  assert.equal(b.fidelity.overallStatus, "partial");
});

test("modified/missing conversion and path traversal are rejected without PCB output", async () => {
  const a = await converted(); a[1].bytes = new TextEncoder().encode(board + " ");
  for (const assets of [a, (await converted()).slice(1)]) {
    const b = await parseEdaProject(assets);
    assert.equal(b.pcbs.length, 0);
    assert.ok(b.diagnostics.some(d => d.code === "ALLEGRO_CONVERSION_INVALID"));
  }
  const m = JSON.parse(new TextDecoder().decode((await converted())[2].bytes)); m.source.path = "../source.brd";
  assert.throws(() => readAllegroManifest(new TextEncoder().encode(JSON.stringify(m))), /路径/);
});

test("two converted boards namespace identical native keys, unreferenced PCB is excluded", async () => {
  const b = await parseEdaProject([...(await converted("a/")), ...(await converted("b/")), input("unrelated.kicad_pcb", board)]);
  assert.equal(b.pcbs.length, 2); assert.equal(b.parts.length, 2);
  assert.ok(!b.diagnostics.some(d => d.code === "IR_DUPLICATE_ENTITY_ID"));
  assert.equal(b.inventory.find(a => a.relativePath === "unrelated.kicad_pcb")?.irParticipation, "excluded");
});

test("KiCad numeric net tables remain supported alongside quoted numeric names", async () => {
  const b = await parseEdaProject([input("old.kicad_pcb", board.replace('(layers ', '(net 1 "GND") (net 2 "0") (layers ').replaceAll('(net "GND")', '(net 1 "GND")').replaceAll('(net "0")', '(net 2 "0")'))]);
  assert.deepEqual(b.nets.map(n => n.canonicalName).sort(), ["0", "GND"]);
  assert.equal(b.nets.find(n => n.canonicalName === "GND")?.endpoints.length, 3);
});

test("online intake preserves a failed original and validates successful conversion response", async (t) => {
  const source = { path: "project/My Board.brd", bytes: native() };
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "worker unavailable" }, { status: 503 }));
  const failed = await prepareAllegroInputs([source]);
  assert.equal(failed.assets[0], source); assert.equal(failed.diagnostics.length, 1);
  const pack = await converted();
  t.mock.method(globalThis, "fetch", async () => new Response(zipSync(Object.fromEntries(pack.map(a => [a.path, a.bytes])))));
  const result = await prepareAllegroInputs([source]);
  assert.equal(result.diagnostics.length, 0);
  const b = await parseEdaProject(result.assets);
  assert.equal(b.pcbs.length, 1); assert.equal(b.project.name, "My Board");
  assert.equal(b.diagnostics.filter(d => d.severity === "error").length, 0);
});

test("conversion API fails closed without configuration/authentication and limits streams", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.ALLEGRO_CONVERTER_URL; delete process.env.ALLEGRO_CONVERTER_TOKEN;
    assert.equal((await POST(new Request("https://refir.test/api/allegro", { method: "POST" }))).status, 503);
    process.env.ALLEGRO_CONVERTER_URL = "https://converter.invalid/convert";
    process.env.ALLEGRO_CONVERTER_TOKEN = "worker-token";
    process.env.EDA_API_TOKEN = "a".repeat(32);
    assert.equal((await POST(new Request("https://refir.test/api/allegro", { method: "POST" }))).status, 401);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); c.close(); } });
    await assert.rejects(boundedBody(stream, 4), /ALLEGRO_WEB_LIMIT/);
  } finally {
    for (const key of ["ALLEGRO_CONVERTER_URL", "ALLEGRO_CONVERTER_TOKEN", "EDA_API_TOKEN"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
