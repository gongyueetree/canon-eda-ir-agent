-- Native component asset candidates, content-addressed files and review provenance.
CREATE TABLE IF NOT EXISTS eda_design_chunks (tenant_id TEXT NOT NULL, hash TEXT NOT NULL, idx INTEGER NOT NULL, chunk_hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant_id,hash,idx));

CREATE TABLE IF NOT EXISTS eda_design_files (tenant_id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(tenant_id,hash));

CREATE TABLE IF NOT EXISTS eda_design_assets (tenant_id TEXT NOT NULL, id TEXT NOT NULL, mpn TEXT NOT NULL, manufacturer TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CANDIDATE', revision INTEGER NOT NULL DEFAULT 0, asset JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id));

CREATE INDEX IF NOT EXISTS eda_design_identity ON eda_design_assets(tenant_id,mpn,manufacturer,kind);

CREATE TABLE IF NOT EXISTS eda_design_origins (tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, origin_id TEXT NOT NULL, origin JSONB NOT NULL, PRIMARY KEY(tenant_id,asset_id,origin_id), FOREIGN KEY(tenant_id,asset_id) REFERENCES eda_design_assets(tenant_id,id));

CREATE TABLE IF NOT EXISTS eda_design_reviews (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, action TEXT NOT NULL, revision INTEGER NOT NULL, snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
