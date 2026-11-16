// Group g3 (HOPE docs, M10), round 4: the module spec's lock-coverage, error-code, grace, partition, SFV-example and
// STRIDE statements are checked against the code they describe. Each test fails if the spec text is reverted to the
// earlier wording, or if the code changes so that the new wording becomes untrue.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decideSfvWatchdogStatus, planSfvCompletion } from "@chartwarden/hope";
import type { IsoInstant } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  HopeAnswerVersionConflictError,
  HopeAssessmentImmutableError,
  HopeItemInactiveForIscError,
  HopeProtectedItemWriteError,
} from "../src/modules/10-hope/hope-answer-service";
import { HopeInvalidAnswerValueError } from "../src/modules/10-hope/hope-answer-value";
import { hopeSfvDueAtFromJ2050B } from "../src/modules/10-hope/hope-sfv-service";
import {
  RESULT_IMPORTABLE_STATUSES,
  resultRefusalCode,
} from "../src/modules/10-hope/hope-submission-result";
import {
  M10_ALERT_MAX_ABANDONED_EMITS,
  M10_ALERT_MAX_ABANDONED_EMITS_PROCESS,
  planM10AlertEmissions,
} from "../src/modules/10-hope/jobs/watchdog-alerts";

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

/** The one table row of `block` that starts with `prefix`. */
function row(block: string, prefix: string): string {
  const found = block.split("\n").filter((line) => line.startsWith(`| ${prefix}`));
  if (found.length !== 1) throw new Error(`expected one row for ${prefix}, found ${found.length}`);
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
      else if (path.endsWith(".ts")) out.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(ROOT, dir));
  return out.join("\n");
}

const codeLines = (text: string): string[] =>
  text.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));

const ROUTES = between("### 4.1 Route Inventory", "#### 4.1.1");
const LOCKS = between("#### 4.1.1", "### 4.2 Webhooks");
const ERRORS = between("### 4.4 Error Codes", "### 4.5 Socket.IO");
const JOBS = between("### 4.8 BullMQ Jobs", "### 4.9 M36");

describe("spec 4.8: the abandoned-emit cap is per organization and per process", () => {
  it("the window-watchdog row names both caps with the code's numbers", () => {
    const text = row(JOBS, "`hope.windows` | `hope-window-watchdog` | cron");
    expect(text).toContain(`at ${M10_ALERT_MAX_ABANDONED_EMITS} of one organization`);
    expect(text).toContain(`at ${M10_ALERT_MAX_ABANDONED_EMITS_PROCESS} across the whole process`);
    expect(text).not.toContain("in the process the tick emits nothing");
    expect(M10_ALERT_MAX_ABANDONED_EMITS).toBeLessThan(M10_ALERT_MAX_ABANDONED_EMITS_PROCESS);
  });

  it("the process ceiling is checked before every emit, by both watchdogs' shared delivery", () => {
    const alerts = read(`${M10_SRC}/jobs/watchdog-alerts.ts`);
    expect(alerts).toContain("const capped = stoppedByCap(");
    expect(read(`${M10_SRC}/jobs/watchdog-ticks.ts`).match(/deliverAlerts\(/g)).toHaveLength(1);
    expect(row(JOBS, "`hope.sfv` | `sfv-watchdog` | cron")).toContain("same after-commit");
    expect(row(JOBS, "`hope.windows` | `hope-window-watchdog` | cron")).toContain("`sfv-watchdog`");
  });
});

describe("spec 4.1 / 4.1.1: lock coverage names what the code does", () => {
  it("every row lock and advisory key in a request route sits inside takeBoundedLock", () => {
    const unbounded = (source: string): string[] => {
      const lines = source.split("\n");
      return lines.flatMap((line, index) => {
        if (!/\.for\("update"\)|pg_advisory_xact_lock\(/.test(line)) return [];
        const before = lines.slice(Math.max(0, index - 40), index + 1).join("\n");
        return before.includes("takeBoundedLock(") ? [] : [`line ${index + 1}: ${line.trim()}`];
      });
    };
    // The checker has teeth: a bare FOR UPDATE is reported.
    expect(unbounded('await tx.select().from(X).for("update");')).toHaveLength(1);
    const requestFiles = readdirSync(join(ROOT, M10_SRC))
      .filter((name) => name.endsWith(".ts"))
      .concat(["scheduling/schedule-writer.ts", "outbox-consumers/m6-admission-scheduling.ts"]);
    for (const name of requestFiles) {
      expect(unbounded(read(`${M10_SRC}/${name}`)), name).toEqual([]);
    }
  });

  it("the three advisory keys the spec names are the ones the code takes", () => {
    const service = read(`${M10_SRC}/hope-route-service-db.ts`);
    for (const key of ["m10:record:", "m10:lineage:", "m10:assemble:"]) {
      expect(service, key).toContain(`\`${key}`);
      expect(LOCKS, key).toContain(`\`${key.slice(0, -1)}\``);
    }
  });

  it("assemble takes its advisory key as the first statement, before the candidate read, and the spec says so", () => {
    const body = slice(
      read(`${M10_SRC}/hope-route-service-db.ts`),
      "async assembleSubmission(",
      "const candidates",
    );
    expect(body).toContain("lockRecordKey(t, `m10:assemble:");
    expect(row(LOCKS, "`POST /hope/submissions/assemble`")).toContain("the first statement");
    expect(row(ROUTES, "`POST` | `/hope/submissions/assemble`")).toContain("`409 M10_RECORD_BUSY`");
  });

  it("skip, retry and regenerate bound the one statement that queues behind a row lock, and only the validation-finding writes are listed as not covered", () => {
    const service = read(`${M10_SRC}/hope-route-service-db.ts`);
    // The status-judging UPDATE is the bounded statement; neither route takes an advisory or row lock of its own.
    for (const body of [
      slice(service, "async skipSchedule(", "async recordTimepoint("),
      slice(service, "async retrySubmission(", "async assembleSubmission("),
    ]) {
      expect(body).toContain("takeBoundedLock(");
      expect(body).not.toMatch(
        /lockRecordKey|lockAssessmentRow|lockTriggeredSfv|\.for\("update"\)/,
      );
    }
    // Regenerate bounds the schedule INSERT in the writer, on the request path only (the consumer's call stays unbounded).
    const writer = read(`${M10_SRC}/scheduling/schedule-writer.ts`);
    expect(writer).toMatch(/input\.boundLockWait\s*\?\s*takeBoundedLock\(/);
    expect(writer).toContain("boundLockWait: true");
    for (const route of [
      "`POST /hope/schedules/:id/skip`, `POST /hope/submissions/:id/retry`",
      "`POST /hope/admin/regenerate-schedules`",
    ]) {
      expect(LOCKS.slice(0, LOCKS.indexOf("**Not covered**")), route).toContain(route);
    }
    const notCovered = LOCKS.slice(LOCKS.indexOf("**Not covered**"));
    expect(notCovered).toContain("validation-finding writes");
    for (const route of [
      "POST /hope/schedules/:id/skip",
      "POST /hope/submissions/:id/retry",
      "POST /hope/admin/regenerate-schedules",
      "POST /hope/submissions/assemble",
    ]) {
      expect(notCovered, route).not.toContain(route);
    }
  });

  it("the cron ticks bound their waits with boundCronLockWait, not takeBoundedLock; the eraser has no timeout", () => {
    const jobs = sourcesUnder(`${M10_SRC}/jobs`);
    expect(jobs).not.toContain("takeBoundedLock");
    const ticks = read(`${M10_SRC}/jobs/watchdog-ticks.ts`);
    expect(ticks.match(/await boundCronLockWait\(t\)/g)).toHaveLength(2);
    const workers = read(`${M10_SRC}/jobs/cron-workers.ts`);
    expect(workers.slice(workers.indexOf("export async function runHopeRetentionCron"))).toContain(
      "await boundCronLockWait(t)",
    );
    const eraser = read(`${M10_SRC}/erasers/hope-eraser.ts`);
    expect(eraser).toContain("pg_advisory_xact_lock(hashtext(");
    expect(eraser).not.toContain("lock_timeout");
    const notCovered = LOCKS.slice(LOCKS.indexOf("**Not covered**"));
    expect(notCovered).toContain("`boundCronLockWait`");
    expect(notCovered).toContain("destruction eraser");
    expect(LOCKS).not.toMatch(/Every lock statement/);
  });

  it("the sign path takes no SFV lock, and the spec says 'No SFV lock' rather than 'Never'", () => {
    const service = read(`${M10_SRC}/hope-route-service-db.ts`);
    const sign = slice(service, "async signTimepoint(", "async correctTimepoint(");
    expect(sign).not.toMatch(/lockTriggeredSfv|symptomFollowUpVisits|SFV\b.*for\("update"\)/);
    expect(row(LOCKS, "`POST .../sign`")).toContain("| No SFV lock;");
    expect(row(LOCKS, "`GET /hope/submissions/:id/package`")).not.toContain("writes nothing");
  });

  it("every POST, PUT and PATCH accepts the key because the plugin guards every non-GET/HEAD method", () => {
    expect(ROUTES).toContain(
      "All POST, PUT and PATCH endpoints accept the standard `Idempotency-Key`",
    );
    expect(ROUTES).not.toContain("All POST/PUT endpoints accept");
    expect(read("apps/backend/src/bootstrap/plugins/idempotency.ts")).toContain(
      'request.method === "GET" || request.method === "HEAD"',
    );
  });
});

describe("spec 4.1 PATCH .../answers: the statuses and codes are the database backend's", () => {
  const answers = row(ROUTES, "`PATCH` | `/hope/assessments/:id/answers`");

  it("the thrown errors carry the statuses and codes the row names", () => {
    const protectedItem = new HopeProtectedItemWriteError("A0100");
    const inactive = new HopeItemInactiveForIscError("A0100", "HUV");
    const invalid = new HopeInvalidAnswerValueError("A0100", "bad");
    const immutable = new HopeAssessmentImmutableError("id", "signed");
    const stale = new HopeAnswerVersionConflictError("id");
    expect([protectedItem.statusCode, protectedItem.code]).toEqual([403, "FORBIDDEN"]);
    expect([inactive.statusCode, inactive.code]).toEqual([422, "VALIDATION_FAILED"]);
    expect(inactive.details?.[0]?.code).toBe("HOPE_ITEM_INACTIVE_FOR_ISC");
    expect([invalid.statusCode, invalid.code]).toEqual([422, "VALIDATION_FAILED"]);
    expect(invalid.details?.[0]?.code).toBe("HOPE_INVALID_ANSWER_VALUE");
    for (const conflict of [immutable, stale]) {
      expect([conflict.statusCode, conflict.code]).toEqual([409, "CONFLICT"]);
    }
    for (const part of [
      "`403 FORBIDDEN`",
      "`404 NOT_FOUND`",
      "`422 VALIDATION_FAILED`",
      "`HOPE_ITEM_INACTIVE_FOR_ISC`",
      "`HOPE_INVALID_ANSWER_VALUE`",
      "`409 CONFLICT`",
      "`409 M10_RECORD_BUSY`",
    ]) {
      expect(answers, part).toContain(part);
    }
    expect(answers).not.toContain("(403 / 404 / 400)");
  });

  it("the M10_VERSION_CONFLICT family is the in-memory backend's; M10_ASSESSMENT_IMMUTABLE is also the HUV date route's", () => {
    const patch = read(`${M10_SRC}/hope-answer-service.ts`);
    const service = read(`${M10_SRC}/hope-route-service-db.ts`);
    for (const code of [
      "M10_VERSION_CONFLICT",
      "M10_ASSESSMENT_IMMUTABLE",
      "M10_INVALID_ANSWER",
      "M10_DUPLICATE_ANSWER",
      "M10_PROTECTED_ANSWER",
    ]) {
      expect(patch, code).not.toContain(code);
      expect(read(`${M10_SRC}/routes/service.ts`), code).toContain(code);
      expect(answers, code).toContain(code);
    }
    expect(service).not.toContain("M10_VERSION_CONFLICT");
    const huv = slice(service, "async setHuvCompletionDate(", "async signTimepoint(");
    expect(huv).toContain('"M10_ASSESSMENT_IMMUTABLE"');
    expect(service.replace(huv, "")).not.toContain("M10_ASSESSMENT_IMMUTABLE");
    expect(read(`${M10_SRC}/index.ts`)).toContain("createDbHopeBackend(db, outbox)");
  });
});

describe("spec 4.1 results row: which batch states accept a result", () => {
  const results = row(ROUTES, "`POST` | `/hope/submissions/:id/results`");

  it("names every importable status and the three refusal codes, as resultRefusalCode answers them", () => {
    for (const status of RESULT_IMPORTABLE_STATUSES)
      expect(results, status).toContain(`\`${status}\``);
    for (const status of ["packaged", "queued", "ready"]) {
      expect(resultRefusalCode(status)).toBe("M10_SUBMISSION_RESULT_NOT_UPLOADED");
      expect(results, status).toContain(`\`${status}\``);
    }
    expect(resultRefusalCode("cancelled")).toBe("M10_SUBMISSION_CANCELLED");
    expect(resultRefusalCode("accepted")).toBe("M10_SUBMISSION_RESULT_ALREADY_RECORDED");
    expect(results).toContain("`M10_SUBMISSION_CANCELLED`");
    expect(results).toContain("`M10_SUBMISSION_RESULT_ALREADY_RECORDED`");
    expect(results).not.toContain("for an uploaded batch");
  });
});

describe("spec grace statements: a fixed 7 days, no tenant setting, and no SFV grace", () => {
  it("no M10 code passes a grace to the planner, and the spec no longer says 'tenant grace'", () => {
    expect(sourcesUnder(M10_SRC)).not.toMatch(/graceDays|late_deadline_grace_days/);
    expect(SPEC).not.toMatch(
      /tenant grace|default 7-day grace|late_deadline_grace_days. is permitted/,
    );
    expect(SPEC).toContain("a fixed 7-day grace: the planner takes a `graceDays` parameter");
    expect(SPEC).toContain("(the fixed 7-day grace)");
  });

  it("an SFV completion is judged against due_at with no grace, as the 4.4 row says", () => {
    const dueAt = "2026-06-10T23:59:59.999Z" as IsoInstant;
    const target = { id: "sfv-1", status: "open", dueAt } as never;
    expect(() => planSfvCompletion(target, "a-1" as never, dueAt)).not.toThrow();
    const late = "2026-06-11T00:00:00.000Z" as IsoInstant;
    expect(() => planSfvCompletion(target, "a-1" as never, late)).toThrow(/past due/);
    expect(() =>
      planSfvCompletion(target, "a-1" as never, late, { adminOverride: true }),
    ).not.toThrow();
    expect(row(ERRORS, "`M10_SFV_PAST_DUE`")).toContain("no grace");
    expect(row(ERRORS, "`M10_SFV_PAST_DUE`")).not.toContain("due_at + grace");
  });
});

describe("spec 3.6 / 2.2.2 / 8.4 / 12: no partition is dropped and no code reads extended_for_cms", () => {
  it("the rotation job and its migration only create partitions", () => {
    const job = read("apps/backend/src/bootstrap/jobs/partition-rotation.ts");
    const migration = read("packages/db/migrations/0224_partition_rotation.sql");
    expect(job).not.toMatch(/drop|detach/i);
    expect(migration).not.toMatch(/drop\s+(table|partition)|detach\s+partition/i);
    const eraser = read(`${M10_SRC}/erasers/hope-eraser.ts`);
    expect(eraser).toContain("partitionsDropped: 0");
  });

  it("no non-comment line of the M10 code or the hope package reads extended_for_cms", () => {
    const lines = codeLines(sourcesUnder(M10_SRC) + sourcesUnder("packages/hope/src"));
    expect(lines.filter((line) => /extended_for_cms|extendedForCms/.test(line))).toEqual([]);
  });

  it("the spec's partition-drop statements are gone from 3.6, the 2.2.2 diagram, 4.8.1 and section 12", () => {
    expect(SPEC).not.toContain("row removed at partition drop");
    expect(SPEC).not.toContain("lets the `eraseFn` drop a partition");
    expect(SPEC).not.toContain("flag prevents partition drop");
    expect(SPEC).not.toContain("flag prevents premature drops");
    expect(SPEC).not.toContain("eraser (all four paths)");
    expect(SPEC).toContain("eraser (row-delete, extended-retention block and legal-hold override");
    expect(between("### 3.6 Partition Strategy", "-----")).toContain("drops and detaches none");
  });
});

describe("spec 2.2.3 / 7.3 / 7.4: the SFV example uses the live due_at and the alerts M10 emits", () => {
  const LA = "America/Los_Angeles";
  const dueAt = hopeSfvDueAtFromJ2050B("2026-06-08").toISOString() as IsoInstant;

  it("J2050B 2026-06-08 gives due_at 06-10 23:59:59.999 UTC; a 15:00 UTC tick leaves it open, the 06-11 00:00 UTC tick makes it overdue", () => {
    expect(dueAt).toBe("2026-06-10T23:59:59.999Z");
    const decide = (asOfInstant: string) =>
      decideSfvWatchdogStatus({
        current: "open",
        dueAt,
        asOfInstant: asOfInstant as IsoInstant,
        timeZone: LA,
      });
    expect(decide("2026-06-10T15:00:00.000Z")).toBe("open");
    expect(decide("2026-06-11T00:00:00.000Z")).toBe("overdue");
    const seven = between("### 7.3", "### 7.5");
    expect(seven).toContain("2026-06-10 23:59:59.999 UTC");
    expect(seven).toContain("2026-06-11 00:00 UTC");
    expect(seven).not.toContain("due_at = 2026-06-10 14:00");
  });

  it("one alert per transition: the correlation id has no time bucket, and the SFV row carries an empty alert_cadence", () => {
    const sfv = {
      sfvId: "sfv-1",
      patientId: "p-1",
      admissionId: "adm-1",
      triggeringAssessmentId: "a-1",
      status: "overdue",
      dueAt,
      timeZone: LA,
    } as const;
    const plan = (eventName: "m10.hope.sfv_overdue" | "m10.hope.sfv_missed") =>
      planM10AlertEmissions({
        organizationId: "org-1",
        schedules: [],
        sfvs: [sfv],
        events: [{ eventName, payload: { sfvId: "sfv-1" } }],
      });
    const [first] = plan("m10.hope.sfv_overdue");
    const [again] = plan("m10.hope.sfv_overdue");
    const [missed] = plan("m10.hope.sfv_missed");
    expect(first?.correlationId).toBe(again?.correlationId);
    expect(first?.severity).toBe("critical");
    expect(first?.correlationId).not.toBe(missed?.correlationId);
    expect(read(`${M10_SRC}/hope-sfv-service.ts`)).toContain("alertCadence: {}");
    const workers = read(`${M10_SRC}/jobs/cron-workers.ts`);
    const registered = slice(
      workers,
      "export function registerM10CronWorkers",
      "export async function runSubmissionJob",
    );
    expect(registered).not.toContain("M10_QUEUES.alerts");
    expect(between("#### 2.2.3", "#### 2.2.4")).toContain("is **not built**");
  });
});

describe("spec 7.1 / 7.10: recording inserts a draft; signing is a separate call", () => {
  it("recordTimepoint inserts status draft and never signed, and the examples say so", () => {
    const record = slice(
      read(`${M10_SRC}/hope-route-service-db.ts`),
      "async recordTimepoint(",
      "// ── Record an RFA-04 SFV completion",
    );
    expect(record).toContain('status: "draft"');
    expect(record).not.toContain('status: "signed"');
    expect(between("### 7.1", "### 7.2")).toContain(
      "inserts the `hope_assessment` row as a **draft**",
    );
    expect(between("### 7.1", "### 7.2")).not.toContain("is created with `status=signed`");
    expect(between("### 7.10", "### 7.11")).not.toContain("is created with `status=signed`");
  });
});

describe("spec 8.5 STRIDE: unbuilt mitigations are marked design only", () => {
  const STRIDE = between("### 8.5 STRIDE", "## 9. Test Plan");

  it("the adapter, MinIO envelope and integrity worker the rows rely on do not exist", () => {
    const searched = [
      "apps/backend/src",
      "packages/hope/src",
      "packages/iqies-client/src",
      "scripts",
      "architecture",
    ]
      .map(sourcesUnder)
      .join("\n");
    expect(searched).not.toMatch(/envelope[-_ ]?integrity/i);
    expect(read("packages/iqies-client/src/adapter.ts")).toContain("createUnboundIqiesAdapter");
    const workers = read(`${M10_SRC}/jobs/cron-workers.ts`);
    expect(
      slice(
        workers,
        "export function registerM10CronWorkers",
        "export async function runSubmissionJob",
      ),
    ).not.toContain("M10_QUEUES.submission");
    expect(workers).toContain("envelopeStorageUri: null");
    expect(read(`${M10_SRC}/hope-route-service-db.ts`)).toContain(
      "envelopeStorageUri: `db://hope_submission/${row.id}/package`",
    );
  });

  it("the banner and all five affected rows carry the design-only marker", () => {
    expect(STRIDE).toContain("Nothing re-hashes the stored bytes");
    expect(STRIDE.match(/\*\(Design only: not built\)\*/g)?.length).toBeGreaterThanOrEqual(5);
    expect(STRIDE).not.toContain("M4's envelope-integrity worker periodically re-hashes");
    expect(STRIDE).not.toContain("Adapter never logs envelope content;");
  });
});
