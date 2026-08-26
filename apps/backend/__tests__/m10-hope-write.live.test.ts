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
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type HopeWriteOutboxPort,
  M10_OUTBOX_EVENTS,
  createDbHopeBackend,
} from "../src/modules/10-hope/index";
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

  it("assembleSubmission queues a submission; retry is refused unless the submission is rejected", async () => {
    const assembled = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
    expect(assembled.status).toBe("queued");
    expect(await eventsFor(assembled.id)).toContain("m10.hope.submission_queued");
    // A queued submission cannot be retried (409).
    await expect(svc.retrySubmission(ORG_A, assembled.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    // Seed a rejected submission → retry re-queues it.
    const rejected = (
      await admin.query(
        `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
         VALUES ($1,$2,'2026-06','rejected',3) RETURNING id`,
        [ORG_A, providerOf[ORG_A]],
      )
    ).rows[0].id as string;
    const requeued = await svc.retrySubmission(ORG_A, rejected);
    expect(requeued.status).toBe("queued");
  });

  it("requestSummaryPdf emits summary_requested for a real assessment", async () => {
    const adm = nextAdmission();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    const res = await svc.requestSummaryPdf(ORG_A, memberOf[ORG_A], draft.id);
    expect(res).toEqual({ assessmentId: draft.id, requested: true });
    expect(await eventsFor(draft.id)).toContain("m10.hope.summary_requested");
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
