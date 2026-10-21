/**
 * F-217 — LIVE Postgres proof that the F2F/CTI ADEQUACY predicate (`certification/adequacy.ts`) actually
 * gates benefit-period activation through M6's production write service (`signCtiHospiceMd`, the path that
 * advances any period >= 2), as the real NOBYPASSRLS `wardenx_app` role, with the REAL catalog-validating
 * outbox publisher (`_m6-outbox.ts`) — so the additive `adequacy` field on `m6.election.period_started` is
 * checked against the boot catalog schema, not waved through a no-op.
 *
 * What this pins, each through real rows:
 *   · the adequate path signs the CTI; the period starts on its own start date (the auto-end cron, the day
 *     after period 1 ends — 42 CFR 418.21(a)) and publishes the no-PHI decision on the event
 *   · every inadequate reason that is REACHABLE through the service refuses with a typed 409
 *     `ELECTION_PERIOD_ADEQUACY_FAILED` + machine-readable `details`, and the whole tx rolls back (the CTI
 *     stays unsigned, the period stays `pending`, no `period_started` event is written)
 *   · a late CTI and an overridden F2F window are FLAGS on the event, never a refusal (R-CTI-01, D4, D5)
 *   · period 1 (the admission-activation ceremony, governed by R-AC-01) is NOT routed through the gate
 *   · cross-tenant: another org cannot sign/activate this org's CTI
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:adequacy-gate:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { claimAssemblyRangeContextForOrg } from "../src/modules/06-admission/index";
import { runElectionPeriodAutoEndCron } from "../src/modules/06-admission/jobs/cron-workers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";

const NARRATIVE_OK =
  "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.";
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative: NARRATIVE_OK,
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-11111111217a";
const ORG_B = "22222222-2222-2222-2222-22222222217b";
const USER = "33333333-3333-3333-3333-33333333217a";
const MD = "55555555-5555-5555-5555-55555555217a";
const ATTENDING = "77777777-7777-7777-7777-77777777217a";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-88888888217a";

const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;
const OVERRIDE_REASON = "Documented hospitalisation delayed the visit past the window.";

/** UTC calendar day `offset` days from today (the suite compares dates the way the service does). */
const dayOffset = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/**
 * F-226 - a pending recert period's EXPECTED START. The gate computes the F2F window against it, so the
 * fixtures must carry a realistic one: the period starts in 10 days, the F2F was done today (10 days prior,
 * inside [start-30, start-1]). The old fixtures stamped `within_window = true` on a row that had no start.
 */
const EXPECTED_START = dayOffset(10);

describe.skipIf(!DB_URL)("F-217 — F2F/CTI adequacy gate — LIVE Postgres (wardenx_app role)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS report_mv CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...ROLES, "report_writer"])
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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

  /** Period-1 activation ceremony through production writes only (NOR → election → CTI → activate). */
  async function activate(narrative = NARRATIVE_OK, patientId = randomUUID()) {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periodId = (await svc.listElectionPeriods(ORG_A, admissionId))?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        narrative,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    await svc.activateAdmission(ORG_A, admissionId, nor.version);
    // Period 1 ends the day before EXPECTED_START, so the recert periods below are contiguous with it.
    await admin.query("UPDATE election_period SET scheduled_end_at=$2 WHERE id=$1", [
      periodId,
      dayOffset(9),
    ]);
    return { admissionId, periodId, patientId };
  }

  /** A pending recert period at `sequence` with a hospice-MD CTI drafted against it. */
  async function recert(
    admissionId: string,
    sequence: number,
    narrative = NARRATIVE_OK,
    expectedStart: string | null = EXPECTED_START,
  ) {
    const periodId = (
      await admin.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, expected_start)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ORG_A, admissionId, sequence, sequence <= 2 ? "ninety_day" : "sixty_day", expectedStart],
      )
    ).rows[0].id as string;
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        ...CTI_CLINICAL,
        narrative,
        isRecert: true,
      },
      USER,
    );
    return { periodId, cti };
  }

  async function f2f(
    periodId: string,
    o: {
      status?: string;
      withinWindow?: boolean | null;
      /** `encounter_date` (default today: 10 days before EXPECTED_START, inside the window). */
      encounterDate?: string | null;
      attestedAt?: string | null;
      override?: { reason: string } | null;
    } = {},
  ) {
    const status = o.status ?? "attested";
    const attestedAt = o.attestedAt === undefined ? "now()" : o.attestedAt;
    await admin.query(
      `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
         performer_role, encounter_date, within_window, status, attestation_signed_at,
         window_override, window_override_reason, window_override_by)
       VALUES ($1,$2,$3,'hospice_np', $9::date, $4, $5, ${attestedAt === null ? "NULL" : attestedAt},
               $6, $7, $8)`,
      [
        ORG_A,
        periodId,
        MD,
        o.withinWindow === undefined ? true : o.withinWindow,
        status,
        !!o.override,
        o.override?.reason ?? null,
        o.override ? USER : null,
        o.encounterDate === undefined ? dayOffset(0) : o.encounterDate,
      ],
    );
  }

  /** The hourly auto-end cron on `day` (org-local): completes period 1, starts every due signed recert. */
  const startOn = (day: string) =>
    runElectionPeriodAutoEndCron({
      connection: {} as never,
      db: handle.db,
      outbox: validatingM6Outbox(),
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      now: () => new Date(`${day}T17:00:00.000Z`),
    });

  const periodStatus = async (id: string) =>
    (await admin.query("SELECT status FROM election_period WHERE id=$1", [id])).rows[0].status;
  const ctiStatus = async (id: string) =>
    (await admin.query("SELECT status FROM certification_of_terminal_illness WHERE id=$1", [id]))
      .rows[0].status;
  const startedEvents = async (periodId: string) =>
    (
      await admin.query(
        `SELECT payload FROM outbox_event
          WHERE event_type='m6.election.period_started' AND payload->>'electionPeriodId'=$1`,
        [periodId],
      )
    ).rows.map((r) => r.payload as Record<string, unknown>);

  /** Refusal contract: typed 409 + the codes in `details`, tx fully rolled back. */
  async function expectRefused(
    periodId: string,
    cti: { id: string; version: number },
    codes: string[],
  ) {
    await expect(svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER)).rejects.toMatchObject({
      code: "ELECTION_PERIOD_ADEQUACY_FAILED",
      statusCode: 409,
      details: codes.map((code) => ({ code })),
    });
    expect(await periodStatus(periodId)).toBe("pending");
    expect(await ctiStatus(cti.id)).toBe("drafted");
    expect(await startedEvents(periodId)).toHaveLength(0);
  }

  /** Bug 3 — a recert CTI without a >= 200-char narrative is a typed 422, everything rolled back. */
  async function expectNarrativeRequired(
    periodId: string,
    cti: { id: string; version: number },
    code: "CTI_NARRATIVE_MISSING" | "CTI_NARRATIVE_TOO_SHORT",
  ) {
    await expect(svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER)).rejects.toMatchObject({
      code: "CTI_NARRATIVE_REQUIRED",
      statusCode: 422,
      details: [{ code }],
    });
    expect(await periodStatus(periodId)).toBe("pending");
    expect(await ctiStatus(cti.id)).toBe("drafted");
    expect(await startedEvents(periodId)).toHaveLength(0);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'org-f217a','A','A'), ($2,'org-f217b','B','B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f217@x.test'), ($2,'f217-md@x.test'), ($3,'f217-att@x.test')`,
      [USER, MD, ATTENDING],
    );
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG_A],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db);
    svc = createDbAdmissionRouteService(
      handle.db,
      validatingM6Outbox(), // the REAL catalog-validating publisher (refuse-on-failure)
      undefined,
      {
        async belongsToOrg(organizationId: string, providerEntityId: string) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      },
    );
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("the adequate path", () => {
    it("period 3 with an in-window attested F2F + a signed 200+ char CTI activates and publishes the decision", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId);
      const signed = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      expect(signed.state).toBe("signed");
      // Signed 10 days early: the period waits for its start date (no overlap with period 1).
      expect(await periodStatus(periodId)).toBe("pending");
      expect(await startedEvents(periodId)).toHaveLength(0);
      await startOn(EXPECTED_START);
      expect(await periodStatus(periodId)).toBe("active");
      const events = await startedEvents(periodId);
      expect(events).toHaveLength(1);
      expect(events[0]?.adequacy).toEqual({
        verdict: "adequate",
        f2fRequired: true,
        reasonCodes: [],
        flags: [],
      });
    });

    it("period 2 needs NO F2F and still publishes f2fRequired=false", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 2);
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await startOn(EXPECTED_START);
      expect(await periodStatus(periodId)).toBe("active");
      expect((await startedEvents(periodId))[0]?.adequacy).toMatchObject({
        verdict: "adequate",
        f2fRequired: false,
      });
    });

    it("the event decision carries only codes — no person/period ids or narrative text (no PHI)", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId);
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await startOn(EXPECTED_START);
      const wire = JSON.stringify((await startedEvents(periodId))[0]?.adequacy);
      for (const secret of [MD, USER, periodId, a.admissionId, NARRATIVE_OK.slice(0, 30)]) {
        expect(wire).not.toContain(secret);
      }
    });
  });

  describe("inadequate — refuses with a typed 409 and rolls everything back", () => {
    it("CTI narrative shorter than 200 characters → 422 CTI_NARRATIVE_REQUIRED (the signer must supply it)", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 2, "n".repeat(199));
      await expectNarrativeRequired(periodId, cti, "CTI_NARRATIVE_TOO_SHORT");
    });

    it("a skeleton CTI with no narrative at all (what transferIn drafts)", async () => {
      const a = await activate();
      const periodId = (
        await admin.query(
          `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind)
           VALUES ($1,$2,2,'ninety_day') RETURNING id`,
          [ORG_A, a.admissionId],
        )
      ).rows[0].id as string;
      const cti = (
        await admin.query(
          `INSERT INTO certification_of_terminal_illness (organization_id, election_period_id, hospice_md_id)
           VALUES ($1,$2,$3) RETURNING id, version`,
          [ORG_A, periodId, MD],
        )
      ).rows[0];
      await expectNarrativeRequired(
        periodId,
        { id: cti.id, version: Number(cti.version) },
        "CTI_NARRATIVE_MISSING",
      );
    });

    it("period 3: F2F recorded outside the window (within_window=false)", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId, { withinWindow: false, encounterDate: dayOffset(-40) });
      await expectRefused(periodId, cti, ["F2F_OUTSIDE_WINDOW"]);
    });

    it("F-226: a persisted within_window=true is NOT trusted - the real encounter date is recomputed (the F-217 bug shape)", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      // What the old always-true completeF2f wrote: flag true, but the date is 50 days before the start.
      await f2f(periodId, { withinWindow: true, encounterDate: dayOffset(-40) });
      await expectRefused(periodId, cti, ["F2F_OUTSIDE_WINDOW"]);
    });

    it("F-226: an F2F the day AFTER the period start is outside the window even when flagged true (R-F2F-02; the first day itself is timely, MBPM ch. 9 §20.1(5)(a))", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId, { withinWindow: true, encounterDate: dayOffset(11) });
      await expectRefused(periodId, cti, ["F2F_OUTSIDE_WINDOW"]);
    });

    it("F-226: recomputed in-window but persisted false disagree -> unverified, fail closed", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId, { withinWindow: false });
      await expectRefused(periodId, cti, ["F2F_WINDOW_UNVERIFIED"]);
    });

    it("F-226: a missing encounter_date fails closed", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId, { encounterDate: null });
      await expectRefused(periodId, cti, ["F2F_ENCOUNTER_DATE_MISSING"]);
    });

    it("F-226: an undeterminable period start (no expected_start, no preceding period end) fails closed", async () => {
      const a = await activate();
      // sequence 3 with no sequence 2 row and no expected_start: nothing to anchor the window to.
      const { periodId, cti } = await recert(a.admissionId, 3, NARRATIVE_OK, null);
      await f2f(periodId);
      await expectRefused(periodId, cti, ["F2F_WINDOW_UNVERIFIED"]);
    });

    it("F-226: a legacy pending period with NULL expected_start derives it from the preceding period's end + 1", async () => {
      const a = await activate();
      // period 2 active-ish: give it a scheduled_end_at 10 days out, then a legacy (un-stamped) period 3.
      await admin.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status,
                                      effective_at, scheduled_end_at)
         VALUES ($1,$2,2,'ninety_day','active',$3,$4)`,
        [ORG_A, a.admissionId, dayOffset(-80), dayOffset(9)],
      );
      const { periodId, cti } = await recert(a.admissionId, 3, NARRATIVE_OK, null);
      await f2f(periodId); // encounter today = 10 days before derived start (today+10)
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await startOn(EXPECTED_START);
      expect(await periodStatus(periodId)).toBe("active");
    });

    it("period 3: F2F whose window was never verified (within_window NULL) fails closed", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId, { withinWindow: null });
      await expectRefused(periodId, cti, ["F2F_WINDOW_UNVERIFIED"]);
    });

    it("period 3+: no F2F / scheduled-only / unsigned attestation keep the existing typed R-F2F-04 refusal", async () => {
      const a = await activate();
      const setups: Array<(p: string) => Promise<void>> = [
        async () => {},
        (p) => f2f(p, { status: "scheduled", attestedAt: null }),
        (p) => f2f(p, { status: "attested", attestedAt: null }),
      ];
      let sequence = 3;
      for (const setup of setups) {
        const { periodId, cti } = await recert(a.admissionId, sequence++);
        await setup(periodId);
        await expect(svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER)).rejects.toMatchObject({
          code: "F2F_REQUIRED_FOR_RECERT",
          statusCode: 409,
        });
        expect(await periodStatus(periodId)).toBe("pending");
      }
    });

    it("an F2F attested on a DIFFERENT period does not satisfy this one", async () => {
      const a = await activate();
      const other = await recert(a.admissionId, 3);
      await f2f(other.periodId);
      const { periodId, cti } = await recert(a.admissionId, 4);
      await expect(svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER)).rejects.toMatchObject({
        code: "F2F_REQUIRED_FOR_RECERT",
      });
      expect(await periodStatus(periodId)).toBe("pending");
    });

    it("an override with a too-short reason is not accepted as a window waiver", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId, { withinWindow: false, override: { reason: "too short" } });
      await expectRefused(periodId, cti, ["F2F_OVERRIDE_INVALID"]);
    });
  });

  describe("flags are published, never refused (R-CTI-01, D4, D5)", () => {
    it("a valid F2F window override activates the period and is flagged F2F_WINDOW_OVERRIDDEN", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId, { withinWindow: false, override: { reason: OVERRIDE_REASON } });
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await startOn(EXPECTED_START);
      expect(await periodStatus(periodId)).toBe("active");
      expect((await startedEvents(periodId))[0]?.adequacy).toMatchObject({
        verdict: "adequate",
        flags: ["F2F_WINDOW_OVERRIDDEN"],
      });
    });

    it("a CTI marked late (route 27) activates the period and is flagged CTI_SIGNED_LATE", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 2);
      const late = await svc.markCtiLate(ORG_A, cti.id, cti.version);
      await svc.signCtiHospiceMd(ORG_A, cti.id, late.version, USER);
      await startOn(EXPECTED_START);
      expect(await periodStatus(periodId)).toBe("active");
      expect((await startedEvents(periodId))[0]?.adequacy).toMatchObject({
        verdict: "adequate",
        flags: ["CTI_SIGNED_LATE", "CTI_LATE_REASON_MISSING"],
      });
    });
  });

  describe("period 1 is not routed through the gate (R-AC-01 governs the initial CTI)", () => {
    it("an admission whose initial CTI narrative is short still activates", async () => {
      const a = await activate("Short initial certification narrative.");
      expect(await periodStatus(a.periodId)).toBe("active");
    });
  });

  describe("M23 claim-assembly parity (F-121)", () => {
    it("the range reader reports the same CTI/F2F the gate accepted for an adequate period 3", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 3);
      await f2f(periodId);
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await startOn(EXPECTED_START);
      const ctx = await claimAssemblyRangeContextForOrg(handle.db, ORG_A, a.patientId, {
        from: EXPECTED_START,
        to: EXPECTED_START,
      });
      expect(ctx?.certifications.find((c) => c.electionPeriodSequence === 3)).toMatchObject({
        ctiSigned: true,
      });
      expect(ctx?.faceToFace.find((f) => f.electionPeriodSequence === 3)).toMatchObject({
        attested: true,
      });
    });
  });

  describe("cross-tenant isolation (real wardenx_app role, RLS)", () => {
    it("another org cannot sign or activate this org's recert CTI; nothing changes", async () => {
      const a = await activate();
      const { periodId, cti } = await recert(a.admissionId, 2);
      await expect(svc.signCtiHospiceMd(ORG_B, cti.id, cti.version, USER)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await periodStatus(periodId)).toBe("pending");
      expect(await ctiStatus(cti.id)).toBe("drafted");
      // ...and the owning org still can.
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await startOn(EXPECTED_START);
      expect(await periodStatus(periodId)).toBe("active");
    });
  });
});
