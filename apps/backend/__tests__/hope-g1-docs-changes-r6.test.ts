// Group g1, round 6 (HOPE docs, M10): CHANGES.md must not narrate a past that never shipped, and must carry assemble's contract.
//
// CHANGES.md is written for an integrator on the PREVIOUS release. Round 5 removed one sentence that described an earlier state of
// code that is new in the same entry; its siblings were still there: "(it used to lock on every open)" (the workspace open took no
// lock on the previous release), "only sooner" (sooner than a lock wait that never shipped), "Before, a stuck request made the other
// requests ... wait without limit" (the record locks themselves are new; only two submission-batch locks existed), and "mark-uploaded
// and results used to answer a generic 409" for a cancelled batch (no cancelled batch could exist before migration 1495).
// Reads the document and the code each replacement sentence describes, so either side drifting fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (repoPath: string): string => readFileSync(join(process.cwd(), repoPath), "utf8");
/** Markdown is hard-wrapped, so a phrase can straddle a line break: compare with whitespace collapsed. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

const M10 = "apps/backend/src/modules/10-hope";
const CHANGES = flat(read("docs/api/CHANGES.md"));
const NEWEST = CHANGES.slice(
  CHANGES.indexOf("## 2026-11-15 — HOPE: record writes wait at most 5 seconds"),
  CHANGES.indexOf("## 2026-11-15 — HOPE: a package that was never uploaded"),
);
const CANCEL_ENTRY = CHANGES.slice(
  CHANGES.indexOf("## 2026-11-15 — HOPE: a package that was never uploaded"),
  CHANGES.indexOf("## 2026-11-15 — HOPE: signing needs an attestation"),
);

describe("CHANGES.md: no sentence describes an earlier state of new code", () => {
  it("has the entries under test", () => {
    expect(NEWEST.length).toBeGreaterThan(0);
    expect(CANCEL_ENTRY.length).toBeGreaterThan(0);
  });

  it("does not say the record locks used to be unbounded or taken on every workspace open", () => {
    expect(NEWEST).not.toMatch(/Before, a stuck request/i);
    expect(NEWEST).not.toMatch(/instead of queueing until the other request finishes/i);
    expect(NEWEST).not.toMatch(/it used to lock on every open/i);
    expect(NEWEST).not.toMatch(/only sooner/i);
  });

  it("says the record locks are new in this release, and which two locks already existed", () => {
    expect(NEWEST).toContain("Most of these locks are new in this release");
    expect(NEWEST).toContain(
      "until now only `mark-uploaded` and recording a CMS result locked a submission batch row (with no bound)",
    );
    // those two are the submission-batch row locks the code still takes (now bounded)
    const db = read(`${M10}/hope-route-service-db.ts`);
    for (const method of ["markSubmissionUploaded", "importSubmissionResult"]) {
      const from = db.indexOf(`async ${method}(`);
      expect(from, `${method} exists`).toBeGreaterThan(-1);
      expect(db.slice(from, from + 1500)).toContain('.for("update")');
    }
  });

  it("does not say a cancelled batch used to answer a generic 409 (none could exist before)", () => {
    expect(CANCEL_ENTRY).not.toMatch(/used to answer a generic/i);
    expect(CANCEL_ENTRY).toContain("are all `409 M10_SUBMISSION_CANCELLED`");
  });
});

describe("CHANGES.md: the workspace-open lock sentence matches the code", () => {
  it("says the lock is taken only when something has to be written", () => {
    expect(NEWEST).toContain(
      "`GET .../workspace` takes the record's lock only when something has to be written (the chart prefill or the control answers are out of date)",
    );
  });

  it("the chart prefill and the control reconcile read unlocked and return before the lock when nothing is pending", () => {
    const prefill = read(`${M10}/hope-admission-prefill-service.ts`);
    const unlockedRead = prefill.indexOf(
      "pendingOf(await answersByItem(tx, assessment.id, itemList)).length === 0",
    );
    expect(unlockedRead).toBeGreaterThan(-1);
    expect(unlockedRead).toBeLessThan(
      prefill.indexOf("await lockAssessmentRow(tx, organizationId, assessment.id)"),
    );

    const answers = read(`${M10}/hope-answer-service.ts`);
    const reconcile = answers.slice(answers.indexOf("async function reconcileControlsWhenNeeded("));
    const early = reconcile.indexOf(
      "(await outOfDateControls(tx, assessment, itemsByCode)).length === 0) return",
    );
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(
      reconcile.indexOf("await lockAssessmentRow(tx, organizationId, assessment.id)"),
    );
  });
});

describe("CHANGES.md: PATCH .../answers refusals before the locks do not claim a history", () => {
  it("says the codes are the ones the route already answered", () => {
    expect(NEWEST).toContain(
      "the codes are the ones this route already answered; no lock wait comes first",
    );
  });
});

describe("CHANGES.md: assemble's contract is complete", () => {
  const bullet = NEWEST.slice(
    NEWEST.indexOf("- **`POST /api/v1/hope/submissions/assemble` can answer"),
  );
  const assemble = bullet.slice(
    0,
    bullet.indexOf("- **`POST /api/v1/hope/admin/regenerate-schedules`"),
  );

  it("names the 409 M10_RECORD_BUSY, the ordinary 409 when nothing is eligible, and the unchanged 422", () => {
    expect(assemble).toContain("`409 M10_RECORD_BUSY`");
    expect(assemble).toContain(
      "No signed HOPE assessments are eligible for iQIES package generation",
    );
    expect(assemble).toContain(
      "The other refusals are unchanged: `422` when the submission header or an assessment's payload cannot be built (the message names what to set)",
    );
  });

  it("matches the code: the 422 is a ValidationError raised from the payload error, the 409 is a ConflictError", () => {
    const db = read(`${M10}/hope-route-service-db.ts`);
    const body = db.slice(db.indexOf("async assembleSubmission("));
    expect(body).toMatch(
      /error instanceof HopeSubmissionPayloadError\)\s*\{\s*throw new ValidationError\(error\.message/,
    );
    expect(body).toMatch(
      /throw new ConflictError\(\s*"No signed HOPE assessments are eligible for iQIES package generation"/,
    );
  });

  it("does not list assemble among the routes that take no bounded lock", () => {
    const from = NEWEST.indexOf("**Not covered**");
    const uncovered = NEWEST.slice(from, NEWEST.indexOf("The destruction eraser", from));
    expect(uncovered).not.toContain("assemble");
  });
});
