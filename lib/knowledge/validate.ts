import type { CanonicalIrBundle } from "../eda/types";
/** Structural boundary validation; does not certify uploaded engineering truth. */
export function validateMiningInput(value: unknown): CanonicalIrBundle {
  if (!value || typeof value !== "object") throw new Error("INVALID_BUNDLE");
  const b = value as CanonicalIrBundle;
  if (
    !b.bundleId ||
    !b.project?.id ||
    !b.parser?.adapterVersion ||
    !b.fidelity ||
    !b.summary
  )
    throw new Error("INVALID_BUNDLE");
  for (const key of [
    "parts",
    "nets",
    "schematics",
    "pcbs",
    "inventory",
    "crossDocumentLinks",
    "diagnostics",
  ] as const)
    if (!Array.isArray(b[key]) || b[key].length > 50000)
      throw new Error("INVALID_BUNDLE_" + key);
  const ids = new Set(b.parts.map((p) => p.id));
  if (ids.size !== b.parts.length) throw new Error("DUPLICATE_PART");
  for (const p of b.parts)
    if (typeof p.reference !== "string" || !Array.isArray(p.sourceRefs))
      throw new Error("INVALID_PART");
  for (const s of b.schematics) {
    if (!Array.isArray(s.pins)) throw new Error("INVALID_PINS");
    for (const p of s.pins)
      if (!ids.has(p.partId) || typeof p.name !== "string")
        throw new Error("INVALID_PIN_REFERENCE");
  }
  for (const n of b.nets)
    if (
      !Array.isArray(n.endpoints) ||
      !n.resolution ||
      !Array.isArray(n.sourceRefs)
    )
      throw new Error("INVALID_NET");
  for (const p of b.pcbs)
    if (!Array.isArray(p.pads) || !Array.isArray(p.footprints))
      throw new Error("INVALID_PCB");
  return b;
}
