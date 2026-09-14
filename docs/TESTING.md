# Testing

```bash
npm ci
npx tsc --noEmit
npm run lint
npm test
npm run build:vercel
npm run mine:batch -- fixtures/mining/manifest.json outputs/check
npm run mine:batch -- fixtures/mining/manifest.json outputs/check
```

The second batch must report CACHED for the three fixture projects. Fixtures are synthetic and intentionally small; they are not vendor circuits, data-sheet pinouts or manufacturing-ready KiCad files.

Regression coverage includes old EDA adapters, domain exports, PCB dimensions, no-junction crossings, semantic grouping, other-IC/rail boundaries, immutable review edits, port recomputation, approval evidence, forged tenant headers, actual one-page PDF text extraction and source coordinates, invalid PDFs and schematic Y conversion.

Required production checks not run here: a configured PostgreSQL/Neon round trip; concurrent edits returning 409; approve→publish→published-only API flow; user Golden-100 measurements; real browser upload and interaction. The environment's cloud browser blocked localhost preview, so no browser pass is claimed.
