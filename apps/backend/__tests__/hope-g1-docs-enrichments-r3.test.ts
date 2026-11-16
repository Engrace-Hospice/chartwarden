// Group g1, round 3 (HOPE docs and OpenAPI summaries, M10): the summaries of the two routes whose old text promised
// behaviour the code does not have, and the BUSINESS_LOGIC.md sentences about idempotency.
//
//   · `POST /hope/admin/regenerate-schedules` was summarised as "recompute schedules"; the code only creates the windows an
//     admission is missing (schedule-writer.ts skips an RFA that already has a row in ANY status).
//   · `POST /hope/submissions/assemble` was summarised as "outside the cron cadence"; no assemble cron runs, the route is the
//     only assemble path, and it takes a bounded advisory lock first, so it can answer 409 M10_RECORD_BUSY.
//
// Reads the registry itself (not the emitted openapi.json, which is regenerated centrally). The cross-document check reads
// the sibling-owned spec and CHANGES.md read-only: it pins the busy message, it does not edit them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_ENRICHMENTS } from "../../../scripts/openapi/enrichments";

const BUSY_MESSAGE =
  "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again.";
const NEW_KEY = "NEW Idempotency-Key";
const REGENERATE = "POST /api/v1/hope/admin/regenerate-schedules";
const ASSEMBLE = "POST /api/v1/hope/submissions/assemble";

const summaryOf = (route: string): string => {
  const summary = ROUTE_ENRICHMENTS[route]?.summary;
  if (!summary) throw new Error(`no summary registered for ${route}`);
  return summary;
};
/** Markdown is hard-wrapped, so a phrase can straddle a line break: compare with whitespace collapsed. */
const docText = (repoPath: string): string =>
  readFileSync(join(process.cwd(), repoPath), "utf8").replace(/\s+/g, " ");

describe("regenerate-schedules summary: it creates missing windows, it does not recompute", () => {
  it("says it creates only the missing windows and leaves existing rows, in any status, untouched", () => {
    const summary = summaryOf(REGENERATE);
    expect(summary).toContain("create any missing HOPE schedule windows");
    expect(summary).toContain("existing rows, in any status, are left untouched");
    expect(summary).toContain("nothing is recomputed or reopened");
    expect(summary).toContain("returns the admission's schedule count");
  });

  it("no longer opens with 'recompute schedules'", () => {
    expect(summaryOf(REGENERATE)).not.toMatch(/recompute schedules/i);
  });

  it("keeps the projection-gap refusal with the same-key replay note and a NEW Idempotency-Key", () => {
    const summary = summaryOf(REGENERATE);
    expect(summary).toContain("422 M10_ADMISSION_PROJECTION_GAP");
    expect(summary).toContain("replays the 422 for 24 h on the same key");
    expect(summary).toContain(NEW_KEY);
  });
});

describe("assemble summary: the only assemble path, no cron, and a bounded lock", () => {
  it("says no cron runs it and no longer implies a cron cadence", () => {
    const summary = summaryOf(ASSEMBLE);
    expect(summary).toContain("the only assemble path; no cron runs it");
    expect(summary).not.toMatch(/outside the cron cadence/i);
    expect(summary).not.toMatch(/force-assemble/i);
  });

  it("names the refusals the route answers: 409 when nothing is eligible, 422 when the package cannot be built", () => {
    const summary = summaryOf(ASSEMBLE);
    expect(summary).toContain("409 CONFLICT when no signed assessment is eligible");
    expect(summary).toContain(
      "422 when the submission header or an assessment payload cannot be built",
    );
  });

  it("carries the pinned M10_RECORD_BUSY wording, scoped to a POST (the key is released)", () => {
    const summary = summaryOf(ASSEMBLE);
    expect(summary).toContain("409 M10_RECORD_BUSY");
    expect(summary).toContain(BUSY_MESSAGE);
    expect(summary).toContain("The same Idempotency-Key may be reused because the key is released");
  });

  it("is counted among the bounded-lock M10 routes (the guard in hope-g1-docs-enrichments.test.ts is 14 without it)", () => {
    const busy = Object.entries(ROUTE_ENRICHMENTS)
      .filter(([route]) => /\/hope(\/|$)/.test(route) && !route.includes("/portal/"))
      .filter(([, enrichment]) => enrichment.summary?.includes("M10_RECORD_BUSY"))
      .map(([route]) => route);
    expect(busy).toContain(ASSEMBLE);
    expect(busy.length).toBeGreaterThanOrEqual(15);
  });
});

describe("retry summary: a requeue only, nothing consumes it", () => {
  it("says it flips rejected to queued and neither re-validates nor re-assembles", () => {
    const summary = summaryOf("POST /api/v1/hope/submissions/:id/retry");
    expect(summary).toContain("status rejected to queued; nothing consumes queued");
    expect(summary).toContain("neither re-validates nor re-assembles");
  });
});

describe("the pinned busy message is identical in every document that quotes it", () => {
  // The code message (`assessmentLockTimeout`), spec 4.4 and CHANGES.md must be word-for-word the OpenAPI summaries' text.
  it.each([
    "docs/modules/CHARTWARDEN_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md",
    "docs/api/CHANGES.md",
    "docs/BUSINESS_LOGIC.md",
  ])("%s never quotes a changed version of the message", (repoPath) => {
    const text = docText(repoPath);
    const quotes = text.split("The record is busy").length - 1;
    const verbatim = text.split(BUSY_MESSAGE).length - 1;
    expect(verbatim).toBe(quotes);
  });
});

describe("docs/BUSINESS_LOGIC.md: idempotency sentences are scoped to the methods that carry a key", () => {
  const doc = docText("docs/BUSINESS_LOGIC.md");

  it("says the idempotency layer guards mutating methods only and a GET is never claimed or cached", () => {
    expect(doc).toContain(
      "It guards mutating methods only: a GET or HEAD carries no key and is never claimed or cached.",
    );
  });

  it("says a retryable failure is released only when nothing committed, else replayed and the retry needs a NEW key", () => {
    expect(doc).toContain(
      "`409 M10_RECORD_BUSY`) is released instead of cached when nothing of the request had committed",
    );
    expect(doc).toContain(
      "once something had committed it is replayed and the retry needs a NEW key",
    );
  });

  it("M10 section: the 422 replay advice is scoped to POST/PUT/PATCH and says a GET carries no key", () => {
    const m10 = doc.slice(doc.indexOf("### M10 — HOPE Engine"), doc.indexOf("### M11 — Orders"));
    expect(m10).toContain(
      "On POST, PUT and PATCH the idempotency layer replays such a 422 for 24 h on the same key",
    );
    expect(m10).toContain(
      "use a NEW `Idempotency-Key` after an operator fixes the cause; a GET carries no key",
    );
  });

  it("M10 section: regenerate-schedules only creates missing windows and assemble has no cron", () => {
    const m10 = doc.slice(doc.indexOf("### M10 — HOPE Engine"), doc.indexOf("### M11 — Orders"));
    expect(m10).toContain("only creates the windows an admission is missing");
    expect(m10).toContain("not recomputed or reopened");
    expect(m10).toContain("no cron runs it");
    expect(m10).toContain(
      "Only an `open` schedule can be skipped (any other status is `409 CONFLICT`)",
    );
  });
});
