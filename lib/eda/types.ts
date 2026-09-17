export type SourceFormat = "kicad" | "altium" | "easyeda" | "unknown";

export type DiagnosticSeverity =
  | "fatal"
  | "error"
  | "warning"
  | "information";

export type SourceRef = {
  assetId: string;
  path: string;
  nativeId?: string;
  line?: number;
  column?: number;
  jsonPath?: string;
  resolutionMethod:
    | "explicit"
    | "embedded"
    | "connectivity_resolved"
    | "cross_document_matched"
    | "derived"
    | "unknown";
};

export type SourceAsset = {
  id: string;
  relativePath: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  detectedFormat: SourceFormat;
  entryRole:
    | "project"
    | "schematic"
    | "pcb"
    | "symbol_library"
    | "footprint_library"
    | "rules"
    | "attachment"
    | "unknown";
  securityStatus: "accepted" | "blocked";
};

export type ParseDiagnostic = {
  id: string;
  severity: DiagnosticSeverity;
  category:
    | "format"
    | "version"
    | "encoding"
    | "syntax"
    | "structure"
    | "library"
    | "connectivity"
    | "geometry"
    | "mapping"
    | "consistency"
    | "unsupported"
    | "security"
    | "resource";
  code: string;
  message: string;
  sourceRef?: SourceRef;
  preservationStatus?: "preserved" | "normalized" | "not_applicable";
};

export type IrPoint = {
  x: string;
  y: string;
  unit: "mm";
  raw?: [string, string];
};

export type PartIr = {
  id: string;
  logicalPartKey: string;
  reference: string;
  value: string;
  symbolUnits: Array<{
    id: string;
    unit: number;
    position?: IrPoint;
    rotation?: string;
  }>;
  footprintInstanceId?: string;
  footprint?: string;
  fields: Record<string, string>;
  manufacturerRaw?: string;
  mpnRaw?: string;
  variantStatus: "fitted" | "dnp" | "optional" | "variant_excluded" | "unknown";
  pinPadMap: Array<{
    pin: string;
    pad: string;
    status: "explicit" | "verified" | "missing";
  }>;
  sourceRefs: SourceRef[];
};

export type NetEndpoint = {
  id: string;
  type: "symbol_pin" | "label" | "footprint_pad" | "track" | "via" | "zone";
  targetId?: string;
  identifier: Record<string, string>;
  position?: IrPoint;
};

export type NetIr = {
  id: string;
  domain: "schematic_logical" | "pcb_physical";
  canonicalName: string;
  displayNames: string[];
  endpoints: NetEndpoint[];
  segmentIds: string[];
  resolution: {
    method: "explicit" | "connectivity_resolved" | "unresolved" | "unknown";
    confidence: number;
  };
  sourceRefs: SourceRef[];
};

export type SchematicIr = {
  id: string;
  documentId: string;
  name: string;
  rootSheetId: string;
  sheets: Array<{ id: string; name: string; instancePath: string }>;
  texts?: Array<{ id: string; symbolUnitId?: string; text: string; kind: string; position: IrPoint; rotation: string; size: string; align: "start" | "middle" | "end" }>;
  sheetBoxes?: Array<{ id: string; name: string; file: string; position: IrPoint; size: { x: string; y: string }; pins: Array<{ name: string; position: IrPoint }> }>;
  page?: { width: number; height: number; title?: string };
  graphics?: Array<{ id: string; symbolUnitId: string; points: IrPoint[]; closed: boolean }>;
  symbolInstanceIds: string[];
  pins: Array<{
    id: string;
    partId: string;
    symbolUnitId: string;
    reference: string;
    number: string;
    name: string;
    electricalType?: string;
    position: IrPoint;
    sourceRef: SourceRef;
  }>;
  wires: Array<{ id: string; points: IrPoint[]; sourceRef: SourceRef }>;
  junctions: Array<{ id: string; position: IrPoint; sourceRef: SourceRef }>;
  labels: Array<{
    id: string;
    name: string;
    kind: "local" | "global" | "hierarchical" | "power";
    shape?: string;
    textPosition?: IrPoint;
    rotation?: string;
    size?: string;
    position: IrPoint;
    sourceRef: SourceRef;
  }>;
  noConnects: IrPoint[];
  connectivityGraphId: string;
  sourceRefs: SourceRef[];
};

export type PcbIr = {
  id: string;
  documentId: string;
  name: string;
  units: "mm";
  coordinateSystem: {
    sourceUnits: string;
    canonicalUnits: "mm";
    rotationConvention: "degrees_ccw";
    precision: "source_token_preserved";
  };
  layers: Array<{
    id: string;
    sourceId: string;
    name: string;
    role: string;
    side: "front" | "back" | "inner" | "both" | "unknown";
    copper: boolean;
  }>;
  stackup: Array<Record<string, string | null>>;
  boardOutline: Array<{
    id: string;
    kind: "line" | "arc" | "circle" | "rectangle";
    geometry: Record<string, unknown>;
  }>;
  physicalDimensions?: {
    width: string;
    height: string;
    thickness?: string;
    unit: "mm";
    boundingBox: {
      minX: string;
      minY: string;
      maxX: string;
      maxY: string;
    };
    outlineClosed: boolean;
  };
  footprints: Array<{
    id: string;
    reference: string;
    value: string;
    libraryIdentifier: string;
    models?: Array<{ path: string; offset: number[]; scale: number[]; rotation: number[]; hidden: boolean }>;
    graphics?: Array<{ id: string; layer: string; kind: "line" | "arc" | "circle" | "rectangle"; geometry: Record<string, unknown> }>;
    position?: IrPoint;
    rotation: string;
    side: "front" | "back" | "unknown";
    locked: boolean;
    padIds: string[];
    sourceRef: SourceRef;
  }>;
  pads: Array<{
    id: string;
    footprintId: string;
    number: string;
    padType: string;
    shape: string;
    rotation?: string;
    drill?: { x: string; y: string };
    position?: IrPoint;
    size?: { x: string; y: string; unit: "mm" };
    layers: string[];
    netId?: string;
    sourceNativeNetId?: string;
    netName?: string;
    sourceRef: SourceRef;
  }>;
  tracks: Array<{
    id: string;
    kind: "segment" | "arc";
    start?: IrPoint;
    end?: IrPoint;
    mid?: IrPoint;
    width?: string;
    layer?: string;
    netId?: string;
    sourceNativeNetId?: string;
    sourceRef: SourceRef;
  }>;
  vias: Array<{
    id: string;
    position?: IrPoint;
    size?: string;
    drill?: string;
    layers: string[];
    netId?: string;
    sourceNativeNetId?: string;
    sourceRef: SourceRef;
  }>;
  zones: Array<{
    id: string;
    netId?: string;
    sourceNativeNetId?: string;
    layers: string[];
    sourceRef: SourceRef;
  }>;
  sourceRefs: SourceRef[];
};

export type FidelityDimension = {
  status: "complete" | "substantially_complete" | "partial" | "structure_only" | "unknown";
  recognized: number;
  normalized: number;
  opaque: number;
  note: string;
};

export type CanonicalIrBundle = {
  bomMappings?: Record<string, import("../bom/types").BomMapping>;
  pdfEvidence?: import("../knowledge/types").PdfEvidenceDocument[];
  bundleId: string;
  generatedAt: string;
  parser: {
    agent: "eda-canonical-ir-agent";
    agentVersion: "1.4.1";
    adapterId: string;
    adapterVersion: "1.4.1";
    deterministic: true;
    llmUsedForParsing: false;
    roundTripReadiness: "read_only";
  };
  project: {
    projectIrVersion: "1.0.0";
    id: string;
    name: string;
    sourceFormat: SourceFormat;
    sourceFormatVersion?: string;
    sourceToolVersion?: string;
    documentGraph: Array<{
      id: string;
      type: string;
      name: string;
      relation: "contains" | "references";
    }>;
    settings: Record<string, unknown>;
    opaqueExtensions: Array<{
      sourceFormat: SourceFormat;
      recordType: string;
      sourcePath: string;
      preservationStatus: "preserved";
      payloadHash: string;
    }>;
  };
  inventory: SourceAsset[];
  schematics: SchematicIr[];
  pcbs: PcbIr[];
  parts: PartIr[];
  nets: NetIr[];
  constraints: Array<Record<string, unknown>>;
  variants: Array<Record<string, unknown>>;
  libraries: Array<Record<string, unknown>>;
  crossDocumentLinks: Array<{
    id: string;
    type: "part_to_footprint" | "pin_to_pad" | "schematic_net_to_pcb_net";
    sourceEntityId: string;
    targetEntityId: string;
    status: "explicit" | "verified" | "probable" | "ambiguous" | "missing" | "conflicting";
    confidence: number;
    evidence: string[];
  }>;
  sourceMap: SourceRef[];
  diagnostics: ParseDiagnostic[];
  fidelity: {
    overallStatus: FidelityDimension["status"];
    dimensions: Record<string, FidelityDimension>;
    recognizedObjectCount: number;
    normalizedObjectCount: number;
    opaqueObjectCount: number;
    droppedObjectCount: 0;
    criticalGapCount: number;
  };
  summary: {
    documents: number;
    sheets: number;
    partInstances: number;
    footprints: number;
    logicalNets: number;
    pcbNets: number;
    warnings: number;
    errors: number;
  };
};

export type InputAsset = {
  path: string;
  bytes: Uint8Array;
};

