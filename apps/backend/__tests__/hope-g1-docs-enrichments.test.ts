// Group g1 (HOPE docs and OpenAPI summaries, M10): the OpenAPI summaries and BUSINESS_LOGIC.md say what the code does.
//
// The M10 summaries in scripts/openapi/enrichments.ts are the only place an integrator reading the generated OpenAPI
// learns a refusal exists, and the wording of three of them is pinned (the busy message, and the "use a NEW
// Idempotency-Key" advice for the two 422 codes the idempotency layer replays). This reads the registry itself (not the
// emitted openapi.json, which is regenerated centrally) so a summary that drifts from the code fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOPE_SCHEDULE_SKIP_REASON_CODES } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { ROUTE_ENRICHMENTS } from "../../../scripts/openapi/enrichments";

/** The exact text the code (`assessmentLockTimeout`), spec 4.4, CHANGES.md and the OpenAPI summaries all carry. */
const BUSY_MESSAGE =
  "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again.";
const NEW_KEY = "NEW Idempotency-Key";

const HOPE_ROUTE = /\/hope(\/|$)/;
const m10Routes = Object.entries(ROUTE_ENRICHMENTS).filter(
  ([route]) => HOPE_ROUTE.test(route) && !route.includes("/portal/"),
);
const summaryOf = (route: string): string => {
  const summary = ROUTE_ENRICHMENTS[route]?.summary;
  if (!summary) throw new Error(`no summary registered for ${route}`);
  return summary;
};
const isGet = (route: string): boolean => route.startsWith("GET ");

describe("M10 OpenAPI summaries: the pinned M10_RECORD_BUSY wording", () => {
  const busy = m10Routes.filter(([, e]) => e.summary?.includes("M10_RECORD_BUSY"));

  it("covers the routes that take a bounded lock (a guard against the filter matching nothing)", () => {
    expect(busy.length).toBeGreaterThanOrEqual(14);
  });

  it.each(busy)("%s carries the busy message verbatim", (_route, enrichment) => {
    expect(enrichment.summary).toContain(BUSY_MESSAGE);
  });

  it.each(busy.filter(([route]) => !isGet(route)))(
    "%s (POST/PUT/PATCH) says the same Idempotency-Key may be reused because the key is released",
    (_route, enrichment) => {
      expect(enrichment.summary).toContain(
        "The same Idempotency-Key may be reused because the key is released",
      );
    },
  );

  it.each(busy.filter(([route]) => isGet(route)))(
    "%s (a GET) carries no key sentence: a GET is never claimed or cached, so it is simply sent again",
    (_route, enrichment) => {
      expect(enrichment.summary).not.toContain("may be reused");
      expect(enrichment.summary).not.toContain(NEW_KEY);
      expect(enrichment.summary).toContain("A GET is never claimed or cached");
    },
  );
});

describe("M10 OpenAPI summaries: the 422s the idempotency layer replays", () => {
  const specGate = m10Routes.filter(([, e]) => e.summary?.includes("M10_SPEC_NOT_IN_FORCE"));

  it("names M10_SPEC_NOT_IN_FORCE on the POST routes and on both GET reads", () => {
    expect(specGate.map(([route]) => route).sort()).toEqual(
      [
        "GET /api/v1/hope/assessments/:id/review",
        "GET /api/v1/hope/assessments/:id/workspace",
        "POST /api/v1/admissions/:admissionId/hope/sfv",
        "POST /api/v1/admissions/:admissionId/hope/timepoints",
        "POST /api/v1/hope/assessments/:id/sign",
      ].sort(),
    );
  });

  it.each(specGate.filter(([route]) => !isGet(route)))(
    "%s (POST) tells the client to use a NEW Idempotency-Key after an operator loads the spec",
    (_route, enrichment) => {
      expect(enrichment.summary).toContain("replays the 422 for 24 h on the same key");
      expect(enrichment.summary).toContain(NEW_KEY);
    },
  );

  it.each(specGate.filter(([route]) => isGet(route)))(
    "%s (a GET) does not tell the client to mint a key: a GET has none and a retry just works",
    (_route, enrichment) => {
      expect(enrichment.summary).not.toContain(NEW_KEY);
      expect(enrichment.summary).toContain("a GET is never cached");
    },
  );

  it.each([
    "POST /api/v1/admissions/:admissionId/hope/sfv",
    "POST /api/v1/hope/admin/regenerate-schedules",
  ])(
    "%s names M10_ADMISSION_PROJECTION_GAP with the replay note and a NEW Idempotency-Key",
    (route) => {
      const summary = summaryOf(route);
      expect(summary).toContain("422 M10_ADMISSION_PROJECTION_GAP");
      expect(summary).toContain("replays the 422 for 24 h on the same key");
      expect(summary).toContain(NEW_KEY);
    },
  );
});

describe("M10 OpenAPI summaries: refusals added to existing routes", () => {
  it("POST /hope/schedules/{id}/skip documents the 409 for a schedule that is not open", () => {
    const summary = summaryOf("POST /api/v1/hope/schedules/:id/skip");
    expect(summary).toContain("409 CONFLICT");
    expect(summary).toContain("only an open schedule can be skipped");
    for (const status of ["completed", "expired", "skipped"]) expect(summary).toContain(status);
  });

  it("POST .../hope/timepoints documents the 422 for rfaKind 04_sfv and points at the SFV route", () => {
    const summary = summaryOf("POST /api/v1/admissions/:admissionId/hope/timepoints");
    expect(summary).toContain("04_sfv");
    expect(summary).toContain("M10_RFA_KIND_NOT_A_TIMEPOINT");
    expect(summary).toContain("POST /admissions/{admissionId}/hope/sfv");
  });

  it("the skip, retry and regenerate summaries name the bounded wait (409 M10_RECORD_BUSY), as the code takes it", () => {
    for (const route of [
      "POST /api/v1/hope/schedules/:id/skip",
      "POST /api/v1/hope/submissions/:id/retry",
      "POST /api/v1/hope/admin/regenerate-schedules",
    ]) {
      expect(summaryOf(route), route).toContain("M10_RECORD_BUSY");
    }
  });

  it("the skip summary names the closed reason list and that a note is refused", () => {
    const summary = summaryOf("POST /api/v1/hope/schedules/:id/skip");
    for (const code of HOPE_SCHEDULE_SKIP_REASON_CODES) expect(summary).toContain(code);
    expect(summary).toContain("a note included");
  });

  it.each([
    "POST /api/v1/hope/schedules/:id/skip",
    "POST /api/v1/hope/submissions/:id/retry",
    "POST /api/v1/hope/submissions/assemble",
    "POST /api/v1/hope/submissions/:id/mark-uploaded",
    "POST /api/v1/hope/submissions/:id/cancel",
    "POST /api/v1/hope/submissions/:id/results",
    "POST /api/v1/hope/admin/regenerate-schedules",
  ])("%s documents that an AI principal is refused (403)", (route) => {
    expect(summaryOf(route)).toContain("AI principals refused (403)");
  });
});

describe("docs/BUSINESS_LOGIC.md: the late-deadline grace", () => {
  const doc = readFileSync(join(process.cwd(), "docs/BUSINESS_LOGIC.md"), "utf8");
  // Only the M10 section: a failure then prints a paragraph, not the whole document.
  // Whitespace collapsed: the markdown is hard-wrapped, so a phrase can straddle a line break.
  const section = doc
    .slice(doc.indexOf("### M10 — HOPE Engine"), doc.indexOf("### M11 — Orders"))
    .replace(/\s+/g, " ");

  it("does not call the 7-day grace configurable: no caller passes graceDays and no tenant setting exists", () => {
    expect(section).not.toMatch(/configurable grace/i);
    expect(section).toContain("fixed 7-day grace");
    expect(section).toContain("no tenant setting feeds it");
  });
});
