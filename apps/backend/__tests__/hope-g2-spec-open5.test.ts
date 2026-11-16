// Group g2 (HOPE docs, M10), open5 pass: the module spec says what the code does. Each test reads a spec statement and the
// code it describes, so it fails if the spec text is put back to the earlier wording or if the code changes so that the
// new wording becomes untrue. Classes: built-vs-unbuilt (the M36 SFV alert, Socket.IO, the submit worker, M38 value sets,
// the out-of-band builders, the HQRP counter, the CMS envelope, `extended_for_cms`), docs-omit-behaviour-change (the system
// skip, `m10.hope.inactivation_created`, the three-row schedule, the live consumer's name) and overclaim ("produced by
// nothing", "four rows").
//
// `M10_SPEC_FILE` points the suite at another copy of the spec; it exists only so the suite can be run against the
// previous wording to prove that it fails there.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { planAdmissionTimepoints, planDischargeTimepoint } from "@chartwarden/hope";
import { assembleEnvelopeCanonical } from "@chartwarden/iqies-client";
import type { IsoInstant, LocalDate } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/events-by-m10";
import { createHopeOrgRollupProvider } from "../src/modules/10-hope/seams/org-rollup-provider";
import type { HopeOrgRollupStore } from "../src/modules/10-hope/seams/org-rollup-store";

const ROOT = process.cwd();
const SPEC = readFileSync(
  process.env.M10_SPEC_FILE ??
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

/** The text of every non-test .ts file under `dir`, with its path. */
function sourcesUnder(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (absolute: string): void => {
    for (const name of readdirSync(absolute)) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      const path = join(absolute, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
        out.push({ path, text: readFileSync(path, "utf8") });
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/** The lines of `text` that are not a comment. */
const codeLinesOf = (text: string): string[] =>
  text.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));

const ROUTES = between("### 4.1 Route Inventory", "#### 4.1.1");
const ERRORS = between("### 4.4 Error Codes", "### 4.5 Socket.IO");
const SOCKETS = between("### 4.5 Socket.IO", "### 4.6 Permission Keys");
const PERMS = between("### 4.6 Permission Keys", "### 4.7 ABAC");
const JOBS = between("### 4.8 BullMQ Jobs", "#### 4.8.1");
const EVENTS = between("### 2.4 Side-Effects", "## 3. Drizzle Schema");
const DECISIONS = between("## 11. Resolved Decisions", "## 12. Acceptance Sign-Off Checklist");
const TASKS = between("## 10. Implementation Tasks", "## 11. Resolved Decisions");
const CHECKLIST = SPEC.slice(SPEC.indexOf("## 12. Acceptance Sign-Off Checklist"));
const decision = (id: string): string => line(DECISIONS, `| ${id} |`);
const WORKFLOW_SRC = read(`${M10_SRC}/outbox-consumers/m6-admission-workflow.ts`);
const M10_CODE = sourcesUnder(M10_SRC);
/** What `scheduleM10Jobs` registers: the non-comment lines of the registration file. */
const SCHEDULED_CODE = codeLinesOf(read(`${M10_SRC}/jobs/cron-schedule.ts`)).join("\n");

describe("spec 1.1 / 1.3 / 4.8 / 10 / 12: three schedule rows on activation, the Discharge row on discharge, by one live consumer", () => {
  it("the planner writes three admission-anchored rows and a separate discharge row", () => {
    const anchor = planAdmissionTimepoints({
      anchorDate: "2026-06-01" as LocalDate,
      timeZone: "UTC",
    });
    expect(anchor.map((d) => d.rfaKind)).toEqual(["01_admission", "02_huv1", "03_huv2"]);
    const discharge = planDischargeTimepoint({
      dischargeDate: "2026-06-15" as LocalDate,
      timeZone: "UTC",
    });
    expect(discharge.rfaKind).toBe("05_discharge");
  });

  it("no spec place says four rows, a four-timepoint worker or a Discharge placeholder", () => {
    expect(SPEC).not.toMatch(/creates four `hope_timepoint_schedule` rows/);
    expect(SPEC).not.toContain("Discharge placeholder");
    expect(SPEC).not.toContain("placeholder Discharge");
    expect(SPEC).not.toContain("auto-creates the four base timepoints");
    expect(SPEC).not.toContain("Creates the four base timepoints per admission");
    expect(TASKS).toContain("creates three `hope_timepoint_schedule` rows");
    expect(CHECKLIST).toContain("creates three `hope_timepoint_schedule` rows");
    expect(line(JOBS, "| `hope.scheduling` | `schedule-hope-timepoints`")).toContain(
      "three timepoints per admission",
    );
  });

  it("the spec names the consumer that is bound at boot, and the code binds exactly that one", () => {
    const note = between("> **Original delivery list", "| # | Task |");
    expect(note).toContain("`outbox-consumers/m6-admission-workflow.ts`");
    expect(note).toContain("the older `outbox-consumers/m6-admission-scheduling.ts` is not bound");
    expect(WORKFLOW_SRC).toContain('consumerName: "m10.m6-admission-workflow"');
    expect(WORKFLOW_SRC).toContain(
      'eventTypes: ["m6.admission.activated", "m6.admission.discharged"]',
    );
    const boot = read("apps/backend/src/index.ts");
    expect(boot).toContain("buildM10AdmissionWorkflowConsumer({");
    expect(boot).not.toMatch(/buildM10AdmissionSchedulingConsumer\(/);
    expect(CHECKLIST).toContain(
      "one consumer subscribed to M6's `admission.activated` and `admission.discharged`",
    );
    expect(SPEC).not.toContain("the two consumers of M6's");
  });

  it("the live consumer throws a plain Error for an unsited admission, and the PROJECTION_GAP row says so", () => {
    expect(WORKFLOW_SRC).toContain("has no provider/location siting");
    expect(WORKFLOW_SRC).not.toContain("M10_ADMISSION_PROJECTION_GAP");
    expect(WORKFLOW_SRC).toMatch(/throw new Error\(\s*`m10\.m6-admission-workflow: admission/);
    const gap = line(ERRORS, "| `M10_ADMISSION_PROJECTION_GAP`");
    expect(gap).toContain("does not raise the typed code");
    expect(gap).toContain("a plain `Error`");
    expect(gap).toContain("the unbound `outbox-consumers/m6-admission-scheduling.ts`");
    expect(gap).not.toContain("scheduling consumer raises it too");
  });

  it("a new timepoint with no patient is refused with the projection gap, and the 4.1 row and the 4.4 row name that route", () => {
    const service = read(`${M10_SRC}/hope-route-service-db.ts`);
    expect(service).toMatch(
      /"M10_ADMISSION_PROJECTION_GAP",\s*timepointProjectionGapMessage\(admissionId\)/,
    );
    const gap = line(ERRORS, "| `M10_ADMISSION_PROJECTION_GAP`");
    expect(gap).toContain("`POST /admissions/:admissionId/hope/timepoints`");
    expect(gap).toContain("for a NEW record only");
    expect(line(ROUTES, "| `POST` | `/admissions/:admissionId/hope/timepoints`")).toContain(
      "`422 M10_ADMISSION_PROJECTION_GAP`",
    );
  });
});

describe("spec 2.2.1 / 6: the discharge consumer skips a HUV window that opens after the discharge date", () => {
  it("the code sets skipped with discharged_before_huv_window on open HUV1 / HUV2 rows, and no permission is read", () => {
    expect(WORKFLOW_SRC).toContain('skipReasonCode: "discharged_before_huv_window"');
    expect(WORKFLOW_SRC).toContain('inArray(SCHED.rfaKind, ["02_huv1", "03_huv2"])');
    expect(WORKFLOW_SRC).toContain('eq(SCHED.status, "open")');
    expect(WORKFLOW_SRC).not.toContain("hope.schedule.skip");
  });

  it("2.2.1 (diagram and bullet) and the section 6 skip note both name the system skip", () => {
    const states = between("#### 2.2.1", "#### 2.2.2");
    expect(states).toContain("discharge before a HUV window opens (system) ──▶ skipped");
    expect(states).toContain("skip_reason_code='discharged_before_huv_window'");
    expect(states).toContain("The permission governs only the API skip");
    const six = between("- **Schedule skip**", "**External collaborator access:**");
    expect(six).toContain("`discharged_before_huv_window`");
  });
});

describe("spec 2.2.4 / 7.9 / 1.1: queued comes from .../retry, in_flight from nothing registered", () => {
  it("the code writes queued only in retry and the unregistered runners' stores, and in_flight only in the submit runner's store", () => {
    const writers = (status: string): string[] =>
      M10_CODE.filter((f) =>
        codeLinesOf(f.text).some((l) => l.includes(`status: "${status}"`) && !/(eq|ne)\(/.test(l)),
      )
        .map((f) => f.path.split("/10-hope/")[1] as string)
        .sort();
    expect(writers("queued")).toEqual([
      "hope-route-service-db.ts",
      "jobs/assemble-store.ts",
      "jobs/submission-store.ts",
      "routes/service.ts", // the in-memory twin, which production does not mount (spec 4.1)
    ]);
    expect(writers("in_flight")).toEqual(["jobs/submission-store.ts"]);
    const service = read(`${M10_SRC}/hope-route-service-db.ts`);
    expect(service).toMatch(/\.set\(\{ status: "queued", updatedAt: new Date\(\) \}\)/);
    expect(service).toContain('"m10.hope.submission_queued"');
    expect(SCHEDULED_CODE).not.toContain("assemble-hope-submission");
    expect(SCHEDULED_CODE).not.toContain("iqies-submit-worker");
  });

  it("no spec place says queued is produced by nothing", () => {
    expect(SPEC).not.toContain("`queued` / `in_flight` are produced by nothing");
    expect(SPEC).not.toContain("`queued` / `in_flight` batches are produced by nothing");
    expect(SPEC).not.toContain("`queued` and `in_flight` belong to the unbuilt automated design");
    const lifecycle = between("#### 2.2.4", "### 2.3 Validation Rules");
    expect(lifecycle).toContain("`in_flight` is produced by nothing registered");
    expect(lifecycle).toContain("`queued` only by the deprecated `POST .../retry`");
    const cycle = between("### 7.9", "### 7.10");
    expect(cycle).toContain("a `queued` batch comes only from the deprecated `POST .../retry`");
  });
});

/** The payload property names the catalog declares for `eventName`. */
function payloadKeys(eventName: string): string[] {
  const entry = M10_OUTBOX_EVENTS.find((e) => e.eventName === eventName);
  const schema = entry?.payloadSchema as unknown as { properties: Record<string, unknown> };
  return Object.keys(schema.properties);
}

describe("spec 2.4 / 4.1: every event the catalog registers has a row, inactivation_created and retention_eligible included", () => {
  const SHORTHAND: Record<string, string> = {
    "m10.hope.timepoint_scheduled": "hope.timepoint.scheduled",
    "m10.hope.timepoint_signed": "hope.timepoint.signed",
    "m10.hope.timepoint_expired": "hope.timepoint.expired",
    "m10.hope.j2051_trigger_fired": "hope.j2051.triggered",
    "m10.hope.sfv_created": "hope.sfv.created",
    "m10.hope.sfv_completed": "hope.sfv.completed",
    "m10.hope.sfv_overdue": "hope.sfv.overdue",
    "m10.hope.sfv_missed": "hope.sfv.missed",
    "m10.hope.correction_submitted": "hope.correction.submitted",
    "m10.hope.inactivation_created": "hope.inactivation.created",
    "m10.hope.submission_queued": "hope.submission.queued",
    "m10.hope.submission_transmitted": "hope.submission.transmitted",
    "m10.hope.submission_accepted": "hope.submission.accepted",
    "m10.hope.submission_rejected": "hope.submission.rejected",
    "m10.hope.summary_requested": "hope.summary_requested",
    "m10.hope.retention_eligible": "hope.retention.eligible",
  };

  it("the catalog and this map name the same events (a new event fails here until it has a spec row)", () => {
    expect(M10_OUTBOX_EVENTS.map((e) => e.eventName).sort()).toEqual(Object.keys(SHORTHAND).sort());
  });

  it("each event has a row in the 2.4 table", () => {
    for (const shorthand of Object.values(SHORTHAND)) {
      expect(EVENTS, shorthand).toContain(`| \`${shorthand}\` |`);
    }
  });

  it("the inactivation row and the 4.1 inactivations row name the event the service emits, with the catalog payload", () => {
    const service = read(`${M10_SRC}/hope-route-service-db.ts`);
    expect(service).toContain('"m10.hope.inactivation_created"');
    expect(service).toContain(
      "{ inactivationAssessmentId: inactivation.id, targetAssessmentId: original.id }",
    );
    expect(payloadKeys("m10.hope.inactivation_created")).toEqual([
      "inactivationAssessmentId",
      "targetAssessmentId",
    ]);
    const row = line(EVENTS, "| `hope.inactivation.created` |");
    expect(row).toContain("`{ inactivationAssessmentId, targetAssessmentId }`");
    expect(line(ROUTES, "| `POST` | `/hope/assessments/:id/inactivations`")).toContain(
      "emits `m10.hope.inactivation_created`",
    );
  });

  it("the retention row names the payload the scan publishes", () => {
    expect(read(`${M10_SRC}/jobs/cron-workers.ts`)).toContain('"m10.hope.retention_eligible"');
    expect(payloadKeys("m10.hope.retention_eligible")).toEqual([
      "patientId",
      "basis",
      "retentionYears",
      "eligibleAt",
    ]);
    expect(line(EVENTS, "| `hope.retention.eligible` |")).toContain(
      "`{ patientId, basis, retentionYears, eligibleAt }`",
    );
  });
});

describe("spec 1.1 / 1.3 / 1.4 / 4.5 / 5.2 / 7.2: no M36 SFV alert, Socket.IO event or submit worker is described as built", () => {
  const MESSAGING = sourcesUnder("apps/backend/src/modules/36-messaging");

  it("no M36 consumer is bound to an M10 event, and M10 emits no hope:* Socket.IO event", () => {
    for (const file of MESSAGING) expect(file.text, file.path).not.toContain("m10.hope.");
    const everything = sourcesUnder("apps/backend/src").concat(sourcesUnder("packages/hope/src"));
    for (const file of everything) {
      expect(codeLinesOf(file.text).join("\n"), file.path).not.toMatch(
        /["'`]hope:(schedule|assessment|sfv|submission:(transmitted|accepted))/,
      );
    }
  });

  it("the only M10 outbox event that a consumer outside M10 subscribes to for the SFV is M14's, on sfv_created", () => {
    const subscribers = sourcesUnder("apps/backend/src/modules")
      .filter((f) => !f.path.includes("/10-hope/"))
      .filter((f) => /eventTypes:[^\]]*m10\.hope\.sfv_/.test(f.text))
      .map((f) => f.path.split("/modules/")[1]?.split("/")[0]);
    expect(subscribers).toEqual(["14-idg"]);
  });

  it("1.1, 1.3, 1.4 and 7.2 qualify the SFV alert and the submit worker", () => {
    const purpose = between(
      "- **Server-authoritative J2051 trigger evaluation.**",
      "- **PPS / ESAS-r snapshot at sign.**",
    );
    expect(purpose).toContain("**design, not built.**");
    expect(purpose).toContain("no M36 consumer is bound to it");
    const regulatory = between("### 1.3 Regulatory Drivers", "### 1.4 Competitive Context");
    expect(line(regulatory, "| CMS HOPE Manual §J2030")).toContain(
      "*design:* alert dispatched immediately (not built",
    );
    expect(line(regulatory, "| 42 CFR §418.312")).toContain(
      "*As built* no `iqies-submit-worker` runs",
    );
    expect(regulatory).not.toContain("iQIES submission worker with deadline alerts ensures");
    const competitive = between("### 1.4 Competitive Context", "## 2. Domain Model");
    expect(competitive).not.toContain("We submit. The cron-driven");
    expect(competitive).toContain("the operator calls `POST /hope/submissions/assemble`");
    expect(competitive).toContain(
      "the design adds an alert routing to the care team channel, which is not built",
    );
    expect(competitive).toContain("the design also escalates an alert as the window closes");
    expect(competitive).toContain("the design adds deadline alerts that escalate through M36");
    const seven = between("### 7.2", "### 7.3");
    expect(seven).toContain("*Design, not built (§4.5, §4.9):*");
    expect(seven).toContain("a tester finds the `m10.hope.sfv_created` outbox event");
  });

  it("4.5 and 5.2 say the Socket.IO events are design only", () => {
    expect(SOCKETS).toContain(
      "> **Design only: not built.** No code emits or subscribes to any `hope:*` Socket.IO event",
    );
    expect(SPEC).toContain(
      "(design only: no `hope:*` Socket.IO event is emitted or consumed as built, §4.5)",
    );
  });
});

describe("spec 7.4 / D10 / D12: a missed SFV counts through M30's pull of the org rollup; there is no HQRP counter", () => {
  const store = (
    rows: { dueAt: IsoInstant; completedAt: IsoInstant | null }[],
  ): HopeOrgRollupStore => ({ terminalSfvs: async () => rows }) as unknown as HopeOrgRollupStore;
  const period = { from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" } as never;

  it("a missed SFV (no completion) is due and not on time; a completion at or before due_at is on time", async () => {
    const due = "2026-06-10T23:59:59.999Z" as IsoInstant;
    const provider = createHopeOrgRollupProvider(
      store([
        { dueAt: due, completedAt: null },
        { dueAt: due, completedAt: "2026-06-09T12:00:00.000Z" as IsoInstant },
      ]),
    );
    expect(await provider.sfvTimelinessRollup("org-1", period)).toEqual({
      sfvDue: 2,
      sfvOnTime: 1,
    });
  });

  it("nothing subscribes to m10.hope.sfv_missed outside M10, and the seam has no counter", () => {
    for (const file of sourcesUnder("apps/backend/src/modules").filter(
      (f) => !f.path.includes("/10-hope/"),
    )) {
      expect(file.text, file.path).not.toContain("m10.hope.sfv_missed");
    }
    expect(SPEC).not.toContain("### 7.4 SFV missed; HQRP non-compliance counter increments");
    const text = between("### 7.4", "### 7.5");
    expect(text).toContain("`HopeOrgRollupProvider`");
    expect(text).toContain("No consumer subscribes to `m10.hope.sfv_missed`");
    expect(text).not.toContain("M30's quality measure pipeline records the non-compliance");
  });

  it("D5, D7 and D10 carry an as-built clause, and the schedule registers none of the unbuilt submission jobs", () => {
    expect(decision("D5")).toContain("**As built:** no `iqies-submit-worker` cron is registered");
    expect(decision("D7")).toContain("**As built:** nothing queues a Correction RFA");
    expect(decision("D10")).toContain("**as built** the counter is not built, D12");
    for (const name of [
      "iqies-submit-worker",
      "iqies-reconcile-worker",
      "submit-correction-rfa",
      "hope-alert-dispatcher",
    ]) {
      expect(SCHEDULED_CODE, name).not.toContain(name);
    }
    expect(SCHEDULED_CODE).toContain(
      'type M10ScheduledJobName = "hope-retention-scan" | "hope-window-watchdog" | "sfv-watchdog"',
    );
  });
});

describe("spec 4.9.1: the out-of-band builders are not called, M36 strips on its own, and the one test covers a window alert", () => {
  it("apart from its definition, nothing under apps or packages calls buildOutOfBandPayload or buildInAppPayload", () => {
    const callers = sourcesUnder("apps/backend/src")
      .concat(sourcesUnder("packages"))
      .filter((f) => !f.path.endsWith("packages/hope/src/alerts.ts"))
      .filter((f) =>
        codeLinesOf(f.text).some((l) => /buildOutOfBandPayload|buildInAppPayload/.test(l)),
      );
    expect(callers.map((f) => f.path)).toEqual([]);
  });

  it("M36 has its own out-of-band sanitiser, and the only test of the builder takes a timepoint-window alert", () => {
    expect(existsSync(join(ROOT, "packages/messaging/src/notification/sanitize.ts"))).toBe(true);
    expect(read("packages/messaging/src/notification/sanitize.ts")).toContain(
      "export function sanitizeForOutOfBand",
    );
    const test = read("apps/backend/__tests__/hope-routes.test.ts");
    expect(test).toContain(
      "buildOutOfBandPayload carries no patient-name token for a timepoint-window alert",
    );
    expect(test).not.toMatch(/buildOutOfBandPayload\(buildSfvAlert/);
  });

  it("the spec carries the as-built note and the SFV severity paragraph says it is not built", () => {
    const section = between("#### 4.9.1", "### 4.10 iQIES Submission Worker Loop");
    expect(section).toContain(
      "> **As built.** The two builders exist in `packages/hope/src/alerts.ts` but nothing calls them",
    );
    expect(section).toContain("M36's own `sanitizeForOutOfBand`");
    expect(section).toContain("no test covers a `HopeSfvAlert` input");
    expect(section).toContain("**SFV trigger-time severity (M10-F19 / SD-015) — design, not built");
  });
});

describe("spec 2.3 / 1.1 / 4.4 / 5.6: the M38 value-set rule is not on the live validation path", () => {
  it("only run-validation.ts reads the terminology seam, and only the unregistered submit runner calls it", () => {
    const readers = M10_CODE.filter((f) =>
      codeLinesOf(f.text).some((l) =>
        /TerminologyProvider|isMemberOf\(|hospice_terminal_diagnosis/.test(l),
      ),
    ).map((f) => f.path.split("/10-hope/")[1]);
    expect(readers).toEqual(["validation/run-validation.ts"]);
    const callers = M10_CODE.filter((f) =>
      codeLinesOf(f.text).some((l) => /runHopeAssessmentValidation\(/.test(l)),
    )
      .map((f) => f.path.split("/10-hope/")[1])
      .sort();
    expect(callers).toEqual(["jobs/cron-workers.ts", "validation/run-validation.ts"]);
    expect(SCHEDULED_CODE).not.toContain("iqies-submit-worker");
  });

  it("M10_DIAGNOSIS_NOT_IN_VALUE_SET is declared and thrown nowhere", () => {
    const users = sourcesUnder("apps/backend/src")
      .concat(sourcesUnder("packages"))
      .filter((f) => codeLinesOf(f.text).some((l) => l.includes("M10_DIAGNOSIS_NOT_IN_VALUE_SET")))
      .map((f) => f.path.split("/wardenx4/")[1] ?? f.path);
    expect(users.map((p) => p.replace(/^.*?(packages\/hope\/src\/errors\.ts)$/, "$1"))).toEqual([
      "packages/hope/src/errors.ts",
    ]);
  });

  it("2.3, 1.1, 4.4 and 5.6 say the rule is design only", () => {
    const rules = between(
      "**Business logic (`record-hope-timepoint`):**",
      "**Pre-submission (`validate-hope-assessment`):**",
    );
    expect(rules).toContain("**design; not enforced as built.**");
    expect(rules).toContain(
      "an invalid Section I code passes record, draft validation and assemble and only CMS rejects it",
    );
    expect(line(ERRORS, "| `M10_DIAGNOSIS_NOT_IN_VALUE_SET`")).toContain(
      "**Not raised as built:**",
    );
    const degraded = between("#### Degraded-Mode Behaviour", "#### BCP Re-entry Path");
    const m38 = line(degraded, "| M38 (terminology seam)");
    expect(m38).toContain("as built no live M10 path reads it");
    expect(m38).not.toContain("only pre-submission validation reads it");
    const overview = between(
      "- **Pre-submission validation.**",
      "- **Append-only correction RFA workflow.**",
    );
    expect(overview).toContain("*design, not enforced on the live path*");
    expect(overview).toContain("(*design:* as built the M38 re-validation does not exist");
    expect(TASKS).toContain(
      "Row 4: the value-set membership rule is not on the live validation path",
    );
  });
});

describe("spec 1.3 / 4.6: the CMS envelope, the retention flag and the permission catalog are described as built", () => {
  it("the iqies-client envelope is a canonical-JSON hash pre-image, and the assemble route does not call the package", () => {
    const canonical = assembleEnvelopeCanonical({
      providerEntityCcn: "000000",
      submissionPeriod: "2026-06",
      items: [],
    });
    expect(canonical.startsWith("{")).toBe(true);
    expect(JSON.parse(canonical).schema).toBe("cms-hope-submission/v1");
    expect(read(`${M10_SRC}/hope-route-service-db.ts`)).not.toContain("@chartwarden/iqies-client");
    expect(existsSync(join(ROOT, `${M10_SRC}/hope-cms-xml-render.ts`))).toBe(true);
    expect(existsSync(join(ROOT, `${M10_SRC}/hope-cms-xml-serializer.ts`))).toBe(true);
    const regulatory = between("### 1.3 Regulatory Drivers", "### 1.4 Competitive Context");
    const row = line(regulatory, "| CMS HOPE Submission Spec");
    expect(row).not.toContain("implements the envelope per CMS spec");
    expect(row).toContain("canonical-JSON envelope model (a hash pre-image, not the wire XML)");
    expect(row).toContain("10-hope/hope-cms-xml-render.ts");
  });

  it("the 418.104 row names the transmission-date rule and says the extended_for_cms flag is read by no code", () => {
    const regulatory = between("### 1.3 Regulatory Drivers", "### 1.4 Competitive Context");
    const row = line(regulatory, "| 42 CFR §418.104");
    expect(row).not.toContain("`compliance` retention with `extended_for_cms` 10-year retention");
    expect(row).toContain("10 years from the last iQIES transmission");
    expect(row).toContain("a label that no code reads");
    expect(read(`${M10_SRC}/erasers/hope-eraser.ts`)).toContain("partitionsDropped: 0");
    expect(read(`${M10_SRC}/jobs/retention.ts`)).toContain(
      "export const HOPE_SUBMITTED_RETENTION_YEARS = 10;",
    );
    for (const file of M10_CODE) {
      expect(
        codeLinesOf(file.text).filter((l) => /extended_for_cms|extendedForCms/.test(l)),
        file.path,
      ).toEqual([]);
    }
    expect(TASKS).toContain("Row 23: no code reads the `extended_for_cms` flag");
  });

  it("the permission excerpt no longer says recompute, and the as-built note names the real catalog file", () => {
    expect(PERMS).not.toContain("Recompute schedules");
    expect(PERMS).toContain("Create any missing schedule windows for an admission (admin)");
    expect(PERMS).toContain(
      "> **As built.** The keys are registered in `packages/auth/src/permissions/contributed.ts`",
    );
    expect(existsSync(join(ROOT, "packages/hope/src/permissions.ts"))).toBe(false);
    const catalog = read("packages/auth/src/permissions/contributed.ts");
    expect(catalog).toContain('"hope.admin.regenerate_schedules"');
    expect(read("packages/auth/src/permissions/contributed.ts")).toContain('description: ""');
    expect(read(`${M10_SRC}/scheduling/schedule-writer.ts`)).toContain(
      "skipping any RFA that already has a schedule row on this admission",
    );
    const route = line(ROUTES, "| `POST` | `/hope/admin/regenerate-schedules`");
    expect(route).toContain("`404 NOT_FOUND` from the `hope.scope` guard");
  });
});
