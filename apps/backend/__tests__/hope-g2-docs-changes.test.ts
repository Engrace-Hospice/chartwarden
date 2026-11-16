// Group g2 (HOPE docs, M10): docs/api/CHANGES.md says what the code does.
//
// CHANGES.md is read by integrators, who act on it literally. Four classes of drift kept recurring in it and no test read
// it: a lock-coverage list that still named a route the code now bounds (assemble) and that said the destruction eraser
// "takes none" (it takes its own unbounded advisory lock); error codes that did not match the classes that raise them
// (PATCH .../answers said 400 for an invalid value, which is a 422); the 422 replay advice without its POST/PUT/PATCH scope;
// and behaviour changes with no entry (the 409 on skip, the 422 for rfaKind 04_sfv, assemble's 409 M10_RECORD_BUSY, the two
// routes that raise M10_ADMISSION_PROJECTION_GAP, regenerate-schedules creating only missing windows).
// Each test reads the document and, where it can, the code the sentence describes, so either side drifting fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (repoPath: string): string => readFileSync(join(ROOT, repoPath), "utf8");
/** Markdown is hard-wrapped, so a phrase can straddle a line break: compare with whitespace collapsed. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

const M10 = "apps/backend/src/modules/10-hope";
const CHANGES = flat(read("docs/api/CHANGES.md"));
/** The newest entry only (the HOPE lock/spec/skip changes); the later entries are older notes. */
const NEWEST = CHANGES.slice(
  CHANGES.indexOf("## 2026-11-15 — HOPE: record writes wait at most 5 seconds"),
  CHANGES.indexOf("## 2026-11-15 — HOPE: a package that was never uploaded"),
);
const SIGNING_ENTRY = CHANGES.slice(
  CHANGES.indexOf("## 2026-11-15 — HOPE: signing needs an attestation"),
  CHANGES.indexOf("## 2026-11-10"),
);

/** The sentence that starts at `**Not covered**` and ends at the next sentence about the eraser. */
const notCoveredSentence = (): string => {
  const from = NEWEST.indexOf("**Not covered**");
  expect(from, "the lock-coverage note has a Not covered sentence").toBeGreaterThan(-1);
  return NEWEST.slice(from, NEWEST.indexOf("The destruction eraser", from));
};

describe("CHANGES.md: lock coverage matches the code", () => {
  it("does not list POST /hope/submissions/assemble as unbounded: the code takes a bounded advisory key first", () => {
    expect(notCoveredSentence()).not.toContain("submissions/assemble");
    const code = read(`${M10}/hope-route-service-db.ts`);
    const assemble = code.slice(code.indexOf("async assembleSubmission("));
    const firstStatement = assemble.indexOf("lockRecordKey(t, `m10:assemble:${organizationId}`");
    expect(firstStatement).toBeGreaterThan(-1);
    // before the candidate read
    expect(firstStatement).toBeLessThan(assemble.indexOf("readAssembleCandidateIds("));
    // and the document names it as a bounded route with the busy code
    expect(NEWEST).toContain("assembling a package (`POST /hope/submissions/assemble`");
    expect(NEWEST).toContain(
      "**`POST /api/v1/hope/submissions/assemble` can answer `409 M10_RECORD_BUSY`.**",
    );
  });

  it("lists only the validation-finding writes as uncovered, and the code bounds the skip, retry and regenerate waits", () => {
    const uncovered = notCoveredSentence();
    expect(uncovered).toContain("validation-finding writes");
    for (const route of [
      "POST /hope/schedules/{id}/skip",
      "POST /hope/submissions/{id}/retry",
      "POST /hope/admin/regenerate-schedules",
    ]) {
      expect(uncovered).not.toContain(route);
      // ... and the covered list names them, as the routes whose queued write is bounded.
      expect(NEWEST).toContain(route);
    }
    const code = read(`${M10}/hope-route-service-db.ts`);
    const body = (name: string, next: string): string =>
      code.slice(code.indexOf(`async ${name}(`), code.indexOf(`async ${next}(`));
    expect(body("skipSchedule", "recordTimepoint")).toContain("takeBoundedLock(");
    expect(body("retrySubmission", "assembleSubmission")).toContain("takeBoundedLock(");
    // regenerate takes its bound where it writes: the schedule insert, on the request path only.
    expect(read(`${M10}/scheduling/schedule-writer.ts`)).toMatch(
      /input\.boundLockWait\s*\?\s*takeBoundedLock\(/,
    );
    expect(body("regenerateSchedules", "loadAssessment")).toContain(
      "regenerateSchedulesForAdmission(",
    );
  });

  it("says the destruction eraser takes its own advisory lock with no timeout, never that it takes none", () => {
    expect(NEWEST).not.toMatch(/eraser takes none/i);
    expect(NEWEST).toContain(
      "The destruction eraser takes its own per-patient advisory lock with no timeout.",
    );
    const eraser = read(`${M10}/erasers/hope-eraser.ts`);
    expect(eraser).toContain("pg_advisory_xact_lock(hashtext(${patientId}))");
    expect(eraser).not.toContain("takeBoundedLock");
  });

  it("does not claim the bound covers every lock; it scopes the later-statement mapping to the transaction that set it", () => {
    expect(NEWEST).not.toMatch(/covers every lock/i);
    expect(NEWEST).toContain(
      "for the rest of the transaction that set it, so a lock timeout raised by any LATER statement of that same transaction",
    );
  });

  it("scopes the stuck-request history to the requests that needed the lock, not every request", () => {
    expect(NEWEST).not.toContain("made every other request for the record wait");
  });
});

describe("CHANGES.md: PATCH .../answers refusal codes match the classes that raise them", () => {
  const section = NEWEST.slice(NEWEST.indexOf("- `PATCH .../answers` now refuses"));
  const bullet = section.slice(0, section.indexOf("- `PUT /api/v1/hope/assessments/{id}`"));

  it("names 403 for a protected item, 404 for an unknown one and 422 (not 400) for an invalid value", () => {
    expect(bullet).toContain("protected item (`403`)");
    expect(bullet).toContain("unknown item (`404`)");
    expect(bullet).toContain("`422 VALIDATION_FAILED`");
    expect(bullet).not.toContain("`400`");
    const answers = read(`${M10}/hope-answer-service.ts`);
    expect(answers).toMatch(/class HopeProtectedItemWriteError extends ForbiddenError/);
    expect(answers).toMatch(/class HopeItemInactiveForIscError extends ValidationError/);
    expect(read(`${M10}/hope-answer-value.ts`)).toMatch(
      /class HopeInvalidAnswerValueError extends ValidationError/,
    );
  });

  it("says an item that is not applicable under the proposed answers is refused AFTER the locks, and the code orders it so", () => {
    expect(bullet).toContain("**after** the locks, on the locked row");
    expect(bullet).toContain("`HOPE_ITEM_NOT_APPLICABLE` or `HOPE_ITEM_APPLICABILITY_PENDING`");
    const answers = read(`${M10}/hope-answer-service.ts`);
    const patch = answers.slice(answers.indexOf("async patchAnswers("));
    const order = [
      "await prepareChanges(",
      "await lockTriggeredSfv(",
      "await lockDraftAtVersion(",
      "assertSetItemsApplicable(",
    ].map((needle) => patch.indexOf(needle));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("CHANGES.md: the 422 replay advice is scoped to POST/PUT/PATCH and says a GET has no key", () => {
  const REPLAY =
    "On POST, PUT and PATCH the idempotency layer replays the 422 for 24 h on the same key, so use a NEW Idempotency-Key after an operator repairs the admission projection; a GET carries no key";

  it("M10_ADMISSION_PROJECTION_GAP: names both routes that raise it and carries the pinned replay sentence", () => {
    const bullet = NEWEST.slice(
      NEWEST.indexOf("**`422 M10_ADMISSION_PROJECTION_GAP` is raised by two routes:**"),
    );
    expect(bullet).toContain("`POST /admissions/{admissionId}/hope/sfv`");
    expect(bullet).toContain("`POST /hope/admin/regenerate-schedules`");
    expect(bullet).toContain(REPLAY);
    // both routes really raise it
    expect(read(`${M10}/hope-sfv-completion-guards.ts`)).toContain("M10_ADMISSION_PROJECTION_GAP");
    expect(read(`${M10}/scheduling/schedule-writer.ts`)).toContain(
      'throw new HopeStateError("M10_ADMISSION_PROJECTION_GAP"',
    );
  });

  it("the SFV completion entry says the same, not the older 'once the admission is repaired send the request again'", () => {
    expect(SIGNING_ENTRY).toContain(
      "on POST, PUT and PATCH the idempotency layer replays the 422 for 24 h on the same key, so use a NEW Idempotency-Key after an operator repairs the admission projection; a GET carries no key",
    );
    expect(SIGNING_ENTRY).not.toContain("once the admission is");
  });

  it("M10_SPEC_NOT_IN_FORCE keeps its POST/PUT/PATCH scope and GET qualifier", () => {
    expect(NEWEST).toContain(
      "On POST, PUT and PATCH the idempotency layer replays the 422 for 24 h on the same key, so after an operator loads the spec use a NEW Idempotency-Key. A GET (`.../workspace`, `.../review`) carries no key and is never cached",
    );
  });
});

describe("CHANGES.md: behaviour changes of this work have an entry that matches the code", () => {
  it("skip: 409 CONFLICT for a schedule that is not open, with the message the code raises", () => {
    expect(NEWEST).toContain(
      "`POST /api/v1/hope/schedules/{id}/skip` skips only an `open` schedule",
    );
    expect(NEWEST).toContain("only an open schedule can be skipped");
    expect(read(`${M10}/hope-route-service-db.ts`)).toContain(
      "only an open schedule can be skipped",
    );
  });

  it("04_sfv on POST .../hope/timepoints: 422 VALIDATION_FAILED with the details code the code raises", () => {
    expect(NEWEST).toContain('`rfaKind: "04_sfv"` is now `422 VALIDATION_FAILED`');
    expect(NEWEST).toContain('`code: "M10_RFA_KIND_NOT_A_TIMEPOINT"`');
    const code = read(`${M10}/hope-route-service-db.ts`);
    expect(code).toContain('code: "M10_RFA_KIND_NOT_A_TIMEPOINT"');
  });

  it("regenerate-schedules: creates only missing windows (no 'recompute'), and the writer skips an RFA that has a row in any status", () => {
    const bullet = NEWEST.slice(
      NEWEST.indexOf("**`POST /api/v1/hope/admin/regenerate-schedules` creates only"),
    );
    expect(bullet).toContain("creates only the schedule windows an admission is missing");
    expect(bullet).toContain("nothing is recomputed, moved or reopened");
    expect(bullet).toContain("`scheduleCount` is the admission's total number of schedule rows");
    const writer = read(`${M10}/scheduling/schedule-writer.ts`);
    expect(writer).toContain("skipping any RFA that already has a schedule row on this admission");
    expect(writer).toContain(
      "const todo = input.descriptors.filter((d) => !already.has(d.rfaKind))",
    );
  });

  it("the watchdog alert note carries the per-org and process-wide caps the code defines, not the old single cap", () => {
    expect(NEWEST).not.toMatch(/Six timed-out emits still running in the process/i);
    expect(NEWEST).toContain(
      "Six timed-out emits of one organization still running stop that organization's alert emitting",
    );
    expect(NEWEST).toContain("30 across the whole process stop every organization's");
    const alerts = read(`${M10}/jobs/watchdog-alerts.ts`);
    expect(alerts).toContain("export const M10_ALERT_MAX_ABANDONED_EMITS = 6;");
    expect(alerts).toContain("export const M10_ALERT_MAX_ABANDONED_EMITS_PROCESS = 30;");
  });

  it("an 'nothing is written' claim is not made for the SFV completion refusal (no record is inserted is what the code guarantees)", () => {
    expect(SIGNING_ENTRY).not.toContain("nothing is written and the SFV stays open");
    expect(SIGNING_ENTRY).toContain("no record is inserted and the SFV stays open");
  });

  it("the deadline-override audit note says the typed justification is kept and screened, never that it is dropped", () => {
    expect(NEWEST).toContain(
      "It still carries the typed justification text (`context.justification`, trimmed)",
    );
    expect(NEWEST).toContain("screened for patient identifiers");
    expect(NEWEST).not.toContain("`justificationSupplied`");
    expect(NEWEST).not.toContain("no longer carries the typed justification");
  });
});

describe("CHANGES.md: the pinned M10_RECORD_BUSY message is quoted verbatim", () => {
  const BUSY_MESSAGE =
    "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again.";

  it("every quote of the message is the exact message, and the code raises the same text", () => {
    const quotes = CHANGES.split("The record is busy").length - 1;
    expect(quotes).toBeGreaterThan(0);
    expect(CHANGES.split(BUSY_MESSAGE).length - 1).toBe(quotes);
    expect(flat(read(`${M10}/hope-assessment-lock.ts`))).toContain(BUSY_MESSAGE);
  });
});
