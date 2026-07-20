import { parseAltium } from "./altium";
import { inventoryAssets } from "./detect";
import { parseEasyEda } from "./easyeda";
import { parseKicad, type KicadParseOutput } from "./kicad";
import type { CanonicalIrBundle, InputAsset, NetIr, ParseDiagnostic, PartIr, SourceFormat } from "./types";
import { basename, diagnostic, stableId, withoutExtension } from "./util";

function linkDocuments(parts: PartIr[], nets: NetIr[], pcbs: KicadParseOutput["pcbs"]): CanonicalIrBundle["crossDocumentLinks"] {
  const links: CanonicalIrBundle["crossDocumentLinks"] = [];
  const footprintByReference = new Map(pcbs.flatMap((pcb) => pcb.footprints.map((footprint) => [footprint.reference, footprint] as const)));
  const padById = new Map(pcbs.flatMap((pcb) => pcb.pads.map((pad) => [pad.id, pad] as const)));
  const pcbNetByPad = new Map<string, NetIr>();
  for (const net of nets.filter((item) => item.domain === "pcb_physical")) {
    for (const endpoint of net.endpoints.filter((item) => item.type === "footprint_pad")) {
      if (endpoint.targetId) pcbNetByPad.set(endpoint.targetId, net);
    }
  }

  for (const part of parts) {
    const footprint = footprintByReference.get(part.reference);
    if (!footprint) {
      links.push({
        id: stableId("link", "part_to_footprint", part.id),
        type: "part_to_footprint",
        sourceEntityId: part.id,
        targetEntityId: "",
        status: "missing",
        confidence: 1,
        evidence: [`RefDes ${part.reference} 未在 PCB 中找到`],
      });
      continue;
    }
    part.footprintInstanceId = footprint.id;
    part.footprint ??= footprint.libraryIdentifier;
    links.push({
      id: stableId("link", "part_to_footprint", part.id, footprint.id),
      type: "part_to_footprint",
      sourceEntityId: part.id,
      targetEntityId: footprint.id,
      status: "verified",
      confidence: 1,
      evidence: [`RefDes=${part.reference}`, "Project 内唯一器件/封装实例"],
    });
    const schematicPins = new Set(
      nets
        .filter((net) => net.domain === "schematic_logical")
        .flatMap((net) => net.endpoints)
        .filter((endpoint) => endpoint.type === "symbol_pin" && endpoint.identifier.reference === part.reference)
        .map((endpoint) => endpoint.identifier.pin),
    );
    for (const pin of schematicPins) {
      const matchingPads = pcbs.flatMap((pcb) => pcb.pads).filter((pad) => pad.footprintId === footprint.id && pad.number === pin);
      if (matchingPads.length === 1) {
        part.pinPadMap.push({ pin, pad: matchingPads[0].number, status: "verified" });
        links.push({
          id: stableId("link", "pin_to_pad", part.id, pin, matchingPads[0].id),
          type: "pin_to_pad",
          sourceEntityId: stableId("pin-semantic", part.id, pin),
          targetEntityId: matchingPads[0].id,
          status: "verified",
          confidence: 1,
          evidence: [`RefDes=${part.reference}`, `Pin/Pad Number=${pin}`],
        });
      } else {
        part.pinPadMap.push({ pin, pad: matchingPads[0]?.number ?? "", status: "missing" });
      }
    }
  }

  const logicalNets = nets.filter((net) => net.domain === "schematic_logical");
  const physicalNets = nets.filter((net) => net.domain === "pcb_physical");
  for (const logicalNet of logicalNets) {
    const verifiedTargets = new Map<string, { net: NetIr; evidence: string[] }>();
    for (const pinEndpoint of logicalNet.endpoints.filter((endpoint) => endpoint.type === "symbol_pin")) {
      const footprint = footprintByReference.get(pinEndpoint.identifier.reference);
      if (!footprint) continue;
      const pad = Array.from(padById.values()).find((candidate) => candidate.footprintId === footprint.id && candidate.number === pinEndpoint.identifier.pin);
      if (!pad) continue;
      const physicalNet = pcbNetByPad.get(pad.id);
      if (physicalNet) {
        const current = verifiedTargets.get(physicalNet.id) ?? { net: physicalNet, evidence: [] };
        current.evidence.push(`${pinEndpoint.identifier.reference}.${pinEndpoint.identifier.pin} ↔ Pad ${pad.number}`);
        verifiedTargets.set(physicalNet.id, current);
      }
    }
    if (verifiedTargets.size === 1) {
      const target = Array.from(verifiedTargets.values())[0];
      links.push({
        id: stableId("link", "schematic_net_to_pcb_net", logicalNet.id, target.net.id),
        type: "schematic_net_to_pcb_net",
        sourceEntityId: logicalNet.id,
        targetEntityId: target.net.id,
        status: "verified",
        confidence: 1,
        evidence: target.evidence,
      });
    } else if (verifiedTargets.size > 1) {
      for (const target of verifiedTargets.values()) {
        links.push({
          id: stableId("link", "schematic_net_to_pcb_net", logicalNet.id, target.net.id),
          type: "schematic_net_to_pcb_net",
          sourceEntityId: logicalNet.id,
          targetEntityId: target.net.id,
          status: "conflicting",
          confidence: 1,
          evidence: target.evidence,
        });
      }
    } else {
      const sameName = physicalNets.find((net) => net.canonicalName === logicalNet.canonicalName);
      if (sameName) {
        links.push({
          id: stableId("link", "schematic_net_to_pcb_net", logicalNet.id, sameName.id),
          type: "schematic_net_to_pcb_net",
          sourceEntityId: logicalNet.id,
          targetEntityId: sameName.id,
          status: "probable",
          confidence: 0.5,
          evidence: ["仅名称相同；未作为确定性事实"],
        });
      }
    }
  }
  return links;
}

function calculateFidelity(
  format: SourceFormat,
  parsed: KicadParseOutput,
  diagnostics: ParseDiagnostic[],
): CanonicalIrBundle["fidelity"] {
  const errorCount = diagnostics.filter((item) => item.severity === "error" || item.severity === "fatal").length;
  const dimensions: CanonicalIrBundle["fidelity"]["dimensions"] = {
    sourceFiles: { status: "complete", recognized: parsed.recognized, normalized: parsed.normalized, opaque: parsed.opaque, note: "所有摄取文件均保留 Hash 与清单。" },
    schematicConnectivity: {
      status: format === "kicad" && parsed.schematics.length ? "substantially_complete" : format === "altium" ? "structure_only" : "partial",
      recognized: parsed.schematics.reduce((sum, schematic) => sum + schematic.wires.length + schematic.labels.length, 0),
      normalized: parsed.nets.filter((net) => net.domain === "schematic_logical").length,
      opaque: 0,
      note: format === "kicad" ? "端点、Junction、标签和符号 Pin 采用确定性几何图；内部交叉无 Junction 不连接。" : "未对不稳定或专有记录猜测连通性。",
    },
    pcbConnectivity: {
      status: parsed.pcbs.length ? "substantially_complete" : format === "altium" ? "structure_only" : "unknown",
      recognized: parsed.pcbs.reduce((sum, pcb) => sum + pcb.pads.length + pcb.tracks.length + pcb.vias.length, 0),
      normalized: parsed.nets.filter((net) => net.domain === "pcb_physical").length,
      opaque: 0,
      note: "PCB 连通性只使用源文件显式 Net ID，不以几何交叉覆盖。",
    },
    libraries: {
      status: parsed.libraries.length ? "partial" : "unknown",
      recognized: parsed.libraries.length,
      normalized: parsed.libraries.length,
      opaque: parsed.opaque,
      note: "仅解析工程内嵌或本地授权的定义；不访问用户全局库或网络。",
    },
    sourceMap: {
      status: parsed.sourceMap.length ? "substantially_complete" : "unknown",
      recognized: parsed.normalized,
      normalized: parsed.sourceMap.length,
      opaque: parsed.opaque,
      note: "规范化实体保留文件、Native ID、行列或 JSON Path（可用时）。",
    },
  };
  const overallStatus =
    errorCount > 0 ? "partial" : format === "altium" ? "structure_only" : parsed.opaque > 0 ? "partial" : "substantially_complete";
  return {
    overallStatus,
    dimensions,
    recognizedObjectCount: parsed.recognized,
    normalizedObjectCount: parsed.normalized,
    opaqueObjectCount: parsed.opaque,
    droppedObjectCount: 0,
    criticalGapCount: errorCount + diagnostics.filter((item) => item.code.includes("MISSING") || item.code.includes("CONFLICT")).length,
  };
}

export async function parseEdaProject(inputs: InputAsset[], intakeDiagnostics: ParseDiagnostic[] = []): Promise<CanonicalIrBundle> {
  const detection = await inventoryAssets(inputs);
  let parsed: KicadParseOutput;
  if (detection.sourceFormat === "kicad") parsed = parseKicad(inputs, detection.assets);
  else if (detection.sourceFormat === "easyeda") parsed = parseEasyEda(inputs, detection.assets);
  else if (detection.sourceFormat === "altium") parsed = parseAltium(inputs, detection.assets);
  else {
    parsed = {
      settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [diagnostic("FORMAT_UNSUPPORTED", "没有可用于该工程包的解析适配器。", "error", "unsupported")], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0,
    };
  }
  const diagnostics = [...intakeDiagnostics, ...detection.diagnostics, ...parsed.diagnostics];
  const projectName = parsed.projectName ?? withoutExtension(detection.assets.find((asset) => asset.entryRole === "project")?.fileName ?? basename(inputs[0]?.path ?? "Untitled project"));
  const crossDocumentLinks = linkDocuments(parsed.parts, parsed.nets, parsed.pcbs);
  for (const missing of crossDocumentLinks.filter((link) => link.status === "missing")) {
    const part = parsed.parts.find((item) => item.id === missing.sourceEntityId);
    diagnostics.push(diagnostic("FOOTPRINT_DEFINITION_MISSING", `${part?.reference ?? "器件"} 没有匹配的 PCB Footprint。`, "warning", "consistency", part?.sourceRefs[0]));
  }
  const documentGraph = [
    ...detection.assets.map((asset) => ({ id: stableId("document", asset.id), type: asset.entryRole, name: asset.fileName, relation: "contains" as const })),
  ];
  const bundleId = stableId("bundle", ...detection.assets.map((asset) => asset.sha256).sort());
  const fidelity = calculateFidelity(detection.sourceFormat, parsed, diagnostics);
  const opaqueExtensions = parsed.opaqueNodes.map((node) => ({ sourceFormat: detection.sourceFormat, recordType: node.recordType, sourcePath: node.sourcePath, preservationStatus: "preserved" as const, payloadHash: node.payloadHash }));
  return {
    bundleId,
    generatedAt: new Date().toISOString(),
    parser: {
      agent: "eda-canonical-ir-agent",
      agentVersion: "1.0.0-mvp",
      adapterId: detection.sourceFormat === "kicad" ? "kicad-sexpr" : detection.sourceFormat === "easyeda" ? "easyeda-standard-json" : detection.sourceFormat === "altium" ? "altium-safe-intake" : "unknown",
      adapterVersion: "1.0.0-mvp",
      deterministic: true,
      llmUsedForParsing: false,
      roundTripReadiness: "read_only",
    },
    project: {
      projectIrVersion: "1.0.0",
      id: stableId("project", ...detection.assets.map((asset) => asset.sha256).sort()),
      name: projectName,
      sourceFormat: detection.sourceFormat,
      sourceFormatVersion: parsed.sourceFormatVersion,
      sourceToolVersion: parsed.sourceToolVersion,
      documentGraph,
      settings: parsed.settings,
      opaqueExtensions,
    },
    inventory: detection.assets,
    schematics: parsed.schematics,
    pcbs: parsed.pcbs,
    parts: parsed.parts,
    nets: parsed.nets,
    constraints: parsed.constraints,
    variants: [],
    libraries: parsed.libraries,
    crossDocumentLinks,
    sourceMap: Array.from(new Map(parsed.sourceMap.map((ref) => [`${ref.assetId}:${ref.nativeId ?? ref.jsonPath ?? ref.path}:${ref.line ?? ""}`, ref])).values()),
    diagnostics,
    fidelity,
    summary: {
      documents: detection.assets.length,
      sheets: parsed.schematics.reduce((sum, schematic) => sum + schematic.sheets.length, 0),
      partInstances: parsed.parts.length,
      footprints: parsed.pcbs.reduce((sum, pcb) => sum + pcb.footprints.length, 0),
      logicalNets: parsed.nets.filter((net) => net.domain === "schematic_logical").length,
      pcbNets: parsed.nets.filter((net) => net.domain === "pcb_physical").length,
      warnings: diagnostics.filter((item) => item.severity === "warning").length,
      errors: diagnostics.filter((item) => item.severity === "error" || item.severity === "fatal").length,
    },
  };
}
