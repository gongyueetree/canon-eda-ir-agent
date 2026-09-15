import type {
  BomQuery,
  PartCandidate,
  RankedCandidate,
  BomMapping,
  Probe,
} from "./types";
export const normalizeMpn = (s: string) =>
  s.trim().toUpperCase().replace(/\s+/g, ""); // Never remove ordering suffix punctuation.
const aliases: Record<string, string> = {
  ti: "Texas Instruments",
  "texas instruments": "Texas Instruments",
  德州仪器: "Texas Instruments",
  adi: "Analog Devices",
  "analog devices": "Analog Devices",
  "analog devices inc.": "Analog Devices",
  maxim: "Analog Devices",
  "maxim integrated": "Analog Devices",
  st: "STMicroelectronics",
  stmicroelectronics: "STMicroelectronics",
  on: "onsemi",
  onsemi: "onsemi",
  "on semiconductor": "onsemi",
  "diodes incorporated": "Diodes Incorporated",
  "diodes inc.": "Diodes Incorporated",
  nexperia: "Nexperia",
  "raspberry pi": "Raspberry Pi",
};
export function manufacturerName(s: string) {
  return aliases[s.trim().toLowerCase()] ?? s.trim();
}
export function skipReason(q: BomQuery) {
  if (
    q.references.length &&
    q.references.every((r) => /^(?:R|C|L|FB)\d+$/i.test(r))
  )
    return "电阻、电容、电感或磁珠：本次不自动选型";
  if (
    q.references.length &&
    q.references.every((r) => /^(?:H|MH|TP)\d+$/i.test(r))
  )
    return "安装孔或测试点：无需映射采购料号";
  return "";
}
function packagePins(s: string) {
  return s
    .toUpperCase()
    .match(
      /(?:QFN|DFN|TSSOP|SSOP|SOIC|SOP|LQFP|TQFP|QFP|BGA|VSON)[- _]?(\d+)/,
    )?.[1];
}
export function rankCandidates(
  q: BomQuery,
  hits: PartCandidate[],
): RankedCandidate[] {
  const query = normalizeMpn(q.mpn || q.value),
    groups = new Map<string, RankedCandidate>();
  for (const h of hits) {
    if (!h.mpn) continue;
    const manufacturer = manufacturerName(h.manufacturer);
    const key = normalizeMpn(h.mpn) + "|" + manufacturer.toLowerCase();
    const exact = normalizeMpn(h.mpn) === query;
    const conflicts: string[] = [];
    if (
      q.manufacturer &&
      manufacturer &&
      manufacturerName(q.manufacturer).toLowerCase() !==
        manufacturer.toLowerCase()
    )
      conflicts.push("厂商与源工程不一致");
    const sourcePins = packagePins(q.footprint),
      candidatePins = packagePins(h.package);
    if (sourcePins && candidatePins && sourcePins !== candidatePins)
      conflicts.push("封装管脚数与源工程不一致");
    const old = groups.get(key);
    if (old) {
      old.evidence.push(h);
      old.sources = [...new Set([...old.sources, h.source])];
      old.conflicts = [...new Set([...old.conflicts, ...conflicts])];
      if (h.source === "ezplm") {
        old.manufacturer = h.manufacturer;
        old.description = h.description || old.description;
        old.package = h.package || old.package;
      }
      continue;
    }
    groups.set(key, {
      ...h,
      manufacturer: h.source === "ezplm" ? h.manufacturer : manufacturer,
      exact,
      conflicts,
      sources: [h.source],
      evidence: [h],
    });
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        a.conflicts.length - b.conflicts.length ||
        Number(b.sources.includes("ezplm")) -
          Number(a.sources.includes("ezplm")) ||
        b.sources.length - a.sources.length,
    )
    .slice(0, 12);
}
export function judgeMapping(
  q: BomQuery,
  hits: PartCandidate[],
  probes: Probe[],
): BomMapping {
  const candidates = rankCandidates(q, hits),
    exact = candidates.filter((c) => c.exact);
  const selected =
    exact.length === 1 && !!exact[0].manufacturer && !exact[0].conflicts.length
      ? exact[0]
      : undefined;
  // A failed channel could have returned a conflicting manufacturer; require review unless master data verified it.
  const verified =
    selected &&
    (!probes.some((p) => p.status === "ERROR") ||
      selected.sources.includes("ezplm"));
  const status = skipReason(q)
    ? "SKIPPED"
    : verified
      ? "VERIFIED"
      : candidates.length
        ? "REVIEW_REQUIRED"
        : probes.some((p) => p.status === "ERROR")
          ? "QUERY_FAILED"
          : probes.every((p) => p.status === "NOT_CONFIGURED")
            ? "NOT_CONFIGURED"
            : "NO_MATCH";
  return {
    query: q,
    status,
    candidates,
    selected: verified ? selected : undefined,
    probes,
    updatedAt: new Date().toISOString(),
    message:
      status === "SKIPPED"
        ? skipReason(q)
        : status === "VERIFIED"
          ? "完整料号精确命中，厂商已补全；请核对封装与订货后缀"
          : status === "REVIEW_REQUIRED"
            ? "存在相似型号、多厂商或证据冲突，请选择并确认"
            : status === "QUERY_FAILED"
              ? "接口查询失败，不代表没有该器件"
              : status === "NOT_CONFIGURED"
                ? "请配置至少一个数据源的服务端 API 凭据"
                : "未找到型号，可编辑检索词后重试",
  };
}
