import { NextResponse } from "next/server";
import { getProjectBundle, isDatabaseConfigured } from "../../../../lib/database";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  const { id } = await context.params;
  const tenant = request.headers.get("oai-authenticated-user-email") || request.headers.get("x-eda-tenant") || "local-demo";
  try {
    const project = await getProjectBundle(tenant, id);
    if (!project) return NextResponse.json({ error: "PROJECT_NOT_FOUND" }, { status: 404 });
    return NextResponse.json(project);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Database query failed" }, { status: 500 });
  }
}
