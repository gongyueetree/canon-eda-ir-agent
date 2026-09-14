# Data model

CanonicalIrBundle remains the engineering source of truth. Optional pdfEvidence adds document extraction evidence without changing existing nets.

MiningResult is versioned independently: schemaVersion, minerVersion, sourceHash, bundleId, graph, anchors, blocks. The SHA256 incorporates source names/hashes, parser versions and normalized graph inputs. IDs of blocks depend on source hash, miner version, anchor ID and pin group.

eda_projects/eda_parse_jobs/eda_ir_bundles remain available. New persisted IDs include a hash of the server-selected workspace; bundle content is hashed rather than trusting client IDs. Raw candidate output is in eda_knowledge_runs. eda_knowledge_blocks carries the current reviewed snapshot and optimistic revision. eda_knowledge_reviews stores an atomic audit snapshot for each mutation. These records do not claim production/simulation verification.

Raw source binary data is retained by batch CLI in content-addressed raw/ files, linked through raw-manifest.json. Browser-only source data is not uploaded to a binary object store.
