import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { createDemoFiles, filesToInputAssets } from "../lib/eda/archive";
import { createIrDomainExport, IR_DOMAIN_KEYS, isIrDomainKey } from "../lib/eda/export";
import { parseEdaProject } from "../lib/eda/parse";
import type { CanonicalIrBundle } from "../lib/eda/types";

async function parseDemo() {
  const intake = await filesToInputAssets(createDemoFiles());
  return parseEdaProject(intake.assets, intake.diagnostics);
}

test("domain exports are independently portable and Net IR retains concrete links", async () => {
  const bundle = await parseDemo();

  for (const domain of IR_DOMAIN_KEYS) {
    const exported = createIrDomainExport(bundle, domain);
    assert.equal(exported.schema, "canon-eda-ir");
    assert.equal(exported.schemaVersion, "1.0.0");
    assert.equal(exported.bundleId, bundle.bundleId);
    assert.equal(exported.projectId, bundle.project.id);
    assert.ok(exported.entityCount > 0);
    assert.doesNotThrow(() => JSON.stringify(exported));
    assert.equal(isIrDomainKey(domain), true);
  }

  const netExport = createIrDomainExport(bundle, "net");
  const netData = netExport.data as {
    nets: CanonicalIrBundle["nets"];
    crossDocumentLinks: CanonicalIrBundle["crossDocumentLinks"];
  };
  assert.deepEqual(netData.nets, bundle.nets);
  assert.deepEqual(netData.crossDocumentLinks, bundle.crossDocumentLinks);
  assert.ok(netData.nets.some((net) => net.endpoints.length > 0));
  assert.equal(isIrDomainKey("invalid"), false);
});

test("Edge.Cuts is mechanical board edge, never copper", async () => {
  const bundle = await parseDemo();
  const layers = bundle.pcbs[0]?.layers ?? [];
  const edgeCuts = layers.find((layer) => layer.name === "Edge.Cuts");

  assert.ok(edgeCuts, "demo PCB should include Edge.Cuts");
  assert.equal(edgeCuts.role, "edge");
  assert.equal(edgeCuts.side, "both");
  assert.equal(edgeCuts.copper, false);
  assert.equal(layers.filter((layer) => layer.copper).length, 2);
  assert.deepEqual(bundle.pcbs[0].physicalDimensions, {
    width: "80",
    height: "40",
    thickness: "1.6",
    unit: "mm",
    boundingBox: { minX: "10", minY: "10", maxX: "90", maxY: "50" },
    outlineClosed: true,
  });
});

test("all canonical strong references resolve to emitted entities", async () => {
  const bundle = await parseDemo();
  const dangling = bundle.diagnostics.filter((item) => item.code === "IR_DANGLING_REFERENCE");
  const duplicates = bundle.diagnostics.filter((item) => item.code === "IR_DUPLICATE_ENTITY_ID");
  const documentIds = new Set(bundle.project.documentGraph.map((document) => document.id));
  const pinIds = new Set(bundle.schematics.flatMap((schematic) => schematic.pins.map((pin) => pin.id)));
  const netIds = new Set(bundle.nets.map((net) => net.id));

  assert.deepEqual(dangling, []);
  assert.deepEqual(duplicates, []);
  assert.ok(bundle.schematics.every((schematic) => documentIds.has(schematic.documentId)));
  assert.ok(bundle.pcbs.every((pcb) => documentIds.has(pcb.documentId)));
  assert.ok(
    bundle.nets
      .flatMap((net) => net.endpoints)
      .filter((endpoint) => endpoint.type === "symbol_pin")
      .every((endpoint) => endpoint.targetId && pinIds.has(endpoint.targetId)),
  );
  assert.ok(
    bundle.crossDocumentLinks
      .filter((link) => link.type === "pin_to_pad")
      .every((link) => pinIds.has(link.sourceEntityId)),
  );
  assert.ok(
    bundle.pcbs
      .flatMap((pcb) => [...pcb.pads, ...pcb.tracks, ...pcb.vias, ...pcb.zones])
      .every((entity) => !entity.netId || netIds.has(entity.netId)),
  );
});

test("segment-only schematic nets are explicit unresolved gaps", async () => {
  const bundle = await parseDemo();
  const isolatedNets = bundle.nets.filter(
    (net) => net.domain === "schematic_logical" && net.endpoints.length === 0 && net.segmentIds.length > 0,
  );

  assert.ok(isolatedNets.length > 0, "demo should retain its isolated vertical segment");
  for (const net of isolatedNets) {
    assert.equal(net.resolution.method, "unresolved");
    assert.ok(net.resolution.confidence < 1);
    assert.ok(net.sourceRefs.length > 0);
  }
  assert.ok(bundle.diagnostics.some((item) => item.code === "SCHEMATIC_ISOLATED_SEGMENT"));
  assert.equal(bundle.fidelity.dimensions.schematicConnectivity.status, "partial");
  assert.equal(bundle.fidelity.overallStatus, "partial");
  assert.ok(bundle.fidelity.criticalGapCount > 0);
});

test("archive intake ignores macOS metadata, local history, and VCS files before parsing", async () => {
  const demoFiles = createDemoFiles();
  const project = new Uint8Array(await demoFiles[0].arrayBuffer());
  const schematic = new Uint8Array(await demoFiles[1].arrayBuffer());
  const pcb = new Uint8Array(await demoFiles[2].arrayBuffer());
  const archive = zipSync({
    "LED8x8/LED8x8.kicad_pro": project,
    "LED8x8/LED8x8.kicad_sch": schematic,
    "LED8x8/LED8x8.kicad_pcb": pcb,
    "LED8x8/.history/LED8x8.kicad_sch": schematic,
    "LED8x8/.history/LED8x8.kicad_pcb": pcb,
    "LED8x8/.history/.git/objects/fixture": new TextEncoder().encode("history object"),
    "LED8x8/.git/config": new TextEncoder().encode("[core]"),
    "__MACOSX/LED8x8/._LED8x8.kicad_sch": new TextEncoder().encode("AppleDouble"),
    "LED8x8/.DS_Store": new TextEncoder().encode("Finder metadata"),
    "LED8x8/local.kicad_prl": new TextEncoder().encode("{}"),
    "LED8x8/fp-info-cache": new TextEncoder().encode("cache"),
    "LED8x8/LED8x8.kicad_pcb-bak": pcb,
    "LED8x8/LED8x8.sch-bak": schematic,
    "LED8x8/legacy.bak": schematic,
  });
  const intake = await filesToInputAssets([new File([archive], "LED8x8.zip")]);
  const bundle = await parseEdaProject(intake.assets, intake.diagnostics);

  assert.deepEqual(
    intake.assets.map((asset) => asset.path).sort(),
    ["LED8x8/LED8x8.kicad_pcb", "LED8x8/LED8x8.kicad_pro", "LED8x8/LED8x8.kicad_sch"],
  );
  assert.ok(intake.diagnostics.some((item) => item.code === "ARCHIVE_METADATA_IGNORED"));
  assert.ok(intake.diagnostics.some((item) => item.code === "PROJECT_HISTORY_IGNORED"));
  assert.ok(intake.diagnostics.some((item) => item.code === "VCS_METADATA_IGNORED"));
  assert.ok(intake.diagnostics.some((item) => item.code === "EDA_LOCAL_STATE_IGNORED"));
  assert.equal(bundle.schematics.length, 1);
  assert.equal(bundle.pcbs.length, 1);
  assert.equal(bundle.parts.length, 2);
  assert.equal(bundle.pcbs[0].footprints.length, 2);
  assert.equal(bundle.summary.errors, 0);
});

test("KiCad Legacy .sch resolves parts, pins, nets, and cross-document links from the matching .pro", async () => {
  const encoder = new TextEncoder();
  const legacyLibrary = `EESchema-LIBRARY Version 2.4
#encoding utf-8
DEF Device_R R 0 0 N Y 1 F N
DRAW
X ~ 1 -100 0 100 R 50 50 1 1 P
X ~ 2 100 0 100 L 50 50 1 1 P
ENDDRAW
ENDDEF`;
  const legacySchematic = `EESchema Schematic File Version 4
LIBS:Fixture-cache
EELAYER 29 0
EELAYER END
$Descr A4 11693 8268
Sheet 1 1
Title "Legacy Fixture"
$EndDescr
$Comp
L Device:R R1
U 1 1 ABCDEF01
P 1000 1000
F 0 "R1" H 1000 1050 50  0000 C CNN
F 1 "10k" H 1000 950 50  0000 C CNN
F 2 "Resistor_SMD:R_0603_1608Metric" H 1000 1000 50  0001 C CNN
\t1    1000 1000
\t1    0    0    -1
$EndComp
Wire Wire Line
\t500 1000 900 1000
Wire Wire Line
\t1100 1000 1500 1000
Text Label 500 1000 2    50   ~ 0
VIN
Text Label 1500 1000 0    50   ~ 0
VOUT
$EndSCHEMATC`;
  const sideSchematic = legacySchematic.replace("Legacy Fixture", "Side document").replace(/R1/g, "R2");
  const pcb = `(kicad_pcb (version 20171130) (host pcbnew 5.1.0)
    (general (thickness 1))
    (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
    (net 0 "") (net 1 VIN) (net 2 VOUT)
    (module Resistor_SMD:R_0603_1608Metric (layer F.Cu) (at 5 5)
      (fp_text reference R1 (at 0 -1) (layer F.SilkS))
      (fp_text value 10k (at 0 1) (layer F.Fab))
      (pad 1 smd rect (at -1 0) (size 1 1) (layers F.Cu F.Paste F.Mask) (net 1 VIN))
      (pad 2 smd rect (at 1 0) (size 1 1) (layers F.Cu F.Paste F.Mask) (net 2 VOUT)))
    (gr_rect (start 0 0) (end 10 10) (layer Edge.Cuts) (width 0.1)))`;
  const archive = zipSync({
    "Fixture/Fixture.pro": encoder.encode("[eeschema]\nversion=1\n"),
    "Fixture/Fixture.sch": encoder.encode(legacySchematic),
    "Fixture/Side.sch": encoder.encode(sideSchematic),
    "Fixture/Fixture-cache.lib": encoder.encode(legacyLibrary),
    "Fixture/Fixture.kicad_pcb": encoder.encode(pcb),
  });
  const intake = await filesToInputAssets([new File([archive], "Fixture.zip")]);
  const bundle = await parseEdaProject(intake.assets, intake.diagnostics);

  assert.equal(bundle.schematics.length, 1);
  assert.equal(bundle.schematics[0].name, "Legacy Fixture");
  assert.equal(bundle.parts.length, 1);
  assert.equal(bundle.parts[0].reference, "R1");
  assert.equal(bundle.schematics[0].pins.length, 2);
  assert.equal(bundle.summary.logicalNets, 2);
  assert.equal(bundle.summary.pcbNets, 2);
  assert.equal(bundle.crossDocumentLinks.filter((link) => link.type === "part_to_footprint" && link.status === "verified").length, 1);
  assert.equal(bundle.crossDocumentLinks.filter((link) => link.type === "pin_to_pad" && link.status === "verified").length, 2);
  assert.equal(bundle.crossDocumentLinks.filter((link) => link.type === "schematic_net_to_pcb_net" && link.status === "verified").length, 2);
  assert.ok(bundle.diagnostics.some((item) => item.code === "LEGACY_SCHEMATIC_NOT_IN_PROJECT"));
  assert.equal(bundle.summary.errors, 0);
});

test("footprint Edge.Cuts contribute to closed physical board dimensions", async () => {
  const encoder = new TextEncoder();
  const pcb = `(kicad_pcb (version 20171130) (host pcbnew 5.1.0)
    (general (thickness 1.2))
    (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
    (module Connector:Cutout (layer F.Cu) (at 10 5)
      (fp_text reference J1 (at 0 0) (layer F.SilkS))
      (fp_text value CUTOUT (at 0 1) (layer F.Fab))
      (fp_line (start 0 -1) (end -2 -1) (layer Edge.Cuts) (width 0.1))
      (fp_line (start -2 -1) (end -2 1) (layer Edge.Cuts) (width 0.1))
      (fp_line (start -2 1) (end 0 1) (layer Edge.Cuts) (width 0.1)))
    (gr_line (start 0 0) (end 10 0) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 10 0) (end 10 4) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 10 6) (end 10 10) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 10 10) (end 0 10) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 0 10) (end 0 0) (layer Edge.Cuts) (width 0.1)))`;
  const bundle = await parseEdaProject([{ path: "Cutout.kicad_pcb", bytes: encoder.encode(pcb) }]);
  const board = bundle.pcbs[0];

  assert.equal(board.boardOutline.length, 8);
  assert.ok(board.boardOutline.some((item) => item.geometry.source === "footprint"));
  assert.deepEqual(board.physicalDimensions, {
    width: "10",
    height: "10",
    thickness: "1.2",
    unit: "mm",
    boundingBox: { minX: "0", minY: "0", maxX: "10", maxY: "10" },
    outlineClosed: true,
  });
  assert.ok(!bundle.diagnostics.some((item) => item.code === "BOARD_OUTLINE_OPEN"));
});

test("legacy center/start/angle PCB arcs are normalized before dimension calculation", async () => {
  const pcb = `(kicad_pcb (version 20171130) (host pcbnew 5.1.0)
    (general (thickness 0.8))
    (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
    (gr_line (start 1 0) (end 9 0) (layer Edge.Cuts) (width 0.1))
    (gr_arc (start 9 1) (end 9 0) (angle 90) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 10 1) (end 10 9) (layer Edge.Cuts) (width 0.1))
    (gr_arc (start 9 9) (end 10 9) (angle 90) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 9 10) (end 1 10) (layer Edge.Cuts) (width 0.1))
    (gr_arc (start 1 9) (end 1 10) (angle 90) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 0 9) (end 0 1) (layer Edge.Cuts) (width 0.1))
    (gr_arc (start 1 1) (end 0 1) (angle 90) (layer Edge.Cuts) (width 0.1)))`;
  const bundle = await parseEdaProject([
    { path: "Rounded.kicad_pcb", bytes: new TextEncoder().encode(pcb) },
  ]);
  const board = bundle.pcbs[0];

  assert.equal(board.boardOutline.filter((item) => item.kind === "arc").length, 4);
  assert.ok(
    board.boardOutline
      .filter((item) => item.kind === "arc")
      .every((item) => item.geometry.center && item.geometry.start && item.geometry.end && item.geometry.angle === "90"),
  );
  assert.deepEqual(board.physicalDimensions, {
    width: "10",
    height: "10",
    thickness: "0.8",
    unit: "mm",
    boundingBox: { minX: "0", minY: "0", maxX: "10", maxY: "10" },
    outlineClosed: true,
  });
});

test("KiCad power symbols become power labels instead of Part IR instances", async () => {
  const schematic = `(kicad_sch (version 20250114) (generator eeschema)
    (uuid 00000000-0000-0000-0000-000000000001)
    (lib_symbols
      (symbol "power:GND"
        (power)
        (symbol "GND_1_1"
          (pin power_in line (at 0 0 90) (length 0) (name "~") (number "1")))))
    (wire (pts (xy 10 10) (xy 20 10)) (uuid 10000000-0000-0000-0000-000000000001))
    (wire (pts (xy 30 10) (xy 40 10)) (uuid 10000000-0000-0000-0000-000000000002))
    (symbol
      (lib_id "power:GND")
      (at 10 10 0)
      (unit 1)
      (uuid 20000000-0000-0000-0000-000000000001)
      (property "Reference" "#PWR01" (at 10 12 0))
      (property "Value" "GND" (at 10 8 0))
      (property "Footprint" "" (at 10 10 0)))
    (symbol
      (lib_id "power:GND")
      (at 30 10 0)
      (unit 1)
      (uuid 20000000-0000-0000-0000-000000000002)
      (property "Reference" "#PWR02" (at 30 12 0))
      (property "Value" "GND" (at 30 8 0))
      (property "Footprint" "" (at 30 10 0))))`;
  const bundle = await parseEdaProject([
    { path: "power-label.kicad_sch", bytes: new TextEncoder().encode(schematic) },
  ]);

  assert.equal(bundle.parts.length, 0);
  assert.equal(bundle.schematics[0].symbolInstanceIds.length, 0);
  assert.equal(bundle.schematics[0].pins.length, 0);
  assert.equal(bundle.schematics[0].labels.filter((label) => label.kind === "power" && label.name === "GND").length, 2);
  assert.equal(bundle.nets.filter((net) => net.canonicalName === "GND").length, 1);
  assert.ok(!bundle.diagnostics.some((item) => item.code === "IR_DANGLING_REFERENCE"));
  assert.equal(bundle.summary.errors, 0);
});

test("EasyEDA Standard docType routes multi-sheet schematic and PCB shapes into semantic IR", async () => {
  const schematic = {
    docType: "5",
    title: "Multi page",
    schematics: [
      {
        title: "Power",
        dataStr: {
          docType: "1",
          shape: [
            "W~0 0 10 0~#008800~1~0~none~wire1~0",
            "J~0~0~2.5~#CC0000~junction1~0",
            "F~part_netLabel_netPort~0~0~0~label1~~0^^0~0^^VCC~#0000FF~7pt~0",
            "LIB~5~0~package`R_0603`~0~0~symbol1#@$T~P~0~0~0~0~0~0~0~0~0~0~R1#@$T~N~0~0~0~0~0~0~0~0~0~0~10k#@$P~~~1~0~0~~pin1",
          ],
        },
      },
      { title: "Signals", dataStr: { docType: "1", shape: ["W~0 10 10 10~#008800~1~0~none~wire2~0"] } },
    ],
  };
  const pcb = {
    head: { docType: "3" },
    title: "Board",
    layers: ["1~TopLayer~#FF0000~true~true", "2~BottomLayer~#0000FF~true~true", "10~BoardOutLine~#FF00FF~true~true"],
    shape: [
      "TRACK~1~10~~0 0 20 0 20 10 0 10 0 0~outline1~0",
      "TRACK~0.25~1~VCC~5 5 15 5~track1~0",
      "VIA~15~5~0.8~VCC~0.4~via1~0",
      "LIB~5~5~package`R_0603`~0~0~footprint1#@$TEXT~P~0~0~1~0~0~3~~1~R1~~0~ref1~~0#@$TEXT~N~0~0~1~0~0~3~~1~10k~~0~value1~~0#@$PAD~RECT~5~5~1~1~1~VCC~1~0~~0~pad1",
    ],
  };
  const bundle = await parseEdaProject([
    { path: "multi-sheet.json", bytes: new TextEncoder().encode(JSON.stringify(schematic)) },
    { path: "board.json", bytes: new TextEncoder().encode(JSON.stringify(pcb)) },
  ]);

  assert.equal(bundle.parser.adapterId, "easyeda-standard-json");
  assert.equal(bundle.schematics.length, 1);
  assert.deepEqual(bundle.schematics[0].sheets.map((sheet) => sheet.name), ["Power", "Signals"]);
  assert.equal(bundle.pcbs.length, 1);
  assert.ok(bundle.schematics[0].wires.length >= 2);
  assert.ok(bundle.schematics[0].junctions.length >= 1);
  assert.ok(bundle.schematics[0].labels.some((label) => label.name === "VCC"));
  assert.ok(bundle.parts.some((part) => part.reference === "R1"));
  assert.ok(bundle.pcbs[0].footprints.some((footprint) => footprint.reference === "R1"));
  assert.ok(bundle.nets.some((net) => net.domain === "pcb_physical" && net.canonicalName === "VCC"));
  assert.equal(bundle.summary.errors, 0);
});

test("JLCEDA Pro EPro ZIP is expanded and record diagnostics are aggregated", async () => {
  const encoder = new TextEncoder();
  const lineStream = (records: unknown[][]) => encoder.encode(records.map((record) => JSON.stringify(record)).join("\n"));
  const manifest = {
    schematics: { project1: { name: "Fixture project", sheets: [{ name: "Main", id: 1, uuid: "sheet-uuid" }] } },
    pcbs: { pcb1: "Fixture board" },
  };
  const archive = zipSync({
    "project.json": encoder.encode(JSON.stringify(manifest)),
    "SHEET/project1/1.esch": lineStream([
      ["DOCTYPE", "SCH", "1.1"],
      ["COMPONENT", "e1", "", 5, 5, 0, 0, {}, 0],
      ["ATTR", "a1", "e1", "Designator", "R1", 0, 1, 5, 5, 0, "style", 0],
      ["ATTR", "a2", "e1", "Value", "10k", 0, 1, 5, 5, 0, "style", 0],
      ["WIRE", "w1", [[0, 0, 10, 0]], "style", 0],
      ["ATTR", "a3", "w1", "NET", "VCC", 0, 0, 0, 0, 0, "style", 0],
      ["UNKNOWN_RECORD", "u1"],
    ]),
    "PCB/pcb1.epcb": lineStream([
      ["DOCTYPE", "PCB", "1.7"],
      ["LAYER", 1, "TOP", "Top Layer", 3, "#ff0000", 1, "#7f0000", 1],
      ["NET", "VCC", null, null, 1, null, 0, null],
      ["COMPONENT", "fp1", 0, 1, 5, 5, 0, {}, 1],
      ["ATTR", "fa1", 0, "fp1", 3, 5, 5, "Designator", "R1", 0],
      ["PAD_NET", "fp1", "1", "VCC", "pad1"],
      ["LINE", "track1", 0, "VCC", 1, 5, 5, 15, 5, 0.25, 0],
      ["VIA", "via1", 0, "VCC", "", 15, 5, 0.4, 0.8, 0, null, null, 0, []],
    ]),
    "__MACOSX/._project.json": encoder.encode("metadata"),
  });
  const intake = await filesToInputAssets([new File([archive], "fixture.epro")]);
  const bundle = await parseEdaProject(intake.assets, intake.diagnostics);

  assert.equal(bundle.parser.adapterId, "jlceda-pro-records");
  assert.equal(bundle.schematics[0].sheets[0].name, "Main");
  assert.equal(bundle.pcbs.length, 1);
  assert.equal(bundle.schematics[0].wires.length, 1);
  assert.equal(bundle.pcbs[0].tracks.length, 1);
  assert.equal(bundle.pcbs[0].vias.length, 1);
  assert.ok(bundle.parts.some((part) => part.reference === "R1"));
  assert.ok(bundle.diagnostics.some((item) => item.code === "ARCHIVE_METADATA_IGNORED"));
  assert.equal(bundle.diagnostics.filter((item) => item.code === "JLCEDA_RECORDS_PARTIAL").length, 1);
  assert.equal(bundle.summary.errors, 0);
});

test("standalone KiCad libraries expose symbol and footprint object counts without project-entry errors", async () => {
  const encoder = new TextEncoder();
  const symbolLibrary = `(kicad_symbol_lib (version 20231120) (generator kicad_symbol_editor)
    (symbol "Fixture:R" (pin passive line (at 0 0 0) (length 2.54) (name "~") (number "1"))))`;
  const footprintLibrary = `(footprint "Fixture_R_0603" (version 20240108) (generator pcbnew)
    (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))`;
  const bundle = await parseEdaProject([
    { path: "Fixture.kicad_sym", bytes: encoder.encode(symbolLibrary) },
    { path: "Fixture.kicad_mod", bytes: encoder.encode(footprintLibrary) },
  ]);

  assert.equal(bundle.project.sourceFormat, "kicad");
  assert.equal(bundle.libraries.length, 2);
  assert.ok(bundle.libraries.some((library) => library.type === "symbol" && library.objectCount === 1));
  assert.ok(bundle.libraries.some((library) => library.type === "footprint" && library.objectCount === 1));
  assert.ok(!bundle.diagnostics.some((item) => item.code === "PROJECT_ENTRY_NOT_FOUND"));
  assert.equal(bundle.summary.errors, 0);
});

test("Altium OutJob and JLCEDA SQLite containers are honestly classified without corruption errors", async () => {
  const encoder = new TextEncoder();
  const outJobBundle = await parseEdaProject([
    { path: "fabrication.OutJob", bytes: encoder.encode("[OutputGroup]\nName=Fabrication\n") },
  ]);
  assert.equal(outJobBundle.parser.adapterId, "altium-safe-intake");
  assert.ok(outJobBundle.diagnostics.some((item) => item.code === "ALTIUM_OUTJOB_PRESERVED"));
  assert.ok(!outJobBundle.diagnostics.some((item) => item.code === "SOURCE_FILE_CORRUPTED"));
  assert.equal(outJobBundle.fidelity.overallStatus, "structure_only");

  const sqliteBytes = new Uint8Array(128);
  sqliteBytes.set(encoder.encode("SQLite format 3\u0000"));
  const sqliteBundle = await parseEdaProject([{ path: "fixture.eprj", bytes: sqliteBytes }]);
  assert.equal(sqliteBundle.parser.adapterId, "jlceda-pro-records");
  assert.ok(sqliteBundle.diagnostics.some((item) => item.code === "JLCEDA_SQLITE_STRUCTURE_ONLY"));
  assert.ok(!sqliteBundle.diagnostics.some((item) => item.code === "PARSER_SYNTAX_ERROR"));
  assert.equal(sqliteBundle.summary.errors, 0);
  assert.equal(sqliteBundle.fidelity.overallStatus, "partial");
});


test("hierarchy sheet boxes, pins and embedded symbol body survive normalization", async () => {
  const source=`(kicad_sch (version 20250114) (generator eeschema)
    (lib_symbols (symbol "Device:R" (symbol "R_0_1" (rectangle (start -1 -2) (end 1 2))) (symbol "R_1_1" (pin passive line (at 0 3 270) (length 1) (name "~") (number "1")))))
    (sheet (at 20 30) (size 40 25) (property "Sheetname" "Power") (property "Sheetfile" "power.kicad_sch") (pin "VIN" input (at 20 40 0)))
    (symbol (lib_id "Device:R") (at 80 50 0) (unit 1) (property "Reference" "R1") (property "Value" "10k")))`;
  const b=await parseEdaProject([{path:"root.kicad_sch",bytes:new TextEncoder().encode(source)}]);
  assert.equal(b.schematics[0].sheetBoxes?.[0].file,"power.kicad_sch");
  assert.equal(b.schematics[0].sheetBoxes?.[0].pins[0].position.y,"40");
  const body=b.schematics[0].graphics?.find(g=>g.closed);
  assert.equal(body?.points[0].x,"79");assert.equal(body?.points[0].y,"52");
});

test("rotated footprint uses sheet-down coordinates and preserves pad orientation and drill", async()=>{
  const b=await parseEdaProject([{path:"rotated.kicad_pcb",bytes:new TextEncoder().encode(`(kicad_pcb (version 20250114) (generator pcbnew) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (footprint "Test" (layer "F.Cu") (at 10 20 90) (property "Reference" "J1") (pad "1" thru_hole oval (at 2 0 90) (size 3 2) (drill oval 1.5 1) (layers "*.Cu" "*.Mask"))))`)}]);
  const p=b.pcbs[0].pads[0];assert.equal(p.position?.x,"10");assert.equal(p.position?.y,"18");assert.equal(p.rotation,"90");assert.deepEqual(p.drill,{x:"1.5",y:"1"});
});
