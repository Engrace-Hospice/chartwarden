// Group g2 (HOPE docs, M10), round 6: the module spec says what the code does. Each test reads a spec statement and the
// code it describes, so it fails if the spec text is put back to the earlier wording or if the code changes so that the
// new wording becomes untrue. Classes: built-vs-unbuilt (idempotency tuple, alerting, MinIO storage, the delivery
// list), overclaim ("nothing is written", "never awaits an external call", "a warning finding is written"), and
// docs-omit-behaviour-change (the PATCH answers statuses, the supersede trigger, the permission key and routes of D2/D9/D12).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LATE_COMPLETION_REASON_CODES } from "@chartwarden/hope";
import { describe, expect, it } from "vitest";
import { PatchAnswersSchema, parse } from "../src/modules/10-hope/routes/hope-typebox";
import { createHopeSubmissionProvider } from "../src/modules/10-hope/seams/providers";

const ROOT = process.cwd();
const SPEC = readFileSync(
  join(ROOT, "docs/modules/CHARTWARDEN_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md"),
  "utf8",
);
const M10_SRC = "apps/backend/src/modules/10-hope";
const read = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

/** The spec text from `start` up to `end`; a renamed heading fails loudly rather than matching nothing. */
function between(start: string, end: string): string {
  const from = SPEC.indexOf(start);
  const to = SPEC.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`spec heading not found: ${from < 0 ? start : end}`);
  return SPEC.slice(from, to);
}

/** The one line of `block` that starts with `prefix`. */
function line(block: string, prefix: string): string {
  const found = block.split("\n").filter((text) => text.startsWith(prefix));
  if (found.length !== 1) throw new Error(`expected one line for ${prefix}, found ${found.length}`);
  return found[0] as string;
}

/** The code text from `start` up to `end` (an anchor that moved fails loudly). */
function slice(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  const to = code.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`code anchor not found: ${from < 0 ? start : end}`);
  return code.slice(from, to);
}

/** The text of every non-test .ts file under `dir`. */
function sourcesUnder(dir: string): string {
  const out: string[] = [];
  const walk = (absolute: string): void => {
    for (const name of readdirSync(absolute)) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      const path = join(absolute, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts"))
        out.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(ROOT, dir));
  return out.join("\n");
}

const ROUTES = between("### 4.1 Route Inventory", "#### 4.1.1");
const LOCKS = between("#### 4.1.1", "### 4.2 Webhooks");
const ERRORS = between("### 4.4 Error Codes", "### 4.5 Socket.IO");
const DECISIONS = between("## 11. Resolved Decisions", "## 12. Acceptance Sign-Off Checklist");
const CHECKLIST = SPEC.slice(SPEC.indexOf("## 12. Acceptance Sign-Off Checklist"));
const decision = (id: string): string => line(DECISIONS, `| ${id} |`);

describe("spec 4.1 PATCH .../answers: a body that fails the route schema is 422 INVALID, an empty list included", () => {
  it("the route parses the body with parse(), which answers 422 VALIDATION_FAILED / INVALID (no framework 400)", () => {
    const answers = line(ROUTES, "| `PATCH` | `/hope/assessments/:id/answers`");
    const failing = [{ ifVersion: 1, changes: [] }, { ifVersion: 0, changes: [] }, { changes: [] }];
    for (const body of failing) {
      let caught: unknown;
      try {
        parse(PatchAnswersSchema, body);
      } catch (error) {
        caught = error;
      }
      const error = caught as { statusCode?: number; code?: string; details?: { code?: string }[] };
      expect([error.statusCode, error.code, error.details?.[0]?.code]).toEqual([
        422,
        "VALIDATION_FAILED",
        "INVALID",
      ]);
    }
    const routes = read(`${M10_SRC}/routes/hope-routes.ts`);
    const patchRoute = slice(routes, '"/api/v1/hope/assessments/:id/answers"', "async (request)");
    expect(patchRoute).not.toMatch(/schema\s*:/);
    expect(answers).toContain("`422 VALIDATION_FAILED` from the route's `parse()`");
    expect(answers).toContain("details code `INVALID`");
    expect(answers).toContain("there is no framework `400`");
    expect(answers).toContain(
      "`HOPE_EMPTY_ANSWER_PATCH` is reachable only by a direct service call",
    );
  });
});

describe("spec 1.1: the double-batching guard is the one the code has; the idempotency tuple is a design", () => {
  it("names the partial unique index and assemble's skip statuses, and drops 'a retry never double-submits'", () => {
    const submission = line(SPEC, "- **iQIES submission as a separately-tiered subsystem.**");
    expect(submission).toContain("`uniq_hope_sub_item_assessment_active`");
    expect(submission).not.toContain("a retry never double-submits");
    expect(submission).not.toMatch(/Idempotent on `\(provider_entity_id/);
    expect(submission).toContain("is a design only");
    expect(read("packages/db/migrations/0034_hope_m10_tables.sql")).toMatch(
      /CREATE UNIQUE INDEX "uniq_hope_sub_item_assessment_active"[^;]*WHERE item_status = 'pending'/,
    );
    const assemble = slice(
      read(`${M10_SRC}/hope-route-service-db.ts`),
      "async assembleSubmission(",
      "const eligible = await lockPackageableRecords",
    );
    expect(assemble).toContain("readAssembleCandidateIds(");
    // The manual route (its candidate read, hope-assemble-candidates.ts) and the cron scan share one list
    // (jobs/assemble-store.ts); the spec names each of its statuses.
    expect(read(`${M10_SRC}/hope-assemble-candidates.ts`)).toContain(
      "ASSEMBLE_BLOCKING_ITEM_STATUSES",
    );
    const sharedList = slice(
      read(`${M10_SRC}/jobs/assemble-store.ts`),
      "export const ASSEMBLE_BLOCKING_ITEM_STATUSES",
      "] as const",
    );
    for (const status of ["pending", "accepted", "accepted_with_warnings", "rejected"]) {
      expect(sharedList, status).toContain(`"${status}"`);
      expect(submission, status).toContain(`\`${status}\``);
    }
    expect(read("packages/db/migrations/0034_hope_m10_tables.sql")).not.toMatch(
      /UNIQUE[^;\n]*submission_period/i,
    );
  });

  it("the replay row and the delivery list agree: the tuple is design only", () => {
    expect(line(between("### 8.5 STRIDE", "## 9. Test Plan"), "| **Replay**")).toContain(
      "*(Design only: not built)* idempotency on `(provider_entity_id, submission_period, hope_assessment_id)`",
    );
    expect(between("## 10. Implementation Tasks", "| # | Task |")).toContain(
      "the idempotency tuple of row 15 is a design only",
    );
  });
});

describe("spec 1.1 / 4.9 / 7.10: alerting is described as built only where it exists", () => {
  it("§1.1 says the SFV row carries an empty cadence nothing consumes, and names the only alerts", () => {
    const alerting = line(SPEC, "- **Alerting (design; as built a minimum).**");
    expect(alerting).toContain("an SFV row with an empty one (`{}`)");
    expect(alerting).toContain("`hope-alert-dispatcher` has no Worker");
    expect(alerting).toContain("There is no SFV reminder cadence and no submission-deadline alert");
    expect(SPEC).not.toContain(
      "Each `symptom_follow_up_visit` row carries a typed `alert_cadence`",
    );
    expect(read(`${M10_SRC}/hope-sfv-service.ts`)).toContain("alertCadence: {}");
    const workers = read(`${M10_SRC}/jobs/cron-workers.ts`);
    const registered = slice(
      workers,
      "export function registerM10CronWorkers",
      "export async function runSubmissionJob",
    );
    expect(registered).not.toContain("M10_QUEUES.alerts");
  });

  it("no code outside tests calls the submission-deadline or iQIES-rejection alert builders", () => {
    const callers = ["apps", "packages", "scripts"]
      .map(sourcesUnder)
      .join("\n")
      .split("\n")
      .filter((text) => /build(SubmissionDeadline|IqiesRejection)Alert\(/.test(text))
      .filter((text) => !/^\s*export function /.test(text));
    expect(callers).toEqual([]);
    const note = between("### 4.9 M36 Typed Alert Payload", "#### 4.9.1");
    expect(note).toContain("**not built**");
    expect(note).toContain("`buildSubmissionDeadlineAlert` and `buildIqiesRejectionAlert`");
  });

  it("§7.10 no longer says the Compliance-Officer alert fires", () => {
    const text = between("### 7.10", "### 7.11");
    expect(text).not.toContain("the Compliance-Officer alert fires as that deadline nears");
    expect(text).toContain("**Not built (design only):** a Compliance-Officer alert");
  });
});

describe("spec 4.4 M10_SFV_COMPLETION_INCOMPLETE: no record is inserted, and the check runs before the insert", () => {
  it("the row says 'no record is inserted', not 'nothing is written'", () => {
    const text = line(ERRORS, "| `M10_SFV_COMPLETION_INCOMPLETE`");
    expect(text).toContain("no record is inserted and the SFV stays open");
    expect(text).not.toContain("nothing is written");
    const record = slice(
      read(`${M10_SRC}/hope-sfv-completion-record.ts`),
      "async function completeSfvInTx(",
      "return deps.toView(row)",
    );
    expect(record.indexOf("await guardedSfv(")).toBeGreaterThan(-1);
    expect(record.indexOf("await guardedSfv(")).toBeLessThan(
      record.indexOf("await insertSignedSfvAssessment("),
    );
  });
});

describe("spec 4.10.1: the MinIO storage and adapter resilience are marked design only where they are described", () => {
  it("carries its own banner, and no non-test app code uses the breaker, key builder or object-lock constants", () => {
    const head = between("#### 4.10.1", "**Circuit-breaker configuration");
    expect(head).toContain("**Design only: not built (adapter resilience and MinIO storage).**");
    expect(head).toContain("`createUnboundIqiesAdapter`");
    const app = sourcesUnder("apps");
    for (const name of [
      "buildEnvelopeStorageUri",
      "IQIES_ENVELOPE_OBJECT_LOCK",
      "IQIES_CIRCUIT_BREAKER_CONFIG",
      "evaluateBreaker",
    ]) {
      expect(app, name).not.toContain(name);
    }
    expect(read(`${M10_SRC}/hope-route-service-db.ts`)).toContain(
      "envelopeStorageUri: `db://hope_submission/${row.id}/package`",
    );
  });
});

describe("spec 10 / 12: the delivery list and the checklist say which items are not what runs", () => {
  it("§10 and §12 name each unbuilt row, and the code has none of the unbuilt pieces", () => {
    const tasks = between("## 10. Implementation Tasks", "| # | Task |");
    for (const part of [
      "Rows 6 and 11",
      "Row 9: no Correction RFA submission is queued",
      "Row 12: `revalidate-on-terminology-update` is a catalog row with no body",
      "Row 13: there is no `late-completion-confirm.ts`",
      "Rows 15 and 16",
      "Row 17: `hope-deadline-alerts` is not built",
    ]) {
      expect(tasks, part).toContain(part);
    }
    const workers = between("### Workers & jobs", "### Frontend");
    expect(workers).toContain("**Not as built.**");
    expect(workers).toContain("`hope-deadline-alerts`");
    expect(CHECKLIST).toContain("*(As built only the two M6 subscriptions exist;");

    const code = sourcesUnder(M10_SRC);
    expect(code).not.toMatch(/late-completion-confirm|hope-deadline-alerts\.cron/);
    // Every outbox subscription M10 registers is on an M6 admission event.
    const subscribed = [...code.matchAll(/eventTypes:\s*\[([^\]]*)\]/g)].map((m) => m[1] ?? "");
    expect(subscribed.length).toBeGreaterThan(0);
    for (const types of subscribed) expect(types).not.toMatch(/m38\.|m39\./);
    // The HQRP non-compliance counter is not on the seam the spec names.
    const provider = createHopeSubmissionProvider({} as never);
    expect(Object.keys(provider).sort()).toEqual(["latestForProviderEntity", "submission"]);
  });
});

describe("spec D2 / D9 / D12 and the checklist: the permission key, column and routes are the real ones", () => {
  const catalog = read("packages/auth/src/permissions/contributed.ts");

  it("names hope.admin.late_deadline_override, which the catalog and the route have, and says the override lifts one capture", () => {
    expect(catalog).toContain('"hope.admin.late_deadline_override"');
    expect(read(`${M10_SRC}/routes/hope-routes.ts`)).toContain(
      'P("hope.admin.late_deadline_override")',
    );
    expect(SPEC).not.toContain("hope.schedule.override");
    expect(catalog).not.toContain("hope.schedule.override");
    expect(SPEC).not.toContain("extends the deadline");
    expect(decision("D2")).toContain("`hope.admin.late_deadline_override`");
    expect(decision("D2")).toContain("lifts the cutoff for that one capture");
    expect(CHECKLIST).toContain("lifts the cutoff for that one capture");
  });

  it("names the real column and no unbuilt late-confirm or discharge-trigger route as a citation", () => {
    expect(read("packages/db/migrations/0034_hope_m10_tables.sql")).toContain(
      '"late_completion_reason_code"',
    );
    expect(SPEC).not.toMatch(/(?<![a-z_])late_reason_code/);
    const d12 = decision("D12");
    expect(d12).toContain("`hope_assessment.late_completion_reason_code`");
    expect(d12).toContain("there is no `late-confirm` route");
    expect(d12).not.toContain("`POST /timepoints/:id/late-confirm`");
    expect(decision("D9")).not.toContain("`POST /admissions/:id/hope/discharge-trigger`");
    expect(decision("D9")).toContain("`materialize-discharge-timepoint`");
    expect(SPEC).toContain("`materialize-discharge-timepoint`");
    expect(sourcesUnder("apps/backend/src")).not.toMatch(/late-confirm|discharge-trigger/);
  });

  it("D12's codelist is LATE_COMPLETION_REASON_CODES, and the counter is marked not built", () => {
    const d12 = decision("D12");
    for (const code of LATE_COMPLETION_REASON_CODES) expect(d12, code).toContain(`\`${code}\``);
    expect(d12).toContain("the counter is **not built**");
  });
});

describe("spec 4.1 / 4.4 regenerate-schedules: an admission the caller cannot see is 404 from the scope guard, 422 only when not sited", () => {
  it("the route row and the M10_ADMISSION_PROJECTION_GAP row say so, as the route and the predicate behave", () => {
    const route = line(ROUTES, "| `POST` | `/hope/admin/regenerate-schedules`");
    expect(route).toContain("`404 NOT_FOUND` from the `hope.scope` guard");
    expect(route).toContain(
      "`422 M10_ADMISSION_PROJECTION_GAP` is for a visible admission that cannot be sited",
    );
    const gap = line(ERRORS, "| `M10_ADMISSION_PROJECTION_GAP`");
    expect(gap).toContain("on that route only for a visible admission that is not sited");
    const routes = read(`${M10_SRC}/routes/hope-routes.ts`);
    expect(routes).toMatch(
      /preHandler: \[\s*ADMIN_REGEN,\s*REJECT_AI_OPERATIONS,\s*SCOPE_BODY_ADMISSION\("hope\.admin\.regenerate_schedules"\),?\s*\]/,
    );
    expect(routes).toMatch(/SCOPE_BODY_ADMISSION = [\s\S]*?notFoundOnDeny: true/);
    expect(read(`${M10_SRC}/abac-predicates.ts`)).toMatch(/if \(!facts\) return false;/);
  });
});

describe("spec 4.1.1 lock order: the results import is the one request UPDATE of an assessment row outside the assessment lock", () => {
  it("the sentence is scoped to request paths and draft rows, and names the results exception the code has", () => {
    const order = line(LOCKS, "M10's total lock order is");
    expect(order).toContain(
      "every request path that writes answers or UPDATEs a draft assessment row",
    );
    expect(order).not.toContain("every path that writes answers or UPDATEs the assessment row");
    expect(order).toContain("`POST .../results` stamping `iqies_record_id`");
    const results = slice(
      read(`${M10_SRC}/hope-route-service-db.ts`),
      "async importSubmissionResult(",
      "await insertResultEvents(",
    );
    // The stamp is one bulk UPDATE of `hope_assessment` (hope-submission-result-writes.ts), under the submission row lock.
    expect(results).toContain("await stampAssessmentRecordIds(");
    expect(results).not.toMatch(/lockAssessmentRow|ANSWER/);
    const writes = read(`${M10_SRC}/hope-submission-result-writes.ts`);
    expect(writes).toContain("UPDATE ${ASSESS} AS a");
    expect(writes).not.toMatch(/lockAssessmentRow|ANSWER/);
  });
});

describe("spec 4.1.1 'Not covered (2)': the assemble runner takes its key through lockRecordKey", () => {
  it("names runAssembleSubmissionCron, lockRecordKey and M10_RECORD_BUSY, as the code does", () => {
    const notCovered = LOCKS.slice(LOCKS.indexOf("**Not covered**"));
    expect(notCovered).toContain("`runAssembleSubmissionCron`");
    expect(notCovered).toContain("`lockRecordKey`");
    expect(notCovered).toContain("raised as `M10_RECORD_BUSY`");
    const runner = slice(
      read(`${M10_SRC}/jobs/cron-workers.ts`),
      "export async function runAssembleSubmissionCron",
      "// ── F-072",
    );
    expect(runner).toContain("await boundCronLockWait(t)");
    expect(runner).toContain("await lockRecordKey(t, `m10:assemble:${organizationId}`");
    const lock = read(`${M10_SRC}/hope-assessment-lock.ts`);
    expect(
      slice(lock, "export async function lockRecordKey", "await takeBoundedLock("),
    ).toBeTruthy();
    expect(lock).toContain('"M10_RECORD_BUSY"');
  });
});

describe("spec 5.6 / 7.13: the recording service reads two in-platform seams, and the PPS warning needs siting", () => {
  it("recordTimepoint reads the M6 admission seam and the chart prefill, and never the M9 snapshot or M36", () => {
    const service = read(`${M10_SRC}/hope-route-service-db.ts`);
    const record = slice(
      service,
      "async recordTimepoint(",
      "// ── Record an RFA-04 SFV completion",
    );
    expect(record).toContain('getSeam("AdmissionStatusReader")');
    expect(record).toContain("prefillAdmission(");
    expect(record).not.toMatch(/d8Snapshot|LatestAssessmentProvider|AlertEmit|iqies/i);
    const sign = slice(service, "async signTimepoint(", "async correctTimepoint(");
    expect(sign).toContain("d8Snapshot(");

    const tier2 = between("**Tier 2 constraint (DR-010):**", "#### Degraded-Mode Behaviour");
    expect(tier2).not.toContain("never awaits an external call inline");
    expect(tier2).toContain("calls none of M36, M38, M9 or iQIES inline");
    expect(tier2).toContain("`AdmissionStatusReader`");
  });

  it("the PPS finding is stored only when the siting resolves, otherwise a log line is written; the spec says so in all three places", () => {
    const tail = slice(
      read(`${M10_SRC}/hope-sign-tail.ts`),
      "async function recordD8Finding(",
      "await t.insert(FINDING)",
    );
    expect(tail).toContain("if (!input.siting)");
    expect(tail).toContain("console.warn(");
    const rows = [
      between("**Tier 2 constraint (DR-010):**", "#### Degraded-Mode Behaviour"),
      line(
        between("#### Degraded-Mode Behaviour", "#### BCP Re-entry Path"),
        "| M9 (PPS/ESAS-r seam)",
      ),
      line(between("### 7.13", "-----"), "- **PPS not available at sign time.**"),
    ];
    for (const text of rows) expect(text).toMatch(/provider entity and location (can be )?resolve/);
    expect(rows[1]).not.toContain("`severity='warning'` written (non-blocking)");
  });
});

describe("spec 3.4 / 12: the correction-supersede trigger fires when the correction is signed", () => {
  it("migration 0225 is an AFTER UPDATE draft-to-signed trigger, and the sample and the checklist say so", () => {
    const migration = read("packages/db/migrations/0225_hope_correction_supersede_on_sign.sql");
    expect(migration).toContain("AFTER UPDATE ON hope_assessment");
    expect(migration).toContain("OLD.status = 'draft'");
    expect(migration).not.toMatch(/AFTER INSERT ON hope_assessment/);
    expect(read("packages/db/migrations/0034_hope_m10_tables.sql")).not.toContain("superseded_at");

    const sample = between(
      "-- Correction-supersede trigger",
      "CREATE TRIGGER trg_hope_assessment_correction_supersede",
    );
    expect(sample).toContain("DESIGN SKETCH (AFTER INSERT)");
    expect(sample).toContain("As built (migration 0225");
    const check = line(CHECKLIST, "- [ ] **(blocker)** Correction-supersede trigger");
    expect(check).toContain("when a correction or inactivation draft is signed");
    expect(check).toContain("migration 0225");
    expect(check).not.toContain("fires on insert");
    expect(check).not.toContain("superseded_at = now()");
    expect(line(SPEC, "| CMS HOPE Correction Policy")).toContain(
      "fires when the correction is signed",
    );
  });
});
