import { neon } from "@neondatabase/serverless";
import { sha256 } from "./eda/util";
import type { CanonicalIrBundle } from "./eda/types";

let schemaPromise: Promise<void> | undefined;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function sqlClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_NOT_CONFIGURED");
  return neon(connectionString);
}

export async function ensureDatabaseSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sql = sqlClient();
      await sql`
        CREATE TABLE IF NOT EXISTS eda_projects (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          source_format TEXT NOT NULL,
          latest_bundle_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, id)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS eda_parse_jobs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES eda_projects(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL,
          status TEXT NOT NULL,
          adapter_id TEXT NOT NULL,
          input_snapshot_hash TEXT NOT NULL,
          result_summary JSONB NOT NULL,
          diagnostics JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS eda_ir_bundles (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES eda_projects(id) ON DELETE CASCADE,
          parse_job_id TEXT NOT NULL REFERENCES eda_parse_jobs(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL,
          project_ir_version TEXT NOT NULL,
          source_format TEXT NOT NULL,
          bundle_hash TEXT NOT NULL,
          bundle JSONB NOT NULL,
          fidelity JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, bundle_hash)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS eda_projects_tenant_updated_idx ON eda_projects (tenant_id, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS eda_parse_jobs_project_idx ON eda_parse_jobs (project_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS eda_ir_bundles_project_idx ON eda_ir_bundles (project_id, created_at DESC)`;
    })().catch(error => { schemaPromise = undefined; throw error; });
  }
  return schemaPromise;
}

export async function listProjects(tenantId: string) {
  await ensureDatabaseSchema();
  const sql = sqlClient();
  return sql`
    SELECT p.id, p.name, p.source_format, p.latest_bundle_id, p.updated_at,
      COALESCE(j.result_summary, '{}'::jsonb) AS summary,
      COALESCE(b.fidelity, '{}'::jsonb) AS fidelity
    FROM eda_projects p
    LEFT JOIN LATERAL (
      SELECT result_summary FROM eda_parse_jobs
      WHERE project_id = p.id AND tenant_id = ${tenantId}
      ORDER BY created_at DESC LIMIT 1
    ) j ON TRUE
    LEFT JOIN eda_ir_bundles b ON b.id = p.latest_bundle_id
    WHERE p.tenant_id = ${tenantId}
    ORDER BY p.updated_at DESC
    LIMIT 20
  `;
}

export async function saveBundle(tenantId: string, bundle: CanonicalIrBundle) {
  await ensureDatabaseSchema();
  const sql = sqlClient();
  const project = bundle.project;
  const parser = bundle.parser;
  const summary = bundle.summary;
  const inventory = bundle.inventory;
  const namespace = await sha256(new TextEncoder().encode(tenantId));
  const contentHash = await sha256(new TextEncoder().encode(JSON.stringify({...bundle,generatedAt:undefined})));
  const projectId = `${namespace}:${project.id}`;
  const bundleId = `${namespace}:${contentHash}`;
  const jobId = `job_${bundleId.replace(/^bundle_/, "")}`;
  const bundleHash = String(bundleId);
  const snapshotHash = inventory.map((asset) => String(asset.sha256)).sort().join(":");

  await sql.transaction([
  sql`
    INSERT INTO eda_projects (id, tenant_id, name, source_format, latest_bundle_id, updated_at)
    VALUES (${projectId}, ${tenantId}, ${String(project.name)}, ${String(project.sourceFormat)}, ${bundleId}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      source_format = EXCLUDED.source_format,
      latest_bundle_id = EXCLUDED.latest_bundle_id,
      updated_at = NOW()
  `,
  sql`
    INSERT INTO eda_parse_jobs (
      id, project_id, tenant_id, status, adapter_id, input_snapshot_hash,
      result_summary, diagnostics, completed_at
    ) VALUES (
      ${jobId}, ${projectId}, ${tenantId}, 'COMPLETED', ${String(parser.adapterId)},
      ${snapshotHash}, ${JSON.stringify(summary)}::jsonb, ${JSON.stringify(bundle.diagnostics ?? [])}::jsonb, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      result_summary = EXCLUDED.result_summary,
      diagnostics = EXCLUDED.diagnostics,
      completed_at = NOW()
  `,
  sql`
    INSERT INTO eda_ir_bundles (
      id, project_id, parse_job_id, tenant_id, project_ir_version,
      source_format, bundle_hash, bundle, fidelity
    ) VALUES (
      ${bundleId}, ${projectId}, ${jobId}, ${tenantId}, ${String(project.projectIrVersion)},
      ${String(project.sourceFormat)}, ${bundleHash}, ${JSON.stringify(bundle)}::jsonb,
      ${JSON.stringify(bundle.fidelity ?? {})}::jsonb
    )
    ON CONFLICT (tenant_id, bundle_hash) DO UPDATE SET
      bundle = EXCLUDED.bundle,
      fidelity = EXCLUDED.fidelity
  `,
  ]);
  return { projectId, bundleId, jobId };
}

export async function getProjectBundle(tenantId: string, projectId: string) {
  await ensureDatabaseSchema();
  const sql = sqlClient();
  const rows = await sql`
    SELECT p.id, p.name, p.source_format, p.updated_at, b.bundle
    FROM eda_projects p
    JOIN eda_ir_bundles b ON b.id = p.latest_bundle_id
    WHERE p.tenant_id = ${tenantId} AND p.id = ${projectId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

