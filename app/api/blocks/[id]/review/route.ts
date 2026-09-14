import { authorize, authError } from "../../../../../lib/auth";
import { reviewBlock } from "../../../../../lib/knowledge/storage";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const tenant = authorize(request);
    const text = await request.text();
    if (text.length > 100000) throw new Error("REQUEST_TOO_LARGE");
    const data = JSON.parse(text);
    if (!Number.isInteger(data.revision) || data.revision < 0)
      throw new Error("INVALID_REVISION");
    return Response.json(
      await reviewBlock(
        tenant,
        (await context.params).id,
        data.action,
        data.revision,
        data.edit ?? {},
        data.acknowledge === true,
      ),
    );
  } catch (e) {
    if (e instanceof Error && e.message === "REVISION_CONFLICT")
      return Response.json({ error: e.message }, { status: 409 });
    return authError(e);
  }
}
