/**
 * M10L — the Drizzle HOPE write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role: record a draft (linked to its open schedule) ·
 * sign (server-authoritative J2051 verdict; the DB schedule-mark-completed trigger closes the schedule, a
 * fired trigger opens the SFV in the same tx) · correct (the append-only amendment whose insert fires the
 * DB supersede trigger and reuses the original's target_date) · SFV completion · schedule skip · submission
 * assemble/retry · summary-PDF request. Like the M7/M8/M9 write suites it binds the REAL catalog-validating
 * transactional publisher (buildBootOutboxCatalog([M10_OUTBOX_EVENTS]) → the caller's tx) and asserts the
 * `m10.hope.*` rows land in `outbox_event`. RLS is exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m10:write:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { DEFAULT_ORG_TIME_ZONE, orgLocalDate } from "@wardenx/hope";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type HopeWriteOutboxPort,
  M10_OUTBOX_EVENTS,
  buildM10AdmissionSchedulingConsumer,
  createDbHopeBackend,
} from "../src/modules/10-hope/index";
import {
  type M10WorkerDeps,
  runAssembleSubmissionCron,
  runHopeWindowWatchdogCron,
  runIqiesReconcileCron,
  runIqiesSubmitCron,
  runSfvWatchdogCron,
} from "../src/modules/10-hope/jobs/cron-workers";
import { releaseSubmission } from "../src/modules/10-hope/jobs/submission-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
/** J2051 fires at `moderate` or higher; `mild` does not. */
const TRIGGER_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "moderate" }] } } };
const QUIET_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] } } };

describe.skipIf(!DB_URL)("M10 HOPE write lifecycle — LIVE Postgres (M10L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbHopeBackend>;
  /** #48 — the same catalog-validating publisher the service uses, handed to the scheduling consumer
   * and the watchdog cron so their `m10.hope.*` emits are validated against the boot catalog too. */
  let consumerOutbox: HopeWriteOutboxPort;
  const memberOf: Record<string, string> = {};
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  let admSeq = 0x77000000;
  const nextAdmission = (): string => {
    admSeq += 1;
    return `77000000-0000-4000-8000-${admSeq.toString(16).padStart(12, "0")}`;
  };

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

  /** Seed an open schedule for (admission, rfa) as superuser; returns its id. */
  async function seedSchedule(
    org: string,
    admissionId: string,
    rfaKind = "01_admission",
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6, now(), now() + interval '5 days', now() + interval '10 days', '{}'::jsonb, 'auto_admission')
         RETURNING id`,
        [org, providerOf[org], locationOf[org], PATIENT, admissionId, rfaKind],
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m10w@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-M10W-${org.slice(0, 4)}`,
            `M10W ${org.slice(0, 4)}`,
            `NPI-M10W-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerOf[org]],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
    const outbox: HopeWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m10" }),
    };
    svc = createDbHopeBackend(handle.db, outbox);
    consumerOutbox = outbox;
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const recordArgs = (data: Record<string, unknown>) => ({
    rfaKind: "01_admission" as const,
    targetDate: new Date().toISOString(),
    authorDiscipline: "RN",
    data,
  });

  /**
   * #45 — M6's `AdmissionStatusReader`, the seam `recordTimepoint` now resolves the SUBJECT of the
   * record through. Registered before every test because recording is no longer willing to guess: it
   * used to write the `admissionId` into `patient_id` whenever the schedule lookup missed, and
   * `hope_assessment.patient_id` has no FK to catch that.
   */
  function registerAdmissionReader(
    over: { patientId?: string; organizationId?: string } = {},
  ): void {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async (admissionId: string) => ({
        admissionId,
        patientId: over.patientId ?? PATIENT,
        organizationId: over.organizationId ?? ORG_A,
        providerEntityId: providerOf[ORG_A],
        locationId: locationOf[ORG_A],
        status: "active",
        admissionAt: "2026-01-05",
        activatedAt: "2026-01-05",
        dischargedAt: null,
        currentElectionPeriodId: null,
        currentLevelOfCare: "routine_home_care",
      }),
    });
  }

  beforeEach(() => registerAdmissionReader());

  it("record → sign (no J2051) closes the linked schedule and emits timepoint_signed", async () => {
    const adm = nextAdmission();
    const sched = await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    expect(draft.status).toBe("draft");
    const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
    expect(signed.status).toBe("signed");
    expect(signed.j2051TriggerFired).toBe(false);
    // The AFTER-UPDATE trigger closed the schedule.
    const back = await svc.getSchedule(ORG_A, sched);
    expect(back.status).toBe("completed");
    expect(await eventsFor(draft.id)).toContain("m10.hope.timepoint_signed");
  });

  it("sign with a J2051 moderate trigger opens the SFV; recordSfv completes it", async () => {
    const adm = nextAdmission();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(TRIGGER_DATA));
    const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
    expect(signed.j2051TriggerFired).toBe(true);
    const events = await eventsFor(draft.id);
    expect(events).toContain("m10.hope.timepoint_signed");
    expect(events).toContain("m10.hope.j2051_trigger_fired");
    const { sfvs } = await svc.listSfv(ORG_A, "open");
    const sfv = sfvs.find((s) => s.triggeringAssessmentId === draft.id);
    expect(sfv).toBeDefined();
    expect(await eventsFor(sfv!.id)).toContain("m10.hope.sfv_created");
    // Complete the SFV with an RFA-04 row.
    const completion = await svc.recordSfv(ORG_A, memberOf[ORG_A], adm, {
      triggeringAssessmentId: draft.id,
      targetDate: new Date().toISOString(),
      authorDiscipline: "RN",
      data: QUIET_DATA,
    });
    expect(completion.status).toBe("signed");
    const done = await svc.getSfv(ORG_A, sfv!.id);
    expect(done.status).toBe("completed");
    expect(await eventsFor(sfv!.id)).toContain("m10.hope.sfv_completed");
  });

  // ── GAP-019 — the §D8 clinical-context snapshot + its compensating warning finding ───────────────
  //
  // The DB backend used to skip D8 entirely: `clinical_context_snapshot` was written only by a
  // CORRECTION copying the original's (always-null) value, so no production HOPE assessment has ever
  // carried the PPS/ESAS-r context D8 exists to preserve — and the spec's compensating control ("if no
  // PPS is on file at signing, the validator emits a warning-severity finding") did not exist either,
  // so the gap was invisible to compliance review rather than merely non-blocking.
  describe("D8 clinical-context snapshot at sign (GAP-019)", () => {
    /** Register the M9 + M6 seams the sign path reads. `pps` null ⇒ the missing-PPS case. */
    function seams(scores: { pps: number | null; esas_r: number | null } | "unavailable"): void {
      registerSeam("AdmissionStatusReader", {
        getAdmissionSummary: async (admissionId: string) => ({
          admissionId,
          patientId: PATIENT,
          organizationId: ORG_A,
          providerEntityId: providerOf[ORG_A],
          locationId: locationOf[ORG_A],
          status: "active",
          admissionAt: "2026-01-05",
          activatedAt: "2026-01-05",
          dischargedAt: null,
          currentElectionPeriodId: null,
          currentLevelOfCare: "routine_home_care",
        }),
      });
      registerSeam("LatestAssessmentProvider", {
        latestBatch: async (_patientId: string, scaleTypes: readonly string[]) => {
          if (scores === "unavailable") throw new Error("M9 seam unavailable");
          return scaleTypes.flatMap((scaleType) => {
            const score = scores[scaleType as "pps" | "esas_r"];
            return score === null ? [] : [{ scaleType, score }];
          });
        },
      });
    }

    async function d8Findings(assessmentId: string): Promise<Array<{ severity: string }>> {
      const { rows } = await admin.query(
        "SELECT severity, rule_id, message FROM hope_validation_finding WHERE hope_assessment_id=$1 AND rule_id=$2",
        [assessmentId, "D8_CLINICAL_CONTEXT_PPS_MISSING"],
      );
      return rows;
    }

    afterEach(() => __resetSeamsForTest());

    it("snapshots PPS + ESAS-r onto the signed row, and writes NO warning finding", async () => {
      seams({ pps: 60, esas_r: 4 });
      const adm = nextAdmission();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      expect(signed.snapshot).toEqual({ pps: 60, esas_r: 4 });
      expect(await d8Findings(draft.id)).toHaveLength(0);
    });

    it("records the snapshot AND a warning finding when no PPS is on file", async () => {
      // "we looked and there was none" is a different fact from "we never looked", so the snapshot is
      // still written — with a null pps — beside the finding.
      seams({ pps: null, esas_r: 7 });
      const adm = nextAdmission();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      expect(signed.status).toBe("signed"); // §7.13 — never blocking
      expect(signed.snapshot).toEqual({ pps: null, esas_r: 7 });
      const findings = await d8Findings(draft.id);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("warning");
    });

    it("still signs, and still records the finding, when the M9 seam cannot be reached at all", async () => {
      seams("unavailable");
      const adm = nextAdmission();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      expect(signed.status).toBe("signed");
      expect(signed.snapshot).toBeNull();
      expect(await d8Findings(draft.id)).toHaveLength(1);
    });

    it("with no seams registered at all the signature still succeeds (the old behaviour, unblocked)", async () => {
      const adm = nextAdmission();
      await seedSchedule(ORG_A, adm);
      // The draft is recorded WITH the M6 seam (#45 — the subject of the record may not be guessed),
      // then every seam is dropped before signing. That asymmetry is the point: enrichment degrades
      // per §7.13, identity does not.
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      __resetSeamsForTest();
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      expect(signed.status).toBe("signed");
      expect(signed.snapshot).toBeNull();
      // The finding row needs the NOT NULL siting the M6 seam supplies, so it cannot be written here —
      // the service logs that instead of dropping it silently.
      expect(await d8Findings(draft.id)).toHaveLength(0);
    });
  });

  it("correct a signed timepoint supersedes the original (DB trigger), reuses target_date, emits correction_submitted", async () => {
    const adm = nextAdmission();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
    const corrected = await svc.correctTimepoint(ORG_A, memberOf[ORG_A], signed.id, {
      correctionReason: "corrected section J after re-review",
      targetDate: new Date(Date.now() + 86_400_000).toISOString(), // ignored — the FK reuses the original's
      authorDiscipline: "RN",
      data: TRIGGER_DATA,
    });
    expect(corrected.correctsAssessmentId).toBe(signed.id);
    expect(corrected.targetDate).toBe(signed.targetDate); // composite self-FK forces the reuse
    const original = await svc.getAssessment(ORG_A, signed.id);
    expect(original.status).toBe("superseded");
    expect(original.supersededByAssessmentId).toBe(corrected.id);
    expect(await eventsFor(corrected.id)).toContain("m10.hope.correction_submitted");
    // Correcting the now-superseded original is refused (409).
    await expect(
      svc.correctTimepoint(ORG_A, memberOf[ORG_A], signed.id, {
        correctionReason: "second attempt on a superseded row",
        targetDate: new Date().toISOString(),
        authorDiscipline: "RN",
        data: QUIET_DATA,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("updateDraft merges into a draft; a signed row cannot be edited (409) and cannot correct a draft (409)", async () => {
    const adm = nextAdmission();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    const updated = await svc.updateDraft(ORG_A, draft.id, { A: { A1: "x" } });
    expect(updated.status).toBe("draft");
    // Correcting a draft (not signed) is refused.
    await expect(
      svc.correctTimepoint(ORG_A, memberOf[ORG_A], draft.id, {
        correctionReason: "cannot correct a draft",
        targetDate: new Date().toISOString(),
        authorDiscipline: "RN",
        data: QUIET_DATA,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
    await expect(svc.updateDraft(ORG_A, draft.id, { A: { A1: "y" } })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("skipSchedule marks the schedule skipped", async () => {
    const adm = nextAdmission();
    const sched = await seedSchedule(ORG_A, adm);
    const skipped = await svc.skipSchedule(ORG_A, sched, "patient_declined");
    expect(skipped.status).toBe("skipped");
  });

  it("retry is refused unless the submission is rejected", async () => {
    // Seed a rejected submission → retry re-queues it. (F-058 moved the assemble half of this test into
    // its own describe below, because assemble no longer produces exactly one batch by construction.)
    const rejected = (
      await admin.query(
        `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
         VALUES ($1,$2,'2026-Q2','rejected',3) RETURNING id`,
        [ORG_A, providerOf[ORG_A]],
      )
    ).rows[0].id as string;
    const requeued = await svc.retrySubmission(ORG_A, rejected);
    expect(requeued.status).toBe("queued");
    await expect(svc.retrySubmission(ORG_A, rejected)).rejects.toMatchObject({ statusCode: 409 });
  });

  // ── F-058 (#150) — the §4.10 stage-1 assembler, at the row ───────────────────────────────────────
  //
  // `hope_submission_item` had NO writer anywhere in the repo: the only non-schema references were the
  // eraser (deleting rows nothing created) and the M10 RLS suite (inserting its own). The route that
  // claimed to force-assemble inserted a `hope_submission` with `itemCount: 0` and no items, ignoring
  // `planAssembleSubmissions` — which had shipped unit-tested with zero production callers since
  // M10-T07 — and answered 201 Created.
  //
  // These assertions are at the ROW because that is the only place the fix is real: the slice can prove
  // the grouping and the counts, but not that item rows exist, not that
  // `uniq_hope_sub_item_assessment_active` is now a barrier over a table something fills, and not that
  // `hope_assessment.provider_entity_id` carries the batch key. That column shipped NOT NULL in
  // migration 0034 for exactly this purpose — the schema header says so ("denormalized from the
  // admission … so submission batching and the iQIES ccn_at_election match run without joining M6") —
  // and 0130 relaxed it to nullable because the write path did not carry it. Nothing read it either, so
  // the relaxation cost nothing visible: the reader it existed for was the assembler, which did not
  // exist. Both ends are now real.
  describe("F-058 — assemble writes hope_submission_item", () => {
    /**
     * Batch away everything already eligible.
     *
     * The suite shares one database across its tests with no truncation between them, so assessments
     * signed by the tests above are eligible here. Draining first is what lets each case assert about
     * the rows IT created rather than about the suite's accumulated history.
     */
    async function drain(): Promise<void> {
      await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
    }

    /** Sign a fresh assessment so it becomes eligible for batching. */
    async function signOne(org: string): Promise<string> {
      const adm = nextAdmission();
      await seedSchedule(org, adm);
      const draft = await svc.recordTimepoint(org, memberOf[org], adm, recordArgs(QUIET_DATA));
      const signed = await svc.signTimepoint(org, memberOf[org], draft.id);
      return signed.id;
    }

    it("stamps the batch key on the assessment at record time", async () => {
      const id = await signOne(ORG_A);
      const { rows } = await admin.query(
        "SELECT provider_entity_id, location_id FROM hope_assessment WHERE id = $1",
        [id],
      );
      // Both columns were NULL on every row the platform had ever written. `hope_submission.provider_entity_id`
      // is NOT NULL, so with no batch key nothing could ever have been assembled.
      expect(rows[0].provider_entity_id).toBe(providerOf[ORG_A]);
      expect(rows[0].location_id).toBe(locationOf[ORG_A]);
    });

    it("creates a batch WITH its item rows, and the itemCount matches the rows", async () => {
      await drain();
      const a = await signOne(ORG_A);
      const b = await signOne(ORG_A);
      const res = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      // Both target dates are `now()`, so both land in the same CMS quarter — one batch, two items.
      expect(res.submissions.length).toBe(1);

      const batch = res.submissions[0];
      expect(batch?.itemCount).toBe(2);
      const { rows } = await admin.query(
        "SELECT hope_assessment_id, item_status FROM hope_submission_item WHERE hope_submission_id = $1",
        [batch?.id],
      );
      // The rows are the point: this table had no writer at all, so `itemCount` was a number with
      // nothing behind it.
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.hope_assessment_id).sort()).toEqual([a, b].sort());
      expect(rows.every((r) => r.item_status === "pending")).toBe(true);
      expect(await eventsFor(String(batch?.id))).toContain("m10.hope.submission_queued");
    });

    it("keys the period off the assessment's target date, not the clock", async () => {
      await drain();
      await signOne(ORG_A);
      const res = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      expect(res.submissions.length).toBe(1);
      // `YYYY-Qn`. The old route wrote `new Date().toISOString().slice(0, 7)` — `YYYY-MM` — which
      // nothing that reads a submission period could parse.
      expect(res.submissions[0]?.submissionPeriod).toMatch(/^\d{4}-Q[1-4]$/);
    });

    it("is idempotent: a second pass batches nothing and reports the skip", async () => {
      await drain();
      await signOne(ORG_A);
      const first = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      expect(first.submissions.length).toBe(1);
      const second = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      expect(second.submissions).toEqual([]);
      // NOT `1`. `drain()` batched the suite's whole history first, and every one of those rows is still
      // eligible-with-an-active-item on this pass — which is exactly what `skippedAlreadyBatched`
      // counts. The invariant that matters is order-independent: after a pass, nothing eligible is left
      // unbatched. (This assertion read `toBe(1)` and could never hold; it had never been run, because
      // `assembleSubmission` threw on its SECOND call for the whole life of the feature — F-086.)
      expect(second.skippedAlreadyBatched).toBe(second.assessmentsConsidered);
      expect(second.skippedAlreadyBatched).toBeGreaterThanOrEqual(1);
    });

    it("uniq_hope_sub_item_assessment_active refuses a second pending item for one assessment", async () => {
      // The partial unique index guarded a table nothing wrote. It is the backstop under two concurrent
      // assemblers that both read the same eligible set before either writes.
      await drain();
      const id = await signOne(ORG_A);
      await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      const sub = (
        await admin.query(
          `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
           VALUES ($1,$2,'2026-Q2','queued',1) RETURNING id`,
          [ORG_A, providerOf[ORG_A]],
        )
      ).rows[0].id as string;
      await expect(
        admin.query(
          `INSERT INTO hope_submission_item (organization_id, hope_submission_id, hope_assessment_id, item_status)
           VALUES ($1,$2,$3,'pending')`,
          [ORG_A, sub, id],
        ),
      ).rejects.toThrow(/uniq_hope_sub_item_assessment_active/);
    });

    it("a queued batch is not counted as a non-acceptance on the compliance dashboard", async () => {
      // The regression this change would otherwise have introduced: `submissionAcceptanceRate` divided
      // by every submission of any status, so assembling real batches would have shown 0% acceptance —
      // the §1.3 APU-penalty band — for work merely awaiting transmit.
      await drain();
      await signOne(ORG_A);
      const before = await svc.complianceDashboard(ORG_A, providerOf[ORG_A]);
      await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      const after = await svc.complianceDashboard(ORG_A, providerOf[ORG_A]);
      expect(after.submissionAcceptanceCounts.total).toBe(before.submissionAcceptanceCounts.total);
    });

    it("does not batch another tenant's assessments", async () => {
      await signOne(ORG_A);
      const res = await svc.assembleSubmission(ORG_B, providerOf[ORG_B]);
      expect(res.submissions).toEqual([]);
      expect(res.assessmentsConsidered).toBe(0);
    });
  });

  // ── F-072 (#177) — §4.10 stages 2 and 3, at the row ──────────────────────────────────────────────
  //
  // F-058 built the assembler. The submit and reconcile workers were still unbuilt, and with them five
  // pure planners with no production callers plus `hasBlockingError`, whose whole purpose is to gate a
  // transmit that had no transmit-time to run in. These prove the ORCHESTRATION the planners cannot:
  // the batch-level refusal, the CAS ordering around the adapter call, the roll-back that must never
  // un-transmit, and the partial acceptance report.
  //
  // The iQIES wire protocol is still absent and is not invented — these drive the typed `IqiesAdapter`
  // port with fakes, which is exactly what a real transport would replace.
  describe("F-072 — the iQIES submit + reconcile workers", () => {
    const orgs = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };

    function deps(over: Partial<M10WorkerDeps> = {}): M10WorkerDeps {
      return {
        connection: {} as never,
        db: handle.db,
        outbox: consumerOutbox as never,
        activeOrgs: orgs,
        validateItem: async () => [],
        // The CCN resolver is REQUIRED, not optional-with-a-default: unbound it rejects with
        // `M10_WORKER_PORT_UNBOUND` and the submit worker collects that into an `AggregateError`, so
        // every test in this block failed on its first tick regardless of what it was asserting. It went
        // unnoticed because `queuedBatch()` threw one layer earlier for the whole life of the block
        // (F-086) — the second `assembleSubmission` call raised a duplicate key — so no tick ever ran.
        // A real CCN shape, because `buildSubmissionEnvelope` puts it on the wire to CMS.
        providerEntityCcn: { ccnFor: async () => "341234" },
        now: () => new Date("2026-08-27T10:00:00.000Z"),
        ...over,
      } as M10WorkerDeps;
    }

    /**
     * Retire every batch the suite has already produced, the way an ACCEPTANCE would.
     *
     * Both crons sweep the ORG — every `queued` batch on a submit tick, every `in_flight` one on a
     * reconcile tick. That is what a real tick does and what makes them worth testing at all, and it
     * means a test that intends to observe ONE batch has to be the only batch in play: otherwise its
     * scripted adapter is asked about its neighbours' rows, throws, and the cron collects that into an
     * `AggregateError` the test never expected. Stamping the assessments' `iqies_record_id` is the half
     * that makes it stick — that column is one of the assembler's eligibility clauses, so without it the
     * next `drain()` simply re-batches the same rows.
     */
    async function retirePriorBatches(): Promise<void> {
      await admin.query(
        `UPDATE hope_assessment SET iqies_record_id = 'suite-retired'
          WHERE organization_id = $1
            AND id IN (SELECT hope_assessment_id FROM hope_submission_item WHERE organization_id = $1)`,
        [ORG_A],
      );
      await admin.query(
        `UPDATE hope_submission_item SET item_status = 'accepted', iqies_record_id = 'suite-retired'
          WHERE organization_id = $1 AND item_status = 'pending'`,
        [ORG_A],
      );
      await admin.query(
        `UPDATE hope_submission SET status = 'accepted', accepted_at = now(), accepted_count = item_count
          WHERE organization_id = $1 AND status IN ('queued','in_flight')`,
        [ORG_A],
      );
    }

    /** Sign a fresh assessment and assemble it, returning (assessmentId, submissionId). */
    async function queuedBatch(): Promise<{ assessmentId: string; submissionId: string }> {
      await svc.assembleSubmission(ORG_A, providerOf[ORG_A]); // drain the suite's history
      await retirePriorBatches(); // …and take it out of the crons' way
      const adm = nextAdmission();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      const res = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      const submissionId = res.submissions[0]?.id as string;
      expect(submissionId).toBeDefined();
      return { assessmentId: signed.id, submissionId };
    }

    async function submissionRow(id: string) {
      const { rows } = await admin.query("SELECT * FROM hope_submission WHERE id = $1", [id]);
      return rows[0];
    }

    it("transmits a clean batch: in_flight, batch id, digest, and submission_transmitted", async () => {
      const { submissionId } = await queuedBatch();
      const out = await runIqiesSubmitCron(
        deps({
          iqies: {
            submitBatch: async (req) => {
              // The envelope carries the PE's CCN and the batch's period — `buildSubmissionEnvelope`
              // had no production caller before this.
              expect(req.envelope.providerEntityCcn).toBeTruthy();
              expect(req.envelope.items.length).toBeGreaterThan(0);
              expect(req.correlationId).toBe(submissionId);
              return { iqiesBatchId: "iqies-1", transmittedAt: "2026-08-27T10:00:00.000Z" };
            },
            fetchAcceptanceReport: async () => ({ iqiesBatchId: "iqies-1", items: [] }),
          },
        }),
      );
      expect(out.transmitted).toContain(submissionId);
      const row = await submissionRow(submissionId);
      expect(row.status).toBe("in_flight");
      expect(row.iqies_batch_id).toBe("iqies-1");
      expect(row.envelope_sha256).toMatch(/^[0-9a-f]{64}$/);
      // Null deliberately: the key names the RENDERED submission XML and nothing renders it. The
      // digest does not depend on it.
      expect(row.envelope_storage_uri).toBeNull();
      expect(await eventsFor(submissionId)).toContain("m10.hope.submission_transmitted");
    });

    it("refuses the WHOLE batch when any item has a blocking error, and records why", async () => {
      const { assessmentId, submissionId } = await queuedBatch();
      const out = await runIqiesSubmitCron(
        deps({
          validateItem: async () => [
            {
              ruleId: "cms.section_i.missing",
              severity: "error" as const,
              section: "I",
              itemCode: null,
              message: "Section I is required before submission.",
            },
          ],
          iqies: {
            submitBatch: async () => {
              throw new Error("must not transmit a blocked batch");
            },
            fetchAcceptanceReport: async () => ({ iqiesBatchId: "x", items: [] }),
          },
        }),
      );
      expect(out.blocked).toContain(submissionId);
      // Never a partial transmit (§4.10) — the batch does not move at all.
      expect((await submissionRow(submissionId)).status).toBe("queued");
      const { rows } = await admin.query(
        "SELECT rule_id, severity FROM hope_validation_finding WHERE hope_assessment_id = $1 AND severity = 'error'",
        [assessmentId],
      );
      // The refusal is a row a clinician can see, not only a worker log line.
      expect(rows.length).toBeGreaterThan(0);
    });

    it("rolls a failed transmit back to queued so a later tick retries it", async () => {
      const { submissionId } = await queuedBatch();
      await expect(
        runIqiesSubmitCron(
          deps({
            iqies: {
              submitBatch: async () => {
                throw new Error("iqies unreachable");
              },
              fetchAcceptanceReport: async () => ({ iqiesBatchId: "x", items: [] }),
            },
          }),
        ),
      ).rejects.toBeInstanceOf(AggregateError);
      const row = await submissionRow(submissionId);
      // Back to queued, and — critically — with no batch id, so nothing believes CMS received it.
      expect(row.status).toBe("queued");
      expect(row.iqies_batch_id).toBeNull();
    });

    it("never un-transmits: a batch that reached iQIES is not rolled back", async () => {
      // `releaseSubmission` is guarded on `iqies_batch_id IS NULL`. This drives the guard directly,
      // because the ordering it protects (CAS → adapter → record) has no other observable.
      const { submissionId } = await queuedBatch();
      await runIqiesSubmitCron(
        deps({
          iqies: {
            submitBatch: async () => ({
              iqiesBatchId: "iqies-2",
              transmittedAt: "2026-08-27T10:00:00.000Z",
            }),
            fetchAcceptanceReport: async () => ({ iqiesBatchId: "iqies-2", items: [] }),
          },
        }),
      );
      // Through `withOrgContext`, the way the cron calls it. On the bare pool the M4 audit trigger has
      // no `app.user_id` to attribute the write to and the statement dies casting `''` to uuid — the
      // store functions in this module are all transaction-scoped by contract.
      await withOrgContext(handle.db, { organizationId: ORG_A, userId: memberOf[ORG_A] }, (tx) =>
        releaseSubmission(tx as never, ORG_A, submissionId),
      );
      const row = await submissionRow(submissionId);
      expect(row.status).toBe("in_flight");
      expect(row.iqies_batch_id).toBe("iqies-2");
    });

    it("reconciles acceptance: item accepted, assessment stamped, submission_accepted emitted", async () => {
      const { assessmentId, submissionId } = await queuedBatch();
      await runIqiesSubmitCron(
        deps({
          iqies: {
            submitBatch: async () => ({
              iqiesBatchId: "iqies-3",
              transmittedAt: "2026-08-27T10:00:00.000Z",
            }),
            fetchAcceptanceReport: async () => ({ iqiesBatchId: "iqies-3", items: [] }),
          },
        }),
      );
      const out = await runIqiesReconcileCron(
        deps({
          iqies: {
            submitBatch: async () => {
              throw new Error("not used");
            },
            fetchAcceptanceReport: async () => ({
              iqiesBatchId: "iqies-3",
              items: [
                {
                  hopeAssessmentId: assessmentId,
                  outcome: "accepted" as const,
                  iqiesRecordId: "rec-1",
                  findings: [],
                },
              ],
            }),
          },
        }),
      );
      expect(out.reconciled).toContain(submissionId);
      const row = await submissionRow(submissionId);
      expect(row.status).toBe("accepted");
      expect(row.accepted_count).toBe(1);
      expect(row.accepted_at).not.toBeNull();
      const item = (
        await admin.query(
          "SELECT item_status, iqies_record_id FROM hope_submission_item WHERE hope_submission_id = $1",
          [submissionId],
        )
      ).rows[0];
      expect(item.item_status).toBe("accepted");
      expect(item.iqies_record_id).toBe("rec-1");
      // The assessment's own terminal marker — half the assembler's eligibility rule, so without this
      // an accepted assessment would be re-batched forever.
      const assess = (
        await admin.query("SELECT iqies_record_id FROM hope_assessment WHERE id = $1", [
          assessmentId,
        ])
      ).rows[0];
      expect(assess.iqies_record_id).toBe("rec-1");
      expect(await eventsFor(submissionId)).toContain("m10.hope.submission_accepted");
    });

    // F-086 — the D7 correction chain reaches the CMS envelope.
    //
    // `correctsIqiesRecordId` is the field that tells iQIES this record REPLACES an accepted one rather
    // than being a new submission. It is resolved by a correlated self-join on `corrects_assessment_id`,
    // and the identical fragment in `assemble-store.ts` answered null for every row because Drizzle
    // rendered its outer column unqualified — inside `from hope_assessment o` that resolved to
    // `o.corrects_assessment_id`, so the predicate was `o.id = o.corrects_assessment_id`. The copy that
    // actually reaches the wire (`pendingItemsForSubmission`) has a join, so Drizzle qualified it and it
    // was right — by accident. Both go through one helper now, and this is what pins the behaviour.
    it("carries the accepted original's iQIES record id on a correction's envelope item", async () => {
      const { assessmentId, submissionId } = await queuedBatch();
      const accepted = deps({
        iqies: {
          submitBatch: async () => ({
            iqiesBatchId: "iqies-c1",
            transmittedAt: "2026-08-27T10:00:00.000Z",
          }),
          fetchAcceptanceReport: async () => ({
            iqiesBatchId: "iqies-c1",
            items: [
              {
                hopeAssessmentId: assessmentId,
                outcome: "accepted" as const,
                iqiesRecordId: "rec-original",
                findings: [],
              },
            ],
          }),
        },
      });
      await runIqiesSubmitCron(accepted);
      await runIqiesReconcileCron(accepted);
      expect((await submissionRow(submissionId)).status).toBe("accepted");

      // Correct the accepted original and batch the correction. A correction is written already SIGNED
      // (§7.8 — a correction of record is authored and attested in one act), so it is eligible at once.
      const corrected = await svc.correctTimepoint(ORG_A, memberOf[ORG_A], assessmentId, {
        correctionReason: "corrected section J after re-review",
        targetDate: new Date().toISOString(),
        authorDiscipline: "RN",
        data: QUIET_DATA,
      });
      const res = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      expect(res.submissions.length).toBe(1);

      let seen: ReadonlyArray<{ hopeAssessmentId: string; correctsIqiesRecordId: string | null }> =
        [];
      await runIqiesSubmitCron(
        deps({
          iqies: {
            submitBatch: async (req) => {
              seen = req.envelope.items;
              return { iqiesBatchId: "iqies-c2", transmittedAt: "2026-08-27T10:00:00.000Z" };
            },
            fetchAcceptanceReport: async () => ({ iqiesBatchId: "iqies-c2", items: [] }),
          },
        }),
      );
      const item = seen.find((i) => i.hopeAssessmentId === corrected.id);
      expect(item).toBeDefined();
      expect(item?.correctsIqiesRecordId).toBe("rec-original");
    });

    it("reconciles rejection: item rejected, finding written, assessment NOT stamped", async () => {
      const { assessmentId, submissionId } = await queuedBatch();
      await runIqiesSubmitCron(
        deps({
          iqies: {
            submitBatch: async () => ({
              iqiesBatchId: "iqies-4",
              transmittedAt: "2026-08-27T10:00:00.000Z",
            }),
            fetchAcceptanceReport: async () => ({ iqiesBatchId: "iqies-4", items: [] }),
          },
        }),
      );
      await runIqiesReconcileCron(
        deps({
          iqies: {
            submitBatch: async () => {
              throw new Error("not used");
            },
            fetchAcceptanceReport: async () => ({
              iqiesBatchId: "iqies-4",
              items: [
                {
                  hopeAssessmentId: assessmentId,
                  outcome: "rejected" as const,
                  iqiesRecordId: null,
                  findings: [{ ruleId: "iqies.E0100", message: "Item J2051 is out of range." }],
                },
              ],
            }),
          },
        }),
      );
      const row = await submissionRow(submissionId);
      expect(row.status).toBe("rejected");
      expect(row.rejected_count).toBe(1);
      // A wholly rejected batch has an ANSWER but nothing accepted; stamping accepted_at would make
      // the column mean "answered".
      expect(row.accepted_at).toBeNull();
      const assess = (
        await admin.query("SELECT iqies_record_id FROM hope_assessment WHERE id = $1", [
          assessmentId,
        ])
      ).rows[0];
      // Stamping a rejected item would make it permanently unsubmittable — `iqies_record_id IS NULL`
      // is half the assembler's eligibility rule.
      expect(assess.iqies_record_id).toBeNull();
      const findings = (
        await admin.query(
          "SELECT rule_id FROM hope_validation_finding WHERE hope_assessment_id = $1 AND rule_id = 'iqies.E0100'",
          [assessmentId],
        )
      ).rows;
      expect(findings.length).toBe(1);
      expect(await eventsFor(submissionId)).toContain("m10.hope.submission_rejected");
    });

    it("leaves a batch in_flight when the acceptance report answers none of its items", async () => {
      // A partial or empty report must not be folded as a wholly accepted batch — `planReconcile`
      // derives status from the outcomes it is GIVEN, so handing it an empty set would score 0/0 as
      // `accepted`. The next tick asks again.
      const { submissionId } = await queuedBatch();
      await runIqiesSubmitCron(
        deps({
          iqies: {
            submitBatch: async () => ({
              iqiesBatchId: "iqies-5",
              transmittedAt: "2026-08-27T10:00:00.000Z",
            }),
            fetchAcceptanceReport: async () => ({ iqiesBatchId: "iqies-5", items: [] }),
          },
        }),
      );
      const out = await runIqiesReconcileCron(
        deps({
          iqies: {
            submitBatch: async () => {
              throw new Error("not used");
            },
            fetchAcceptanceReport: async () => ({ iqiesBatchId: "iqies-5", items: [] }),
          },
        }),
      );
      expect(out.reconciled).not.toContain(submissionId);
      expect((await submissionRow(submissionId)).status).toBe("in_flight");
    });

    it("the unbound adapter fails the job loudly instead of leaving the batch silent", async () => {
      // This is the property that let the `assemble-hope-submission` cron be registered at all. With
      // no transport, a queued batch used to sit forever with nothing reporting it; now the worker
      // raises, BullMQ DLQs the job, and `attachDlqAlertsToAll` surfaces it.
      const { submissionId } = await queuedBatch();
      await expect(runIqiesSubmitCron(deps({ iqies: undefined }))).rejects.toBeInstanceOf(
        AggregateError,
      );
      expect((await submissionRow(submissionId)).status).toBe("queued");
    });

    it("the assemble cron batches org-wide, across provider entities", async () => {
      // The route assembles for ONE named CCN; the cron has no operator naming one, so it groups
      // across all of them.
      await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
      const adm = nextAdmission();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      const out = await runAssembleSubmissionCron(deps());
      expect(out.submissionsCreated).toBe(1);
      expect(out.assessmentsBatched).toBe(1);
    });
  });

  it("requestSummaryPdf emits summary_requested for a real assessment", async () => {
    const adm = nextAdmission();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    const res = await svc.requestSummaryPdf(ORG_A, memberOf[ORG_A], draft.id);
    expect(res).toEqual({ assessmentId: draft.id, requested: true });
    expect(await eventsFor(draft.id)).toContain("m10.hope.summary_requested");
  });

  // ── #48 — the timepoint-schedule WRITE path, proven at the row ───────────────────────────────────
  //
  // `hope_timepoint_schedule` is the §2.2.1 window ledger the CMS capture gate, the watchdog cron, the
  // late-deadline math, the worklist and the on-time compliance rate all sit on, and nothing in the repo
  // ever inserted a row into it. Every test above seeds one by hand as superuser, which is exactly how
  // the gap survived: the suite proved what the service does WITH a window and never asked where one
  // comes from.
  describe("#48 — hope_timepoint_schedule is written", () => {
    const consumer = () =>
      buildM10AdmissionSchedulingConsumer({ db: handle.db, outbox: consumerOutbox });

    async function schedulesFor(admissionId: string) {
      const { rows } = await admin.query(
        `SELECT rfa_kind, status, generated_by, window_opens_at, window_closes_at, late_deadline_at,
                provider_entity_id, location_id, patient_id
           FROM hope_timepoint_schedule WHERE admission_id=$1 ORDER BY rfa_kind`,
        [admissionId],
      );
      return rows as Array<Record<string, string | Date>>;
    }

    it("materializes the three admission-anchored CMS windows on m6.admission.activated", async () => {
      const adm = nextAdmission();
      await consumer().handle({
        organizationId: ORG_A,
        eventType: "m6.admission.activated",
        payload: { admissionId: adm, patientId: PATIENT, activatedAt: "2026-06-01T18:00:00.000Z" },
      });
      const rows = await schedulesFor(adm);
      expect(rows.map((r) => r.rfa_kind)).toEqual(["01_admission", "02_huv1", "03_huv2"]);
      expect(rows.every((r) => r.status === "open")).toBe(true);
      expect(rows.every((r) => r.generated_by === "auto_admission")).toBe(true);
      // Sited from the M6 seam — the NOT NULL columns that make a guessed placement impossible.
      expect(rows.every((r) => r.provider_entity_id === providerOf[ORG_A])).toBe(true);
      expect(rows.every((r) => r.location_id === locationOf[ORG_A])).toBe(true);
      expect(rows.every((r) => r.patient_id === PATIENT)).toBe(true);

      // The CMS day offsets, read back through a DIFFERENT function than the one that wrote them
      // (orgLocalDate vs startOfOrgDayInstant), so this is not the calculator asserting on itself.
      const asLocal = (d: Date) => orgLocalDate(d.toISOString(), DEFAULT_ORG_TIME_ZONE);
      const admissionRow = rows[0] as {
        window_opens_at: Date;
        window_closes_at: Date;
        late_deadline_at: Date;
      };
      expect(asLocal(admissionRow.window_opens_at)).toBe("2026-06-01"); // SOC = day 1
      expect(asLocal(admissionRow.window_closes_at)).toBe("2026-06-05"); // days 1–5
      expect(asLocal(admissionRow.late_deadline_at)).toBe("2026-06-12"); // + the 7-day D2 grace
      const huv1 = rows[1] as { window_opens_at: Date; window_closes_at: Date };
      expect(asLocal(huv1.window_opens_at)).toBe("2026-06-06"); // days 6–15
      expect(asLocal(huv1.window_closes_at)).toBe("2026-06-15");
      const huv2 = rows[2] as { window_opens_at: Date; window_closes_at: Date };
      expect(asLocal(huv2.window_opens_at)).toBe("2026-06-16"); // days 16–30
      expect(asLocal(huv2.window_closes_at)).toBe("2026-06-30");

      // §2.4 — `m10.hope.timepoint_scheduled` was declared in the catalog and never once emitted.
      const events = await admin.query(
        "SELECT event_type FROM outbox_event WHERE event_type=$1 AND organization_id=$2",
        ["m10.hope.timepoint_scheduled", ORG_A],
      );
      expect(events.rows.length).toBeGreaterThanOrEqual(3);
    });

    it("materializes the single 7-day Discharge RFA window on m6.admission.discharged (D9)", async () => {
      const adm = nextAdmission();
      await consumer().handle({
        organizationId: ORG_A,
        eventType: "m6.admission.discharged",
        payload: { admissionId: adm, reason: "death", dischargeDate: "2026-07-02" },
      });
      const rows = await schedulesFor(adm);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.rfa_kind).toBe("05_discharge");
      expect(rows[0]!.generated_by).toBe("auto_discharge");
      const asLocal = (d: Date) => orgLocalDate(d.toISOString(), DEFAULT_ORG_TIME_ZONE);
      expect(asLocal(rows[0]!.window_opens_at as Date)).toBe("2026-07-02");
      expect(asLocal(rows[0]!.window_closes_at as Date)).toBe("2026-07-08"); // 7 calendar days
    });

    it("is idempotent on redelivery — including after a window has been closed", async () => {
      const adm = nextAdmission();
      const deliver = () =>
        consumer().handle({
          organizationId: ORG_A,
          eventType: "m6.admission.activated",
          payload: {
            admissionId: adm,
            patientId: PATIENT,
            activatedAt: "2026-06-01T18:00:00.000Z",
          },
        });
      await deliver();
      // The schema's `uniq_hope_sched_admission_rfa_open` partial index only covers `status='open'`, so
      // a closed window would let a redelivery mint a SECOND obligation for the same RFA. Closing one
      // first is what makes this a real idempotency test rather than an index test.
      await admin.query(
        "UPDATE hope_timepoint_schedule SET status='completed' WHERE admission_id=$1 AND rfa_kind='01_admission'",
        [adm],
      );
      await deliver();
      await deliver();
      const rows = await schedulesFor(adm);
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.rfa_kind === "01_admission")).toHaveLength(1);
    });

    it("refuses an unsited admission and writes NOTHING", async () => {
      const adm = nextAdmission();
      registerSeam("AdmissionStatusReader", {
        getAdmissionSummary: async (admissionId: string) => ({
          admissionId,
          patientId: PATIENT,
          organizationId: ORG_A,
          providerEntityId: providerOf[ORG_A],
          locationId: null, // activation never sited it
          status: "active",
          admissionAt: "2026-06-01",
          activatedAt: "2026-06-01",
          dischargedAt: null,
          currentElectionPeriodId: null,
          currentLevelOfCare: "routine_home_care",
        }),
      });
      await expect(
        consumer().handle({
          organizationId: ORG_A,
          eventType: "m6.admission.activated",
          payload: {
            admissionId: adm,
            patientId: PATIENT,
            activatedAt: "2026-06-01T18:00:00.000Z",
          },
        }),
      ).rejects.toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP" });
      expect(await schedulesFor(adm)).toHaveLength(0);
    });

    it("refuses another tenant's admission", async () => {
      const adm = nextAdmission();
      await expect(
        consumer().handle({
          organizationId: ORG_B, // the seam answers for ORG_A
          eventType: "m6.admission.activated",
          payload: {
            admissionId: adm,
            patientId: PATIENT,
            activatedAt: "2026-06-01T18:00:00.000Z",
          },
        }),
      ).rejects.toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP" });
      expect(await schedulesFor(adm)).toHaveLength(0);
    });

    it("route 20 regenerate actually regenerates, idempotently (it used to be a count)", async () => {
      // The seam stub reports activatedAt 2026-01-05 and no discharge, so the admin path materializes
      // the same three admission-anchored windows from the admission's own state. This is the supported
      // way to backfill an admission activated before the scheduling consumer shipped.
      const adm = nextAdmission();
      expect(await schedulesFor(adm)).toHaveLength(0);
      const first = await svc.regenerateSchedules(ORG_A, adm);
      expect(first.scheduleCount).toBe(3);
      const second = await svc.regenerateSchedules(ORG_A, adm);
      expect(second.scheduleCount).toBe(3); // no duplicates
      expect(await schedulesFor(adm)).toHaveLength(3);
    });

    it("links the draft to its open window, and the sign trigger then closes it", async () => {
      // The DB trigger `trg_hope_schedule_mark_completed` fires on draft→signed WHERE schedule_id IS NOT
      // NULL. `hope_assessment.schedule_id` was ALWAYS null in production (no schedule existed to link),
      // so the trigger had nothing to close and the whole completion half of the ledger was dead.
      const adm = nextAdmission();
      await consumer().handle({
        organizationId: ORG_A,
        eventType: "m6.admission.activated",
        payload: {
          admissionId: adm,
          patientId: PATIENT,
          activatedAt: new Date().toISOString(),
        },
      });
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      const linked = await admin.query("SELECT schedule_id FROM hope_assessment WHERE id=$1", [
        draft.id,
      ]);
      expect(linked.rows[0].schedule_id).not.toBeNull();
      await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      const closed = await admin.query(
        "SELECT status, completed_by_assessment_id FROM hope_timepoint_schedule WHERE id=$1",
        [linked.rows[0].schedule_id],
      );
      expect(closed.rows[0].status).toBe("completed");
      expect(closed.rows[0].completed_by_assessment_id).toBe(draft.id);
    });

    it("the hope-window-watchdog cron expires a real overdue window end to end", async () => {
      // The cron reads `openHopeSchedulesForOrg`, which was an always-empty set, so
      // `m10.hope.timepoint_expired` could never be emitted and no missed HOPE timepoint was ever
      // detected. With a real row it transitions and publishes.
      const adm = nextAdmission();
      await consumer().handle({
        organizationId: ORG_A,
        eventType: "m6.admission.activated",
        payload: { admissionId: adm, patientId: PATIENT, activatedAt: "2026-06-01T18:00:00.000Z" },
      });
      await runHopeWindowWatchdogCron({
        connection: {} as never,
        db: handle.db,
        outbox: consumerOutbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        now: () => new Date("2027-01-01T00:00:00.000Z"), // long past every late deadline
      });
      const rows = await schedulesFor(adm);
      expect(rows.every((r) => r.status === "expired")).toBe(true);
      const events = await admin.query(
        `SELECT DISTINCT event_type FROM outbox_event
           WHERE event_type='m10.hope.timepoint_expired' AND organization_id=$1`,
        [ORG_A],
      );
      expect(events.rows).toHaveLength(1);
    });

    it("the sfv-watchdog cron completes a transition too (the same actor sentinel)", async () => {
      // Not this issue's subject, but the same one-line defect: both watchdogs carried a synthetic
      // `app.user_id` with no `user` row, so every status change died on the audit trigger's FK. The
      // WINDOW watchdog never showed it because the table it reads was always empty; this one reads
      // rows that DO exist, so it has been dying every 15 minutes wherever an SFV went past due. This
      // test is what turns that from a claim into a fact.
      const adm = nextAdmission();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(
        ORG_A,
        memberOf[ORG_A],
        adm,
        recordArgs(TRIGGER_DATA),
      );
      await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      const { sfvs } = await svc.listSfv(ORG_A, "open");
      const sfv = sfvs.find((x) => x.triggeringAssessmentId === draft.id);
      expect(sfv).toBeDefined();

      await runSfvWatchdogCron({
        connection: {} as never,
        db: handle.db,
        outbox: consumerOutbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        now: () => new Date("2027-01-01T00:00:00.000Z"), // long past every SFV due date
      });
      const after = await admin.query("SELECT status FROM symptom_follow_up_visit WHERE id=$1", [
        sfv!.id,
      ]);
      expect(after.rows[0].status).not.toBe("open");
    });
  });

  // ── #45 — the subject of a HOPE record, proven at the row ────────────────────────────────────────
  //
  // Every test above seeds an open schedule first, which is why none of them ever exercised the
  // fallback. Production seeds none — no code in the repo inserts a `hope_timepoint_schedule` row — so
  // the fallback was the ONLY path a real deployment took, and it wrote the `admissionId` into
  // `patient_id`. The column has no FK (the corpus keeps them inside the owning module), so Postgres
  // accepted it and the damage surfaced far away, as a 404 on the sign route.
  describe("#45 — hope_assessment.patient_id is a patient", () => {
    const patientIdOf = async (assessmentId: string): Promise<string> =>
      (await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [assessmentId]))
        .rows[0].patient_id as string;

    it("with NO schedule row, the stored patient_id is the admission's patient", async () => {
      const adm = nextAdmission(); // deliberately no seedSchedule — the production shape
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      expect(await patientIdOf(draft.id)).toBe(PATIENT);
      expect(await patientIdOf(draft.id)).not.toBe(adm);
      // The §4.7 resolver `hope.scope` reads on every assessment-scoped route (sign/correct/get).
      expect((await svc.loadAssessment(ORG_A, draft.id))?.patientId).toBe(PATIENT);
    });

    it("carries the real patient onto the SFV row the J2051 trigger opens", async () => {
      // The corruption used to propagate: sign copies the assessment's patient_id onto the SFV, and
      // completing the SFV copies it back onto the RFA-04 assessment.
      const adm = nextAdmission();
      const draft = await svc.recordTimepoint(
        ORG_A,
        memberOf[ORG_A],
        adm,
        recordArgs(TRIGGER_DATA),
      );
      await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      const { rows } = await admin.query(
        "SELECT patient_id FROM symptom_follow_up_visit WHERE triggering_assessment_id=$1",
        [draft.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].patient_id).toBe(PATIENT);
      const completion = await svc.recordSfv(ORG_A, memberOf[ORG_A], adm, {
        triggeringAssessmentId: draft.id,
        targetDate: new Date().toISOString(),
        authorDiscipline: "RN",
        data: QUIET_DATA,
      });
      expect(await patientIdOf(completion.id)).toBe(PATIENT);
    });

    it("refuses (422) and writes NOTHING when the M6 seam cannot project the admission", async () => {
      const adm = nextAdmission();
      registerSeam("AdmissionStatusReader", {
        getAdmissionSummary: async () => {
          throw new Error("M6 seam projection gap: admission is missing provider_entity_id");
        },
      });
      await expect(
        svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA)),
      ).rejects.toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
      const { rows } = await admin.query("SELECT id FROM hope_assessment WHERE admission_id=$1", [
        adm,
      ]);
      expect(rows).toHaveLength(0); // refused BEFORE the transaction, not rolled back after a write
    });

    it("refuses when the seam answers about another tenant's admission", async () => {
      const adm = nextAdmission();
      registerAdmissionReader({ organizationId: ORG_B });
      await expect(
        svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA)),
      ).rejects.toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    });

    it("refuses when the M6 seam is not registered at all", async () => {
      const adm = nextAdmission();
      __resetSeamsForTest();
      await expect(
        svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA)),
      ).rejects.toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    });
  });

  // ── #45 — migration 0215, the repair of rows the defect already wrote ─────────────────────────────
  describe("#45 — migration 0215 repairs rows already written", () => {
    const REPAIR_SQL = readFileSync(
      join(MIGRATIONS_DIR, "0217_m10_hope_patient_id_repair.sql"),
      "utf8",
    );
    /** Seed a real `admission` row (its patient_id is the truth the repair reads). */
    async function seedAdmission(org: string, patientId: string): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id,
             admitted_by_physician_id, status, admission_at)
           VALUES ($1,$2,$3,$4,gen_random_uuid(),'active', now()) RETURNING id`,
          [org, providerOf[org], locationOf[org], patientId],
        )
      ).rows[0].id as string;
    }
    /** Write the corrupt shape the pre-fix service produced: patient_id := admission_id. */
    async function seedCorruptAssessment(org: string, admissionId: string): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO hope_assessment (organization_id, patient_id, admission_id, rfa_kind, status,
             data, target_date, created_by_membership_id)
           VALUES ($1,$2,$2,'01_admission','draft','{}'::jsonb, now(), $3) RETURNING id`,
          [org, admissionId, memberOf[org]],
        )
      ).rows[0].id as string;
    }

    it("repoints a corrupted assessment (and its SFV) at the admission's real patient", async () => {
      const realPatient = "44444444-0000-4000-8000-000000000045";
      const adm = await seedAdmission(ORG_A, realPatient);
      const assessmentId = await seedCorruptAssessment(ORG_A, adm);
      await admin.query(
        `INSERT INTO symptom_follow_up_visit (organization_id, provider_entity_id, location_id,
           patient_id, admission_id, triggering_assessment_id, triggered_at, due_at, alert_cadence)
         VALUES ($1,$2,$3,$4,$4,$5, now(), now() + interval '2 days', '{}'::jsonb)`,
        [ORG_A, providerOf[ORG_A], locationOf[ORG_A], adm, assessmentId],
      );

      await admin.query(REPAIR_SQL);

      expect(
        (await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [assessmentId]))
          .rows[0].patient_id,
      ).toBe(realPatient);
      expect(
        (
          await admin.query(
            "SELECT patient_id FROM symptom_follow_up_visit WHERE triggering_assessment_id=$1",
            [assessmentId],
          )
        ).rows[0].patient_id,
      ).toBe(realPatient);
    });

    it("leaves a row whose admission cannot be resolved, and is a no-op on re-run", async () => {
      // No `admission` row exists for this id, so there is nothing to attribute the record to. Deleting
      // a CMS-reportable clinical record to tidy a data defect would be worse than leaving it broken.
      const orphanAdmission = "77000000-0000-4000-8000-0000000f0045";
      const orphanId = await seedCorruptAssessment(ORG_A, orphanAdmission);
      // Cross-org: the admission exists, but in ORG_B. The repair joins on organization_id too.
      const crossOrgAdmission = await seedAdmission(ORG_B, "44444444-0000-4000-8000-0000000000b0");
      const crossOrgId = await seedCorruptAssessment(ORG_A, crossOrgAdmission);

      await admin.query(REPAIR_SQL);
      expect(
        (await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [orphanId]))
          .rows[0].patient_id,
      ).toBe(orphanAdmission);
      expect(
        (await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [crossOrgId]))
          .rows[0].patient_id,
      ).toBe(crossOrgAdmission);

      // Re-running touches nothing: a repaired row can never match `patient_id = admission_id` again.
      const realPatient = "44444444-0000-4000-8000-000000000046";
      const adm = await seedAdmission(ORG_A, realPatient);
      const repaired = await seedCorruptAssessment(ORG_A, adm);
      await admin.query(REPAIR_SQL);
      const before = (
        await admin.query("SELECT patient_id, updated_at FROM hope_assessment WHERE id=$1", [
          repaired,
        ])
      ).rows[0];
      await admin.query(REPAIR_SQL);
      const after = (
        await admin.query("SELECT patient_id, updated_at FROM hope_assessment WHERE id=$1", [
          repaired,
        ])
      ).rows[0];
      expect(after.patient_id).toBe(realPatient);
      expect(after.updated_at).toEqual(before.updated_at);
    });
  });

  it("RLS — org B cannot sign or correct org A's assessment (non-leaking 404)", async () => {
    const adm = nextAdmission();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    await expect(svc.signTimepoint(ORG_B, memberOf[ORG_B], draft.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(svc.getAssessment(ORG_B, draft.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
