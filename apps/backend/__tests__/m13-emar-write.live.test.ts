/**
 * M13L — the Drizzle eMAR write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role. Like M12, M13 has NO state-transition triggers, so
 * the service does every transition itself (composing the pure `@wardenx/emar` deciders): recordAdministration
 * (single-dose, controlled-substance-with-witness, ad-hoc + scheduled-dose siting) · caregiver-attested capture
 * → acknowledge / dispute · correct (supersede) · void · refuse · intentional-hold · missed-dose acknowledge ·
 * reconciliation decision/update/caregiver-line/finalize/void · comfort-kit return · policy put. Like the
 * M7–M12 write suites it binds the REAL catalog-validating transactional publisher
 * (buildBootOutboxCatalog([M13_OUTBOX_EVENTS]) → the caller's tx) and asserts the `m13.*` rows land in
 * `outbox_event`. RLS is exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m13:write:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { issuePatientWristband } from "../src/modules/05-patient/wristband-db";
import { buildPatientWristbandVerifier } from "../src/modules/05-patient/wristband-verifier";
import {
  type EmarMedicationOrderPort,
  type EmarWriteOutboxPort,
  createDbEmarBackend,
} from "../src/modules/13-emar/emar-route-service-db";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const VOID_REASON = "Recorded against the wrong patient chart in error; verified with the RN.";
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER2 = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const MED_ORDER = "66666666-6666-6666-6666-666666666666";
/** GAP-005 — a Schedule II order. Controlled status comes from the ORDER; the body may only agree. */
const CONTROLLED_MED_ORDER = "6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c";
/** An order M12's D6 verdict refuses — resolvable, but discontinued (F-058). */
const BLOCKED_MED_ORDER = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";
/** GAP-004 — a second patient on the same tenant, with an order of its own. */
const OTHER_PATIENT = "4e4e4e4e-4e4e-4e4e-8e4e-4e4e4e4e4e4e";
const OTHER_MED_ORDER = "6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e";
/** GAP-021 -- a PRN order with a 4h (240 min) minimum interval between doses. */
const PRN_MED_ORDER = "6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f";

describe.skipIf(!DB_URL)("M13 eMAR write lifecycle — LIVE Postgres (M13L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbEmarBackend>;
  let orderPort: EmarMedicationOrderPort;
  const memberOf: Record<string, string> = {};
  const member2Of: Record<string, string> = {};
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  /** GAP-023 -- the patient's active M12 orders the stub reports; [] by default so older cases are unaffected. */
  let activeOrderIds: string[] = [];

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
  async function admStatus(id: string): Promise<string> {
    const { rows } = await admin.query("SELECT status FROM administration_record WHERE id=$1", [
      id,
    ]);
    return rows[0]?.status as string;
  }
  /** Seed a pending `scheduled_dose` (its siting is what recordAdministration copies) as superuser. */
  async function seedScheduledDose(org: string, patientId = PATIENT): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO scheduled_dose (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, medication_order_id, due_at, grace_window_minutes, expected_dose_amount,
           expected_dose_unit, expected_route, materialization_sequence)
         VALUES ($1,$2,$3,$4,$5,$6, now(), 60, 5.0000, 'mg', 'oral', 1) RETURNING id`,
        [org, providerOf[org], locationOf[org], patientId, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;
  }
  async function seedMissedDose(org: string, scheduledDoseId: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO missed_dose (organization_id, provider_entity_id, location_id, scheduled_dose_id,
           patient_id, admission_id, medication_order_id, missed_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'detected_by_sweep') RETURNING id`,
        [org, providerOf[org], locationOf[org], scheduledDoseId, PATIENT, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;
  }
  async function seedWorksheet(org: string, n: number): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO medication_reconciliation_worksheet (organization_id, provider_entity_id, location_id,
           patient_id, admission_id, trigger_kind, trigger_outbox_event_id, triggered_at, due_at, status)
         VALUES ($1,$2,$3,$4,$5,'admission', gen_random_uuid(), now(), now() + interval '5 days', 'pending')
         RETURNING id`,
        [org, providerOf[org], locationOf[org], PATIENT, ADMISSION],
      )
    ).rows[0].id as string;
  }
  async function seedDeployment(org: string, patientId = PATIENT): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO comfort_kit_deployment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, deployed_at)
         VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
        [org, providerOf[org], locationOf[org], patientId, ADMISSION],
      )
    ).rows[0].id as string;
  }

  const recordArgs = (over: Record<string, unknown> = {}) => ({
    medicationOrderId: over.medClass === "controlled_substance" ? CONTROLLED_MED_ORDER : MED_ORDER,
    medClass: "standard" as const,
    mode: "single_dose" as const,
    administeredAt: new Date().toISOString(),
    route: "oral",
    doseAmount: 5,
    doseUnit: "mg",
    ...over,
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'m13w@x.test'),($2,'m13w2@x.test')`,
      [USER, USER2],
    );
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
      member2Of[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER2, org],
        )
      ).rows[0].id as string;
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-M13W-${org.slice(0, 4)}`,
            `M13W ${org.slice(0, 4)}`,
            `NPI-M13W-${org.slice(0, 4)}`,
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
    // GAP-020 -- the wristband verifier is M5's: it reads `patient` + `patient_wristband` under RLS, so the two
    // patients this suite writes administrations for exist as real rows.
    for (const [id, last] of [
      [PATIENT, "Alpha"],
      [OTHER_PATIENT, "Bravo"],
    ] as const)
      await admin.query(
        `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob,
           sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,'Pat',$4,'1950-01-01','female','active')`,
        [id, ORG_A, `mrn-m13-${last}`, last],
      );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M13_OUTBOX_EVENTS]));
    const outbox: EmarWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m13" }),
    };
    // F-031 — the M12 identity reader the production mount binds over
    // `MedicationOrderProvider.getAdministrationContext`. Stands in for M12 here (this is M13's suite, and
    // M12's own provider is proven in dosespot-seams.test.ts) but answers the SAME question with the same
    // shape: an unknown order resolves to null and the write refuses.
    const medicationOrder: EmarMedicationOrderPort = {
      async administrationIdentity({ medicationOrderId }) {
        // F-058 — the §2.9 D6 verdict is ARMED now, so the stub answers it. A discontinued order is a
        // resolvable order that must NOT be administered: the difference between "unknown" (refused for
        // not knowing the patient) and "known and not administrable" (refused on M12's verdict).
        if (medicationOrderId === BLOCKED_MED_ORDER)
          return {
            patientId: PATIENT,
            admissionId: ADMISSION,
            drugName: "Morphine Sulfate Oral Solution",
            route: "oral",
            ivContinuousPolicy: null,
            allowAdministration: false,
            blockedReasons: ["discontinued"],
            medClass: "standard",
            isControlledSubstance: false,
            isSudTreatment: false,
          };
        const known = [MED_ORDER, CONTROLLED_MED_ORDER, OTHER_MED_ORDER, PRN_MED_ORDER];
        if (!known.includes(medicationOrderId)) return null;
        const controlled = medicationOrderId === CONTROLLED_MED_ORDER;
        return {
          patientId: medicationOrderId === OTHER_MED_ORDER ? OTHER_PATIENT : PATIENT,
          admissionId: ADMISSION,
          drugName: "Morphine Sulfate Oral Solution",
          route: "oral",
          // §2.11 D11 — this order authorises titration between 1 and 10 mg/hr. An order that stated no
          // bounds would authorise NO rate change; the last IV test below proves that arm.
          ivContinuousPolicy: { minRate: 1, maxRate: 10 },
          allowAdministration: true,
          blockedReasons: [],
          medClass: controlled ? "controlled_substance" : "standard",
          isControlledSubstance: controlled,
          // GAP-036 follow-up — the controlled order stands in for an SUD-treatment (methadone) order, so the
          // flag M12 now writes is proven to reach the administration row (portal redaction + M28 Part 2 gate).
          isSudTreatment: controlled,
          // GAP-020 -- the order states 5 mg oral, RxNorm/NDC identities, and (PRN) a 240 min minimum.
          doseAmount: 5,
          doseUnit: "mg",
          rxnormRxcui: "rx-morphine",
          ndc: "ndc-morphine",
          prnMinimumIntervalMinutes: medicationOrderId === PRN_MED_ORDER ? 240 : null,
        };
      },
      async activeMedicationOrderIds() {
        return activeOrderIds;
      },
    };
    orderPort = medicationOrder;
    // The REAL M5 verifier over the real tables (not a stub): the wrong_patient arm is proven end to end.
    svc = createDbEmarBackend(
      handle.db,
      outbox,
      undefined,
      () => medicationOrder,
      undefined,
      () => buildPatientWristbandVerifier(handle.db),
    );
  }, 120_000);

  /** Print a real band for `patientId` through M5's own issue path; returns the RAW payload (shown once). */
  async function printBand(
    patientId: string,
    reason = "first_issue",
    expected: number | null = null,
  ) {
    return (
      await issuePatientWristband(
        handle.db,
        { organizationId: ORG_A, userId: USER },
        { patientId, reason: reason as never, expectedCurrentGeneration: expected },
      )
    ).payload;
  }
  const resetBands = async () => {
    await admin.query("DELETE FROM patient_wristband");
    await admin.query("DELETE FROM barcode_scan_event");
    await admin.query("UPDATE administration_policy SET bcma_wristband_required = true");
  };
  const scanEvents = async () =>
    (
      await admin.query(
        `SELECT match_result, wristband_check, wristband_generation, wristband_matched_patient_id,
                administration_record_id, patient_id, patient_wristband_payload_digest, patient_wristband_scanned_at
           FROM barcode_scan_event ORDER BY created_at, id`,
      )
    ).rows;

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("recordAdministration against a scheduled dose commits + sources siting + flips the dose", async () => {
    const sched = await seedScheduledDose(ORG_A);
    const view = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({ scheduledDoseId: sched }),
    );
    expect(view.status).toBe("committed");
    expect(view.patientId).toBe(PATIENT);
    expect(view.scheduledDoseId).toBe(sched);
    expect(await eventsFor(view.id)).toContain("m13.administration.recorded");
    const { rows } = await admin.query(
      "SELECT status, provider_entity_id FROM scheduled_dose WHERE id=$1",
      [sched],
    );
    expect(rows[0].status).toBe("administered");
    const { rows: adm } = await admin.query(
      "SELECT provider_entity_id FROM administration_record WHERE id=$1",
      [view.id],
    );
    expect(adm[0].provider_entity_id).toBe(providerOf[ORG_A]); // siting copied from the scheduled dose
  });

  it("an ad-hoc administration (no scheduled dose) records with null siting + a PRN reassessment emit", async () => {
    const view = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({
        prn: { triggeringPrnReason: "breakthrough pain", requestedByKind: "clinician_observed" },
      }),
    );
    expect(view.status).toBe("committed");
    const events = await eventsFor(view.id);
    expect(events).toContain("m13.administration.recorded");
    expect(events).toContain("m13.prn_administration_recorded");
  });

  it("a controlled-substance administration needs a witness token (mint → record); missing → 422", async () => {
    const sched = await seedScheduledDose(ORG_A);
    // No token → WITNESS_REQUIRED (ValidationError, 422).
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({ scheduledDoseId: sched, medClass: "controlled_substance" }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    // Mint (witness = the second membership) then record — the token's scope must match the resolved
    // patient/order/administering-clinician.
    const { token } = await svc.mintWitnessToken(ORG_A, member2Of[ORG_A], {
      patientId: PATIENT,
      medicationOrderId: CONTROLLED_MED_ORDER,
      administeringClinicianMembershipId: memberOf[ORG_A],
    });
    const view = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({
        scheduledDoseId: sched,
        medClass: "controlled_substance",
        witnessToken: token,
      }),
    );
    expect(view.status).toBe("committed");
    expect(view.isControlledSubstance).toBe(true);
    expect(view.witnessMembershipId).toBe(member2Of[ORG_A]);
    // GAP-036 follow-up — M12's SUD flag is snapshotted onto the administration row (it was never written).
    expect(
      (
        await admin.query("SELECT is_sud_treatment FROM administration_record WHERE id=$1", [
          view.id,
        ])
      ).rows[0].is_sud_treatment,
    ).toBe(true);
    const events = await eventsFor(view.id);
    expect(events).toContain("m13.administration.recorded");
    expect(events).toContain("m13.administration.controlled_witnessed");
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM administration_witness WHERE administration_record_id=$1",
      [view.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("GAP-004: emar.scope resolves every M13 id to its patient under RLS; another org sees nothing", async () => {
    const sched = await seedScheduledDose(ORG_A);
    const missedId = await seedMissedDose(ORG_A, sched);
    const ws = await seedWorksheet(ORG_A, 1);
    const dep = await seedDeployment(ORG_A);
    const adm = await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs());
    const refs = [
      ["administrationId", adm.id],
      ["scheduledDoseId", sched],
      ["missedDoseId", missedId],
      ["worksheetId", ws],
      ["deploymentId", dep],
      ["medicationOrderId", MED_ORDER],
    ] as const;
    for (const [kind, id] of refs) {
      expect(await svc.loadScopePatientId(ORG_A, kind, id)).toBe(PATIENT);
    }
    for (const [kind, id] of refs.filter(([k]) => k !== "medicationOrderId")) {
      expect(await svc.loadScopePatientId(ORG_B, kind, id)).toBeNull();
    }
    expect(await svc.loadOrderMedClass(ORG_A, CONTROLLED_MED_ORDER)).toBe("controlled_substance");
  });

  it("GAP-005: a controlled order sent as medClass 'standard' with no witness → 422, nothing written", async () => {
    const before = (
      await admin.query(
        "SELECT count(*)::int AS n FROM administration_record WHERE medication_order_id=$1",
        [CONTROLLED_MED_ORDER],
      )
    ).rows[0].n as number;
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], {
        ...recordArgs(),
        medicationOrderId: CONTROLLED_MED_ORDER,
        medClass: "standard",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    // Even the old "standard" claim with the order itself left to decide still needs the witness.
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], {
        ...recordArgs(),
        medicationOrderId: CONTROLLED_MED_ORDER,
        medClass: undefined as never,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const after = (
      await admin.query(
        "SELECT count(*)::int AS n FROM administration_record WHERE medication_order_id=$1",
        [CONTROLLED_MED_ORDER],
      )
    ).rows[0].n as number;
    expect(after).toBe(before);
  });

  it("GAP-005: a refusal of a controlled order is stored controlled, and a wrong patient is refused", async () => {
    const refused = await svc.recordRefusal(ORG_A, memberOf[ORG_A], {
      patientId: PATIENT,
      medicationOrderId: CONTROLLED_MED_ORDER,
      refusedAt: new Date().toISOString(),
    } as never);
    expect(refused.isControlledSubstance).toBe(true);
    await expect(
      svc.recordRefusal(ORG_A, memberOf[ORG_A], {
        patientId: "77777777-7777-4777-8777-777777777777",
        medicationOrderId: MED_ORDER,
        refusedAt: new Date().toISOString(),
      } as never),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  // GAP-004 — `emar.scope` proves each named id is in the caller's scope, not that they name ONE patient.
  // A clinician with both patients on caseload passes the gate, so the service is what keeps a row whole.
  it("GAP-004: a dose, IV session or comfort kit of another patient is refused against this order", async () => {
    const mismatch = { statusCode: 422, details: [{ code: "PATIENT_ORDER_MISMATCH" }] };
    const before = Number(
      (await admin.query("SELECT count(*) FROM administration_record")).rows[0].count,
    );

    const otherDose = await seedScheduledDose(ORG_A, OTHER_PATIENT);
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ scheduledDoseId: otherDose })),
    ).rejects.toMatchObject(mismatch);

    const otherKit = await seedDeployment(ORG_A, OTHER_PATIENT);
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({ comfortKitDeploymentId: otherKit }),
      ),
    ).rejects.toMatchObject(mismatch);

    const otherStart = await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({ mode: "iv_continuous_start", medicationOrderId: OTHER_MED_ORDER }),
      data: { infusionRate: 4, rateUnit: "mg/hr", infusionDilution: "morphine 1mg/mL in NS" },
    });
    expect(otherStart.patientId).toBe(OTHER_PATIENT);
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], {
        ...recordArgs({ mode: "iv_continuous_pause", ivSessionId: otherStart.ivSessionId }),
        data: {},
      }),
    ).rejects.toMatchObject(mismatch);

    // Only the other patient's own IV start was written; every mismatched row was refused whole.
    const after = Number(
      (await admin.query("SELECT count(*) FROM administration_record")).rows[0].count,
    );
    expect(after - before).toBe(1);
  });

  it("GAP-004: a caregiver attestation naming a patient the order does not belong to is refused", async () => {
    await expect(
      svc.recordCaregiverAttested(ORG_A, {
        patientId: OTHER_PATIENT,
        medicationOrderId: MED_ORDER,
        administeredAt: new Date().toISOString(),
        caregiverSessionId: "77777777-7777-4777-8777-777777777777",
        route: "oral",
        doseAmount: 5,
        doseUnit: "mg",
      }),
    ).rejects.toMatchObject({ statusCode: 422, details: [{ code: "PATIENT_ORDER_MISMATCH" }] });
  });

  // GAP-004 — witness-attest is deliberately NOT caseload-scoped (the witness is rarely on the patient's
  // caseload), so the mint itself must not sign a patient the order is not for. Consumption would never
  // honour such a token anyway; this proves the mint refuses it up front and that a token for another
  // patient's order cannot be spent against this one.
  it("GAP-004: the witness mint refuses a patient the order is not for, and an unresolvable order", async () => {
    await expect(
      svc.mintWitnessToken(ORG_A, member2Of[ORG_A], {
        patientId: OTHER_PATIENT,
        medicationOrderId: CONTROLLED_MED_ORDER,
        administeringClinicianMembershipId: memberOf[ORG_A],
      }),
    ).rejects.toMatchObject({ statusCode: 422, details: [{ code: "PATIENT_ORDER_MISMATCH" }] });
    await expect(
      svc.mintWitnessToken(ORG_A, member2Of[ORG_A], {
        patientId: PATIENT,
        medicationOrderId: "77777777-7777-4777-8777-777777777777",
        administeringClinicianMembershipId: memberOf[ORG_A],
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: [{ code: "MEDICATION_ORDER_UNRESOLVED" }],
    });
    // A well-formed token for ANOTHER order (and its patient) is refused at consumption: the verifier binds
    // the order and the order's resolved patient, not whatever the witness was told.
    const { token } = await svc.mintWitnessToken(ORG_A, member2Of[ORG_A], {
      patientId: OTHER_PATIENT,
      medicationOrderId: OTHER_MED_ORDER,
      administeringClinicianMembershipId: memberOf[ORG_A],
    });
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({ medClass: "controlled_substance", witnessToken: token }),
      ),
    ).rejects.toMatchObject({ statusCode: 422, details: [{ code: "WITNESS_REQUIRED" }] });
  });

  it("F-031: an ad-hoc administration is filed under the ORDER's patient, not a sentinel", async () => {
    // Before F-031 this row landed on patient_id 00000000-…-aa. Nothing in production materializes a
    // `scheduled_dose` (the m12.medication_order.active -> m13.materialize-schedule consumer is declared and
    // unbound), so this branch was not an edge case — it was every administration the platform could record,
    // and every one of them was absent from the patient's own eMAR.
    const view = await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs());
    expect(view.patientId).toBe(PATIENT);
    const { rows } = await admin.query(
      "SELECT patient_id, admission_id, drug_name_snapshot FROM administration_record WHERE id=$1",
      [view.id],
    );
    expect(rows[0].patient_id).toBe(PATIENT);
    expect(rows[0].admission_id).toBe(ADMISSION);
    // The MAR must say what was given, not "" — the order can be corrected or discontinued afterwards.
    expect(rows[0].drug_name_snapshot).toBe("Morphine Sulfate Oral Solution");
    const listed = await svc.listAdministrations(ORG_A, { patient: PATIENT });
    expect(listed.map((r) => r.id)).toContain(view.id);
  });

  it("F-031: an ad-hoc CONTROLLED-SUBSTANCE administration can now be witnessed", async () => {
    // The D7 verifier binds the token's scope to the patient the service RESOLVED. While that was the
    // sentinel and the witness minted against the real patient, no token could ever match — the
    // controlled-substance path refused every caller, including a correctly-witnessed one.
    const { token } = await svc.mintWitnessToken(ORG_A, member2Of[ORG_A], {
      patientId: PATIENT,
      medicationOrderId: CONTROLLED_MED_ORDER,
      administeringClinicianMembershipId: memberOf[ORG_A],
    });
    const view = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({ medClass: "controlled_substance", witnessToken: token }),
    );
    expect(view.status).toBe("committed");
    expect(view.witnessMembershipId).toBe(member2Of[ORG_A]);
  });

  it("F-031: an administration naming no dose and an unresolvable order is REFUSED, not sentinel-filed", async () => {
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({ medicationOrderId: "77777777-7777-4777-8777-777777777777" }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("F-058: the §2.9 D6 gate refuses an order M12 says is not administrable", async () => {
    // Threaded but unarmed for exactly one release: only `status = "active"` cleared M12's verdict and
    // nothing in the platform activated an order, so arming it then would have refused every
    // administration the system could produce. With the producer fixed the verdict finally separates
    // "ready to give" from "discontinued / replaced / never signed".
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({ medicationOrderId: BLOCKED_MED_ORDER }),
      ),
    ).rejects.toMatchObject({ code: "ADMINISTRATION_BLOCKED" });
    // A scheduled dose is no exemption — the dose was materialized from this same order.
    const sched = await seedScheduledDose(ORG_A);
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({ medicationOrderId: BLOCKED_MED_ORDER, scheduledDoseId: sched }),
      ),
    ).rejects.toMatchObject({ code: "ADMINISTRATION_BLOCKED" });
  });

  it("F-031/#134: an IV session is minted, its graph enforced, and its rate bounded", async () => {
    // Nothing in the codebase wrote `iv_session_id` before this: the production path never set it, the
    // in-memory slice hard-coded it null, and `assertIvSegmentLegal`/`checkIvRateBounds` — real and
    // unit-tested in @wardenx/emar — were called by no one.
    const start = await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({ mode: "iv_continuous_start" }),
      data: { infusionRate: 4, rateUnit: "mg/hr", infusionDilution: "morphine 1mg/mL in NS" },
    });
    expect(start.ivSessionId).not.toBeNull();
    const session = start.ivSessionId as string;

    // A `resume` on a RUNNING session is not legal — the graph, not the client, decides.
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], {
        ...recordArgs({ mode: "iv_continuous_resume", ivSessionId: session }),
        data: {},
      }),
    ).rejects.toMatchObject({ code: "ILLEGAL_IV_SESSION_TRANSITION" });

    // A titration outside the order's [1, 10] bounds is refused with the bounds echoed.
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], {
        ...recordArgs({ mode: "iv_continuous_rate_change", ivSessionId: session }),
        data: { previousRate: 4, newRate: 40, titrationReason: "pain uncontrolled" },
      }),
    ).rejects.toMatchObject({ code: "IV_RATE_OUT_OF_RANGE" });

    // In bounds: committed, and the rate is READABLE off the row (the `data` body is persisted now).
    const titrate = await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({ mode: "iv_continuous_rate_change", ivSessionId: session }),
      data: { previousRate: 4, newRate: 6, titrationReason: "pain uncontrolled" },
    });
    expect(titrate.ivSessionId).toBe(session);

    await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({ mode: "iv_continuous_pause", ivSessionId: session }),
      data: { pauseReason: "line infiltrated" },
    });
    const view = await svc.getIvSession(ORG_A, session);
    expect(view.state).toBe("paused");
    expect(view.segments.map((s) => s.kind)).toEqual([
      "iv_continuous_start",
      "iv_continuous_rate_change",
      "iv_continuous_pause",
    ]);
    expect(view.segments[1]?.rate).toBe(6);
    expect(view.endedAt).toBeNull();

    await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({ mode: "iv_continuous_resume", ivSessionId: session }),
      data: {},
    });
    const stopped = await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({ mode: "iv_continuous_stop", ivSessionId: session }),
      data: { stopReason: "comfort achieved" },
    });
    expect(stopped.ivSessionId).toBe(session);
    const closed = await svc.getIvSession(ORG_A, session);
    expect(closed.state).toBe("stopped");
    expect(closed.endedAt).not.toBeNull();

    // `stopped` is terminal.
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], {
        ...recordArgs({ mode: "iv_continuous_resume", ivSessionId: session }),
        data: {},
      }),
    ).rejects.toMatchObject({ code: "ILLEGAL_IV_SESSION_TRANSITION" });
  });

  it("F-031/#134: two segments sharing a clinical instant order by when they were RECORDED", async () => {
    // A clinician enters `administered_at` from a datetime-local control, which has MINUTE resolution, so
    // a start and the titration seconds later carry the IDENTICAL instant. With only `id` to break the
    // tie the derived state was a random uuid comparison, and `composeIvSession` could refuse a perfectly
    // good session for "not beginning with a start". Both segments are written at the same instant here
    // deliberately.
    const sameInstant = new Date().toISOString();
    const start = await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({ mode: "iv_continuous_start", administeredAt: sameInstant }),
      data: { infusionRate: 2, rateUnit: "mg/hr" },
    });
    const session = start.ivSessionId as string;
    await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({
        mode: "iv_continuous_rate_change",
        ivSessionId: session,
        administeredAt: sameInstant,
      }),
      data: { previousRate: 2, newRate: 5, titrationReason: "breakthrough pain" },
    });
    const view = await svc.getIvSession(ORG_A, session);
    expect(view.segments.map((x) => x.kind)).toEqual([
      "iv_continuous_start",
      "iv_continuous_rate_change",
    ]);
    expect(view.state).toBe("running");
  });

  it("F-031/#134: a start may not name a session and a continuation must", async () => {
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], {
        ...recordArgs({ mode: "iv_continuous_start", ivSessionId: PATIENT }),
        data: { infusionRate: 2 },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], {
        ...recordArgs({ mode: "iv_continuous_pause" }),
        data: { pauseReason: "x" },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("F-031/#134: a controlled infusion is witnessed at start/titrate/stop but NOT at pause", async () => {
    // `planIvSegment`'s rule is narrower than "controlled": pause and resume change no dose, so demanding
    // a second clinician to stop a running pump would be the wrong gate at the wrong moment.
    const mint = async () =>
      (
        await svc.mintWitnessToken(ORG_A, member2Of[ORG_A], {
          patientId: PATIENT,
          medicationOrderId: CONTROLLED_MED_ORDER,
          administeringClinicianMembershipId: memberOf[ORG_A],
        })
      ).token;
    const start = await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({ medClass: "controlled_substance", mode: "iv_continuous_start" }),
      data: { infusionRate: 3, infusionDilution: "1mg/mL" },
      witnessToken: await mint(),
    });
    expect(start.witnessMembershipId).toBe(member2Of[ORG_A]);
    const session = start.ivSessionId as string;

    // No token, and none needed.
    const paused = await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({
        medClass: "controlled_substance",
        mode: "iv_continuous_pause",
        ivSessionId: session,
      }),
      data: { pauseReason: "patient to bathroom" },
    });
    expect(paused.witnessMembershipId).toBeNull();

    await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({
        medClass: "controlled_substance",
        mode: "iv_continuous_resume",
        ivSessionId: session,
      }),
      data: {},
    });
    // A controlled stop DOES need one, and a stop with drug left in the bag announces the wastage — an
    // event catalogued since M13-T08 with no emitter until now.
    const stop = await svc.recordAdministration(ORG_A, memberOf[ORG_A], {
      ...recordArgs({
        medClass: "controlled_substance",
        mode: "iv_continuous_stop",
        ivSessionId: session,
      }),
      data: { stopReason: "death", wastageAmount: 12, wastageReason: "remainder destroyed" },
      witnessToken: await mint(),
    });
    const events = await eventsFor(stop.id);
    expect(events).toContain("m13.administration.controlled_wasted");
  });

  it("caregiver-attested capture → pending_caregiver_review; acknowledge → committed; dispute flags", async () => {
    const cg = await svc.recordCaregiverAttested(ORG_A, {
      patientId: PATIENT,
      medicationOrderId: MED_ORDER,
      administeredAt: new Date().toISOString(),
      caregiverSessionId: "77777777-7777-4777-8777-777777777777",
      route: "oral",
      doseAmount: 5,
      doseUnit: "mg",
    });
    expect(cg.status).toBe("pending_caregiver_review");
    expect(cg.requiresRnReview).toBe(true);
    expect(await eventsFor(cg.id)).toContain("m13.administration.recorded_caregiver_attested");
    const ack = await svc.acknowledgeCaregiver(ORG_A, memberOf[ORG_A], cg.id);
    expect(ack.status).toBe("committed");
    expect(ack.requiresRnReview).toBe(false);
    expect(await eventsFor(cg.id)).toContain("m13.caregiver_administration.acknowledged");

    const cg2 = await svc.recordCaregiverAttested(ORG_A, {
      patientId: PATIENT,
      medicationOrderId: MED_ORDER,
      administeredAt: new Date().toISOString(),
      caregiverSessionId: "88888888-8888-4888-8888-888888888888",
      route: "oral",
      doseAmount: 5,
      doseUnit: "mg",
    });
    await svc.disputeCaregiver(
      ORG_A,
      memberOf[ORG_A],
      cg2.id,
      "dose does not match the active order",
    );
    expect(await eventsFor(cg2.id)).toContain("m13.caregiver_administration.disputed");
  });

  it("correctAdministration supersedes the original and mints a committed replacement", async () => {
    const orig = await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs());
    const corrected = await svc.correctAdministration(
      ORG_A,
      memberOf[ORG_A],
      orig.id,
      "wrong route recorded",
    );
    expect(corrected.status).toBe("committed");
    expect(corrected.id).not.toBe(orig.id);
    expect(await admStatus(orig.id)).toBe("superseded");
    expect(await eventsFor(corrected.id)).toContain("m13.administration.corrected");
  });

  it("GAP-041 — a repeat void is 409 and never overwrites the first void's attribution; a short reason is 422", async () => {
    const rec = await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs());
    await expect(
      svc.voidAdministration(ORG_A, memberOf[ORG_A], rec.id, "too short"),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await admStatus(rec.id)).toBe("committed");

    await svc.voidAdministration(ORG_A, memberOf[ORG_A], rec.id, VOID_REASON);
    await expect(
      svc.voidAdministration(
        ORG_A,
        "00000000-0000-4000-8000-00000000dead",
        rec.id,
        `${VOID_REASON} (again)`,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const { rows } = await admin.query(
      "SELECT void_reason, voided_by FROM administration_record WHERE id=$1",
      [rec.id],
    );
    expect(rows[0].void_reason).toBe(VOID_REASON);
    expect(rows[0].voided_by).toBe(memberOf[ORG_A]);
    const voidedEvents = (await eventsFor(rec.id)).filter((e) => e === "m13.administration.voided");
    expect(voidedEvents).toHaveLength(1);
  });

  it("voidAdministration voids the row; recordRefusal logs a declined dose", async () => {
    const rec = await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs());
    const voided = await svc.voidAdministration(ORG_A, memberOf[ORG_A], rec.id, VOID_REASON);
    expect(voided.status).toBe("voided");
    expect(await eventsFor(rec.id)).toContain("m13.administration.voided");

    const refusal = await svc.recordRefusal(ORG_A, memberOf[ORG_A], {
      patientId: PATIENT,
      medicationOrderId: MED_ORDER,
      medClass: "standard",
      refusedAt: new Date().toISOString(),
    });
    expect(refusal.status).toBe("committed");
    expect(await eventsFor(refusal.id)).toContain("m13.administration.refused");
  });

  it("intentionalHold flips a scheduled dose; acknowledgeMissed clears a missed dose", async () => {
    const sched = await seedScheduledDose(ORG_A);
    const held = await svc.intentionalHold(ORG_A, memberOf[ORG_A], sched);
    expect(held.status).toBe("intentionally_held");
    expect(await eventsFor(sched)).toContain("m13.scheduled_dose.intentionally_held");

    const sched2 = await seedScheduledDose(ORG_A);
    const missed = await seedMissedDose(ORG_A, sched2);
    const ack = await svc.acknowledgeMissed(ORG_A, memberOf[ORG_A], missed);
    expect(ack.acknowledgedAt).not.toBeNull();
    expect(ack.dueAt).not.toBe("");
    expect(await eventsFor(missed)).toContain("m13.missed_dose.acknowledged");
  });

  it("reconciliation: record → update decisions, add a caregiver line, finalize with the handshake emits", async () => {
    const ws = await seedWorksheet(ORG_A, 1);
    // carry_forward of an m12_active line is a no-op (the order already exists) — the real
    // draft_order_requested handshake below is what proves the fix (F-16x, #248): the payload used to be
    // a hardcoded `{}` for EVERY carry_forward/new_order, including this one, which is why this case is
    // asserted separately from the caregiver-reported one that legitimately mints a draft.
    const afterCarry = await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
      lineKind: "m12_active",
      sourceId: MED_ORDER,
      decision: "carry_forward",
    });
    expect(afterCarry.status).toBe("in_progress");
    expect(afterCarry.decisions.length).toBe(1);
    expect(await eventsFor(ws)).not.toContain("m13.reconciliation.draft_order_requested");
    const lineId = afterCarry.decisions[0].lineId;
    await svc.updateDecision(ORG_A, memberOf[ORG_A], ws, lineId, "discontinue");
    await svc.addCaregiverReportedLine(ORG_A, memberOf[ORG_A], ws, "home aspirin 81mg");
    const withDraft = await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
      lineKind: "caregiver_reported",
      sourceId: "home-aspirin-1",
      decision: "carry_forward",
      medicationDetails: {
        drugName: "Aspirin",
        strength: "81 mg",
        doseForm: "tablet",
        route: "oral",
        medClass: "standard",
      },
    });
    // 3 decision rows by now: the m12_active carry_forward (updated to discontinue), the caregiver line
    // addCaregiverReportedLine seeds as document_only, and this caregiver_reported carry_forward.
    expect(withDraft.decisions.length).toBe(3);
    expect(await eventsFor(ws)).toContain("m13.reconciliation.draft_order_requested");
    const finalized = await svc.finalizeReconciliation(ORG_A, memberOf[ORG_A], ws);
    expect(finalized.status).toBe("finalized");
    const events = await eventsFor(ws);
    expect(events).toContain("m13.reconciliation.completed");
    expect(events).toContain("m13.reconciliation.document_requested");
  });

  it("F-031: a decision links the M12 draft it produced (send to prescriber)", async () => {
    const ws = await seedWorksheet(ORG_A, 1);
    const recorded = await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
      lineKind: "caregiver_reported",
      sourceId: "home-med-1",
      decision: "new_order",
      medicationDetails: {
        drugName: "Melatonin",
        strength: "3 mg",
        doseForm: "tablet",
        route: "oral",
        medClass: "standard",
      },
    });
    const line = recorded.decisions[0]!;
    expect(line.resultingMedicationOrderId).toBeNull();
    const draftId = "88888888-8888-4888-8888-888888888888";
    const linked = await svc.updateDecision(
      ORG_A,
      memberOf[ORG_A],
      ws,
      line.lineId,
      "new_order",
      draftId,
    );
    expect(linked.decisions[0]?.resultingMedicationOrderId).toBe(draftId);
    // Changing the decision kind afterwards must not silently drop a link to an order a prescriber may
    // already have signed.
    const rekinded = await svc.updateDecision(ORG_A, memberOf[ORG_A], ws, line.lineId, "hold");
    expect(rekinded.decisions[0]?.resultingMedicationOrderId).toBe(draftId);
  });

  it("finalizeReconciliation with no decisions → RECONCILIATION_INCOMPLETE (422); voidWorksheet voids", async () => {
    const ws = await seedWorksheet(ORG_A, 2);
    await expect(svc.finalizeReconciliation(ORG_A, memberOf[ORG_A], ws)).rejects.toMatchObject({
      statusCode: 422,
    });
    const voided = await svc.voidWorksheet(
      ORG_A,
      memberOf[ORG_A],
      ws,
      "re-triggered by a transfer correction",
    );
    expect(voided.status).toBe("voided");
    expect(await eventsFor(ws)).toContain("m13.reconciliation.voided");
  });

  it("acknowledgeReturn reconciles a comfort-kit deployment", async () => {
    const dep = await seedDeployment(ORG_A);
    const returned = await svc.acknowledgeReturn(ORG_A, memberOf[ORG_A], dep);
    expect(returned.disposalStatus).toBe("returned");
    expect(await eventsFor(dep)).toContain("m13.comfort_kit.returned");
  });

  it("putPolicy upserts the tenant administration policy and round-trips", async () => {
    const put = await svc.putPolicy(ORG_A, { graceWindowMinutes: 20, emarPdfOnCommit: true });
    expect(put.graceWindowMinutes).toBe(20);
    expect(put.emarPdfOnCommit).toBe(true);
    const back = await svc.getPolicy(ORG_A);
    expect(back.graceWindowMinutes).toBe(20);
    expect(back.emarPdfOnCommit).toBe(true);
    expect(await eventsFor(ORG_A)).toContain("m13.policy.changed");
  });

  it("loadWitnessFacts (GAP-021) resolves a real active RN membership's discipline for the ABAC gate", async () => {
    const roleId = (
      await admin.query(
        `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'rn','Registered Nurse','clinical_staff') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
      [ORG_A, member2Of[ORG_A], roleId],
    );

    const facts = await svc.loadWitnessFacts(ORG_A, USER2);
    expect(facts).toMatchObject({
      witnessMembershipId: member2Of[ORG_A],
      witnessDiscipline: "rn",
      witnessMembershipActive: true,
      sameTenant: true,
      witnessIsCaregiver: false,
    });
  });

  it("loadWitnessFacts returns null for a user with no membership on the tenant (fail-closed)", async () => {
    expect(await svc.loadWitnessFacts(ORG_A, "99999999-9999-4999-8999-999999999999")).toBeNull();
  });

  it("loadWitnessFacts reflects a suspended membership as inactive (the pure decider denies membership_inactive)", async () => {
    const suspendedUser = "88888888-8888-4888-8888-888888888888";
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m13w-suspended@x.test')`, [
      suspendedUser,
    ]);
    const suspendedMember = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'suspended') RETURNING id`,
        [suspendedUser, ORG_A],
      )
    ).rows[0].id as string;

    const facts = await svc.loadWitnessFacts(ORG_A, suspendedUser);
    expect(facts).toMatchObject({
      witnessMembershipId: suspendedMember,
      witnessMembershipActive: false,
    });
  });

  // ── GAP-020 — five-rights + BCMA against the real order context ──────────────────────────────────────
  it("GAP-020: a wrong-route administration is refused 422 FIVE_RIGHTS_VIOLATION and nothing is written", async () => {
    const before = (await admin.query("SELECT count(*)::int AS n FROM administration_record"))
      .rows[0].n;
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ route: "IM" })),
    ).rejects.toMatchObject({ code: "FIVE_RIGHTS_VIOLATION", statusCode: 422 });
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM administration_record")).rows[0].n,
    ).toBe(before);
  });

  it("GAP-020: an over-dose, a wrong unit and a future administeredAt are each refused", async () => {
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ doseAmount: 50 })),
    ).rejects.toMatchObject({ code: "FIVE_RIGHTS_VIOLATION" });
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ doseUnit: "mcg" })),
    ).rejects.toMatchObject({ code: "FIVE_RIGHTS_VIOLATION" });
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({ administeredAt: new Date(Date.now() + 3_600_000).toISOString() }),
      ),
    ).rejects.toMatchObject({ code: "FIVE_RIGHTS_VIOLATION" });
    // A partial dose at or below the order is clinically legitimate.
    const half = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({ doseAmount: 2.5 }),
    );
    expect(half.status).toBe("committed");
  });

  it("GAP-020: a BCMA scan is verified against the ORDER's drug (wrong_drug reaches the write path)", async () => {
    await resetBands();
    const band = await printBand(PATIENT);
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({
          barcodeScan: { scannedRxnormRxcui: "rx-some-other-drug", patientWristbandPayload: band },
        }),
      ),
    ).rejects.toMatchObject({ code: "BARCODE_VERIFICATION_FAILED", statusCode: 422 });
    const ok = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({
        barcodeScan: { scannedRxnormRxcui: "rx-morphine", patientWristbandPayload: band },
      }),
    );
    expect(ok.barcodeMatchResult).toBe("match");
  });

  it("GAP-020 (a): a scan of the patient's own printed band is `match`, recorded as verified with the generation + digest, never the raw payload", async () => {
    await resetBands();
    const band = await printBand(PATIENT);
    const view = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({
        barcodeScan: { scannedRxnormRxcui: "rx-morphine", patientWristbandPayload: band },
      }),
    );
    expect(view.barcodeMatchResult).toBe("match");
    const [row] = await scanEvents();
    expect(row).toMatchObject({
      match_result: "match",
      wristband_check: "verified",
      wristband_generation: 1,
      administration_record_id: view.id,
      patient_id: PATIENT,
    });
    expect(row.patient_wristband_payload_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.patient_wristband_scanned_at).toBeInstanceOf(Date);
    // The raw payload is in no column anywhere in the scan or the administration row.
    const dump = JSON.stringify(
      (await admin.query("SELECT * FROM barcode_scan_event")).rows.concat(
        (await admin.query("SELECT * FROM administration_record WHERE id=$1", [view.id])).rows,
      ),
    );
    expect(dump).not.toContain(band);
    expect(dump).not.toContain(band.slice(0, band.lastIndexOf(".")));
  });

  it("GAP-020 (b): patient B's band against patient A's order is refused, NO administration is written, but the near miss is kept with B's id", async () => {
    await resetBands();
    await printBand(PATIENT);
    const bandB = await printBand(OTHER_PATIENT);
    const before = Number(
      (await admin.query("SELECT count(*)::int n FROM administration_record")).rows[0].n,
    );
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({
          barcodeScan: { scannedRxnormRxcui: "rx-morphine", patientWristbandPayload: bandB },
        }),
      ),
    ).rejects.toMatchObject({
      code: "BARCODE_VERIFICATION_FAILED",
      statusCode: 422,
      details: [expect.objectContaining({ code: "WRISTBAND_MISMATCH" })],
    });
    expect(
      Number((await admin.query("SELECT count(*)::int n FROM administration_record")).rows[0].n),
    ).toBe(before);
    const rows = await scanEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      match_result: "wrong_patient",
      wristband_check: "mismatch",
      wristband_matched_patient_id: OTHER_PATIENT,
      administration_record_id: null,
      patient_id: PATIENT,
    });
    // The M4 trigger audited the near-miss insert (the QAPI / surveyor trail).
    const audit = await admin.query(
      `SELECT 1 FROM audit_event WHERE event_type='barcode_scan_event.insert' AND resource_id=
         (SELECT id FROM barcode_scan_event LIMIT 1)`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it("GAP-020 (c): no band on file + required -> refused WRISTBAND_NOT_ON_FILE; policy off -> a bandless scan passes", async () => {
    await resetBands();
    const scan = { scannedRxnormRxcui: "rx-morphine" };
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ barcodeScan: scan })),
    ).rejects.toMatchObject({
      code: "BARCODE_VERIFICATION_FAILED",
      details: [expect.objectContaining({ code: "WRISTBAND_NOT_ON_FILE" })],
    });
    // A patient WITH a band who scans none is `not_presented`.
    await printBand(PATIENT);
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ barcodeScan: scan })),
    ).rejects.toMatchObject({
      details: [expect.objectContaining({ code: "WRISTBAND_NOT_PRESENTED" })],
    });

    await svc.putPolicy(ORG_A, { bcmaWristbandRequired: false });
    const ok = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({ barcodeScan: scan }),
    );
    expect(ok.barcodeMatchResult).toBe("match");
    const last = (await scanEvents()).at(-1);
    expect(last).toMatchObject({
      wristband_check: "skipped_policy_off",
      administration_record_id: ok.id,
    });
    // ...but a band that WAS scanned and is wrong still refuses with the policy off.
    const bandB = await printBand(OTHER_PATIENT);
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({ barcodeScan: { ...scan, patientWristbandPayload: bandB } }),
      ),
    ).rejects.toMatchObject({ details: [expect.objectContaining({ code: "WRISTBAND_MISMATCH" })] });
    expect((await svc.getPolicy(ORG_A)).bcmaWristbandRequired).toBe(false);
  });

  it("GAP-020 (d): after a reprint the OLD band is refused online (superseded) and the new one passes", async () => {
    await resetBands();
    const oldBand = await printBand(PATIENT);
    const newBand = await printBand(PATIENT, "reprint_lost", 1);
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({
          barcodeScan: { scannedRxnormRxcui: "rx-morphine", patientWristbandPayload: oldBand },
        }),
      ),
    ).rejects.toMatchObject({
      details: [expect.objectContaining({ code: "WRISTBAND_SUPERSEDED" })],
    });
    const ok = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({
        barcodeScan: { scannedRxnormRxcui: "rx-morphine", patientWristbandPayload: newBand },
      }),
    );
    expect(ok.barcodeMatchResult).toBe("match");
  });

  it("GAP-020 (e): an offline_sync row scanned before the reprint syncs OK; a >72 h-old scan and a voided band are rejected", async () => {
    await resetBands();
    const oldBand = await printBand(PATIENT);
    await admin.query("UPDATE patient_wristband SET issued_at = now() - interval '30 hours'");
    await printBand(PATIENT, "reprint_damaged", 1);
    await admin.query(
      "UPDATE patient_wristband SET superseded_at = now() - interval '2 hours' WHERE generation = 1",
    );
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const row = (scannedAt: string, extra: Record<string, unknown> = {}) =>
      recordArgs({
        administeredAt: hoursAgo(3),
        lateEntryReason: "Offline capture synced after the shift; scan taken at the bedside.",
        barcodeScan: {
          scannedRxnormRxcui: "rx-morphine",
          patientWristbandPayload: oldBand,
          wristbandScannedAt: scannedAt,
        },
        offlineCapture: {
          deviceId: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
          localId: crypto.randomUUID(),
          capturedAt: hoursAgo(3),
        },
        ...extra,
      });
    // Inside the band's life -> accepted through the offline-sync replay.
    const synced = await svc.offlineSync(ORG_A, memberOf[ORG_A], [row(hoursAgo(3.5))] as never);
    expect(synced.synced).toBe(1);
    expect((await scanEvents()).at(-1)).toMatchObject({
      wristband_check: "verified",
      wristband_generation: 1,
    });
    // The SAME scan time claimed on a plain ONLINE write is refused: only the replay gets the grace window.
    await expect(
      svc.recordAdministration(ORG_A, memberOf[ORG_A], row(hoursAgo(3.5)) as never),
    ).rejects.toMatchObject({
      details: [expect.objectContaining({ code: "WRISTBAND_SUPERSEDED" })],
    });
    // After the band was superseded -> rejected even offline.
    await expect(
      svc.offlineSync(ORG_A, memberOf[ORG_A], [row(hoursAgo(1))] as never),
    ).rejects.toMatchObject({
      details: [expect.objectContaining({ code: "WRISTBAND_SUPERSEDED" })],
    });
    // A voided generation is rejected both ways.
    await admin.query(
      "UPDATE patient_wristband SET voided_at = now(), void_reason = 'compromised' WHERE generation = 1",
    );
    await expect(
      svc.offlineSync(ORG_A, memberOf[ORG_A], [row(hoursAgo(3.5))] as never),
    ).rejects.toMatchObject({ details: [expect.objectContaining({ code: "WRISTBAND_VOIDED" })] });
  });

  it("GAP-020 (f): the caregiver-attested path passes without a band, and refuses a wrong band", async () => {
    await resetBands();
    await printBand(PATIENT);
    const bandB = await printBand(OTHER_PATIENT);
    const base = {
      patientId: PATIENT,
      medicationOrderId: MED_ORDER,
      administeredAt: new Date().toISOString(),
      caregiverSessionId: "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c",
      route: "oral",
      doseAmount: 5,
      doseUnit: "mg",
    };
    const ok = await svc.recordCaregiverAttested(ORG_A, {
      ...base,
      barcodeScan: { scannedRxnormRxcui: "rx-morphine" },
    });
    expect(ok.barcodeMatchResult).toBe("match");
    await expect(
      svc.recordCaregiverAttested(ORG_A, {
        ...base,
        barcodeScan: { scannedRxnormRxcui: "rx-morphine", patientWristbandPayload: bandB },
      }),
    ).rejects.toMatchObject({ code: "BARCODE_VERIFICATION_FAILED" });
    expect((await scanEvents()).at(-1)).toMatchObject({
      match_result: "wrong_patient",
      administration_record_id: null,
    });
  });

  it("GAP-020 (g): an unbound verifier fails closed (not_on_file), and a throwing verifier is a 503 -- never a pass", async () => {
    await resetBands();
    const band = await printBand(PATIENT);
    const scan = { scannedRxnormRxcui: "rx-morphine", patientWristbandPayload: band };
    const unbound = createDbEmarBackend(handle.db, undefined, undefined, () => orderPort);
    await expect(
      unbound.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ barcodeScan: scan })),
    ).rejects.toMatchObject({
      code: "BARCODE_VERIFICATION_FAILED",
      details: [expect.objectContaining({ code: "WRISTBAND_NOT_ON_FILE" })],
    });
    const throwing = createDbEmarBackend(
      handle.db,
      undefined,
      undefined,
      () => orderPort,
      undefined,
      () => ({
        async verify() {
          throw new Error("connection refused: postgres://secret");
        },
      }),
    );
    await expect(
      throwing.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ barcodeScan: scan })),
    ).rejects.toMatchObject({ code: "WRISTBAND_VERIFIER_UNAVAILABLE", statusCode: 503 });
  });

  it("GAP-020: the caregiver path runs the same five-rights gate (wrong route -> 422), and files the real admission", async () => {
    const base = {
      patientId: PATIENT,
      medicationOrderId: MED_ORDER,
      administeredAt: new Date().toISOString(),
      caregiverSessionId: "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c",
      route: "oral",
      doseAmount: 5,
      doseUnit: "mg",
    };
    await expect(
      svc.recordCaregiverAttested(ORG_A, { ...base, route: "IM" }),
    ).rejects.toMatchObject({ code: "FIVE_RIGHTS_VIOLATION" });
    const ok = await svc.recordCaregiverAttested(ORG_A, base);
    expect(ok.status).toBe("pending_caregiver_review");
    expect(ok.admissionId).toBe(ADMISSION);
  });

  // ── GAP-021 / GAP-022 — PRN interval gate + the wrapper row ───────────────────────────────────────────
  it("GAP-021/022: a PRN dose writes its prn_administration row; a second inside the minimum interval is refused", async () => {
    const t0 = Date.now() - 6 * 3_600_000;
    const prn = { triggeringPrnReason: "breakthrough pain", requestedByKind: "clinician_observed" };
    const first = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({
        medicationOrderId: PRN_MED_ORDER,
        administeredAt: new Date(t0).toISOString(),
        prn,
      }),
    );
    // GAP-022 -- the wrapper row exists, tied 1:1 to the administration, with the policy window.
    const { rows } = await admin.query(
      "SELECT id, patient_id, reassessment_window_minutes, reassessment_due_at, prn_interval_override FROM prn_administration WHERE administration_record_id=$1",
      [first.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].patient_id).toBe(PATIENT);
    expect(rows[0].prn_interval_override).toBe(false);
    const event = (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m13.prn_administration_recorded'",
        [first.id],
      )
    ).rows[0];
    expect(event.payload.prnAdministrationId).toBe(rows[0].id);

    // GAP-021 -- 1h after the first dose, inside the 4h minimum: 422, and NOTHING is written.
    const before = (await admin.query("SELECT count(*)::int AS n FROM prn_administration")).rows[0]
      .n;
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        recordArgs({
          medicationOrderId: PRN_MED_ORDER,
          administeredAt: new Date(t0 + 3_600_000).toISOString(),
          prn,
        }),
      ),
    ).rejects.toMatchObject({ code: "PRN_INTERVAL_VIOLATION", statusCode: 422 });
    expect((await admin.query("SELECT count(*)::int AS n FROM prn_administration")).rows[0].n).toBe(
      before,
    );

    // Past the minimum interval it records.
    const later = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      recordArgs({
        medicationOrderId: PRN_MED_ORDER,
        administeredAt: new Date(t0 + 5 * 3_600_000).toISOString(),
        prn,
      }),
    );
    expect(later.status).toBe("committed");
  });

  it("GAP-021: a supervisor override needs the permission and a 40+ char reason, and is persisted", async () => {
    const t0 = Date.now() - 2 * 3_600_000;
    const base = { triggeringPrnReason: "severe pain", requestedByKind: "clinician_observed" };
    const args = (prn: object) =>
      recordArgs({
        medicationOrderId: PRN_MED_ORDER,
        administeredAt: new Date(t0).toISOString(),
        prn,
      });
    // The previous case left a PRN dose at now-1h, so a dose requested at now-2h is inside the window.
    const reason =
      "Patient in uncontrolled pain; medical director approved an early dose by phone.";
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        args({ ...base, intervalOverride: { hasPermission: false, reason } }),
      ),
    ).rejects.toMatchObject({ code: "PRN_INTERVAL_OVERRIDE_NOT_PERMITTED", statusCode: 403 });
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        args({ ...base, intervalOverride: { hasPermission: true, reason: "too short" } }),
      ),
    ).rejects.toMatchObject({ code: "PRN_INTERVAL_OVERRIDE_REASON_TOO_SHORT" });
    const ok = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      args({ ...base, intervalOverride: { hasPermission: true, reason } }),
    );
    const { rows } = await admin.query(
      "SELECT prn_interval_override, prn_interval_override_by FROM prn_administration WHERE administration_record_id=$1",
      [ok.id],
    );
    expect(rows[0].prn_interval_override).toBe(true);
    expect(rows[0].prn_interval_override_by).toBe(memberOf[ORG_A]);
  });

  // ── GAP-023 — reconciliation completeness + terminal-state guards ─────────────────────────────────────
  it("GAP-023: finalize requires EVERY active order line decided; a closed worksheet cannot be reopened", async () => {
    const ws = await seedWorksheet(ORG_A, 3);
    activeOrderIds = [MED_ORDER, CONTROLLED_MED_ORDER];
    try {
      await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
        lineKind: "m12_active",
        sourceId: MED_ORDER,
        decision: "carry_forward",
      });
      // One of two active lines undecided -> 422 RECONCILIATION_INCOMPLETE (not finalizable yet).
      await expect(svc.finalizeReconciliation(ORG_A, memberOf[ORG_A], ws)).rejects.toMatchObject({
        statusCode: 422,
      });
      await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
        lineKind: "m12_active",
        sourceId: CONTROLLED_MED_ORDER,
        decision: "carry_forward",
      });
      const done = await svc.finalizeReconciliation(ORG_A, memberOf[ORG_A], ws);
      expect(done.status).toBe("finalized");
      const completed = (
        await admin.query(
          "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m13.reconciliation.completed'",
          [ws],
        )
      ).rows[0].payload;
      expect(completed.lineSummary.decisions).toHaveLength(2);
      // Terminal: nothing reopens or rewrites it.
      const closed = { statusCode: 409, code: "ILLEGAL_RECONCILIATION_TRANSITION" };
      await expect(svc.finalizeReconciliation(ORG_A, memberOf[ORG_A], ws)).rejects.toMatchObject(
        closed,
      );
      await expect(
        svc.voidWorksheet(ORG_A, memberOf[ORG_A], ws, "trying to void a finalized worksheet"),
      ).rejects.toMatchObject(closed);
      await expect(
        svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
          lineKind: "m12_active",
          sourceId: MED_ORDER,
          decision: "discontinue",
        }),
      ).rejects.toMatchObject(closed);
      await expect(
        svc.updateDecision(ORG_A, memberOf[ORG_A], ws, done.decisions[0]!.lineId, "hold"),
      ).rejects.toMatchObject(closed);
      await expect(
        svc.addCaregiverReportedLine(ORG_A, memberOf[ORG_A], ws, "late add"),
      ).rejects.toMatchObject(closed);
      expect(
        (
          await admin.query("SELECT status FROM medication_reconciliation_worksheet WHERE id=$1", [
            ws,
          ])
        ).rows[0].status,
      ).toBe("finalized");
    } finally {
      activeOrderIds = [];
    }
  });

  it("GAP-023: a caregiver-reported line is attributed to the caller, and a voided worksheet stays voided", async () => {
    const ws = await seedWorksheet(ORG_A, 4);
    await svc.addCaregiverReportedLine(ORG_A, member2Of[ORG_A], ws, "home melatonin");
    const { rows } = await admin.query(
      "SELECT decision_made_by_membership_id FROM medication_reconciliation_decision WHERE worksheet_id=$1",
      [ws],
    );
    expect(rows[0].decision_made_by_membership_id).toBe(member2Of[ORG_A]);
    await svc.voidWorksheet(ORG_A, memberOf[ORG_A], ws, "re-triggered by a transfer correction");
    await expect(
      svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
        lineKind: "m12_active",
        sourceId: MED_ORDER,
        decision: "carry_forward",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (
        await admin.query("SELECT status FROM medication_reconciliation_worksheet WHERE id=$1", [
          ws,
        ])
      ).rows[0].status,
    ).toBe("voided");
  });

  // ── GAP-024 — intentional hold ────────────────────────────────────────────────────────────────────────
  it("GAP-024: a hold records a missed_dose row with the reason; held / administered / lapsed doses are refused", async () => {
    const sched = await seedScheduledDose(ORG_A);
    const held = await svc.intentionalHold(
      ORG_A,
      memberOf[ORG_A],
      sched,
      "patient actively vomiting; hold per RN judgement",
    );
    expect(held.status).toBe("intentionally_held");
    const { rows } = await admin.query(
      "SELECT missed_kind, missed_reason, recorded_by_membership_id, patient_id FROM missed_dose WHERE scheduled_dose_id=$1",
      [sched],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].missed_kind).toBe("intentionally_held");
    expect(rows[0].missed_reason).toContain("vomiting");
    expect(rows[0].recorded_by_membership_id).toBe(memberOf[ORG_A]);
    const link = (
      await admin.query("SELECT missed_dose_id FROM scheduled_dose WHERE id=$1", [sched])
    ).rows[0].missed_dose_id;
    expect(link).toBeTruthy();
    // Already held -> 409 (no overwrite, no second missed_dose row).
    await expect(svc.intentionalHold(ORG_A, memberOf[ORG_A], sched)).rejects.toMatchObject({
      statusCode: 409,
    });
    // An administered dose cannot be flipped to held.
    const given = await seedScheduledDose(ORG_A);
    await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs({ scheduledDoseId: given }));
    await expect(svc.intentionalHold(ORG_A, memberOf[ORG_A], given)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(
      (await admin.query("SELECT status FROM scheduled_dose WHERE id=$1", [given])).rows[0].status,
    ).toBe("administered");
    // Past the grace window the sweep owns it: 409.
    const lapsed = (
      await admin.query(
        `INSERT INTO scheduled_dose (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, medication_order_id, due_at, grace_window_minutes, expected_dose_amount,
           expected_dose_unit, expected_route, materialization_sequence)
         VALUES ($1,$2,$3,$4,$5,$6, now() - interval '3 hours', 30, 5.0000, 'mg', 'oral', 9) RETURNING id`,
        [ORG_A, providerOf[ORG_A], locationOf[ORG_A], PATIENT, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;
    await expect(svc.intentionalHold(ORG_A, memberOf[ORG_A], lapsed)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("RLS: org B cannot void or read org A's administration (404 under the wardenx_app policy)", async () => {
    const rec = await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs());
    await expect(svc.getAdministration(ORG_B, rec.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.voidAdministration(ORG_B, memberOf[ORG_B], rec.id, "x")).rejects.toMatchObject(
      { statusCode: 404 },
    );
  });
});
