export type CatalogCategory = {
  id: string;
  name: string;
  projectCount: number;
  children?: CatalogCategory[];
};
export type CatalogProject = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
};
export type CatalogPage = {
  data: CatalogProject[];
  meta: { nextCursor: string | null; hasMore: boolean };
};
export type CatalogEcad = {
  bomId: string | null;
  name: string;
  description: string | null;
  sourceLinks: { name: string; url: string }[];
  ecadUrl: string | null;
  altiumUrl: string | null;
  hasNetlist: boolean;
};
export type CatalogProvenance = {
  provider: "ezplm";
  projectId: string;
  bomId: string | null;
  projectName: string;
  importedAt: string;
  method: "source_download" | "local_upload";
  files: {
    name: string;
    sha256: string;
    sourceUrl?: string;
    revision?: string;
  }[];
};
export function safeWebUrl(
  value: string | null | undefined,
): string | undefined {
  try {
    const u = new URL(value || "");
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
// Viewer pages are never interpreted as archives, even when they contain a file URL query.
export function sourceKind(value: string): "file" | "github" | "page" {
  const safe = safeWebUrl(value);
  if (!safe) return "page";
  const u = new URL(safe);
  if (u.protocol !== "https:") return "page";
  if (
    /\.(zip|kicad_sch|kicad_pcb|kicad_pro|sch|brd|prjpcb|schdoc|pcbdoc|json|jsonl|epro|eprj|esch|epcb)$/i.test(
      u.pathname,
    )
  )
    return "file";
  if (
    u.hostname === "github.com" &&
    /^\/[^/]+\/[^/]+(?:\.git)?\/?$/.test(u.pathname)
  )
    return "github";
  return "page";
}
export function publicSourceUrl(value: string): string {
  const u = new URL(value);
  u.search = "";
  u.hash = "";
  return u.href;
}
