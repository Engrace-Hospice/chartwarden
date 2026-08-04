// apps/backend/__tests__/m30-response-dto-conformance.test.ts — every M30 read publishes a typed body.
//
// The DTO↔view CONFORMANCE check (does the published shape match what `read-service.ts` returns?) is
// compile-time and lives at the bottom of `quality-typebox.ts`, deliberately: `apps/backend` type-checks
// `src` only (`tsconfig.json` → `"include": ["src"]`) and vitest transpiles without type-checking, so the
// same assertions in this file would be checked NOWHERE and rot silently.
//
// What that leaves uncovered is COVERAGE — a new M30 GET added later, with no enrichment entry, publishes
// a bare 200 and the generated client types its body `never`. Nothing else fails: `openapi:check` verifies
// the document is FRESH, not that it is complete. That is exactly how all 24 M30 reads shipped untyped in
// the first place. This test closes that hole for M30 by reading the emitted document.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface OpenApiDoc {
  readonly paths: Record<
    string,
    Record<string, { responses?: Record<string, { content?: unknown }> }>
  >;
}

const doc = JSON.parse(
  readFileSync(join(process.cwd(), "docs/api/openapi.json"), "utf8"),
) as OpenApiDoc;

/** Every M30 GET operation in the emitted document, with whether it publishes a typed 2xx body. */
function m30Reads(): { path: string; typed: boolean }[] {
  return Object.entries(doc.paths)
    .filter(([path]) => path.includes("/api/v1/quality/"))
    .flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([method]) => method === "get")
        .map(([, op]) => ({
          path,
          typed: Object.entries(op.responses ?? {}).some(
            ([code, res]) => code.startsWith("2") && res.content !== undefined,
          ),
        })),
    );
}

describe("M30 §4.1 reads publish typed response bodies", () => {
  it("every quality GET has a 2xx body schema — none types its response as `never`", () => {
    const untyped = m30Reads()
      .filter((r) => !r.typed)
      .map((r) => r.path);
    // A failure here names the route that needs a `response:` in scripts/openapi/enrichments.ts,
    // and a DTO in quality-typebox.ts mirroring its read-service view.
    expect(untyped).toEqual([]);
  });

  it("covers the whole surface, so the assertion above cannot pass vacuously", () => {
    // If a refactor moved the M30 routes off `/api/v1/quality/`, the filter would match nothing and
    // the emptiness check above would silently succeed against zero routes.
    expect(m30Reads().length).toBeGreaterThanOrEqual(24);
  });
});
