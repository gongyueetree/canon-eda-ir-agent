import assert from "node:assert/strict";
import test from "node:test";
import { parseEdaProject, linkDocuments } from "../lib/eda/parse";
import { createDemoFiles, filesToInputAssets } from "../lib/eda/archive";
import { activeKicadDocuments } from "../lib/eda/active-documents";
import { inventoryAssets } from "../lib/eda/detect";
import { parseSExpression } from "../lib/eda/sexpr";
import type { ParseDiagnostic } from "../lib/eda/types";

const input = (path: string, text: string) => ({ path, bytes: new TextEncoder().encode(text) });
test("active KiCad closure excludes legacy, autosave and unreferenced sheets", async () => {
  const inputs = [input("a.kicad_pro", "{}"), input("a.kicad_sch", '(kicad_sch (sheet (property "Sheetfile" "child.kicad_sch")))'), input("child.kicad_sch", "(kicad_sch)"), input("a.sch", "old"), input("_autosave-a.sch", "old"), input("history/old.kicad_sch", "old"), input("other.kicad_sch", "other")];
  const { assets } = await inventoryAssets(inputs); const diagnostics: ParseDiagnostic[] = [];
  assert.deepEqual([...activeKicadDocuments(inputs, assets, diagnostics)].sort(), ["a.kicad_sch", "child.kicad_sch"]);
  assert.equal(diagnostics.length, 0);
});
test("multiple project roots require selection rather than merging", async () => {
  const inputs = [input("a.kicad_pro", "{}"), input("b.kicad_pro", "{}")];
  const { assets } = await inventoryAssets(inputs); const diagnostics: ParseDiagnostic[] = [];
  assert.equal(activeKicadDocuments(inputs, assets, diagnostics).size, 0);
  assert.equal(diagnostics[0].code, "PROJECT_SELECTION_REQUIRED");
});
test("EasyEDA SOLIDREGION reads layer and net independently from SVG geometry", async () => {
  const b = await parseEdaProject([input("PCB.json", JSON.stringify({ shape: ["SOLIDREGION~1~VCC~M 0 0 L 10 0 L 10 10 Z~solid~region1"] }))]);
  assert.equal(b.pcbs.length, 1); assert.equal(b.schematics.length, 0);
  assert.ok(b.nets.some(n => n.canonicalName === "VCC"));
  assert.ok(!b.nets.some(n => n.canonicalName.startsWith("M ")));
  const bad = await parseEdaProject([input("bad.json", JSON.stringify({ head: { docType: "3" }, shape: ["SOLIDREGION~1~M 0 0 L 1 1 Z~path~solid~r"] }))]);
  assert.ok(bad.diagnostics.some(d => d.code === "EASYEDA_INVALID_NET_FIELD"));
});
test("ambiguous EasyEDA JSON does not silently become a schematic", async () => {
  const b = await parseEdaProject([input("unknown.json", '{"shape":["LIB~x"]}')]);
  assert.equal(b.schematics.length, 0); assert.ok(b.diagnostics.some(d => d.code === "FORMAT_AMBIGUOUS"));
});
test("AD project missing dependency and ActiveBOM have dedicated diagnostics", async () => {
  const b = await parseEdaProject([input("x.PrjPcb", "[Document1]\nDocumentPath=x.SchDoc")]);
  assert.ok(b.diagnostics.some(d => d.code === "PROJECT_DOCUMENT_MISSING"));
  const bom = await parseEdaProject([input("x.BomDoc", "opaque")]);
  assert.ok(bom.diagnostics.some(d => d.code === "ALTIUM_BOMDOC_STRUCTURE_ONLY"));
  assert.ok(!bom.diagnostics.some(d => d.code === "FORMAT_NOT_DETECTED"));
});
test("repeated discoveries merge directed links without losing evidence", async () => {
  const intake = await filesToInputAssets(createDemoFiles()); const b = await parseEdaProject(intake.assets);
  const once = linkDocuments(structuredClone(b.parts), b.nets, b.pcbs);
  const twice = linkDocuments(structuredClone(b.parts), [...b.nets, ...b.nets], b.pcbs);
  assert.equal(twice.length, once.length);
  assert.equal(new Set(twice.map(l => l.id)).size, twice.length);
  assert.ok(twice.some(l => l.type === "pin_to_pad"));
});
test("lazy S-expression tokenization preserves syntax and explicit resource limits", () => {
  assert.equal(parseSExpression('(a "b c" (d 1))').items.length, 1);
  assert.throws(() => parseSExpression("(a b c)", { maxTokens: 3 }), /Token limit 3/);
  assert.throws(() => parseSExpression('(a "unterminated)'), /Unterminated/);
});
