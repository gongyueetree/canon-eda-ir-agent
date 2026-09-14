import { authorize, authError } from "../../../../lib/auth";
import { listBlocks } from "../../../../lib/knowledge/storage";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    return Response.json({
      blocks: await listBlocks(
        authorize(request),
        new URL(request.url).searchParams.get("mpn") ?? "",
        true,
      ),
    });
  } catch (e) {
    return authError(e);
  }
}
