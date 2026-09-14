CREATE TABLE IF NOT EXISTS eda_knowledge_runs (
  id TEXT NOT NULL, tenant_id TEXT NOT NULL, bundle_id TEXT NOT NULL,
  result JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS eda_knowledge_blocks (
  id TEXT NOT NULL, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
  mpn TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CANDIDATE',
  revision INTEGER NOT NULL DEFAULT 0, block JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES eda_knowledge_runs(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS eda_knowledge_reviews (
  id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, block_id TEXT NOT NULL,
  action TEXT NOT NULL, revision INTEGER NOT NULL, snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eda_knowledge_search ON eda_knowledge_blocks(tenant_id,status,mpn);
