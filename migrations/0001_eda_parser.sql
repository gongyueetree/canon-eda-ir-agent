CREATE TABLE IF NOT EXISTS eda_projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_format TEXT NOT NULL,
  latest_bundle_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id)
);

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
);

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
);

CREATE INDEX IF NOT EXISTS eda_projects_tenant_updated_idx ON eda_projects (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS eda_parse_jobs_project_idx ON eda_parse_jobs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS eda_ir_bundles_project_idx ON eda_ir_bundles (project_id, created_at DESC);
