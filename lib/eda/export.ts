import type { CanonicalIrBundle } from "./types";

export const IR_DOMAIN_KEYS = ["project", "schematic", "pcb", "part", "net"] as const;

export type IrDomainKey = (typeof IR_DOMAIN_KEYS)[number];

export type IrDomainExport = {
  schema: "canon-eda-ir";
  schemaVersion: "1.0.0";
  irType: "Project IR" | "Schematic IR" | "PCB IR" | "Part IR" | "Net IR";
  bundleId: string;
  projectId: string;
  projectName: string;
  generatedAt: string;
  entityCount: number;
  data: unknown;
};

const IR_TYPE_BY_DOMAIN: Record<IrDomainKey, IrDomainExport["irType"]> = {
  project: "Project IR",
  schematic: "Schematic IR",
  pcb: "PCB IR",
  part: "Part IR",
  net: "Net IR",
};

export function isIrDomainKey(value: string | null): value is IrDomainKey {
  return value !== null && (IR_DOMAIN_KEYS as readonly string[]).includes(value);
}

export function createIrDomainExport(bundle: CanonicalIrBundle, domain: IrDomainKey): IrDomainExport {
  const domainData: Record<IrDomainKey, { entityCount: number; data: unknown }> = {
    project: {
      entityCount: 1,
      data: bundle.project,
    },
    schematic: {
      entityCount: bundle.schematics.length,
      data: bundle.schematics,
    },
    pcb: {
      entityCount: bundle.pcbs.length,
      data: bundle.pcbs,
    },
    part: {
      entityCount: bundle.parts.length,
      data: bundle.parts,
    },
    net: {
      entityCount: bundle.nets.length,
      data: {
        nets: bundle.nets,
        crossDocumentLinks: bundle.crossDocumentLinks,
      },
    },
  };

  return {
    schema: "canon-eda-ir",
    schemaVersion: "1.0.0",
    irType: IR_TYPE_BY_DOMAIN[domain],
    bundleId: bundle.bundleId,
    projectId: bundle.project.id,
    projectName: bundle.project.name,
    generatedAt: bundle.generatedAt,
    entityCount: domainData[domain].entityCount,
    data: domainData[domain].data,
  };
}
