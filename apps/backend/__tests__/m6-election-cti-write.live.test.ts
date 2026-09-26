import { randomUUID } from "node:crypto";
/**
 * M6L-T03 — the Drizzle election-statement + CTI write lifecycle, proven against real Postgres.
 *
 * Drives the production writes as the NOBYPASSRLS `wardenx_app` role: election statement draft → sign →
 * void; CTI draft → hospice-MD sign (signed on the MD alone; a recert also activates its period — the
 * attending signature gates billing, not the CTI); void; mark-late. Then
 * the FULL activation prerequisites are satisfied through the real write path (no superuser-seeded ES/CTI)
 * → activateAdmission succeeds. Optimistic concurrency (stale ifVersion → 409) throughout.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MD = "55555555-5555-5555-5555-555555555555";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
/** The hospice the patient elects — #44: this id is what sites `admission.provider_entity_id`. */
const PROVIDER_ENTITY = "88888888-8888-8888-8888-888888888888";
const PROVIDER_ENTITY_ORG_B = "99999999-9999-9999-9999-999999999999";
/** A SECOND org-A hospice — used to prove a draft never repoints an already-sited admission. */
const PROVIDER_ENTITY_2 = "88888888-8888-8888-8888-888888888889";

/** The §418.24 draft content every election statement in this suite elects. */
const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)("M6 election + CTI write lifecycle — LIVE Postgres (M6L-T03)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  /** The same service with a DPOA-consent port that answers yes — for the representative-signature case. */
  let svcWithDpoa: ReturnType<typeof createDbAdmissionRouteService>;

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Referral → triage → qualify → accept → NOR-ack: returns a period-1 admission ready for election/CTI. */
  async function admitFor(patientId: string): Promise<{ admissionId: string; periodId: string }> {
    // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periods = await svc.listElectionPeriods(ORG_A, admissionId);
    return { admissionId, periodId: periods![0].id };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m6t3@x.test')`, [USER]);
    // #44 — a provider entity in EACH org: the elected hospice, and one belonging to the other
    // tenant that must never be electable from org A.
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31'),
                ($3,$4,'B Hospice','341235','2222222222','\\x00','12-31'),
                ($5,$2,'A Hospice Two','341236','3333333333','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG_A, PROVIDER_ENTITY_ORG_B, ORG_B, PROVIDER_ENTITY_2],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult
    // The composition root binds this over `provider_entity` (M1's table, which M6 may not import).
    // Here it is the real predicate against the two rows seeded above.
    const providerEntityOrgCheck = {
      async belongsToOrg(organizationId: string, providerEntityId: string) {
        const { rows } = await admin.query(
          "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
          [providerEntityId, organizationId],
        );
        return rows.length > 0;
      },
    };
    svc = createDbAdmissionRouteService(
      handle.db,
      validatingM6Outbox(), // F-100
      undefined,
      providerEntityOrgCheck,
    );
    svcWithDpoa = createDbAdmissionRouteService(
      handle.db,
      undefined,
      undefined,
      providerEntityOrgCheck,
      undefined,
      {
        async hasActiveDpoaHealthcareConsent() {
          return true;
        },
      },
    );
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("election statement: draft → sign → (stale 409)", async () => {
    const { admissionId, periodId } = await admitFor(randomUUID());
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
    expect(es.state).toBe("drafted");
    const signed = await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    expect(signed.state).toBe("signed");
    await expect(svc.signElection(ORG_A, es.id, 0, USER, SIGN)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  // ── #44 — the election statement is a RECORD, and it sites the admission ──────────────────────
  describe("§418.24 election-statement content (#44)", () => {
    it("persists the elected hospice, attending and waiver instead of discarding them", async () => {
      // The route validated seven fields and forwarded ONE. Every column below was NULL on every
      // row ever written, because the handler passed `electionPeriodId` alone.
      const { admissionId, periodId } = await admitFor(randomUUID());
      const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, {
        ...DRAFT,
        stateAddendum: "Oregon addendum text",
      });
      const { rows } = await admin.query(
        `SELECT provider_entity_id, attending_physician_id, curative_care_acknowledgment, state_addendum
           FROM election_statement WHERE id = $1`,
        [es.id],
      );
      expect(rows[0]).toMatchObject({
        provider_entity_id: PROVIDER_ENTITY,
        attending_physician_id: ATTENDING,
        curative_care_acknowledgment: true,
        state_addendum: { text: "Oregon addendum text" },
      });
    });

    it("records a declined waiver as declined, rather than stamping true at signing", async () => {
      // `curative_care_acknowledgment` used to be hardcoded `true` in the SIGN update while the
      // draft's `waiverAcknowledged` was discarded — so `false` still produced an acknowledged
      // waiver on the legal record. That is the one field it is least acceptable to fabricate.
      const { admissionId, periodId } = await admitFor(randomUUID());
      const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, {
        ...DRAFT,
        waiverAcknowledged: false,
      });
      const { rows } = await admin.query(
        "SELECT curative_care_acknowledgment FROM election_statement WHERE id = $1",
        [es.id],
      );
      expect(rows[0].curative_care_acknowledgment).toBe(false);
      // F-062: and it can no longer be SIGNED. R-EL-04 lived only inside the state machine nothing
      // called, so a declined waiver used to produce a signed election statement that asserts the
      // patient waived curative care — the legal record CMS requires the acknowledgment for. The
      // original half of this test (the draft persists `false` rather than being stamped `true` at
      // signing) is unchanged above; the refusal is the half that was missing.
      await expect(svc.signElection(ORG_A, es.id, es.version, USER, SIGN)).rejects.toMatchObject({
        code: "CURATIVE_CARE_ACK_REQUIRED",
      });
    });

    it("records WHO signed and in what capacity", async () => {
      // `signingPatientName`/`signingRole` were accepted and dropped: `patient_name_at_signing` was
      // NULL and `signer_kind` kept the draft's hardcoded "patient" even for a representative.
      const { admissionId, periodId } = await admitFor(randomUUID());
      const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
      // F-062: a representative signature now needs an active M39 `dpoa_healthcare` consent (R-EL-01).
      // `svcWithDpoa` is this suite's stand-in for the ConsentEvaluator seam the composition root binds;
      // the refusal arm is covered in `m6-election-period-guards.live.test.ts`.
      await svcWithDpoa.signElection(ORG_A, es.id, es.version, USER, {
        signingPatientName: "Rep Representative",
        signingRole: "legal_representative",
      });
      const { rows } = await admin.query(
        "SELECT signer_kind, patient_name_at_signing FROM election_statement WHERE id = $1",
        [es.id],
      );
      // The wire says `legal_representative`; the `election_signer_kind` enum says `representative`.
      expect(rows[0]).toMatchObject({
        signer_kind: "representative",
        patient_name_at_signing: "Rep Representative",
      });
    });

    it("sites admission.provider_entity_id — the fact the §4.7 seam refuses to project without", async () => {
      // THE load-bearing assertion. `AdmissionStatusReader.getAdmissionSummary` throws
      // `AdmissionSeamDataGapError` when this column is null, and no insert or update in the whole
      // repository ever set it — activation writes `status`/`activatedAt` only. So the seam failed
      // for every admission in every org, breaking M9, M10, M16 and M21.
      const { admissionId, periodId } = await admitFor(randomUUID());
      const before = await admin.query("SELECT provider_entity_id FROM admission WHERE id = $1", [
        admissionId,
      ]);
      expect(before.rows[0].provider_entity_id).toBeNull();

      await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);

      const after = await admin.query("SELECT provider_entity_id FROM admission WHERE id = $1", [
        admissionId,
      ]);
      expect(after.rows[0].provider_entity_id).toBe(PROVIDER_ENTITY);
    });

    it("does not repoint an admission that is already sited", async () => {
      // The siting UPDATE is guarded on `provider_entity_id IS NULL`. An admission sited by some
      // other path must keep its serving provider entity — a later election drafted against it
      // must not silently move where the care is billed from.
      const { admissionId, periodId } = await admitFor(randomUUID());
      await admin.query("UPDATE admission SET provider_entity_id = $1 WHERE id = $2", [
        PROVIDER_ENTITY_2,
        admissionId,
      ]);
      await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
      const { rows } = await admin.query("SELECT provider_entity_id FROM admission WHERE id = $1", [
        admissionId,
      ]);
      expect(rows[0].provider_entity_id).toBe(PROVIDER_ENTITY_2);
    });

    it("refuses to elect another tenant's hospice", async () => {
      // The FKs on `election_statement.provider_entity_id` / `admission.provider_entity_id` are
      // plain single-column references with no organization in them, and a foreign key is checked
      // as a system operation that does not consult RLS — so nothing below the application stops a
      // cross-tenant election. Absent and cross-tenant read identically (§6.6 existence-non-leak).
      const { admissionId, periodId } = await admitFor(randomUUID());
      await expect(
        svc.draftElectionStatement(ORG_A, admissionId, periodId, {
          ...DRAFT,
          electedProviderEntityId: PROVIDER_ENTITY_ORG_B,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const { rows } = await admin.query("SELECT provider_entity_id FROM admission WHERE id = $1", [
        admissionId,
      ]);
      expect(rows[0].provider_entity_id).toBeNull();
    });

    it("fails CLOSED when the org-check port is unbound, rather than writing an unverified hospice", async () => {
      const unchecked = createDbAdmissionRouteService(handle.db, validatingM6Outbox());
      const { admissionId, periodId } = await admitFor(randomUUID());
      await expect(
        unchecked.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT),
      ).rejects.toMatchObject({ statusCode: 503 });
    });
  });

  it("CTI (period 1, no attending): draft → hospice-MD sign → signed", async () => {
    const { periodId } = await admitFor(randomUUID());
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    expect(cti.state).toBe("drafted");
    const signed = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    expect(signed.state).toBe("signed");
  });

  it("CTI (period 1, with attending): the hospice-MD signature alone signs it; no attending step follows", async () => {
    const { periodId } = await admitFor(randomUUID());
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    // main (#241): the attending physician's CTI signature gates billing, not the CTI or activation, so
    // there is no `awaiting_attending` state and an attending sign on a signed CTI is refused.
    const h = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    expect(h.state).toBe("signed");
    await expect(svc.signCtiAttending(ORG_A, cti.id, h.version, USER)).rejects.toThrow(
      "is not awaiting an attending signature",
    );
  });

  it("recert (period 2): hospice sign fully signs + activates the period", async () => {
    const { admissionId } = await admitFor(randomUUID());
    const p2 = await svc.createElectionPeriod(ORG_A, admissionId);
    expect(p2.state).toBe("pending");
    const cti = await svc.draftCti(
      ORG_A,
      { electionPeriodId: p2.id, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
      USER,
    );
    const signed = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    expect(signed.state).toBe("signed");
    const status = await admin.query("SELECT status FROM election_period WHERE id=$1", [p2.id]);
    expect(status.rows[0].status).toBe("active"); // §7.3 recert activates the period
  });

  it("full activation via the real write path (no superuser-seeded ES/CTI)", async () => {
    const { admissionId, periodId } = await admitFor(randomUUID());
    // Pre-existing bug found while fixing the transfer-in period-count bug: this call was missing the
    // NorAcknowledgeInput object entirely (USER was landing in the `input` param, `actorUserId` was
    // undefined) — __tests__ sits outside apps/backend/tsconfig.json's rootDir so tsc never typechecks
    // this file, and vitest's esbuild transform doesn't typecheck either, so the arity mismatch compiled
    // clean and only broke at runtime against a real DB (a malformed `set_config('app.user_id', , true)`).
    // Same class of bug already fixed in m6-admission-write-lifecycle.live.test.ts and
    // m6-discharge-f2f-loc-write.live.test.ts this session — this file was never touched in that pass.
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    // The hospice-MD signature is the CTI prerequisite for activation; the attending signature gates
    // billing (main #241), so activation does not wait for it.
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
    expect(active.state).toBe("active");
  });

  it("voidCti and markCtiLate", async () => {
    const { periodId } = await admitFor(randomUUID());
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    const late = await svc.markCtiLate(ORG_A, cti.id, cti.version);
    expect(late.writtenCertDeadlineAt).toBeTruthy();
    const voided = await svc.voidCti(ORG_A, cti.id, "entered in error", late.version);
    expect(voided.state).toBe("voided");
  });
});
