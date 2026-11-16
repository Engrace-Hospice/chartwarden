// Group g3 (HOPE docs, M10): the module spec says what the code does.
//
// The spec (docs/modules/CHARTWARDEN_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md) is a proposal that was also edited to describe
// as-built behaviour, and three classes of drift kept recurring in review: the pinned M10_* wording differing between the
// spec, CHANGES.md and the OpenAPI summaries; a claim of "never" / "every" / "wrote nothing" a multi-transaction request
// or an uncovered route makes untrue; and unbuilt behaviour (BCP paper-origin re-entry, the automated iQIES crons) written
// as built. Each test below checks a spec statement against the code it describes, so a doc that drifts, or a code change
// that makes a "Not built" statement false, fails here and names the section to update.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LATE_COMPLETION_REASON_CODES,
  decideSfvWatchdogStatus,
  windowFor,
} from "@chartwarden/hope";
import type { IsoInstant, LocalDate } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { M10_DLQ, M10_JOB_PARAMS, M10_QUEUES } from "../src/modules/10-hope/jobs/index";

const ROOT = process.cwd();
const SPEC_PATH = "docs/modules/CHARTWARDEN_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md";
const SPEC = readFileSync(join(ROOT, SPEC_PATH), "utf8");
const M10_SRC = "apps/backend/src/modules/10-hope";
const read = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

/** The spec text from `start` up to (not including) `end`; a renamed heading fails loudly rather than matching nothing. */
function between(start: string, end: string): string {
  const from = SPEC.indexOf(start);
  const to = SPEC.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`spec heading not found: ${from < 0 ? start : end}`);
  return SPEC.slice(from, to);
}

/** The one markdown table row that starts with `prefix` (a first cell, or the leading cells already written with their pipes). */
function row(block: string, prefix: string): string {
  const start = prefix.startsWith("|") ? prefix : `| ${prefix}`;
  const found = block.split("\n").filter((line) => line.startsWith(start));
  if (found.length !== 1) throw new Error(`expected one row for ${prefix}, found ${found.length}`);
  return found[0] as string;
}

/** The text of every .ts file under `dir` (relative to the repo root), skipping tests and build output. */
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

const BUSY_MESSAGE =
  "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again.";
const REPLAY = "replays the 422 for 24 h on the same key";
const ERRORS = between("### 4.4 Error Codes", "### 4.5 Socket.IO");
const ROUTES = between("### 4.1 Route Inventory", "#### 4.1.1");

describe("spec 4.4: the pinned wording is the one CHANGES.md and the OpenAPI summaries carry", () => {
  it("M10_RECORD_BUSY carries the busy message and scopes the key sentence to POST/PUT/PATCH, with a GET qualifier", () => {
    const busy = row(ERRORS, "`M10_RECORD_BUSY`");
    expect(busy).toContain(BUSY_MESSAGE);
    expect(busy).toContain(
      "On POST, PUT and PATCH the same Idempotency-Key may be reused because the key is released",
    );
    expect(busy).toContain("carries no key and is never claimed or cached");
    expect(busy).not.toContain("`Idempotency-Key`");
  });

  it.each(["`M10_SPEC_NOT_IN_FORCE`", "`M10_ADMISSION_PROJECTION_GAP`"])(
    "%s says the 422 is replayed on the same key (POST/PUT/PATCH), asks for a NEW Idempotency-Key, and has a GET qualifier",
    (code) => {
      const text = row(ERRORS, code);
      expect(text).toContain("On POST, PUT and PATCH the idempotency layer");
      expect(text).toContain(REPLAY);
      expect(text).toContain("NEW Idempotency-Key");
      expect(text).toMatch(/GET .*(carries no key|never cached)/);
      expect(text).not.toContain("`Idempotency-Key`");
      expect(text).not.toMatch(/wrote nothing|writes nothing/);
    },
  );

  it("M10_ADMISSION_PROJECTION_GAP names both routes that raise it", () => {
    const text = row(ERRORS, "`M10_ADMISSION_PROJECTION_GAP`");
    expect(text).toContain("POST /admissions/:admissionId/hope/sfv");
    expect(text).toContain("POST /hope/admin/regenerate-schedules");
  });

  it("the SFV route row repeats the replay sentence for the projection gap", () => {
    const sfv = row(ROUTES, "| `POST` | `/admissions/:admissionId/hope/sfv`");
    expect(sfv).toContain(REPLAY);
    expect(sfv).toContain("NEW Idempotency-Key");
  });

  it("documents the refusals that used to be undocumented: 04_sfv on timepoints and the 409 on skip", () => {
    expect(
      row(ERRORS, "`VALIDATION_FAILED` (details code `M10_RFA_KIND_NOT_A_TIMEPOINT`)"),
    ).toContain("04_sfv");
    expect(row(ERRORS, "`CONFLICT`")).toContain("only an open schedule can be skipped");
    expect(row(ROUTES, "| `POST` | `/admissions/:admissionId/hope/timepoints`")).toContain(
      "M10_RFA_KIND_NOT_A_TIMEPOINT",
    );
    expect(row(ROUTES, "| `POST` | `/hope/schedules/:id/skip`")).toContain("`409 CONFLICT`");
  });
});

describe("spec 4.1 route rows describe the route as built", () => {
  const regenerate = read(`${M10_SRC}/scheduling/schedule-writer.ts`);
  const service = read(`${M10_SRC}/hope-route-service-db.ts`);
  const signBody = service.slice(
    service.indexOf("async signTimepoint("),
    service.indexOf("async correctTimepoint("),
  );

  it("regenerate-schedules only creates missing windows, and the code writes no regenerated_at", () => {
    const text = row(ROUTES, "| `POST` | `/hope/admin/regenerate-schedules`");
    expect(text).toContain("Create any missing HOPE schedule windows");
    expect(text).not.toMatch(/Recompute/);
    expect(regenerate).toContain(
      "skipping any RFA that already has a schedule row on this admission",
    );
    expect(regenerate).not.toMatch(/regenerated_?at/i);
    expect(between("- **Admission backdate.**", "- **PPS not available")).toContain(
      "does not recompute boundaries",
    );
  });

  it("correct inserts a draft; nothing is queued for submission", () => {
    const text = row(ROUTES, "| `POST` | `/hope/assessments/:id/correct`");
    expect(text).toContain("correction DRAFT");
    expect(text).not.toContain("queues Correction-RFA");
    expect(read("packages/db/migrations/0225_hope_correction_supersede_on_sign.sql")).toContain(
      "OLD.status = 'draft'",
    );
  });

  it("retry and assemble rows say what they do (a requeue; the only assemble path, no cron)", () => {
    expect(row(ROUTES, "| `POST` | `/hope/submissions/:id/retry`")).toContain("Deprecated");
    expect(row(ROUTES, "| `POST` | `/hope/submissions/assemble`")).toContain("no cron runs it");
    expect(ROUTES).not.toContain("re-validates, re-assembles");
  });

  it("signing does not re-check the late deadline, and the spec says so", () => {
    expect(signBody.length).toBeGreaterThan(500);
    expect(signBody).not.toMatch(
      /assertCaptureAllowed|classifyCapture|lateDeadlineAt|M10_TIMEPOINT_EXPIRED/,
    );
    expect(between("- **Stale draft past", "- **iQIES rejection")).toContain(
      "signing does not re-check it",
    );
    expect(row(ERRORS, "`M10_TIMEPOINT_EXPIRED`")).toContain("not when it is signed");
  });

  it("the SFV obligation is opened by the answer patch, not by sign", () => {
    expect(read(`${M10_SRC}/hope-answer-service.ts`)).toContain("reconcileTriggeringAssessment");
    expect(read(`${M10_SRC}/hope-sign-tail.ts`)).toContain(
      "so it is read here rather than created",
    );
    expect(between("- **Race: J2051 trigger", "- **Stale draft")).toContain(
      "opened while the draft is answered",
    );
  });
});

describe("spec 4.8 / 4.8.1: queue names and parameters are the code's", () => {
  const JOBS = between("### 4.8 BullMQ Jobs", "### 4.9 M36");
  const PARAMS = between("#### 4.8.1", "**Registration.**");
  const paramRows = PARAMS.split("\n").filter((line) => /^\| `hope\./.test(line));
  const cells = (line: string): string[] => line.split("|").map((cell) => cell.trim());
  const dotted = Object.values(M10_QUEUES) as string[];

  it("uses the dotted names BullMQ accepts, never a colon", () => {
    expect(JOBS).not.toMatch(
      /hope:(scheduling|windows|sfv|alerts|validation|submission|retention)/,
    );
    for (const line of paramRows) expect(dotted).toContain(cells(line)[1]?.replaceAll("`", ""));
  });

  it("names only declared DLQs, and says the retention DLQ is a name only", () => {
    const declared = Object.values(M10_DLQ) as string[];
    const named = new Set(
      [...PARAMS.matchAll(/`(hope\.[a-z]+\.dlq)`/g)].map((match) => match[1] as string),
    );
    for (const name of named) {
      if (name === "hope.retention.dlq")
        expect(PARAMS).toContain("`M10_DLQ` in `jobs/index.ts` declares no retention DLQ");
      else expect(declared).toContain(name);
    }
    expect(declared).not.toContain("hope.retention.dlq");
  });

  it("every job's priority, attempts, backoff and concurrency equal M10_JOB_PARAMS", () => {
    const seen = new Set<string>();
    for (const line of paramRows) {
      const [, , job, priority, attempts, backoff, concurrency] = cells(line);
      const name = (job ?? "").replaceAll("`", "") as keyof typeof M10_JOB_PARAMS;
      const params = M10_JOB_PARAMS[name];
      expect(params, `${name} is not in M10_JOB_PARAMS`).toBeDefined();
      seen.add(name);
      const normal = (text: string): string =>
        text
          .replace(/\s*\(.*$/, "")
          .replaceAll(" ", "")
          .replace("min", "m");
      expect({ name, priority: Number.parseInt(priority ?? "", 10) }).toEqual({
        name,
        priority: params.priority,
      });
      expect({ name, attempts: Number.parseInt(attempts ?? "", 10) }).toEqual({
        name,
        attempts: params.attempts,
      });
      expect({ name, concurrency: Number.parseInt(concurrency ?? "", 10) }).toEqual({
        name,
        concurrency: params.concurrency,
      });
      expect({ name, backoff: normal(backoff ?? "") }).toEqual({
        name,
        backoff: normal(params.backoff),
      });
    }
    expect([...seen].sort()).toEqual(Object.keys(M10_JOB_PARAMS).sort());
  });

  it("lists submit-correction-rfa among the unwired stages, and the changelog gives no queue count", () => {
    expect(JOBS).toContain("`submit-correction-rfa` has a pure planner");
    expect(SPEC).not.toContain("all 11 queues");
    expect(Object.keys(M10_QUEUES)).toHaveLength(7);
  });
});

describe("spec 5.6: BCP re-entry and mobile offline are design only", () => {
  const BCP = between("#### BCP Re-entry Path", "#### Mobile Offline Storage");
  const MOBILE = between("#### Mobile Offline Storage", "## 6. Permissions Matrix");
  const item = (n: number): string => between(`${n}. **`, `${n + 1}. **`);
  const searched = ["apps/backend/src", "packages/hope/src", "packages/types/src"]
    .map(sourcesUnder)
    .join("\n");

  it("item 1: a paper-origin record is an ordinary late capture over the real codelist", () => {
    for (const code of LATE_COMPLETION_REASON_CODES) expect(BCP).toContain(`\`${code}\``);
    expect(BCP).toContain("is **not** accepted verbatim");
    expect(BCP).toContain("`409 M10_TIMEPOINT_EXPIRED`");
  });

  it.each([2, 3, 4])("item %i is marked Not built", (n) => {
    expect(item(n)).toContain("Not built");
  });

  it("the Not built statements are still true (if one of these appears, update the spec and M10_DR_INT_INVENTORY.md)", () => {
    expect(LATE_COMPLETION_REASON_CODES as readonly string[]).not.toContain("system_outage");
    for (const name of [
      "bcpPaperOrigin",
      "paper_origin_transcribed",
      "system_outage_bcp",
      "no-phi-indexeddb",
    ]) {
      expect(searched, name).not.toContain(name);
    }
    expect(existsSync(join(ROOT, "packages/mobile-offline"))).toBe(false);
    expect(existsSync(join(ROOT, "packages/hope/src/sections/Z/schema.ts"))).toBe(false);
  });

  it("the offline section says the package and the lint rule do not exist", () => {
    expect(MOBILE).toContain("Design only: not built");
    expect(MOBILE).toContain("`packages/mobile-offline`");
    expect(MOBILE).toContain("does not exist");
  });
});

describe("spec 7: the worked examples use the code's numbers", () => {
  const LA = "America/Los_Angeles";
  const localLA = (instant: string): string =>
    new Date(instant).toLocaleString("sv-SE", { timeZone: LA });

  it("7.5: SOC counts as day 1, so HUV2 is 05-16..05-30 and the late deadline ends 06-06", () => {
    const huv2 = windowFor("03_huv2", "2026-05-01" as LocalDate, LA);
    expect(localLA(huv2.windowOpensAt)).toBe("2026-05-16 00:00:00");
    expect(localLA(huv2.windowClosesAt)).toBe("2026-05-30 23:59:59");
    expect(localLA(huv2.lateDeadlineAt)).toBe("2026-06-06 23:59:59");
    const text = between("### 7.5", "### 7.6");
    expect(text).toContain("2026-05-16 – 2026-05-30");
    expect(text).toContain("2026-06-06 23:59:59.999");
  });

  it("7.4: an SFV due 06-10 is still overdue at 06-17 15:00 and missed after the end of 06-17 (org-local)", () => {
    const base = {
      current: "open",
      dueAt: "2026-06-10T21:00:00.000Z" as IsoInstant,
      timeZone: LA,
    } as const;
    expect(
      decideSfvWatchdogStatus({ ...base, asOfInstant: "2026-06-17T22:00:00.000Z" as IsoInstant }),
    ).toBe("overdue");
    expect(
      decideSfvWatchdogStatus({ ...base, asOfInstant: "2026-06-18T07:01:00.000Z" as IsoInstant }),
    ).toBe("missed");
    expect(between("### 7.4", "### 7.5")).toContain(
      "at 2026-06-17 15:00 the SFV is still `overdue`",
    );
  });

  it("7.6: the late reason code in the example is in the codelist", () => {
    const text = between("### 7.6", "### 7.7");
    expect(LATE_COMPLETION_REASON_CODES as readonly string[]).toContain("hospitalization");
    expect(text).toContain("late_completion_reason_code='hospitalization'");
    expect(text).not.toContain("patient_hospitalized");
  });

  it("7.9 describes the manual package flow, and the cron stages as not built", () => {
    const text = between("### 7.9", "### 7.10");
    for (const step of [
      "status='packaged'",
      "mark-uploaded",
      "POST .../results",
      "Not built (design only)",
    ]) {
      expect(text).toContain(step);
    }
    expect(text).not.toContain("transitions to `in_flight`");
  });
});

describe("spec 8.1 / 8.4: the audit events and the eraser are the ones the code has", () => {
  const AUDIT = between("### 8.1 Audit Events Emitted", "### 8.2 Metrics");
  const ERASER = between("### 8.4 Destruction", "### 8.5 STRIDE");
  const migrations = [
    "0035_hope_m10_rls_audit_triggers",
    "0222_hope_m10_phase_1a_spec_foundation",
    "0482_m10_hope_retention_review",
  ]
    .map((name) => read(`packages/db/migrations/${name}.sql`))
    .join("\n");

  it("every trigger event named in 8.1 is written by a migration trigger", () => {
    const tables = new Set(
      [...AUDIT.matchAll(/`(\w+)\.insert`/g)].map((match) => match[1] as string),
    );
    expect(tables.size).toBeGreaterThanOrEqual(5);
    for (const table of tables) expect(migrations, table).toContain(`'${table}.' || lower(TG_OP)`);
  });

  it("the three explicit events are named and are written by the code", () => {
    const code = sourcesUnder(M10_SRC);
    for (const event of [
      "hope.timepoint_signed",
      "hope.sfv_completed",
      "hope.late_deadline_override",
    ]) {
      expect(AUDIT).toContain(`\`${event}\``);
      expect(code).toContain(`"${event}"`);
    }
  });

  it("names none of the events no code writes", () => {
    expect(AUDIT).not.toMatch(
      /^\| `(hope_schedule\.|sfv\.|hope_assessment\.(created|updated|signed|corrected|superseded)|hope_submission\.(queued|transmitted|accepted|rejected))/m,
    );
    expect(between("- **Schedule skip**", "**External collaborator access:**")).toContain(
      "there is no `hope_schedule.skipped` event",
    );
  });

  it("8.4 describes hope-eraser.ts: class hope_record, row delete only, and says the answer rows are untouched", () => {
    const eraser = read(`${M10_SRC}/erasers/hope-eraser.ts`);
    expect(ERASER).toContain("erasers/hope-eraser.ts");
    expect(ERASER).toContain("**`hope_record`**");
    expect(ERASER).toContain("`hope_assessment_answer` rows are not touched");
    expect(ERASER).toContain("`partitionsDropped` is always `0`");
    expect(eraser).toContain('registerEraser("hope_record"');
    expect(eraser).not.toMatch(/hope_assessment_answer|hopeAssessmentAnswers/);
    expect(eraser).toContain("partitionsDropped: 0");
    expect(SPEC).not.toContain('registerEraser("hope_records"');
  });
});
