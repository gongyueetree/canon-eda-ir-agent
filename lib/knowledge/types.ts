import type { SourceRef } from "../eda/types";
export type PinRole =
  | "POWER"
  | "GROUND"
  | "CLOCK"
  | "RESET"
  | "BOOT"
  | "ENABLE"
  | "USB"
  | "SPI"
  | "I2C"
  | "SWD"
  | "UART"
  | "FEEDBACK"
  | "SWITCHING"
  | "ANALOG"
  | "UNKNOWN";
export type KnowledgeEvidence = {
  id: string;
  entityId: string;
  source: SourceRef;
  sha256?: string;
  parserVersion: string;
  explanation: string;
};
export type GraphPin = {
  id: string;
  partId: string;
  number: string;
  name: string;
  role: PinRole;
  netIds: string[];
};
export type GraphNet = {
  id: string;
  name: string;
  role: PinRole;
  pinIds: string[];
  boundary: boolean;
  confidence: number;
};
export type EngineeringGraph = {
  pins: GraphPin[];
  nets: GraphNet[];
  domain: "schematic_logical" | "pcb_physical";
  warnings: string[];
};
export type BlockMember = {
  partId: string;
  reference: string;
  value: string;
  role: string;
  decision: "included" | "review" | "boundary";
  score: number;
  reasons: string[];
};
export type BlockPort = {
  netId: string;
  name: string;
  role: PinRole;
  pinIds: string[];
  reason: string;
};
export type HardwareBlock = {
  id: string;
  name: string;
  anchorId: string;
  anchorReference: string;
  mpn: string;
  pinGroup: PinRole | "CORE";
  members: BlockMember[];
  ports: BlockPort[];
  evidence: KnowledgeEvidence[];
  confidence: { connectivity: number; semantic: number; sourceQuality: number };
  warnings: string[];
  status: "CANDIDATE" | "APPROVED" | "REJECTED" | "PUBLISHED";
  placement: {
    partId: string;
    dxMm: number;
    dyMm: number;
    rotation: number;
    side: string;
  }[];
};
export type MiningResult = {
  schema: "canon.hardware-knowledge";
  schemaVersion: "1.0.0";
  minerVersion: string;
  bundleId: string;
  sourceHash: string;
  graph: EngineeringGraph;
  anchors: { partId: string; reference: string; mpn: string; reason: string }[];
  blocks: HardwareBlock[];
  warnings: string[];
};
export type ReviewEdit = {
  name?: string;
  members?: {
    partId: string;
    decision: BlockMember["decision"];
    role: string;
  }[];
  ports?: { netId: string; name: string; role: PinRole }[];
};
export type PdfEvidenceDocument = {
  assetId: string;
  path: string;
  sha256: string;
  parserVersion: string;
  status: "TEXT_EXTRACTED" | "OCR_REQUIRED" | "FAILED";
  error?: string;
  pages: {
    page: number;
    width: number;
    height: number;
    text: { text: string; bbox: [number, number, number, number] }[];
    referenceCandidates: string[];
  }[];
  connectivityStatus: "NOT_RECONSTRUCTED";
};
