import test from "node:test";
import assert from "node:assert/strict";
import { judgeMapping, normalizeMpn, skipReason } from "../lib/bom/match";
import {
  mapResponse,
  iceasyAuth,
  searchProvider,
  ezplmHeaders,
} from "../lib/bom/providers";
import type { BomQuery, PartCandidate, Provider } from "../lib/bom/types";
const q: BomQuery = {
  id: "u1",
  references: ["U1"],
  value: "TPS54302DDCR",
  mpn: "",
  manufacturer: "",
  footprint: "Package_TO_SOT_SMD:SOT-23-6",
  description: "",
};
const hit = (
  source: Provider,
  mpn = q.value,
  manufacturer = "Texas Instruments",
): PartCandidate => ({
  source,
  mpn,
  manufacturer,
  package: "SOT-23-6",
  description: "buck converter",
  fetchedAt: "2026-09-14T00:00:00Z",
});
test("complete MPN and manufacturer identity never collapse suffixes or vendors", () => {
  assert.notEqual(normalizeMpn("MAX232CSE+"), normalizeMpn("MAX232CSE"));
  assert.equal(
    judgeMapping(
      q,
      [hit("mouser")],
      [{ source: "mouser", status: "OK", count: 1 }],
    ).status,
    "VERIFIED",
  );
  assert.equal(
    judgeMapping(
      q,
      [hit("mouser", "TPS54302DDCT")],
      [{ source: "mouser", status: "OK", count: 1 }],
    ).status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    judgeMapping(
      q,
      [hit("mouser"), hit("iceasy", q.value, "Other Manufacturer")],
      [{ source: "mouser", status: "OK", count: 2 }],
    ).status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    judgeMapping(
      q,
      [hit("mouser", q.value, "")],
      [{ source: "mouser", status: "OK", count: 1 }],
    ).selected,
    undefined,
  );
});
test("manufacturer conflict, pin-count conflict and supplier failure cannot auto-confirm", () => {
  assert.equal(
    judgeMapping({ ...q, manufacturer: "ST" }, [hit("mouser")], []).status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    judgeMapping(
      { ...q, footprint: "TSSOP-16" },
      [{ ...hit("mouser"), package: "TSSOP-8" }],
      [],
    ).status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    judgeMapping(
      q,
      [hit("mouser")],
      [{ source: "iceasy", status: "ERROR", count: 0 }],
    ).status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    judgeMapping(q, [], [{ source: "iceasy", status: "ERROR", count: 0 }])
      .status,
    "QUERY_FAILED",
  );
  assert.equal(
    judgeMapping(
      q,
      [],
      [{ source: "mouser", status: "NOT_CONFIGURED", count: 0 }],
    ).status,
    "NOT_CONFIGURED",
  );
});
test("passives skip purchasing selection while ICs, diodes and connectors remain eligible", () => {
  for (const ref of ["R1", "C20", "L2", "FB1", "H1", "TP1"])
    assert.ok(skipReason({ ...q, references: [ref] }));
  for (const ref of ["U1", "D2", "Q3", "J1", "Y1"])
    assert.equal(skipReason({ ...q, references: [ref] }), "");
});
test("supplier identity mapping retains manufacturer even with no stock or price", () => {
  assert.equal(
    mapResponse("ezplm", {
      data: [
        {
          id: "1",
          mpn: q.value,
          manufacturer: { name: "Texas Instruments" },
          footprint: "SOT-23-6",
        },
      ],
    })[0].manufacturer,
    "Texas Instruments",
  );
  assert.equal(
    mapResponse("iceasy", {
      code: 100,
      data: { rows: [{ partNo: q.value, linecard: "TI", prices: [] }] },
    })[0].manufacturer,
    "TI",
  );
  const dk = mapResponse("digikey", {
    Products: [
      {
        ManufacturerProductNumber: q.value,
        Manufacturer: { Name: "TI" },
        Parameters: [
          { ParameterText: "Package / Case", ValueText: "SOT-23-6" },
        ],
        ProductVariations: [{ PackageType: { Name: "Tape & Reel" } }],
      },
    ],
  })[0];
  assert.equal(dk.package, "SOT-23-6");
  assert.equal(
    mapResponse("mouser", {
      SearchResults: {
        Parts: [
          {
            ManufacturerPartNumber: q.value,
            Manufacturer: "TI",
            PriceBreaks: [],
          },
        ],
      },
    })[0].mpn,
    q.value,
  );
  assert.throws(() =>
    mapResponse("mouser", { Errors: [{ Message: "unauthorized" }] }),
  );
  assert.throws(() => mapResponse("iceasy", { code: 101 }));
  assert.throws(() => mapResponse("ezplm", { error: "invalid signature" }));
});
test("Iceasy encryption is identical to bom2buy golden vector", () => {
  assert.equal(
    iceasyAuth("demo_account", "DemoPassword123!", "20260911153045"),
    "PdQ5Ia869txISaW/DjmJCSZNpoBD03SZAkODDGLnZiM=",
  );
});
test("configured adapter queries signed master data and reports failure without credential leakage", async () => {
  const before = {
    base: process.env.EZPLM_API_BASE,
    key: process.env.EZPLM_API_KEY,
  };
  const old = globalThis.fetch;
  process.env.EZPLM_API_BASE = "https://example.invalid";
  process.env.EZPLM_API_KEY = "test-key-private";
  try {
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /keyword=TEST-PART&pageSize=12$/);
      const h = init!.headers as Record<string, string>;
      assert.equal(h["X-API-Key"], "test-key-private");
      assert.equal(
        h["X-Signature"],
        ezplmHeaders(
          "/api/v1/api-key/parts",
          "keyword=TEST-PART&pageSize=12",
          h["X-Timestamp"],
          h["X-Nonce"],
        )["X-Signature"],
      );
      return Response.json({
        data: [
          { id: "1", mpn: "TEST-PART", manufacturer: { name: "Example" } },
        ],
      });
    };
    const good = await searchProvider("ezplm", "TEST-PART");
    assert.equal(good.hits[0].manufacturer, "Example");
    assert.equal(good.probe.status, "OK");
    globalThis.fetch = async () => {
      throw new Error("failed URL with test-key-private");
    };
    const bad = await searchProvider("ezplm", "OTHER");
    assert.equal(bad.probe.status, "ERROR");
    assert.ok(!JSON.stringify(bad).includes("test-key-private"));
  } finally {
    globalThis.fetch = old;
    for (const [k, v] of [
      ["EZPLM_API_BASE", before.base],
      ["EZPLM_API_KEY", before.key],
    ])
      if (v === undefined) delete process.env[k!];
      else process.env[k!] = v;
  }
});

test('STEP face colours use renderable single materials without overlapping draw groups',async()=>{
 const {createStepAssembly}=await import('../lib/models/step');const {Mesh}=await import('three');
 const group=createStepAssembly([{color:[.2,.3,.4],attributes:{position:{array:[0,0,0,1,0,0,0,1,0]}},index:{array:[0,1,2]},brep_faces:[{first:0,last:0,color:[1,0,0]}]}]);
 const mesh=group.children[0] as InstanceType<typeof Mesh>;assert.ok(mesh instanceof Mesh);assert.equal(Array.isArray(mesh.material),false);assert.equal(mesh.geometry.index?.count,3);assert.equal(mesh.geometry.getAttribute('color').getX(0),1);assert.equal(mesh.geometry.getAttribute('color').getY(0),0);
});
