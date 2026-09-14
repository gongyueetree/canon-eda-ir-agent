import { authorize, authError } from "../../../../lib/auth";
import { saveMining } from "../../../../lib/knowledge/storage";
import { validateMiningInput } from "../../../../lib/knowledge/validate";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const tenant = authorize(request);
    const text = await request.text();
    if (text.length > 3_500_000)
      return Response.json(
        { error: "Bundle 超过 3.5 MB；请用批处理 CLI 本地导出" },
        { status: 413 },
      );
    const bundle = validateMiningInput(JSON.parse(text));
    return Response.json(await saveMining(tenant, bundle));
  } catch (e) {
    return authError(e);
  }
}
