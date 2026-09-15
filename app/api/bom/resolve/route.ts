import { authorize, authError } from "../../../../lib/auth";
import { providerStatus, searchProvider } from "../../../../lib/bom/providers";
import { judgeMapping, skipReason } from "../../../../lib/bom/match";
import type { BomQuery, Provider } from "../../../../lib/bom/types";
export const runtime = "nodejs";
export const maxDuration = 45;
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    authorize(request);
    return Response.json({ providers: providerStatus() });
  } catch (e) {
    return authError(e);
  }
}
export async function POST(request: Request) {
  try {
    authorize(request);
    const raw = await request.text();
    if (raw.length > 20000)
      return Response.json(
        { error: "单次只接受一个 BOM 行，最多 20 KB" },
        { status: 413 },
      );
    const q = JSON.parse(raw) as BomQuery;
    for (const key of [
      "id",
      "value",
      "footprint",
      "mpn",
      "manufacturer",
      "description",
    ] as const)
      if (typeof q[key] !== "string" || q[key].length > 1000)
        throw new Error("INVALID_BOM_QUERY");
    if (
      !Array.isArray(q.references) ||
      q.references.length > 500 ||
      q.references.some((r) => typeof r !== "string" || r.length > 80)
    )
      throw new Error("INVALID_REFERENCES");
    if (skipReason(q)) return Response.json(judgeMapping(q, [], []));
    const keyword = (q.mpn || q.value || q.description).trim();
    if (!keyword || keyword.length > 200)
      throw new Error("请提供 1–200 字符的型号或检索词");
    const master = await searchProvider("ezplm", keyword);
    const early = judgeMapping(q, master.hits, [master.probe]);
    if (early.status === "VERIFIED")
      return Response.json({
        ...early,
        probes: [
          master.probe,
          ...(["iceasy", "digikey", "mouser"] as Provider[]).map((source) => ({
            source,
            status: "SKIPPED",
            count: 0,
            message: "ezPLM 主数据已精确命中",
          })),
        ],
      });
    const rest = await Promise.all(
      (["iceasy", "digikey", "mouser"] as Provider[]).map((p) =>
        searchProvider(p, keyword),
      ),
    );
    return Response.json(
      judgeMapping(
        q,
        [...master.hits, ...rest.flatMap((r) => r.hits)],
        [master.probe, ...rest.map((r) => r.probe)],
      ),
    );
  } catch (e) {
    return authError(e);
  }
}
