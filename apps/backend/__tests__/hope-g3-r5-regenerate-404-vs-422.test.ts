// Group g3, round 5 (HOPE docs and OpenAPI summaries, M10): `POST /hope/admin/regenerate-schedules` answers 404 for an
// admission the caller cannot see (absent, another organization's, or a failing M6 seam), because the `hope.scope` guard runs
// before the service; only a VISIBLE admission that is not sited (no provider entity or location) is the 422
// M10_ADMISSION_PROJECTION_GAP. The summary used to say "not visible in this organization" was a 422.
//
// Reads the route and predicate source as text, so the doc claim is tied to the code it describes (it fails if either the
// guard is unbound from the route or the predicate stops failing closed). The summary is read from the registry itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_ENRICHMENTS } from "../../../scripts/openapi/enrichments";

const REGENERATE = "POST /api/v1/hope/admin/regenerate-schedules";
const HOPE = "apps/backend/src/modules/10-hope";
const source = (repoPath: string): string => readFileSync(join(process.cwd(), repoPath), "utf8");

const summary = (): string => {
  const text = ROUTE_ENRICHMENTS[REGENERATE]?.summary;
  if (!text) throw new Error(`no summary registered for ${REGENERATE}`);
  return text;
};

describe("regenerate-schedules: 404 from the scope guard vs 422 for a visible, unsited admission", () => {
  it("says an admission the caller cannot see answers 404 before anything is written", () => {
    const text = summary();
    expect(text).toContain(
      "an admission the caller cannot see (absent here, or another organization's) answers 404",
    );
    expect(text).toContain("from the scope guard before anything is written");
  });

  it("puts the 422 M10_ADMISSION_PROJECTION_GAP on a visible admission that is not sited, not on a 'not visible' one", () => {
    const text = summary();
    expect(text).not.toContain("not visible in this organization");
    expect(text).toMatch(
      /visible but not sited \(no provider entity or location\) is 422 M10_ADMISSION_PROJECTION_GAP/,
    );
    // The replay and NEW-key sentences stay on the 422 only (the 404 is not replayed as a projection gap).
    expect(text).toContain("use a NEW Idempotency-Key");
    expect(text.indexOf("answers 404")).toBeLessThan(text.indexOf("M10_ADMISSION_PROJECTION_GAP"));
  });

  it("the route binds hope.scope with notFoundOnDeny on the body's admissionId, ahead of the service", () => {
    const routes = source(`${HOPE}/routes/hope-routes.ts`);
    expect(routes).toMatch(
      /const SCOPE_BODY_ADMISSION = [\s\S]*?"hope\.scope", \{\s*notFoundOnDeny: true,[\s\S]*?admissionId: \(request\.body/,
    );
    expect(routes).toMatch(
      /preHandler: \[\s*ADMIN_REGEN,\s*REJECT_AI_OPERATIONS,\s*SCOPE_BODY_ADMISSION\("hope\.admin\.regenerate_schedules"\),?\s*\]/,
    );
  });

  it("the scope predicate denies (so the route answers 404) when the admission cannot be resolved", () => {
    const predicates = source(`${HOPE}/abac-predicates.ts`);
    expect(predicates).toMatch(
      /const facts = await resolveAdmissionPatient\(context\.organizationId, admissionId\);\s*if \(!facts\) return false;/,
    );
    expect(predicates).toContain("if (summary.organizationId !== organizationId) return null;");
  });
});
