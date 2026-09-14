# API

All data APIs require `Authorization: Bearer <EDA_API_TOKEN>`. Workspace comes only from EDA_WORKSPACE_ID. `/api/projects` may return `{configured:false,projects:[]}` without authentication when no database exists; it exposes no records.

| Method | Path | Body/result |
|---|---|---|
| POST | /api/projects | Canonical Bundle → stored project ID |
| GET | /api/projects | Recent 20 projects |
| GET | /api/projects/{id} | Latest stored Bundle, optional domain filter |
| POST | /api/knowledge/mine | Canonical Bundle (<=3.5 MB) → deterministic result + persisted block revisions; saves Bundle too |
| GET | /api/blocks?mpn=AD9837 | Up to 200 candidate/reviewed/published blocks |
| POST | /api/blocks/{id}/review | action, revision, edit, acknowledge |
| GET | /api/hardware-blocks/search?mpn=AD9837 | Up to 200 PUBLISHED blocks only |

Review example:

```json
{"action":"approve","revision":0,"acknowledge":true,"edit":{"name":"AD9837 DDS Core","members":[],"ports":[]}}
```

Actions: edit (returns CANDIDATE), approve, reject, publish. Publish uses stored approved snapshot; it cannot attach edits. Stale revisions return 409. Auth failure returns 401; missing server token returns 503. Input/processing errors return 400. There is no public anonymous knowledge endpoint.
