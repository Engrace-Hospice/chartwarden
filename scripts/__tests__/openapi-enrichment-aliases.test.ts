// #31 — the OpenAPI enrichment registry binds one alias per schema, and the two tenant-export list
// routes publish the two DIFFERENT contracts they were written against.
//
// scripts/openapi/enrichments.ts is a ~9,700-line flat registry whose imports are one alphabetised
// block per source module. `TenantExportJobListResponseSchema` is exported by BOTH
// routes/platform/platform-typebox.ts and routes/tenant/tenant-typebox.ts, and both were aliased to
// the same `M34TenantExportJobListResponseSchema`. The second binding won, so
// `GET /api/v1/platform/tenant-export-jobs` — the CROSS-TENANT ops discovery list — published the
// tenant-scoped shape: no `organizationId` to attribute a job to a tenant, and none of the four
// `held*` fields a SEC-052 co-signer decides on, even though `?held=true` survived as a query param.
//
// Nothing rejected it. `tsc` reports TS2300 on the file, but scripts/ is in no tsconfig project
// (#34); biome reports lint/suspicious/noRedeclare, but CI runs lint continue-on-error (#33); and
// openapi:check/client:check compare generated output against generated output, so a
// consistently-wrong contract looks satisfied.
//
// Two guards below: the CLASS (no alias may ever be bound twice) and the INSTANCE (the two routes'
// item shapes must actually differ, in the emitted artifact).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ENRICHMENTS = join(ROOT, "scripts/openapi/enrichments.ts");

/** Every local binding introduced by a named `import { ... } from "..."` block, with its source. */
function importedBindings(src: string): { local: string; from: string; imported: string }[] {
  const out: { local: string; from: string; imported: string }[] = [];
  const block = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
  for (const m of src.matchAll(block)) {
    const body = m[1] ?? "";
    const from = m[2] ?? "";
    for (const rawEntry of body.split(",")) {
      const entry = rawEntry.replace(/\/\/[^\n]*/g, "").trim();
      if (!entry) continue;
      const aliased = entry.match(/^(?:type\s+)?([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
      if (aliased) {
        out.push({ imported: aliased[1] as string, local: aliased[2] as string, from });
        continue;
      }
      const bare = entry.match(/^(?:type\s+)?([A-Za-z0-9_$]+)$/);
      if (bare) out.push({ imported: bare[1] as string, local: bare[1] as string, from });
    }
  }
  return out;
}

describe("#31 — enrichment import aliases are unique", () => {
  const src = readFileSync(ENRICHMENTS, "utf8");
  const bindings = importedBindings(src);

  it("the binding parser actually parsed the registry", () => {
    // A guard on the guard: if the regex silently matched nothing, the duplicate check below would
    // pass vacuously and this whole file would be decoration.
    expect(bindings.length).toBeGreaterThan(1000);
    expect(bindings.some((b) => b.local === "M34PlatformBaaRecordViewSchema")).toBe(true);
    expect(bindings.some((b) => b.local === "M34TenantBaaRecordViewSchema")).toBe(true);
  });

  it("no local name is bound by more than one import", () => {
    const byLocal = new Map<string, { from: string; imported: string }[]>();
    for (const b of bindings) {
      const seen = byLocal.get(b.local) ?? [];
      seen.push({ from: b.from, imported: b.imported });
      byLocal.set(b.local, seen);
    }
    const duplicates = [...byLocal.entries()]
      .filter(([, uses]) => uses.length > 1)
      .map(
        ([local, uses]) =>
          `${local} <- ${uses.map((u) => `${u.imported} from ${u.from}`).join("  AND  ")}`,
      );

    // Each duplicate silently discards one schema: the last binding wins and every route that names
    // the alias publishes it, whatever contract it was written against.
    expect(
      duplicates,
      "an enrichment alias is bound twice — one schema is being silently discarded",
    ).toEqual([]);
  });
});

describe("#31 — the two tenant-export list routes publish different contracts", () => {
  const doc = JSON.parse(readFileSync(join(ROOT, "docs/api/openapi.json"), "utf8")) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    components?: Record<string, unknown>;
  };

  function itemProps(path: string): Record<string, unknown> {
    const op = doc.paths[path]?.get as
      | { responses: Record<string, { content?: Record<string, { schema?: unknown }> }> }
      | undefined;
    if (!op) throw new Error(`route not found in openapi.json: GET ${path}`);
    const schema = op.responses["200"]?.content?.["application/json"]?.schema as
      | { properties?: { items?: { items?: { properties?: Record<string, unknown> } } } }
      | undefined;
    const props = schema?.properties?.items?.items?.properties;
    if (!props) throw new Error(`GET ${path} has no array-item properties in its 200 response`);
    return props;
  }

  const PLATFORM = "/api/v1/platform/tenant-export-jobs";
  const TENANT = "/api/v1/tenant/tenant-export-jobs";

  it("the cross-tenant platform list attributes each job to a tenant", () => {
    // Without organizationId a consumer of a list that spans every tenant cannot tell whose job a
    // row is. This is the field that makes the route's own docstring ("discloses job METADATA — org,
    // purpose, status, bundle size") true.
    expect(Object.keys(itemProps(PLATFORM))).toContain("organizationId");
  });

  it("the platform list carries the SEC-052 hold fields its `held` filter selects on", () => {
    const props = Object.keys(itemProps(PLATFORM));
    for (const field of [
      "heldForOversizedApproval",
      "heldBundleSizeBytes",
      "heldRecordCount",
      "heldAt",
      "bundleDownloadedAt",
    ]) {
      expect(props, `?held=true is filterable but ${field} is not in the response`).toContain(
        field,
      );
    }
  });

  it("the platform list types bundleSizeBytes as the bigint string it is, not a number", () => {
    const bundleSize = itemProps(PLATFORM).bundleSizeBytes as { anyOf?: { type?: string }[] };
    const types = (bundleSize.anyOf ?? []).map((t) => t.type);
    expect(types, "declared Type.String() platform-side because it is a bigint").toContain(
      "string",
    );
  });

  it("the tenant-scoped list keeps its own narrower shape", () => {
    const props = Object.keys(itemProps(TENANT));
    expect(props).toContain("createdAt");
    // A tenant sees its own jobs; org attribution and platform hold-ledger internals are not its business.
    expect(props).not.toContain("organizationId");
    expect(props).not.toContain("heldForOversizedApproval");
  });

  it("the two contracts are not the same object", () => {
    expect(Object.keys(itemProps(PLATFORM)).sort()).not.toEqual(
      Object.keys(itemProps(TENANT)).sort(),
    );
  });
});
