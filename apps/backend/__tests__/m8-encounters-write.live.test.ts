import { randomUUID } from "node:crypto";
/**
 * M8L-T02 — the Drizzle encounter WRITE lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role: draft creation, vitals/mileage authoring,
 * finalize (pins the vocab version), the §2.3 sign machine (RN direct-sign, the §7.4 D1 F2F dual-write,
 * and the LPN cosignature routing), the §2.4 D3 cosignature chain (acknowledge → sign), void, and the
 * addendum aggregate (draft → finalize → sign). Like the M7 write suite (and unlike the M6 outbox slices,
 * which ran against a NOOP) it binds the REAL catalog-validating transactional publisher
 * (buildBootOutboxCatalog([M8_OUTBOX_EVENTS]) → the caller's tx) and asserts the `m8.*` rows land in
 * `outbox_event` — so the boot-catalog wiring + the LOCKED `m8.encounter.signed` payload are proven, not
 * assumed. RLS + §7.7 optimistic concurrency + §2.7 immutability-after-sign are exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m8:write:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInMemorySessionContextStore, createSessionContextResolver } from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import {
  VOCAB_VERSION,
  activeNarrativeVocabRelease,
  narrativeVocabReleaseById,
} from "@wardenx/narrative-vocab";
import { runWithRequestContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createCareTeamProvider } from "../src/modules/05-patient/seams/care-team-provider";
import { createDrizzleCareTeamStore } from "../src/modules/05-patient/seams/drizzle-stores";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import { createDrizzleEncounterEraseStore } from "../src/modules/08-encounters/erasers/encounter-eraser";
import {
  type EncounterWriteOutboxPort,
  M8_OUTBOX_EVENTS,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
} from "../src/modules/08-encounters/index";
import { createDrizzleEncounterReaderStore } from "../src/modules/08-encounters/seams/drizzle-store";
import { requiredSectionSelections, requiredVitalsCapture } from "./_hearthnote-fixtures";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id are NOT NULL but carry NO FK — literals are fine (as the RLS/read suites do). */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
/** A recent-but-past service date (the encounter_service_date_not_future CHECK forbids the future). */
const SERVICE_DATE = "2026-01-15";
const LIVE_NOW = "2026-01-16T17:00:00Z"; // org-local (America/New_York) 2026-01-16, one day after SERVICE_DATE
// `encounter_signature.session_id` is a uuid column — session ids in this system are uuids.
const SESSION_A = "66666666-6666-6666-6666-666666666666";
/** The patient's RN case manager (#124): a DIFFERENT user from the signer, with their own membership —
 *  so "routed to the case manager" and "routed to whoever signed" cannot look the same. */
const USER_RN_CM = "88888888-8888-8888-8888-888888888888";
/** A session id the store never seeds — `resolveStepUpState` resolves it to `null` (never fresh). */
const STALE_SESSION = "77777777-7777-7777-7777-777777777777";

/** §2.6 selection trees (#114). Real template sections + real `@wardenx/narrative-vocab` codes. */
const EMPTY_TREE = { sections: [] };
const TREE = {
  sections: [
    {
      sectionId: "assessment",
      entries: [{ code: "nv.cv.stable" }, { code: "nv.cv.edema", params: { edema_grade: "2+" } }],
    },
  ],
};
/**
 * The REAL AES-256-GCM envelopes over a fixed test DEK — not a reversible stand-in. The production key
 * provider resolves through M34's key ring (a deny-stub until #105); everything above it, including the
 * per-column AAD binding this suite relies on, is the shipping code.
 */
const TEST_DEK = { version: "test-v1", key: Buffer.alloc(32, 7) };
const CIPHERS = createHearthnoteCiphers({
  async dekForOrg() {
    return TEST_DEK;
  },
  async dekForOrgVersion(_org: string, version: string) {
    return { version, key: TEST_DEK.key };
  },
});

describe.skipIf(!DB_URL)("M8 encounter write lifecycle — LIVE Postgres (M8L-T02)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbEncounterRouteService>;
  /** The same service with NO DEK envelope bound — the §3.6 / §2.6 refusal paths. */
  let noCipherSvc: ReturnType<typeof createDbEncounterRouteService>;
  /** What the faked M7 reader answers (see the seam registration in beforeAll). */
  let carePlanOverdue: unknown = null;
  /** §2.6 check 3 (#125) — what the faked M9 reader answers `latestBatch` for any scale asked. */
  let latestScales: Set<string> = new Set();
  /** The RN case manager's membership id — what a cosignature must route to (#124). */
  let CASE_MANAGER_MEMBERSHIP_ID: string;
  const membershipOf: Record<string, string> = {};
  /** The real caller signing (§3.3/D13) — `resolveSignatureProvenance` resolves SESSION_A's step-up
   *  through the SessionContextResolver seam registered in beforeAll (fresh, webauthn). */
  let ACTOR_A: { membershipId: string; sessionId: string };
  /** PARAM-004/CoP-418.104(c) follow-up — signing writes an `encounter_signature` row, which has NOT
   *  NULL provider_entity_id/location_id. F-064 (#159): `createDraft` now RESOLVES the encounter's
   *  siting from M6's `AdmissionStatusReader` (the REAL reader over the seeded active admission row),
   *  rather than a value the harness stamps on afterwards. */
  let SITING_A: { providerEntityId: string; locationId: string };

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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped)");
      }
      await admin.query(sql);
    }
  }

  /** The `m8.*` events persisted for an aggregate, event-type only (asserts the catalog wiring). */
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

  async function seedOrg(org: string, slug: string) {
    membershipOf[org] = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m8w@x.test')`, [USER]);
    await seedOrg(ORG_A, "org-a");
    await seedOrg(ORG_B, "org-b");
    const pe = await admin.query(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1, '01-1234', 'M8 Test PE', '1234567890', 'enc', '12-31') RETURNING id`,
      [ORG_A],
    );
    const loc = await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1, 'M8 Test Loc', '1 Main St', 'Town', 'NY', '10001', 'America/New_York') RETURNING id`,
      [pe.rows[0].id],
    );
    SITING_A = { providerEntityId: pe.rows[0].id as string, locationId: loc.rows[0].id as string };
    await admin.query(
      `INSERT INTO admission (id, organization_id, provider_entity_id, location_id, patient_id, status, admission_at, activated_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$6)`,
      // activated before the earliest late-entry fixture date (GAP-013: service dates back to 2025-12-20)
      [ADMISSION, ORG_A, SITING_A.providerEntityId, SITING_A.locationId, PATIENT, "2025-12-01"],
    );
    ACTOR_A = { membershipId: membershipOf[ORG_A], sessionId: SESSION_A };
    const sessions = createInMemorySessionContextStore([
      {
        sessionClass: "staff",
        portalAccountId: null,
        sessionPatientId: null,
        sessionId: SESSION_A,
        userId: USER,
        membershipId: membershipOf[ORG_A],
        organizationId: ORG_A,
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        lastStepUpAt: new Date(),
        lastStepUpFactor: "webauthn",
      },
    ]);
    registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));
    // §2.4 D3 / §2.6 check 10 (#124) — the cosignature routes to the patient's RN case manager, which
    // M5's CareTeamProvider answers off `patient_assignment` + `membership`. Bound to the REAL M5
    // Drizzle store over the same database, not a fake: the whole point of the fix is that M8 stopped
    // inventing this answer, so a fake here would put the invention back one layer out.
    //
    // That needs a real `patient` row — the rest of this suite gets away with a literal `patient_id`
    // because `encounter.patient_id` carries no FK, but `patient_assignment.patient_id` does.
    await admin.query(
      `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
                            legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,$4,'MRN-M8W','Test','Patient','1950-01-01','F','active')`,
      [PATIENT, ORG_A, SITING_A.providerEntityId, SITING_A.locationId],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m8cm@x.test')`, [USER_RN_CM]);
    CASE_MANAGER_MEMBERSHIP_ID = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_RN_CM, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, provider_entity_id, location_id,
                                       clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,$4,$5,'primary_rn',CURRENT_DATE)`,
      [PATIENT, ORG_A, SITING_A.providerEntityId, SITING_A.locationId, USER_RN_CM],
    );
    // §2.6 check 6 (#121) — the gate consults M7's CarePlanReader at finalize and sign. In production
    // the composition root binds M7's real reader; here a fake stands in, because M7's Drizzle store
    // reads under the CALLER'S ambient request context and this suite drives the service directly with
    // none. `carePlanOverdue` is the switch the overdue tests below flip.
    registerSeam("CarePlanReader", {
      // F-064 — `addCarePlanLink` validates the refs against the patient's relevant plan elements;
      // these are the PROBLEM/GOAL ids the care-plan-link cases below link.
      relevantElementsForEncounter: async () => ({
        planId: "66666666-6666-4666-8666-666666666666",
        patientId: PATIENT,
        problems: [{ problemId: "44444444-4444-4444-8444-444444444444" }],
        goals: [
          {
            goalId: "55555555-5555-4555-8555-555555555555",
            problemId: "44444444-4444-4444-8444-444444444444",
          },
        ],
        interventions: [],
        redacted: false,
      }),
      isReviewOverdue: async () => carePlanOverdue,
      fifteenDayCycleCountsForOrg: async () => ({ numerator: 0, denominator: 0 }),
      terminologyCodeUsageForOrg: async () => [],
    } as never);
    // §2.6 check 3 (#125) — the gate consults M9's LatestAssessmentProvider for recert_visit's PPS/ESAS
    // roster. Faked for the same reason CarePlanReader is: M9's real store also reads under the
    // caller's ambient request context, which this suite (driving the service directly) has none of.
    // `latestScales` is the switch the check-3 tests below flip.
    registerSeam("LatestAssessmentProvider", {
      latest: async () => null,
      latestBatch: async (_patientId: unknown, scaleTypes: readonly string[]) =>
        scaleTypes.filter((s) => latestScales.has(s)).map((scaleType) => ({ scaleType }) as never),
    } as never);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    // F-064 (#159) — M6's REAL `AdmissionStatusReader` over the seeded active admission: `createDraft`
    // validates the admission (org/patient/status/service window) and resolves the encounter's ARCH-011
    // siting through it. Without it the write path has no siting and the assertions below would be
    // testing the harness rather than the code.
    registerSeam(
      "AdmissionStatusReader",
      createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    );
    // Registered after the app-role client exists — the M5 store reads `patient_assignment` under RLS as
    // `wardenx_app`, the same role M8's own writes run as.
    registerSeam("CareTeamProvider", createCareTeamProvider(createDrizzleCareTeamStore(handle.db)));
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M8_OUTBOX_EVENTS]));
    const outbox: EncounterWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m8" }),
    };
    // Cipher-bound, as production is: the composition root always constructs the envelopes (only the KEY
    // resolve is deny-stubbed). `noCipherSvc` is the same service with none, for the §3.6 refusal cases.
    // GAP-013: the late-entry tier is measured against the org-local day, so the clock is pinned to the
    // day after SERVICE_DATE — every case below that is not about lateness stays in the `normal` tier.
    const liveClock = () => new Date(LIVE_NOW);
    svc = createDbEncounterRouteService(handle.db, outbox, CIPHERS, liveClock);
    noCipherSvc = createDbEncounterRouteService(handle.db, outbox, undefined, liveClock);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  /** Create an org-A draft with the given type/discipline; returns the created id. */
  async function draft(
    encounterType: string,
    discipline: string,
    extra: {
      faceToFaceEncounterId?: string;
      serviceDate?: string;
      document?: boolean;
      captureVitals?: boolean;
    } = {},
  ): Promise<string> {
    const d = await svc.createDraft(ORG_A, membershipOf[ORG_A], {
      patientId: PATIENT,
      admissionId: ADMISSION,
      encounterType: encounterType as never,
      discipline: discipline as never,
      serviceDate: (extra.serviceDate ?? SERVICE_DATE) as never,
      ...(extra.faceToFaceEncounterId
        ? { faceToFaceEncounterId: extra.faceToFaceEncounterId }
        : {}),
    });
    // F-064 — the harness used to stamp the siting here, because `createDraft` never did. That is the
    // shape every one of these gaps has taken: the suite supplies the fact its own production path
    // cannot produce, so the gate is proven and the producer is not. `createDraft` resolves it from M6
    // now, and `encounter is sited at createDraft` below asserts exactly that.
    // Document it to the §2.6 gate's floor (#121) unless the caller is testing the gate itself. Every
    // finalize/sign case below went through this draft helper and documented NOTHING before the gate
    // was real — and signed anyway.
    if (extra.document !== false) {
      await svc.updateSelections(
        ORG_A,
        d.id,
        0,
        requiredSectionSelections(encounterType as never, discipline as never),
      );
    }
    // §2.6 check 2 (#125) — same posture as `document`: capture the roster `requiredVitalsFor` itself
    // names for this pair, unless the caller is exercising check 2's own refusal/escape-hatch behavior.
    if (extra.captureVitals !== false) {
      const vitals = requiredVitalsCapture(encounterType as never, discipline as never);
      if (vitals) await svc.captureVitals(ORG_A, d.id, vitals);
    }
    return d.id;
  }

  it("createDraft persists a draft and emits m8.encounter.created", async () => {
    const d = await svc.createDraft(ORG_A, membershipOf[ORG_A], {
      patientId: PATIENT,
      admissionId: ADMISSION,
      encounterType: "routine_visit" as never,
      discipline: "rn" as never,
      serviceDate: SERVICE_DATE as never,
    });
    expect(d.status).toBe("draft");
    expect(d.version).toBe(0);
    const detail = await svc.getEncounter(ORG_A, d.id);
    expect(detail.discipline).toBe("rn");
    expect(await eventsFor(d.id)).toContain("m8.encounter.created");
  });

  it("captureVitals computes BMI, derives abnormal flags, and emits m8.vitals.captured", async () => {
    const id = await draft("routine_visit", "rn");
    const r = await svc.captureVitals(ORG_A, id, {
      bpSystolic: 150,
      bpDiastolic: 95,
      weight: "80",
      weightUnit: "kg",
      height: "180",
      heightUnit: "cm",
    });
    expect(r.bmi).toBe("24.7");
    expect(r.abnormalFlags).toContain("bp_systolic");
    expect(await eventsFor(r.vitalsId)).toContain("m8.vitals.captured");
    // An out-of-envelope reading is a precise 422 (defence-in-depth before the DB CHECK).
    await expect(svc.captureVitals(ORG_A, id, { spo2: 20 })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("captureMileage stores the authoritative miles (D10) and emits m8.mileage.captured", async () => {
    const id = await draft("routine_visit", "rn");
    const r = await svc.captureMileage(ORG_A, id, {
      odometerStart: 1000,
      odometerEnd: 1012,
      source: "odometer",
    });
    expect(r.milesDriven).toBe("12");
    expect(await eventsFor(r.mileageId)).toContain("m8.mileage.captured");
  });

  it("finalize → sign (RN, no cosign) → signed; emits finalized + the LOCKED m8.encounter.signed", async () => {
    const id = await draft("routine_visit", "rn");
    const fin = await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    expect(fin.status).toBe("finalized");
    // 2, not 1: documenting the note to the §2.6 gate's floor (#121) is itself a versioned edit.
    expect(fin.version).toBe(2);
    const [row] = (await admin.query("SELECT vocab_version_id FROM encounter WHERE id=$1", [id]))
      .rows;
    expect(row.vocab_version_id).not.toBeNull(); // D11 pinned at finalize
    const signed = await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("signed");
    expect(signed.cosignatureRequestId).toBeNull();
    const events = await eventsFor(id);
    expect(events).toContain("m8.encounter.finalized");
    expect(events).toContain("m8.encounter.signed");
    // GAP-177 — a visit-less (ad-hoc/retroactive) encounter also records the M17 reconciliation fact.
    expect(events).toContain("m8.encounter.orphan_recorded");
  });

  it("sign requires a fresh step-up (D13) — a stale step-up is 412", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await expect(
      svc.sign(
        ORG_A,
        id,
        { membershipId: membershipOf[ORG_A], sessionId: STALE_SESSION },
        { at: SERVICE_DATE as never },
      ),
    ).rejects.toMatchObject({ statusCode: 412 });
  });

  describe("GAP-013 — late-entry tier is computed, reified, and gated", () => {
    const REASON =
      "Documentation delayed: the tablet was offline for the whole visit and sync failed";
    const OVERRIDE_REASON =
      "Supervisor reviewed the visit record and confirms the late documentation is valid";
    const ADMIN_REASON =
      "Director review: the visit was real and billable, the clinician was on approved leave and the note could not be completed earlier";
    const tierOf = async (id: string) =>
      (
        await admin.query("SELECT late_entry_tier, late_entry_reason FROM encounter WHERE id=$1", [
          id,
        ])
      ).rows[0] as { late_entry_tier: string; late_entry_reason: string | null };
    const signedTier = async (id: string) =>
      (
        await admin.query(
          "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m8.encounter.signed'",
          [id],
        )
      ).rows[0]?.payload.lateEntryTier as string | undefined;

    it("a same-/next-day note finalizes and signs as normal with no reason", async () => {
      const id = await draft("routine_visit", "rn");
      await svc.finalize(ORG_A, id, SERVICE_DATE as never);
      await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
      expect((await tierOf(id)).late_entry_tier).toBe("normal");
      expect(await signedTier(id)).toBe("normal");
    });

    it("3 days late: finalize needs the reason (422), then reifies late_entry and signs carrying it", async () => {
      const id = await draft("routine_visit", "rn", { serviceDate: "2026-01-13" });
      await expect(svc.finalize(ORG_A, id, SERVICE_DATE as never)).rejects.toMatchObject({
        statusCode: 422,
        code: "LATE_ENTRY_REASON_REQUIRED",
      });
      await svc.finalize(ORG_A, id, SERVICE_DATE as never, { lateEntryReason: REASON });
      expect(await tierOf(id)).toEqual({
        late_entry_tier: "late_entry",
        late_entry_reason: REASON,
      });
      await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
      expect(await signedTier(id)).toBe("late_entry");
    });

    it("6 days late: sign is refused until a Clinical Supervisor override is recorded", async () => {
      const id = await draft("routine_visit", "rn", { serviceDate: "2026-01-10" });
      await svc.finalize(ORG_A, id, SERVICE_DATE as never, { lateEntryReason: REASON });
      await expect(
        svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never }),
      ).rejects.toMatchObject({ code: "SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED" });
      // the administrative route is the wrong tier for 6 days
      await expect(
        svc.administrativeOverride(ORG_A, id, {
          actorMembershipId: membershipOf[ORG_A],
          reason: ADMIN_REASON,
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "LATE_ENTRY_TIER_MISMATCH" });
      await svc.lateEntryOverride(ORG_A, id, {
        actorMembershipId: membershipOf[ORG_A],
        reason: OVERRIDE_REASON,
      });
      const overridden = await tierOf(id);
      expect(overridden.late_entry_tier).toBe("significant_late_entry");
      expect(overridden.late_entry_reason).toBe(REASON); // the author's own reason is kept
      await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
      expect(await signedTier(id)).toBe("significant_late_entry");
      const override = (
        await admin.query(
          "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m8.encounter.late_entry_override'",
          [id],
        )
      ).rows[0];
      expect(override.payload.daysLate).toBe(6);
    });

    it("27 days late: only the director's administrative override clears the sign", async () => {
      const id = await draft("routine_visit", "rn", { serviceDate: "2025-12-20" });
      await svc.finalize(ORG_A, id, SERVICE_DATE as never, { lateEntryReason: REASON });
      await expect(
        svc.lateEntryOverride(ORG_A, id, {
          actorMembershipId: membershipOf[ORG_A],
          reason: OVERRIDE_REASON,
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "LATE_ENTRY_TIER_MISMATCH" });
      await expect(
        svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never }),
      ).rejects.toMatchObject({ code: "ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED" });
      await svc.administrativeOverride(ORG_A, id, {
        actorMembershipId: membershipOf[ORG_A],
        reason: ADMIN_REASON,
      });
      await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
      expect(await signedTier(id)).toBe("administrative_override");
    });
  });

  it("LPN sign routes to cosign_pending; acknowledge → cosign signs the encounter (§2.4/§7.2)", async () => {
    const id = await draft("routine_visit", "lpn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    const signed = await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("cosign_pending");
    expect(signed.cosignatureRequestId).not.toBeNull();
    expect(await eventsFor(id)).toContain("m8.encounter.signed");
    const cr = signed.cosignatureRequestId as string;
    expect(await eventsFor(cr)).toContain("m8.encounter.cosignature_routed");
    // §2.4 — "routed to the assigned RN case manager". It used to route to `signedByMembershipId`, so
    // the LPN who signed the note owned its cosignature queue entry and its 12h/24h/48h escalations
    // (#124). Asserted against the ROW, and against the signer specifically, so a stand-in that happened
    // to be non-null could not satisfy it.
    const routed = await admin.query(
      "SELECT routed_to_membership_id FROM cosignature_request WHERE id=$1",
      [cr],
    );
    expect(routed.rows[0].routed_to_membership_id).toBe(CASE_MANAGER_MEMBERSHIP_ID);
    expect(routed.rows[0].routed_to_membership_id).not.toBe(ACTOR_A.membershipId);
    // The cosignature queue surfaces it; the RN acknowledges then cosigns.
    const queue = await svc.cosignatureQueue(ORG_A);
    expect(queue.encounters.some((e) => e.id === id)).toBe(true);
    // GAP-029 — the cosigner is NOT the author: the case-manager membership cosigns (the author, ACTOR_A,
    // is refused at the service level — see the next case).
    const COSIGNER_A = { membershipId: CASE_MANAGER_MEMBERSHIP_ID, sessionId: SESSION_A };
    const ack = await svc.cosignAcknowledge(ORG_A, id, COSIGNER_A, SERVICE_DATE as never);
    expect(ack.status).toBe("acknowledged");
    const done = await svc.cosignSign(ORG_A, id, COSIGNER_A, {
      isQualifiedRn: true,
      at: SERVICE_DATE as never,
    });
    expect(done.status).toBe("cosigned");
    expect(done.cosignedAt).toBeTruthy();
    expect(await eventsFor(id)).toContain("m8.encounter.cosigned");
  });

  it("GAP-029 — the author cannot acknowledge or cosign their own LPN note (403, workflow untouched)", async () => {
    const id = await draft("routine_visit", "lpn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    await expect(
      svc.cosignAcknowledge(ORG_A, id, ACTOR_A, SERVICE_DATE as never),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      svc.cosignSign(ORG_A, id, ACTOR_A, { isQualifiedRn: true, at: SERVICE_DATE as never }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await svc.getCosignature(ORG_A, id)).status).toBe("routed");
  });

  it("§7.4 D1 — an F2F encounter signs as one atomic unit (no cosign); a missing M6 id is 412", async () => {
    // Without the M6 face_to_face_encounter_id the dual-write guard fires (F2F_DUAL_WRITE_REQUIRED → 412).
    const bare = await draft("face_to_face", "md");
    await svc.finalize(ORG_A, bare, SERVICE_DATE as never);
    await expect(
      svc.sign(ORG_A, bare, ACTOR_A, { at: SERVICE_DATE as never }),
    ).rejects.toMatchObject({ statusCode: 412 });
    // With it present, the sign completes as `signed` (MD/NP never route to cosignature).
    const f2f = await draft("face_to_face", "md", { faceToFaceEncounterId: randomUUID() });
    await svc.finalize(ORG_A, f2f, SERVICE_DATE as never);
    const signed = await svc.sign(ORG_A, f2f, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("signed");
    expect(await eventsFor(f2f)).toContain("m8.encounter.signed");
  });

  it("void from draft is a terminal admin action; emits m8.encounter.voided", async () => {
    const id = await draft("routine_visit", "rn");
    const reason = "documented void reason meeting the 40-character minimum length rule";
    const v = await svc.voidEncounter(ORG_A, id, {
      isAdmin: true,
      reason,
      at: SERVICE_DATE as never,
    });
    expect(v.status).toBe("voided");
    expect(await eventsFor(id)).toContain("m8.encounter.voided");
    // A non-admin void is refused (403) before any write.
    const id2 = await draft("routine_visit", "rn");
    await expect(
      svc.voidEncounter(ORG_A, id2, { isAdmin: false, reason, at: SERVICE_DATE as never }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("addendum on a signed encounter: draft → finalize → sign; emits m8.encounter.addendum_signed", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    const a = await svc.createAddendum(ORG_A, id, {
      reason: "Correcting the signed encounter documentation.",
      authorMembershipId: ACTOR_A.membershipId,
    });
    expect(a.status).toBe("draft");
    const addendumNote = await svc.updateAddendumSelections(ORG_A, id, a.id, TREE);
    expect(addendumNote.layer1Preview).toContain("cardiovascularly stable");
    // The addendum's note is its OWN hearthnote_selection row, keyed by addendum_id (#114).
    const addendumRows = await admin.query(
      "SELECT template_key FROM hearthnote_selection WHERE addendum_id=$1",
      [a.id],
    );
    expect(addendumRows.rowCount).toBe(1);
    expect(addendumRows.rows[0].template_key).toBe("routine_visit:rn");
    const fin = await svc.finalizeAddendum(ORG_A, id, a.id);
    expect(fin.status).toBe("finalized");
    const signed = await svc.signAddendum(ORG_A, id, a.id, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("signed");
    expect(await eventsFor(id)).toContain("m8.encounter.addendum_signed");
  });

  // ── §2.6 the assembled-output pin (#122) ────────────────────────────────────────────────────────
  //
  // `hearthnote_assembled_output` had never been written by anything but the eraser. The §2.3 machine has
  // emitted `{ kind: "persist_assembled_output" }` at every finalize since M8-T04 and no service performed
  // it, so the "byte-identical" narrative was reassembled from the selection tree on every read.

  it("§2.6 — finalize PINS the assembled narrative, sealed, and never in the clear", async () => {
    // `draft()` documents every REQUIRED section with `nv.cv.stable`, whose phrase is the string this
    // test looks for in (and never in) the sealed columns.
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);

    const out = await admin.query(
      `SELECT kind, encounter_id, addendum_id, layer1_cipher, layer2_cipher, final_cipher,
              layer2_eligibility, layer2_involved_at_finalize, assembly_template_key, vocab_version_id
         FROM hearthnote_assembled_output WHERE encounter_id=$1`,
      [id],
    );
    expect(out.rowCount).toBe(1);
    const row = out.rows[0];
    expect(row.kind).toBe("primary_finalize");
    expect(row.addendum_id).toBeNull();
    expect(row.assembly_template_key).toBe("routine_visit:rn");
    // D5's finalize-time reification, from the module's own eligibility ladder: the platform
    // `hearthnote.layer2` flag is OFF in Phase 1, so the ladder's outermost gate is the answer.
    expect(row.layer2_eligibility).toBe("kill_switch_active");
    expect(row.layer2_involved_at_finalize).toBe(false);
    expect(row.layer2_cipher).toBeNull(); // the layer2_consistency CHECK, satisfied by derivation
    // The narrative is PHI: neither cipher column may contain it.
    expect(row.layer1_cipher).not.toContain("cardiovascularly stable");
    expect(row.final_cipher).not.toContain("cardiovascularly stable");
    expect(row.final_cipher.startsWith("v1.")).toBe(true);
    // The D11 pin the encounter claims and the version the note was assembled under are ONE value.
    const enc = await admin.query("SELECT vocab_version_id FROM encounter WHERE id=$1", [id]);
    expect(row.vocab_version_id).toBe(enc.rows[0].vocab_version_id);
  });

  it("§2.6 — the pinned bytes survive a change to the tree they were assembled from", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    const atFinalize = await svc.renderPayload(ORG_A, id);
    expect(atFinalize.pinned).toBe(true);
    expect(atFinalize.final).toContain("cardiovascularly stable");

    // Rewrite the inputs underneath the signed note — the shape of a `@wardenx/narrative-vocab` release
    // that edits a shipped phrase, or of the `${patient}` slot resolving for the first time. Done in SQL
    // because the service itself refuses to edit a finalized encounter (§2.7), which is exactly why the
    // recompute-at-read behaviour was invisible: nothing a CLINICIAN can do changes the tree afterwards.
    await admin.query(
      `UPDATE hearthnote_selection
          SET selections = jsonb_set(selections, '{sections,0,entries,0,code}', '"nv.resp.unlabored"')
        WHERE encounter_id=$1`,
      [id],
    );
    // The tree really did change — the selections read reflects it, so the two answers now diverge.
    const tree = await svc.getSelections(ORG_A, id);
    expect(tree.layer1Preview).not.toBe(atFinalize.final);

    const afterEdit = await svc.renderPayload(ORG_A, id);
    expect(afterEdit.final).toBe(atFinalize.final);
    expect(afterEdit.pinned).toBe(true);
  });

  it("§2.6 — a draft renders as an UNPINNED preview, distinguishably", async () => {
    const id = await draft("routine_visit", "rn");
    const preview = await svc.renderPayload(ORG_A, id);
    expect(preview.pinned).toBe(false);
    expect(preview.final).toContain("cardiovascularly stable");
    expect(
      (await admin.query("SELECT 1 FROM hearthnote_assembled_output WHERE encounter_id=$1", [id]))
        .rowCount,
    ).toBe(0);
  });

  it("§2.6 — an addendum finalize pins its OWN output against the parent's template", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    const a = await svc.createAddendum(ORG_A, id, {
      reason: "Correcting the signed encounter documentation.",
      authorMembershipId: ACTOR_A.membershipId,
    });
    await svc.updateAddendumSelections(ORG_A, id, a.id, TREE);
    await svc.finalizeAddendum(ORG_A, id, a.id);

    const out = await admin.query(
      `SELECT kind, encounter_id, assembly_template_key, vocab_version_id
         FROM hearthnote_assembled_output WHERE addendum_id=$1`,
      [a.id],
    );
    expect(out.rowCount).toBe(1);
    expect(out.rows[0].kind).toBe("addendum_finalize");
    expect(out.rows[0].encounter_id).toBeNull(); // the parent_xor CHECK
    // An addendum to an RN routine visit is written against the RN routine-visit template, so it is
    // pinned against that template and the PARENT's pinned vocabulary version.
    expect(out.rows[0].assembly_template_key).toBe("routine_visit:rn");
    const enc = await admin.query("SELECT vocab_version_id FROM encounter WHERE id=$1", [id]);
    expect(out.rows[0].vocab_version_id).toBe(enc.rows[0].vocab_version_id);
  });

  it("§2.6 — with no DEK bound, finalize REFUSES and leaves the encounter in draft", async () => {
    const id = await draft("routine_visit", "rn");
    // The assembled narrative is prose by construction and its columns are NOT NULL, so unlike the
    // selection tree there is no codes-in-the-clear half to write without a key. This is the whole
    // blast radius of #122 until #105 binds the KEK adapter, made executable rather than asserted.
    await expect(noCipherSvc.finalize(ORG_A, id, SERVICE_DATE as never)).rejects.toMatchObject({
      statusCode: 503,
      code: "HEARTHNOTE_CIPHER_UNBOUND",
    });
    expect((await svc.getEncounter(ORG_A, id)).status).toBe("draft");
    expect(
      (await admin.query("SELECT 1 FROM hearthnote_assembled_output WHERE encounter_id=$1", [id]))
        .rowCount,
    ).toBe(0);
  });

  it("§3.6 — the crypto-shred now has something to shred: an erased note's ciphers go empty", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    // The eraser has always handled `hearthnote_assembled_output` — it ran against a table that had never
    // held a row. This is the first time the §3.6 DEK-first shred has had one. Only the shred is driven
    // here: the delete half runs as `wardenx_destruction` (0157), and this suite's connection is the
    // NOBYPASSRLS `wardenx_app` role, which holds DELETE on no M8 table by design (append-only).
    const store = createDrizzleEncounterEraseStore(handle.db);
    await store.cryptoEraseHearthnote(ORG_A, PATIENT);
    const out = await admin.query(
      "SELECT layer1_cipher, final_cipher FROM hearthnote_assembled_output WHERE encounter_id=$1",
      [id],
    );
    expect(out.rowCount).toBe(1);
    expect(out.rows[0].layer1_cipher).toBe("");
    expect(out.rows[0].final_cipher).toBe("");
    // And the render refuses rather than serving an empty note as if it were the record.
    await expect(svc.renderPayload(ORG_A, id)).rejects.toBeTruthy();
  });

  // ── §2.6 D5 Layer-2 (#123) ───────────────────────────────────────────────────────────────────────

  it("§2.6 D5 — enhance answers the ladder's reason, and the same reason the pinned row records", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    const out = await svc.enhanceHearthnote(ORG_A, id);
    expect(out).toEqual({ enhanced: false, reason: "kill_switch_active" });
    // The route and `hearthnote_assembled_output.layer2_eligibility` resolve through the SAME ladder,
    // so they cannot say different things about why Layer 2 did not run for this encounter.
    const row = await admin.query(
      "SELECT layer2_eligibility FROM hearthnote_assembled_output WHERE encounter_id=$1",
      [id],
    );
    expect(row.rows[0].layer2_eligibility).toBe(out.reason);
  });

  it("§2.6 D5 — the decision route's 404 is a real absence: a REAL modification row gets a 200", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    const outputId = (
      await admin.query("SELECT id FROM hearthnote_assembled_output WHERE encounter_id=$1", [id])
    ).rows[0].id as string;

    // An id that names nothing → 404. On its own this is unfalsifiable — a hard-coded refusal looks
    // identical — so the row below is what makes it a real read.
    await expect(
      svc.recordModificationDecision(ORG_A, id, "2f1d4c9e-0000-4000-8000-000000000001"),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Nothing in the product writes `hearthnote_llm_modification` (the Layer-2 dispatch is unbuilt), so
    // this suite writes one directly — the only way to prove the lookup resolves rather than refuses.
    const modId = (
      await admin.query(
        `INSERT INTO hearthnote_llm_modification
           (organization_id, provider_entity_id, location_id, assembled_output_id,
            prompt_template_key, prompt_template_version, model_id,
            tokens_input, tokens_output, latency_ms, diff_json, called_by_membership_id)
         VALUES ($1,$2,$3,$4,'hearthnote.enhance','v1','claude-test',0,0,0,'[]'::jsonb,$5)
         RETURNING id`,
        [ORG_A, SITING_A.providerEntityId, SITING_A.locationId, outputId, membershipOf[ORG_A]],
      )
    ).rows[0].id as string;
    expect(await svc.recordModificationDecision(ORG_A, id, modId)).toEqual({
      modificationId: modId,
    });

    // And it is scoped to its own encounter: the same real modification, asked for under a DIFFERENT
    // encounter, is not found. The route used to echo any id back under any encounter.
    const other = await draft("routine_visit", "rn");
    await expect(svc.recordModificationDecision(ORG_A, other, modId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("§3.6 — the two envelopes are bound to their columns: a blob cannot be moved between them", async () => {
    const sealed = await CIPHERS.freeText.seal(ORG_A, "Family to call if pain escalates.");
    // Same key, same scheme, different AAD — so a free-text envelope written into `final_cipher` fails
    // to open rather than decrypting into the wrong column, and vice versa.
    await expect(CIPHERS.narrative.open(ORG_A, sealed)).rejects.toThrow();
    // And the org is in the AAD too: another tenant's key ring cannot open this one's note.
    await expect(CIPHERS.freeText.open(ORG_B, sealed)).rejects.toThrow();
  });

  it("§7.7 optimistic concurrency — a stale updateSelections is 412, a fresh one bumps the version", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    await expect(svc.updateSelections(ORG_A, id, 99, EMPTY_TREE)).rejects.toMatchObject({
      statusCode: 412,
    });
    const bumped = await svc.updateSelections(ORG_A, id, 0, EMPTY_TREE);
    expect(bumped.version).toBe(1);
  });

  it("§2.7 immutability — editing a signed encounter is refused (IMMUTABLE_AFTER_SIGN → 409)", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    await expect(svc.captureVitals(ORG_A, id, { heartRate: 72 })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  // #92 — the vitals read-back, against real rows under the NOBYPASSRLS `wardenx_app` role. The pure
  // suite proves the projection over in-memory Maps; only this proves the SELECT returns the columns
  // the write actually persisted, that `captured_at` orders them, and that RLS scopes them by tenant.
  it("#92 listVitals round-trips the persisted measurements, newest capture first", async () => {
    // captureVitals: false — this test asserts the EXACT row list its own two captures produce; the
    // #125 auto-capture default would add a third.
    const id = await draft("routine_visit", "rn", { captureVitals: false });
    const first = await svc.captureVitals(ORG_A, id, {
      heartRate: 60,
      temperature: "37.1",
      temperatureUnit: "c",
    });
    // A distinct `captured_at` — the ordering claim is about the real clock, not an id tiebreak.
    await new Promise((r) => setTimeout(r, 25));
    const second = await svc.captureVitals(ORG_A, id, {
      bpSystolic: 150,
      bpDiastolic: 95,
      spo2: 97,
      painScore: 4,
      painScale: "nrs_0_10",
      weight: "80",
      weightUnit: "kg",
      height: "180",
      heightUnit: "cm",
      bloodGlucose: 110,
      bloodGlucoseUnit: "mg_dl",
    });

    const read = await svc.listVitals(ORG_A, id);
    expect(read.encounterId).toBe(id);
    expect(read.vitals.map((v) => v.id)).toEqual([second.vitalsId, first.vitalsId]);

    const [newest, oldest] = read.vitals;
    if (!newest || !oldest) throw new Error("expected two vitals sets");
    expect(newest.bpSystolic).toBe(150);
    expect(newest.bpDiastolic).toBe(95);
    expect(newest.spo2).toBe(97);
    expect(newest.painScore).toBe(4);
    expect(newest.painScale).toBe("nrs_0_10");
    expect(newest.weight).toBe("80");
    expect(newest.height).toBe("180");
    expect(newest.bloodGlucose).toBe(110);
    expect(newest.bloodGlucoseUnit).toBe("mg_dl");
    // Stored BMI comes back as stored; flags re-derive to the same answer the write returned.
    expect(newest.bmi).toBe(second.bmi);
    expect(newest.abnormalFlags).toEqual(second.abnormalFlags);
    // A measurement nobody took reads as null on a row that exists — not as a missing key.
    expect(oldest.heartRate).toBe(60);
    expect(oldest.temperature).toBe("37.1");
    expect(oldest.spo2).toBeNull();
    expect(oldest.bmi).toBeNull();
  });

  it("#92 listVitals survives the encounter being signed (the record stays retrievable)", async () => {
    // captureVitals: false + the full roster in ONE call — §2.6 check 2 (#125) now requires it for a
    // routine_visit to finalize at all, and this test's own assertion is the exact single row it wrote.
    const id = await draft("routine_visit", "rn", { captureVitals: false });
    const written = await svc.captureVitals(ORG_A, id, {
      heartRate: 72,
      bpSystolic: 118,
      bpDiastolic: 76,
      respiratoryRate: 16,
      temperature: "98.6",
      temperatureUnit: "f",
      spo2: 98,
      painScore: 0,
      painScale: "nrs_0_10",
    });
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    // Writing is refused after signing (§2.7); READING must not be — 42 CFR 418.104 requires the
    // signed record be retrievable, and it is the signed state the record exists in.
    const read = await svc.listVitals(ORG_A, id);
    expect(read.vitals.map((v) => v.id)).toEqual([written.vitalsId]);
    expect(read.vitals[0]?.heartRate).toBe(72);
  });

  it("#92 RLS — org B cannot read org A's vitals, and gets a non-leaking 404 not an empty list", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.captureVitals(ORG_A, id, { heartRate: 72 });
    await expect(svc.listVitals(ORG_B, id)).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── §2.6 HearthNote selections (#114) ─────────────────────────────────────────────────────────────
  //
  // The two selections PATCHes published a required body, parsed none of it, bumped `version` and
  // returned 200. Nothing had ever written a `hearthnote_selection` row — the only code that touched the
  // three hearthnote tables was the ERASER. These cases drive the real Drizzle path as the NOBYPASSRLS
  // role and read the row back out of Postgres.

  it("§2.6 — the tree is PERSISTED to hearthnote_selection and reads back assembled", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    const written = await svc.updateSelections(ORG_A, id, 0, TREE);
    expect(written.version).toBe(1);
    expect(written.layer1Preview).toContain("2+ dependent edema");

    // The row exists. Asserted against the TABLE, not the service, because "nothing writes this table"
    // is the finding — a service that returns the right shape from memory would satisfy a weaker test.
    const rows = await admin.query(
      "SELECT template_key, template_version, selections, free_text_cipher, provider_entity_id FROM hearthnote_selection WHERE encounter_id=$1",
      [id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].template_key).toBe("routine_visit:rn");
    expect(rows.rows[0].selections.sections).toHaveLength(1);
    // No cipher is bound in this suite, so the tree carries no free text and the column stays NULL —
    // never plaintext prose in a column named `_cipher`.
    expect(rows.rows[0].free_text_cipher).toBeNull();

    const read = await svc.getSelections(ORG_A, id);
    expect(read.sections).toEqual(TREE.sections);
    expect(read.layer1Preview).toBe(written.layer1Preview);
  });

  it("§2.6 — a second PATCH UPDATES the one row rather than adding a second (mig 0225)", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    await svc.updateSelections(ORG_A, id, 0, TREE);
    await svc.updateSelections(ORG_A, id, 1, {
      sections: [{ sectionId: "assessment", entries: [{ code: "nv.neuro.alert" }] }],
    });
    const rows = await admin.query(
      "SELECT version, selections FROM hearthnote_selection WHERE encounter_id=$1",
      [id],
    );
    // Before 0225 the "unique" indexes were plain indexes, so this would have been two rows and every
    // reader afterwards would have had to guess which one was the note.
    expect(rows.rowCount).toBe(1);
    expect(Number(rows.rows[0].version)).toBe(1);
    const read = await svc.getSelections(ORG_A, id);
    expect(read.sections[0]?.entries[0]?.code).toBe("nv.neuro.alert");
  });

  it("§3.6 — free text is REFUSED with no cipher bound, and nothing is written", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    await expect(
      noCipherSvc.updateSelections(ORG_A, id, 0, {
        sections: [{ sectionId: "plan", entries: [], freeText: "Family to call overnight." }],
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "HEARTHNOTE_CIPHER_UNBOUND" });
    const rows = await admin.query("SELECT 1 FROM hearthnote_selection WHERE encounter_id=$1", [
      id,
    ]);
    expect(rows.rowCount).toBe(0);
    // The refusal is a refusal, not a partial write: the encounter's own version did not move either.
    expect((await svc.getEncounter(ORG_A, id)).version).toBe(0);
  });

  it("§3.6 — with a cipher bound, the prose round-trips and is NEVER stored in the clear", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    const prose = "Family to call if pain escalates overnight.";
    const written = await svc.updateSelections(ORG_A, id, 0, {
      sections: [{ sectionId: "plan", entries: [], freeText: prose }],
    });
    expect(written.layer1Preview).toContain(prose);

    const rows = await admin.query(
      "SELECT selections, free_text_cipher FROM hearthnote_selection WHERE encounter_id=$1",
      [id],
    );
    expect(rows.rows[0].free_text_cipher).not.toBeNull();
    expect(rows.rows[0].free_text_cipher).not.toContain(prose);
    // And it is not hiding in the structured column either — the split is the §3.6 minimization rule.
    expect(JSON.stringify(rows.rows[0].selections)).not.toContain(prose);

    const read = await svc.getSelections(ORG_A, id);
    expect(read.sections[0]?.freeText).toBe(prose);
  });

  it("the M22 render seam 404s with no note, and serves the assembled one after a PATCH", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    // Was a 200 with `final: ""` — an empty note reported as a successful render.
    await expect(svc.renderPayload(ORG_A, id)).rejects.toMatchObject({ statusCode: 404 });
    await svc.updateSelections(ORG_A, id, 0, TREE);
    const rendered = await svc.renderPayload(ORG_A, id);
    expect(rendered.final).toContain("Assessment");
    expect(rendered.final).toContain("cardiovascularly stable");
  });

  it("RLS — org B cannot read or write org A's hearthnote_selection (non-leaking 404)", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    await svc.updateSelections(ORG_A, id, 0, TREE);
    await expect(svc.getSelections(ORG_B, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.updateSelections(ORG_B, id, 1, TREE)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(svc.renderPayload(ORG_B, id)).rejects.toMatchObject({ statusCode: 404 });
    // Org A's note is untouched by org B's attempt.
    expect((await svc.getSelections(ORG_A, id)).sections).toEqual(TREE.sections);
  });

  // ── §2.6 Layer-3 compliance gate (#121) ───────────────────────────────────────────────────────────
  //
  // `transitionEncounter` enforced `gatePreviewPassed`/`gatePassed` correctly and all four callers in
  // this file's subject handed it the literal `true`, so an encounter with nothing documented in any of
  // its four required sections finalized, signed, and emitted `m8.encounter.signed`. These cases drive
  // the real Drizzle path and assert against the TABLE — the row must still be a draft afterwards.

  it("§2.6 — an undocumented encounter does not finalize, and the ROW stays draft", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    await expect(svc.finalize(ORG_A, id, SERVICE_DATE as never)).rejects.toMatchObject({
      statusCode: 422,
      code: "COMPLIANCE_GATE_FAILED",
    });
    const rows = await admin.query("SELECT status, vocab_version_id FROM encounter WHERE id=$1", [
      id,
    ]);
    expect(rows.rows[0].status).toBe("draft");
    // The D11 pin is a finalize side-effect, so a refused finalize must not have left one behind.
    expect(rows.rows[0].vocab_version_id).toBeNull();
    expect(await eventsFor(id)).not.toContain("m8.encounter.finalized");
  });

  it("§2.6 — a note documented short of its required sections is refused, per section", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    // Only two of the four required sections for routine_visit × rn.
    await svc.updateSelections(ORG_A, id, 0, {
      sections: [
        { sectionId: "chief_concern", entries: [{ code: "nv.cv.stable" }] },
        { sectionId: "assessment", entries: [{ code: "nv.neuro.alert" }] },
      ],
    });
    const err = await svc.finalize(ORG_A, id, SERVICE_DATE as never).catch((e: unknown) => e);
    const details = (err as { details?: Array<{ field?: string }> }).details ?? [];
    expect(details.map((d) => d.field).sort()).toEqual(["plan", "vitals_review"]);
  });

  it("§2.6 check 2 (#125) — a routine_visit missing a required vital is refused at finalize, per field; clinically_not_indicated is a real escape", async () => {
    const id = await draft("routine_visit", "rn", { captureVitals: false });
    // Every roster field but BP: the gate runs as a PREVIEW at finalize (same as check 1), so a note
    // missing a required vital never reaches `finalized` in the first place.
    await svc.captureVitals(ORG_A, id, {
      heartRate: 72,
      respiratoryRate: 16,
      temperature: "98.6",
      temperatureUnit: "f",
      spo2: 98,
      painScore: 0,
      painScale: "nrs_0_10",
    });
    const err = await svc.finalize(ORG_A, id, SERVICE_DATE as never).catch((e: unknown) => e);
    const details = (err as { details?: Array<{ field?: string; code?: string }> }).details ?? [];
    expect(details).toContainEqual(expect.objectContaining({ field: "bp", code: "MISSING_VITAL" }));
    const draftRow = await admin.query("SELECT status FROM encounter WHERE id=$1", [id]);
    expect(draftRow.rows[0].status).toBe("draft");

    // The same encounter, with BP marked clinically not indicated and a reason ≥20 chars, finalizes
    // and signs — the escape hatch, reachable for the first time (#125's acceptance criterion).
    await svc.captureVitals(ORG_A, id, {
      clinicallyNotIndicatedFields: ["bp"],
      clinicallyNotIndicatedReason: "patient refused cuff placement this visit",
    });
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    const signed = await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("signed");
  });

  it("§2.6 check 3 (#125) — a recert_visit missing a required scale blocks the SIGN of a fully documented note; the row stays finalized on the refusal", async () => {
    latestScales = new Set(["pps", "esas_r"]); // both present — finalize sees a satisfied gate.
    try {
      const id = await draft("recert_visit", "rn");
      await svc.finalize(ORG_A, id, SERVICE_DATE as never);
      latestScales = new Set(["pps"]); // ESAS drops out before sign — mirrors the M7-overdue shape.
      await expect(
        svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never }),
      ).rejects.toMatchObject({ statusCode: 422, code: "COMPLIANCE_GATE_FAILED" });
      const rows = await admin.query("SELECT status FROM encounter WHERE id=$1", [id]);
      expect(rows.rows[0].status).toBe("finalized");
      expect(await eventsFor(id)).not.toContain("m8.encounter.signed");

      latestScales = new Set(["pps", "esas_r"]);
      const signed = await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
      expect(signed.status).toBe("signed");
    } finally {
      latestScales = new Set();
    }
  });

  it("§2.6 check 6 — an overdue M7 care plan blocks the SIGN of a fully documented note", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    carePlanOverdue = {
      planId: "cp_1",
      patientId: PATIENT,
      overdue: true,
      initialOverdue: false,
      reviewOverdue: true,
      initialDueAt: "2026-01-06T00:00:00.000Z",
      nextReviewDueAt: "2026-01-20T00:00:00.000Z",
    };
    try {
      await expect(
        svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never }),
      ).rejects.toMatchObject({ statusCode: 422, code: "COMPLIANCE_GATE_FAILED" });
      const rows = await admin.query("SELECT status FROM encounter WHERE id=$1", [id]);
      expect(rows.rows[0].status).toBe("finalized");
      expect(await eventsFor(id)).not.toContain("m8.encounter.signed");
      // No signature provenance row either — a refused sign leaves no CoP 418.104(c) trail.
      const sigs = await admin.query("SELECT 1 FROM encounter_signature WHERE encounter_id=$1", [
        id,
      ]);
      expect(sigs.rowCount).toBe(0);
    } finally {
      carePlanOverdue = null;
    }
    // With the plan back in window the same encounter signs — so the block was the plan, not the note.
    const signed = await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("signed");
  });

  it("§2.6 — an addendum with nothing in it does not finalize", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    const a = await svc.createAddendum(ORG_A, id, {
      reason: "Correcting the signed encounter documentation.",
      authorMembershipId: ACTOR_A.membershipId,
    });
    await expect(svc.finalizeAddendum(ORG_A, id, a.id)).rejects.toMatchObject({
      statusCode: 422,
      code: "COMPLIANCE_GATE_FAILED",
    });
    const rows = await admin.query("SELECT status FROM encounter_addendum WHERE id=$1", [a.id]);
    expect(rows.rows[0].status).toBe("draft");
  });

  // ── §2.6 check 10 / §2.4 D3 — the cosigner-exists guard (#124) ────────────────────────────────────

  it("§2.6 check 10 — an LPN note refuses to sign when the patient has no RN case manager", async () => {
    const id = await draft("routine_visit", "lpn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await admin.query(
      "UPDATE patient_assignment SET unassigned_at = CURRENT_DATE WHERE patient_id=$1 AND role='primary_rn'",
      [PATIENT],
    );
    try {
      await expect(
        svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never }),
      ).rejects.toMatchObject({ statusCode: 422, code: "NO_ELIGIBLE_COSIGNER" });
      // A refused sign writes NOTHING: the row is still finalized, there is no CoP 418.104(c)
      // signature row, and no cosignature_request routed at nobody.
      const enc = await admin.query("SELECT status FROM encounter WHERE id=$1", [id]);
      expect(enc.rows[0].status).toBe("finalized");
      expect(
        (await admin.query("SELECT 1 FROM encounter_signature WHERE encounter_id=$1", [id]))
          .rowCount,
      ).toBe(0);
      expect(
        (await admin.query("SELECT 1 FROM cosignature_request WHERE encounter_id=$1", [id]))
          .rowCount,
      ).toBe(0);
      expect(await eventsFor(id)).not.toContain("m8.encounter.signed");
    } finally {
      await admin.query(
        "UPDATE patient_assignment SET unassigned_at = NULL WHERE patient_id=$1 AND role='primary_rn'",
        [PATIENT],
      );
    }
    // Re-assigned, the SAME encounter signs — so the refusal was the missing case manager, not the note.
    expect((await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never })).status).toBe(
      "cosign_pending",
    );
  });

  it("§2.6 check 10 — a case manager whose MEMBERSHIP has lapsed is not an eligible cosigner", async () => {
    const id = await draft("routine_visit", "lpn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    // The assignment stays open; only the membership goes. An RN who has left the agency cannot
    // cosign, and routing to their stale membership id would send the duty to nobody.
    await admin.query("UPDATE membership SET status='revoked' WHERE id=$1", [
      CASE_MANAGER_MEMBERSHIP_ID,
    ]);
    try {
      await expect(
        svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never }),
      ).rejects.toMatchObject({ statusCode: 422, code: "NO_ELIGIBLE_COSIGNER" });
    } finally {
      await admin.query("UPDATE membership SET status='active' WHERE id=$1", [
        CASE_MANAGER_MEMBERSHIP_ID,
      ]);
    }
  });

  it("§2.6 check 10 — an RN note never asks the question: no case manager, still signs", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await admin.query(
      "UPDATE patient_assignment SET unassigned_at = CURRENT_DATE WHERE patient_id=$1 AND role='primary_rn'",
      [PATIENT],
    );
    try {
      // Only lpn/chha route a cosignature (§2.3), so the guard must not become a new way for an RN
      // note to fail — the discipline decides, not the assignment roster.
      expect((await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never })).status).toBe(
        "signed",
      );
    } finally {
      await admin.query(
        "UPDATE patient_assignment SET unassigned_at = NULL WHERE patient_id=$1 AND role='primary_rn'",
        [PATIENT],
      );
    }
  });

  // ── §2.7 D11 the vocabulary version pin (#128) ────────────────────────────────────────────────────
  //
  // Finalize used to write ONE constant sentinel uuid (`…0000d8`) into `encounter.vocab_version_id` on
  // every encounter the platform had ever signed. It satisfied the `encounter_vocab_pinned_when_finalized`
  // CHECK and identified nothing, so §2.6 check 12 could be evaluated against it in neither direction and
  // `checkVocabVersion` — the §2.7 guard, written in M8-T04 — was reached by no production path.
  //
  // The pure suite proves the rule over the in-memory slice. Only these prove the value that actually
  // lands in Postgres, on both tables, and that they cannot disagree.

  const RETIRED_SENTINEL = "00000000-0000-4000-8000-0000000000d8";

  it("#128 finalize pins the real corpus release on the encounter row — never the sentinel", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);

    const { rows } = await admin.query("SELECT vocab_version_id FROM encounter WHERE id=$1", [id]);
    const pinned = rows[0].vocab_version_id as string;
    expect(pinned).not.toBe(RETIRED_SENTINEL);
    expect(pinned).toBe(activeNarrativeVocabRelease(VOCAB_VERSION).id);
    // The stored uuid decodes back to a named corpus — the whole point of D11 for a retained record.
    expect(narrativeVocabReleaseById(pinned)?.version).toBe(VOCAB_VERSION);
  });

  it("#128 the encounter row and its assembled output carry the SAME pin", async () => {
    // Resolved once per finalize, so the version the bytes were assembled under cannot drift from the
    // version the encounter claims. #122 pinned the bytes; this is what they are pinned AGAINST.
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);

    const enc = await admin.query("SELECT vocab_version_id FROM encounter WHERE id=$1", [id]);
    const out = await admin.query(
      "SELECT vocab_version_id FROM hearthnote_assembled_output WHERE encounter_id=$1",
      [id],
    );
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].vocab_version_id).toBe(enc.rows[0].vocab_version_id);
    expect(out.rows[0].vocab_version_id).not.toBe(RETIRED_SENTINEL);
  });

  it("#128 the §2.7 guard REFUSES a draft authored against an older corpus, and the row stays draft", async () => {
    const id = await draft("routine_visit", "rn");
    // Model the mid-draft corpus flip: the selections were saved under an earlier release. The column
    // is written by the production upsert, so this is the same fact finalize reads, not a stand-in.
    await admin.query("UPDATE hearthnote_selection SET template_version=$1 WHERE encounter_id=$2", [
      "narrative-vocab@2026.05.0",
      id,
    ]);

    await expect(svc.finalize(ORG_A, id, SERVICE_DATE as never)).rejects.toMatchObject({
      code: "VOCAB_VERSION_MISMATCH",
    });

    const { rows } = await admin.query(
      "SELECT status, vocab_version_id FROM encounter WHERE id=$1",
      [id],
    );
    expect(rows[0].status).toBe("draft");
    expect(rows[0].vocab_version_id).toBeNull(); // the transition did not happen at all
    // …and no assembled output was pinned for a note that never finalized.
    const out = await admin.query(
      "SELECT 1 FROM hearthnote_assembled_output WHERE encounter_id=$1",
      [id],
    );
    expect(out.rows.length).toBe(0);
  });

  it("#128 re-saving the selections restamps the corpus and the finalize then succeeds", async () => {
    const id = await draft("routine_visit", "rn");
    await admin.query("UPDATE hearthnote_selection SET template_version=$1 WHERE encounter_id=$2", [
      "narrative-vocab@2026.05.0",
      id,
    ]);
    await expect(svc.finalize(ORG_A, id, SERVICE_DATE as never)).rejects.toThrow();

    const before = await svc.getEncounter(ORG_A, id);
    await svc.updateSelections(
      ORG_A,
      id,
      before?.version as number,
      requiredSectionSelections("routine_visit" as never, "rn" as never),
    );
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);

    const { rows } = await admin.query("SELECT vocab_version_id FROM encounter WHERE id=$1", [id]);
    expect(rows[0].vocab_version_id).toBe(activeNarrativeVocabRelease(VOCAB_VERSION).id);
  });

  it("#128 a draft voided before it ever finalized pins a real release, satisfying the CHECK", async () => {
    // `encounter_vocab_pinned_when_finalized` demands a pin for every non-draft row, and a voided draft
    // has never assembled anything. It used to take the sentinel; it now takes the corpus current at
    // the void — decodable, and still never confusable with a signed note's pin.
    const id = await draft("routine_visit", "rn");
    await svc.voidEncounter(ORG_A, id, {
      isAdmin: true,
      reason: "documented void reason meeting the 40-character minimum length rule",
      at: SERVICE_DATE as never,
    });

    const { rows } = await admin.query(
      "SELECT status, vocab_version_id FROM encounter WHERE id=$1",
      [id],
    );
    expect(rows[0].status).toBe("voided");
    expect(rows[0].vocab_version_id).not.toBe(RETIRED_SENTINEL);
    expect(narrativeVocabReleaseById(rows[0].vocab_version_id as string)).not.toBeNull();
  });

  // ── F-064 (#159) — care-plan links, at the row ────────────────────────────────────────────────────
  //
  // `POST .../care-plan-links` parsed a body carrying the M7 problem/goal/intervention refs, passed NONE
  // of them on, persisted nothing, and answered 201 with the ENCOUNTER's id as `linkId`. The route
  // service blamed only the un-threaded refs. The other half is here, and is what made the insert
  // IMPOSSIBLE rather than merely unwritten: `encounter_care_plan_link.provider_entity_id` /
  // `location_id` were NOT NULL while the encounter they copy from carried null in both, because 0128
  // relaxed that pair on every OTHER encounter satellite and left this table out.
  describe("F-064 — the care-plan link persists", () => {
    const PROBLEM = "44444444-4444-4444-8444-444444444444";
    const GOAL = "55555555-5555-4555-8555-555555555555";

    it("encounter is sited at createDraft, from M6 — the column 0128 deferred", async () => {
      const id = await draft("routine_visit", "rn");
      const { rows } = await admin.query(
        "SELECT provider_entity_id, location_id FROM encounter WHERE id = $1",
        [id],
      );
      // Both were NULL on every encounter the platform had ever written, and the harness used to patch
      // them in so the signature row's NOT NULLs would hold.
      expect(rows[0].provider_entity_id).toBe(SITING_A.providerEntityId);
      expect(rows[0].location_id).toBe(SITING_A.locationId);
    });

    it("inserts a real row carrying the M7 refs, and returns ITS id", async () => {
      const id = await draft("routine_visit", "rn");
      const link = await svc.addCarePlanLink(ORG_A, membershipOf[ORG_A], id, {
        problemId: PROBLEM,
        goalId: GOAL,
      });
      expect(link.id).not.toBe(id); // the old `linkId` was the encounter's own id
      const { rows } = await admin.query(
        "SELECT * FROM encounter_care_plan_link WHERE encounter_id = $1",
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].problem_id).toBe(PROBLEM);
      expect(rows[0].goal_id).toBe(GOAL);
      expect(rows[0].intervention_id).toBeNull();
      // Copied from the encounter, which is why the encounter had to be sited first.
      expect(rows[0].provider_entity_id).toBe(SITING_A.providerEntityId);
      expect(rows[0].removed_at).toBeNull();
    });

    it("refuses a link naming no element before the DB CHECK can raise a 23514", async () => {
      const id = await draft("routine_visit", "rn");
      await expect(svc.addCarePlanLink(ORG_A, membershipOf[ORG_A], id, {})).rejects.toMatchObject({
        code: "CARE_PLAN_LINK_REF_REQUIRED",
        statusCode: 422,
      });
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM encounter_care_plan_link WHERE encounter_id = $1",
        [id],
      );
      expect(rows[0].n).toBe(0);
    });

    it("removal is a soft invalidate: the row survives, the link stops listing", async () => {
      const id = await draft("routine_visit", "rn");
      const link = await svc.addCarePlanLink(ORG_A, membershipOf[ORG_A], id, {
        problemId: PROBLEM,
      });
      await svc.removeCarePlanLink(ORG_A, membershipOf[ORG_A], id, link.id);
      expect((await svc.listCarePlanLinks(ORG_A, id)).links).toEqual([]);
      const { rows } = await admin.query(
        "SELECT removed_at, removed_by_membership_id FROM encounter_care_plan_link WHERE id = $1",
        [link.id],
      );
      // `wardenx_app` holds DELETE on no M8 table (§3.6 append-only), and the M4 write-audit trail is
      // only as good as the rows it describes — so the row stays, marked and attributed.
      expect(rows).toHaveLength(1);
      expect(rows[0].removed_at).not.toBeNull();
      expect(rows[0].removed_by_membership_id).toBe(membershipOf[ORG_A]);
    });

    it("removing an already-removed link is a 404, not a second success", async () => {
      const id = await draft("routine_visit", "rn");
      const link = await svc.addCarePlanLink(ORG_A, membershipOf[ORG_A], id, {
        problemId: PROBLEM,
      });
      await svc.removeCarePlanLink(ORG_A, membershipOf[ORG_A], id, link.id);
      await expect(
        svc.removeCarePlanLink(ORG_A, membershipOf[ORG_A], id, link.id),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("the removal-consistency CHECK refuses an instant with no actor", async () => {
      // `encounter_care_plan_link_removal_consistent` — a removal with no actor is unattributable, and
      // an actor with no instant is not a removal. Only the constraint can prove this.
      const id = await draft("routine_visit", "rn");
      const link = await svc.addCarePlanLink(ORG_A, membershipOf[ORG_A], id, {
        problemId: PROBLEM,
      });
      await expect(
        admin.query("UPDATE encounter_care_plan_link SET removed_at = now() WHERE id = $1", [
          link.id,
        ]),
      ).rejects.toThrow(/encounter_care_plan_link_removal_consistent/);
    });
  });

  it("RLS — org B cannot read or write org A's encounter (non-leaking 404)", async () => {
    const id = await draft("routine_visit", "rn", { document: false });
    await expect(svc.getEncounter(ORG_B, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.finalize(ORG_B, id, SERVICE_DATE as never)).rejects.toMatchObject({
      statusCode: 404,
    });
    const { encounters } = await svc.listEncounters(ORG_B);
    expect(encounters.every((e) => e.id !== id)).toBe(true);
  });

  // ── GAP-069 / GAP-070 — the M8 seam store runs on the REAL tables, as `wardenx_app` under RLS ─────────
  describe("seam store over the real tables (GAP-069 / GAP-070)", () => {
    const REQ = { organizationId: ORG_A, userId: USER } as never;
    const seamStore = () =>
      createDrizzleEncounterReaderStore(handle.db, {
        outbox: {
          publish: (tx, e) =>
            buildTxOutboxPublisher(buildBootOutboxCatalog([M8_OUTBOX_EVENTS])).publish(
              tx as never,
              { ...e, callerModule: "m8" },
            ),
        },
        narrativeCipher: CIPHERS.narrative,
      });

    it("EncounterCreator writes a real draft row (no phantom id) and emits m8.encounter.created", async () => {
      const { encounterId } = await runWithRequestContext(REQ, () =>
        seamStore().insertDraftEncounter({
          patientId: PATIENT,
          admissionId: ADMISSION,
          encounterType: "telephonic" as never,
          discipline: "rn" as never,
          serviceDate: SERVICE_DATE as never,
          authorMembershipId: membershipOf[ORG_A],
          visitId: null,
        }),
      );
      const { rows } = await admin.query(
        "SELECT status, organization_id, provider_entity_id, location_id FROM encounter WHERE id=$1",
        [encounterId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("draft");
      expect(rows[0].organization_id).toBe(ORG_A);
      expect(rows[0].provider_entity_id).toBe(SITING_A.providerEntityId);
      expect(await eventsFor(encounterId)).toContain("m8.encounter.created");
    });

    it("MileagePayrollReader returns the signed encounter's authoritative miles; a draft's are not payable", async () => {
      const signedId = await draft("routine_visit", "rn");
      await svc.captureMileage(ORG_A, signedId, {
        odometerStart: 2000,
        odometerEnd: 2018,
        source: "odometer",
      });
      await svc.finalize(ORG_A, signedId, SERVICE_DATE as never);
      await svc.sign(ORG_A, signedId, ACTOR_A, { at: SERVICE_DATE as never });
      const draftId = await draft("routine_visit", "rn");
      await svc.captureMileage(ORG_A, draftId, {
        odometerStart: 3000,
        odometerEnd: 3050,
        source: "odometer",
      });
      const rows = await runWithRequestContext(REQ, () =>
        seamStore().mileageForClinician(membershipOf[ORG_A], {
          from: SERVICE_DATE as never,
          to: SERVICE_DATE as never,
        }),
      );
      const forSigned = rows.find((r) => r.encounterId === signedId);
      expect(forSigned?.milesDriven).toBe(18);
      expect(rows.some((r) => r.encounterId === draftId)).toBe(false);
      // RLS: org B's request context sees none of org A's mileage.
      const other = await runWithRequestContext(
        { organizationId: ORG_B, userId: USER } as never,
        () =>
          seamStore().mileageForClinician(membershipOf[ORG_A], {
            from: SERVICE_DATE as never,
            to: SERVICE_DATE as never,
          }),
      );
      expect(other).toEqual([]);
    });

    it("SignedEncountersReader.renderPayloadFor opens the pinned narrative of a signed encounter", async () => {
      const id = await draft("routine_visit", "rn");
      await svc.finalize(ORG_A, id, SERVICE_DATE as never);
      await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
      const viaRoute = await svc.renderPayload(ORG_A, id);
      const viaSeam = await runWithRequestContext(REQ, () => seamStore().renderPayload(id));
      expect(viaSeam?.final).toBe(viaRoute.final);
      expect(viaSeam?.final.length).toBeGreaterThan(0);
      expect(viaSeam?.addenda).toEqual([]);
    });

    it("a visit with an M18 bracket signs evv_present, PERSISTS it, and the reader reports it (HVLDL numerator)", async () => {
      const visitId = randomUUID();
      registerSeam("EvvBracketResolver", {
        resolveBracket: async () => ({
          checkInEventId: randomUUID(),
          checkOutEventId: randomUUID(),
          startedAt: "2026-01-15T14:00:00.000Z",
          endedAt: "2026-01-15T15:00:00.000Z",
          bracketState: "evv_present",
        }),
      } as never);
      const d = await svc.createDraft(ORG_A, membershipOf[ORG_A], {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit" as never,
        discipline: "rn" as never,
        serviceDate: SERVICE_DATE as never,
        visitId,
      });
      await svc.updateSelections(
        ORG_A,
        d.id,
        0,
        requiredSectionSelections("routine_visit" as never, "rn" as never),
      );
      const vitals = requiredVitalsCapture("routine_visit" as never, "rn" as never);
      if (vitals) await svc.captureVitals(ORG_A, d.id, vitals);
      await svc.finalize(ORG_A, d.id, SERVICE_DATE as never);
      await svc.sign(ORG_A, d.id, ACTOR_A, { at: SERVICE_DATE as never });

      const { rows } = await admin.query(
        "SELECT evv_bracket_state, evv_check_in_event_id, started_at, ended_at FROM encounter WHERE id=$1",
        [d.id],
      );
      expect(rows[0].evv_bracket_state).toBe("evv_present");
      expect(rows[0].evv_check_in_event_id).not.toBeNull();
      const digests = await seamStore().signedEncountersForPatientSince(
        ORG_A,
        PATIENT,
        "2026-01-01T00:00:00.000Z",
      );
      const mine = digests.find((x) => x.encounterId === d.id);
      expect(mine?.evvBracketState).toBe("evv_present");
      expect(mine?.durationMinutes).toBe(60);
      const { rows: ev } = await admin.query(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m8.encounter.signed'",
        [d.id],
      );
      expect(ev[0].payload.evvBracketState).toBe("evv_present");
    });

    it("an encounter with no resolvable bracket signs evv_missing_documented in the event AND the reader (one NULL rule)", async () => {
      registerSeam("EvvBracketResolver", { resolveBracket: async () => null } as never);
      const id = await draft("routine_visit", "rn");
      await svc.finalize(ORG_A, id, SERVICE_DATE as never);
      await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
      const { rows: ev } = await admin.query(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m8.encounter.signed'",
        [id],
      );
      expect(ev[0].payload.evvBracketState).toBe("evv_missing_documented");
      const digests = await seamStore().signedEncountersForPatientSince(
        ORG_A,
        PATIENT,
        "2026-01-01T00:00:00.000Z",
      );
      expect(digests.find((x) => x.encounterId === id)?.evvBracketState).toBe(
        "evv_missing_documented",
      );
    });
  });
});
