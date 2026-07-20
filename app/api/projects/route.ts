import { NextResponse } from "next/server";
import { isDatabaseConfigured, listProjects, saveBundle } from "../../../lib/database";
import type { CanonicalIrBundle } from "../../../lib/eda/types";

export const dynamic = "force-dynamic";

function tenantId(request: Request): string {
  return request.headers.get("oai-authenticated-user-email") || request.headers.get("x-eda-tenant") || "local-demo";
}

export async function GET(request: Request) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ configured: false, projects: [] });
  }
  try {
    const projects = await listProjects(tenantId(request));
    return NextResponse.json({ configured: true, projects });
  } catch (error) {
    return NextResponse.json(
      { configured: true, error: error instanceof Error ? error.message : "Database query failed", projects: [] },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_NOT_CONFIGURED", message: "请在部署环境设置 DATABASE_URL。" },
      { status: 503 },
    );
  }
  try {
    const bundle = (await request.json()) as CanonicalIrBundle;
    const serialized = JSON.stringify(bundle);
    if (serialized.length > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "PARSER_RESOURCE_LIMIT", message: "IR Bundle 超过 API 保存上限。" }, { status: 413 });
    }
    if (!bundle?.bundleId || !bundle?.project?.id || !bundle?.parser?.adapterId) {
      return NextResponse.json({ error: "IR_SCHEMA_VALIDATION_FAILED", message: "缺少 Bundle 必填字段。" }, { status: 400 });
    }
    const result = await saveBundle(tenantId(request), bundle);
    return NextResponse.json({ saved: true, ...result }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "OUTPUT_STORAGE_FAILED", message: error instanceof Error ? error.message : "Database write failed" },
      { status: 500 },
    );
  }
}
