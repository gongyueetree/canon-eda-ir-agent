import { authorize, authError } from "../../../../lib/auth";
import { NextResponse } from "next/server";
import { getProjectBundle, isDatabaseConfigured } from "../../../../lib/database";
import { createIrDomainExport, isIrDomainKey } from "../../../../lib/eda/export";
import type { CanonicalIrBundle } from "../../../../lib/eda/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  const { id } = await context.params;

  try {
    const tenant = authorize(request);
    const project = await getProjectBundle(tenant, id);
    if (!project) return NextResponse.json({ error: "PROJECT_NOT_FOUND" }, { status: 404 });
    const domain = new URL(request.url).searchParams.get("domain");
    if (domain) {
      if (!isIrDomainKey(domain)) {
        return NextResponse.json(
          { error: "INVALID_IR_DOMAIN", supportedDomains: ["project", "schematic", "pcb", "part", "net"] },
          { status: 400 },
        );
      }
      return NextResponse.json(createIrDomainExport(project.bundle as CanonicalIrBundle, domain));
    }
    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof Error && ["UNAUTHORIZED", "AUTH_NOT_CONFIGURED"].includes(error.message)) return authError(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Database query failed" }, { status: 500 });
  }
}

