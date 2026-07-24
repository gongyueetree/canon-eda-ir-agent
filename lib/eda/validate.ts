import type { CanonicalIrBundle, ParseDiagnostic, SourceRef } from "./types";
import { diagnostic } from "./util";

type ReferenceScope = Pick<
  CanonicalIrBundle,
  | "project"
  | "inventory"
  | "schematics"
  | "pcbs"
  | "parts"
  | "nets"
  | "crossDocumentLinks"
  | "sourceMap"
>;

type StrongReference = {
  owner: string;
  field: string;
  targetId?: string;
  sourceRef?: SourceRef;
  optional?: boolean;
};

/** Validate only schema-defined strong references; native/source identifiers are intentionally excluded. */
export function validateReferentialIntegrity(scope: ReferenceScope): ParseDiagnostic[] {
  const entityIds = new Map<string, string>();
  const duplicateIds = new Map<string, string[]>();
  const references: StrongReference[] = [];

  const register = (id: string, kind: string) => {
    const existing = entityIds.get(id);
    if (existing) {
      const kinds = duplicateIds.get(id) ?? [existing];
      kinds.push(kind);
      duplicateIds.set(id, kinds);
      return;
    }
    entityIds.set(id, kind);
  };
  const reference = (owner: string, field: string, targetId?: string, sourceRef?: SourceRef, optional = false) => {
    references.push({ owner, field, targetId, sourceRef, optional });
  };

  register(scope.project.id, "project");
  for (const asset of scope.inventory) register(asset.id, "source_asset");
  for (const document of scope.project.documentGraph) register(document.id, "document");

  for (const schematic of scope.schematics) {
    register(schematic.id, "schematic");
    reference(schematic.id, "documentId", schematic.documentId, schematic.sourceRefs[0]);
    reference(schematic.id, "rootSheetId", schematic.rootSheetId, schematic.sourceRefs[0]);
    for (const sheet of schematic.sheets) register(sheet.id, "sheet");
    for (const symbolInstanceId of schematic.symbolInstanceIds) {
      reference(schematic.id, "symbolInstanceIds", symbolInstanceId, schematic.sourceRefs[0]);
    }
    for (const pin of schematic.pins) {
      register(pin.id, "symbol_pin");
      reference(pin.id, "partId", pin.partId, pin.sourceRef);
      reference(pin.id, "symbolUnitId", pin.symbolUnitId, pin.sourceRef);
    }
    for (const wire of schematic.wires) register(wire.id, "wire");
    for (const junction of schematic.junctions) register(junction.id, "junction");
    for (const label of schematic.labels) register(label.id, "label");
  }

  for (const part of scope.parts) {
    register(part.id, "part");
    for (const unit of part.symbolUnits) register(unit.id, "symbol_unit");
    reference(part.id, "footprintInstanceId", part.footprintInstanceId, part.sourceRefs[0], true);
  }

  for (const pcb of scope.pcbs) {
    register(pcb.id, "pcb");
    reference(pcb.id, "documentId", pcb.documentId, pcb.sourceRefs[0]);
    for (const layer of pcb.layers) register(layer.id, "pcb_layer");
    for (const outline of pcb.boardOutline) register(outline.id, "board_outline");
    for (const footprint of pcb.footprints) {
      register(footprint.id, "footprint");
      for (const padId of footprint.padIds) reference(footprint.id, "padIds", padId, footprint.sourceRef);
    }
    for (const pad of pcb.pads) {
      register(pad.id, "pad");
      reference(pad.id, "footprintId", pad.footprintId, pad.sourceRef);
      reference(pad.id, "netId", pad.netId, pad.sourceRef, true);
    }
    for (const track of pcb.tracks) {
      register(track.id, "track");
      reference(track.id, "netId", track.netId, track.sourceRef, true);
    }
    for (const via of pcb.vias) {
      register(via.id, "via");
      reference(via.id, "netId", via.netId, via.sourceRef, true);
    }
    for (const zone of pcb.zones) {
      register(zone.id, "zone");
      reference(zone.id, "netId", zone.netId, zone.sourceRef, true);
    }
  }

  for (const net of scope.nets) {
    register(net.id, "net");
    for (const endpoint of net.endpoints) {
      register(endpoint.id, "net_endpoint");
      reference(endpoint.id, "targetId", endpoint.targetId, net.sourceRefs[0]);
      if (endpoint.type === "symbol_pin") {
        reference(endpoint.id, "identifier.partId", endpoint.identifier.partId, net.sourceRefs[0]);
      }
    }
    for (const segmentId of net.segmentIds) reference(net.id, "segmentIds", segmentId, net.sourceRefs[0]);
  }

  for (const link of scope.crossDocumentLinks) {
    register(link.id, "cross_document_link");
    reference(link.id, "sourceEntityId", link.sourceEntityId);
    reference(link.id, "targetEntityId", link.targetEntityId, undefined, link.status === "missing");
  }
  for (const source of scope.sourceMap) reference(`source:${source.path}`, "assetId", source.assetId, source);

  const diagnostics: ParseDiagnostic[] = [];
  for (const [id, kinds] of duplicateIds) {
    diagnostics.push(
      diagnostic(
        "IR_DUPLICATE_ENTITY_ID",
        `实体 ID ${id} 被重复定义为 ${kinds.join("、")}。`,
        "error",
        "consistency",
      ),
    );
  }
  const reported = new Set<string>();
  for (const item of references) {
    if (item.optional && !item.targetId) continue;
    if (item.targetId && entityIds.has(item.targetId)) continue;
    const key = `${item.owner}:${item.field}:${item.targetId ?? "<empty>"}`;
    if (reported.has(key)) continue;
    reported.add(key);
    diagnostics.push(
      diagnostic(
        "IR_DANGLING_REFERENCE",
        `${item.owner}.${item.field} 指向不存在的实体 ${item.targetId || "<empty>"}。`,
        "error",
        "consistency",
        item.sourceRef,
        "preserved",
      ),
    );
  }
  return diagnostics;
}
