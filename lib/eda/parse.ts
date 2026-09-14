import { parseAltium } from "./altium";
import { inventoryAssets } from "./detect";
import { parseEasyEda } from "./easyeda";
import { isJlcProProject, parseJlcPro } from "./jlcpro";
import { parseKicad, type KicadParseOutput } from "./kicad";
import type { CanonicalIrBundle, InputAsset, NetIr, ParseDiagnostic, PartIr, SourceFormat } from "./types";
import { basename, diagnostic, stableId, withoutExtension } from "./util";
import { validateReferentialIntegrity } from "./validate";

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
      if (!pcbs.length) continue;
      if (!part.footprint && part.reference.startsWith("#")) continue;
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
    const schematicPins = new Map(
      nets
        .filter((net) => net.domain === "schematic_logical")
        .flatMap((net) => net.endpoints)
        .filter((endpoint) => endpoint.type === "symbol_pin" && endpoint.identifier.reference === part.reference && endpoint.targetId)
        .map((endpoint) => [endpoint.targetId!, endpoint] as const),
    );
    const mappedPinNumbers = new Set<string>();
    for (const [pinId, endpoint] of schematicPins) {
      const pin = endpoint.identifier.pin;
      const matchingPads = pcbs.flatMap((pcb) => pcb.pads).filter((pad) => pad.footprintId === footprint.id && pad.number === pin);
      if (matchingPads.length === 1) {
        if (!mappedPinNumbers.has(pin)) {
          part.pinPadMap.push({ pin, pad: matchingPads[0].number, status: "verified" });
          mappedPinNumbers.add(pin);
        }
        links.push({
          id: stableId("link", "pin_to_pad", pinId, matchingPads[0].id),
          type: "pin_to_pad",
          sourceEntityId: pinId,
          targetEntityId: matchingPads[0].id,
          status: "verified",
          confidence: 1,
          evidence: [`RefDes=${part.reference}`, `Pin/Pad Number=${pin}`],
        });
      } else {
        if (!mappedPinNumbers.has(pin)) {
          part.pinPadMap.push({ pin, pad: matchingPads[0]?.number ?? "", status: "missing" });
          mappedPinNumbers.add(pin);
        }
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
  const hasUnresolvedSchematicNet = parsed.nets.some(
    (net) => net.domain === "schematic_logical" && net.resolution.method === "unresolved",
  );
  const hasSemanticGap = diagnostics.some(
    (item) =>
      item.code.includes("PARTIAL") ||
      item.code.includes("STRUCTURE_ONLY") ||
      item.code.includes("UNSUPPORTED") ||
      item.code.includes("UNRECOGNIZED"),
  );
  const dimensions: CanonicalIrBundle["fidelity"]["dimensions"] = {
    sourceFiles: { status: "complete", recognized: parsed.recognized, normalized: parsed.normalized, opaque: parsed.opaque, note: "所有摄取文件均保留 Hash 与清单。" },
    schematicConnectivity: {
      status: hasUnresolvedSchematicNet ? "partial" : format === "kicad" && parsed.schematics.length ? "substantially_complete" : format === "altium" ? "structure_only" : "partial",
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
    format === "altium"
      ? "structure_only"
      : errorCount > 0 || hasUnresolvedSchematicNet || hasSemanticGap || parsed.opaque > 0
        ? "partial"
        : "substantially_complete";
  const criticalGapCount = diagnostics.filter(
    (item) =>
      item.severity === "error" ||
      item.severity === "fatal" ||
      item.code.includes("MISSING") ||
      item.code.includes("CONFLICT") ||
      item.code.includes("PARTIAL") ||
      item.code.includes("STRUCTURE_ONLY") ||
      item.code === "SCHEMATIC_ISOLATED_SEGMENT",
  ).length;
  return {
    overallStatus,
    dimensions,
    recognizedObjectCount: parsed.recognized,
    normalizedObjectCount: parsed.normalized,
    opaqueObjectCount: parsed.opaque,
    droppedObjectCount: 0,
    criticalGapCount,
  };
}

export async function parseEdaProject(inputs: InputAsset[], intakeDiagnostics: ParseDiagnostic[] = []): Promise<CanonicalIrBundle> {
  const detection = await inventoryAssets(inputs);
  let parsed: KicadParseOutput;
  if (detection.sourceFormat === "kicad") parsed = parseKicad(inputs, detection.assets);
  else if (detection.sourceFormat === "easyeda") parsed = isJlcProProject(inputs, detection.assets) ? parseJlcPro(inputs, detection.assets) : parseEasyEda(inputs, detection.assets);
  else if (detection.sourceFormat === "altium") parsed = parseAltium(inputs, detection.assets);
  else {
    parsed = {
      settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [diagnostic("FORMAT_UNSUPPORTED", "没有可用于该工程包的解析适配器。", "error", "unsupported")], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0,
    };
  }
  const pdfInputs = inputs.filter(input => /\.pdf$/i.test(input.path));
  const pdfOnly = pdfInputs.length > 0 && detection.sourceFormat === "unknown";
  const diagnostics = [...intakeDiagnostics, ...detection.diagnostics, ...parsed.diagnostics].filter(d => !pdfOnly || !["FORMAT_NOT_DETECTED", "FORMAT_UNSUPPORTED"].includes(d.code));
  const pdfEvidence: NonNullable<CanonicalIrBundle["pdfEvidence"]> = [];
  if (pdfInputs.length) {
    const { extractPdfEvidence } = await import("../knowledge/pdf");
    for (const input of pdfInputs) {
      const asset = detection.assets.find(a => a.relativePath === input.path)!;
      pdfEvidence.push(await extractPdfEvidence(input, asset));
    }
    diagnostics.push(diagnostic("PDF_CONNECTIVITY_NOT_RECONSTRUCTED", "PDF 仅提取文本与页面坐标证据；未恢复符号、管脚和连线。扫描页需要 OCR。", "warning", "unsupported"));
  }
  const jlcPro = detection.sourceFormat === "easyeda" && isJlcProProject(inputs, detection.assets);
  const projectName = parsed.projectName ?? withoutExtension(detection.assets.find((asset) => asset.entryRole === "project")?.fileName ?? basename(inputs[0]?.path ?? "Untitled project"));
  const crossDocumentLinks = linkDocuments(parsed.parts, parsed.nets, parsed.pcbs);
  for (const missing of crossDocumentLinks.filter((link) => link.status === "missing")) {
    const part = parsed.parts.find((item) => item.id === missing.sourceEntityId);
    diagnostics.push(diagnostic("FOOTPRINT_DEFINITION_MISSING", `${part?.reference ?? "器件"} 没有匹配的 PCB Footprint。`, "warning", "consistency", part?.sourceRefs[0]));
  }
  const documentGraphById = new Map<string, CanonicalIrBundle["project"]["documentGraph"][number]>();
  for (const asset of detection.assets) {
    const id = stableId("document", asset.sha256, asset.relativePath);
    documentGraphById.set(id, { id, type: asset.entryRole, name: asset.fileName, relation: "contains" });
  }
  for (const schematic of parsed.schematics) {
    documentGraphById.set(schematic.documentId, { id: schematic.documentId, type: "schematic", name: schematic.name, relation: "contains" });
  }
  for (const pcb of parsed.pcbs) {
    documentGraphById.set(pcb.documentId, { id: pcb.documentId, type: "pcb", name: pcb.name, relation: "contains" });
  }
  const documentGraph = Array.from(documentGraphById.values());
  const bundleId = stableId("bundle", ...detection.assets.map((asset) => asset.sha256).sort());
  const opaqueExtensions = parsed.opaqueNodes.map((node) => ({ sourceFormat: detection.sourceFormat, recordType: node.recordType, sourcePath: node.sourcePath, preservationStatus: "preserved" as const, payloadHash: node.payloadHash }));
  const project: CanonicalIrBundle["project"] = {
      projectIrVersion: "1.0.0",
      id: stableId("project", ...detection.assets.map((asset) => asset.sha256).sort()),
      name: projectName,
      sourceFormat: detection.sourceFormat,
      sourceFormatVersion: parsed.sourceFormatVersion,
      sourceToolVersion: parsed.sourceToolVersion,
      documentGraph,
      settings: parsed.settings,
      opaqueExtensions,
  };
  const sourceMap = Array.from(new Map(parsed.sourceMap.map((ref) => [`${ref.assetId}:${ref.nativeId ?? ref.jsonPath ?? ref.path}:${ref.line ?? ""}`, ref])).values());
  diagnostics.push(
    ...validateReferentialIntegrity({
      project,
      inventory: detection.assets,
      schematics: parsed.schematics,
      pcbs: parsed.pcbs,
      parts: parsed.parts,
      nets: parsed.nets,
      crossDocumentLinks,
      sourceMap,
    }),
  );
  const fidelity = calculateFidelity(detection.sourceFormat, parsed, diagnostics);
  return {
    bundleId,
    pdfEvidence,
    generatedAt: new Date().toISOString(),
    parser: {
      agent: "eda-canonical-ir-agent",
      agentVersion: "1.2.0",
      adapterId: detection.sourceFormat === "kicad" ? "kicad-sexpr" : jlcPro ? "jlceda-pro-records" : detection.sourceFormat === "easyeda" ? "easyeda-standard-json" : detection.sourceFormat === "altium" ? "altium-safe-intake" : "unknown",
      adapterVersion: "1.2.0",
      deterministic: true,
      llmUsedForParsing: false,
      roundTripReadiness: "read_only",
    },
    project,
    inventory: detection.assets,
    schematics: parsed.schematics,
    pcbs: parsed.pcbs,
    parts: parsed.parts,
    nets: parsed.nets,
    constraints: parsed.constraints,
    variants: [],
    libraries: parsed.libraries,
    crossDocumentLinks,
    sourceMap,
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

