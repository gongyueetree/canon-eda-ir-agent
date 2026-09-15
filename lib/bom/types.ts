export type Provider = "ezplm" | "iceasy" | "digikey" | "mouser";
export type BomQuery = {
  id: string;
  references: string[];
  value: string;
  footprint: string;
  mpn: string;
  manufacturer: string;
  description: string;
};
export type PartCandidate = {
  mpn: string;
  manufacturer: string;
  package: string;
  description: string;
  source: Provider;
  url?: string;
  fetchedAt: string;
};
export type RankedCandidate = PartCandidate & {
  sources: Provider[];
  exact: boolean;
  conflicts: string[];
  evidence: PartCandidate[];
};
export type Probe = {
  source: Provider;
  status: "OK" | "NOT_CONFIGURED" | "ERROR" | "SKIPPED";
  count: number;
  message?: string;
};
export type BomMapping = {
  query: BomQuery;
  status:
    | "VERIFIED"
    | "CONFIRMED"
    | "REVIEW_REQUIRED"
    | "NO_MATCH"
    | "QUERY_FAILED"
    | "NOT_CONFIGURED"
    | "SKIPPED";
  candidates: RankedCandidate[];
  selected?: RankedCandidate;
  probes: Probe[];
  updatedAt: string;
  message: string;
};
