// #36 — the OpenAPI schema-provenance gate.
//
// `openapi:check` and `client:check` compare GENERATED OUTPUT TO GENERATED OUTPUT, so they prove the
// artifacts are current and nothing about whether the contract is right. A route wired to the wrong
// schema regenerates perfectly consistently: the emitted contract does not look absent or stale, it
// looks satisfied. That is how #31 shipped a cross-tenant ops list carrying the tenant-scoped shape.
//
// Most of what is asserted here is the PARSER, deliberately. The gate reads a 12,000-line registry of
// nested TypeBox literals and prose comments; a parser that silently matches nothing would make the
// whole gate pass vacuously, which is the exact failure mode it was built to catch. The first draft
// of this scanner used a non-greedy `\{[\s\S]*?\}` and reported that the M35 Stripe webhook published
// an M30 CAHPS schema — a false positive caused by running past a single-line entry into the next
// block. Those shapes are pinned below.
import { describe, expect, it } from "vitest";
import {
  type ImportBinding,
  directoryProvenance,
  duplicateAliases,
  importBindings,
  routeSchemaIdentifiers,
  run,
} from "../check-openapi-provenance";
import type { ScannedRoute } from "../openapi/scan-routes";

const REPO = "/repo";

function binding(local: string, from: string, resolved: string | null): ImportBinding {
  return { local, imported: local, from, resolved };
}

function route(path: string, file: string): ScannedRoute {
  return { method: "get", path, module: "34-saas-tenant-platform", file };
}

describe("entry parser", () => {
  it("does not let a single-line entry swallow the entries after it", () => {
    // The exact false positive that killed the first draft: `"POST /x": { summary: "..." },` has no
    // schemas, but a non-greedy match ran to the NEXT `\n  },` and attributed that block's schemas
    // to the webhook route.
    const src = `Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/webhooks/stripe": { summary: "Inbound Stripe webhook (HMAC-verified)" },

  "GET /api/v1/quality/cahps-vendors": {
    summary: "CAHPS vendor bindings",
    response: CahpsVendorResponseSchema,
  },
});`;
    const got = routeSchemaIdentifiers(src);
    expect(got.get("POST /api/v1/webhooks/stripe")).toEqual([]);
    expect(got.get("GET /api/v1/quality/cahps-vendors")).toEqual(["CahpsVendorResponseSchema"]);
  });

  it("reads top-level body/response/query and ignores identifiers nested inside literals", () => {
    const src = `X({
  "POST /api/v1/a": {
    body: RealBody,
    response: Type.Object({ items: Type.Array(NotTheContract) }),
    query: RealQuery,
  },
});`;
    expect(routeSchemaIdentifiers(src).get("POST /api/v1/a")).toEqual(["RealBody", "RealQuery"]);
  });

  it("survives comments carrying unmatched braces and apostrophes", () => {
    // enrichments.ts is heavily commented prose. An apostrophe read as a string delimiter, or a `{`
    // in a comment counted as depth, desynchronises the whole scan from that point on.
    const src = `X({
  // the tenant's list — see the { held } filter; don't confuse it with the platform one
  "GET /api/v1/b": {
    /* a block comment with a stray } brace */
    response: TheSchema,
  },
});`;
    expect(routeSchemaIdentifiers(src).get("GET /api/v1/b")).toEqual(["TheSchema"]);
  });

  it("parses the real registry rather than silently matching nothing", () => {
    // A guard on the guard. Without it every assertion in this file could pass over an empty parse.
    const src = require("node:fs").readFileSync(
      require("node:path").join(process.cwd(), "scripts/openapi/enrichments.ts"),
      "utf8",
    ) as string;
    const routes = routeSchemaIdentifiers(src);
    expect(routes.size).toBeGreaterThan(1000);
    expect(importBindings(src).length).toBeGreaterThan(1000);
  });
});

describe("rule 1 — alias uniqueness", () => {
  it("reports a name bound by two different modules", () => {
    const found = duplicateAliases([
      binding(
        "M34TenantExportJobListResponseSchema",
        "./platform/platform-typebox",
        "/a/platform/platform-typebox",
      ),
      binding(
        "M34TenantExportJobListResponseSchema",
        "./tenant/tenant-typebox",
        "/a/tenant/tenant-typebox",
      ),
      binding("Unrelated", "./x", "/a/x"),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe("duplicate-alias");
    expect(found[0]?.message).toContain("the last one wins");
  });

  it("does not fire on distinct aliases of the same exported name", () => {
    // The correct pattern, already used in the repo for BaaRecordViewSchema.
    expect(
      duplicateAliases([
        {
          imported: "BaaRecordViewSchema",
          local: "M34PlatformBaaRecordViewSchema",
          from: "./platform/platform-typebox",
          resolved: "/a/platform/platform-typebox",
        },
        {
          imported: "BaaRecordViewSchema",
          local: "M34TenantBaaRecordViewSchema",
          from: "./tenant/tenant-typebox",
          resolved: "/a/tenant/tenant-typebox",
        },
      ]),
    ).toEqual([]);
  });
});

describe("rule 2 — directory provenance", () => {
  const routes = [
    route(
      "/api/v1/platform/tenant-export-jobs",
      "apps/backend/src/modules/34/routes/platform/approval.ts",
    ),
  ];
  const key = "GET /api/v1/platform/tenant-export-jobs";

  it("rejects a schema reached from a sibling surface", () => {
    const r = directoryProvenance(
      routes,
      new Map([[key, ["S"]]]),
      [binding("S", "x", `${REPO}/apps/backend/src/modules/34/routes/tenant/tenant-typebox`)],
      REPO,
    );
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.message).toContain("sibling surface");
    expect(r.checked).toBe(1);
  });

  it("accepts a schema co-located with the route", () => {
    const r = directoryProvenance(
      routes,
      new Map([[key, ["S"]]]),
      [binding("S", "x", `${REPO}/apps/backend/src/modules/34/routes/platform/platform-typebox`)],
      REPO,
    );
    expect(r.violations).toEqual([]);
  });

  it("accepts a schema shared from an ancestor directory", () => {
    // routes/typebox.ts is the module's shared root — legitimately used by every surface below it.
    const r = directoryProvenance(
      routes,
      new Map([[key, ["S"]]]),
      [binding("S", "x", `${REPO}/apps/backend/src/modules/34/routes/typebox`)],
      REPO,
    );
    expect(r.violations).toEqual([]);
  });

  it("counts, rather than silently skips, schemas it cannot place by directory", () => {
    // Local consts and @wardenx/* package imports have no comparable file. A gate that dropped them
    // quietly while printing OK would be the same class of lie it exists to catch.
    const r = directoryProvenance(
      routes,
      new Map([[key, ["LocalConst", "PackageSchema"]]]),
      [binding("PackageSchema", "@wardenx/billing", null)],
      REPO,
    );
    expect(r.checked).toBe(0);
    expect(r.unattributed).toBe(2);
    expect(r.unattributedNames).toEqual(["LocalConst", "PackageSchema"]);
    expect(r.violations).toEqual([]);
  });
});

describe("the repo baseline", () => {
  it("is clean, and the run attributed a real number of pairs", () => {
    const { violations, report } = run();
    expect(violations).toEqual([]);
    // Pins the gate against quietly degrading into a no-op if the registry's shape changes.
    expect(report.checked).toBeGreaterThan(1500);
  });
});
