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
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER2 = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const MED_ORDER = "66666666-6666-6666-6666-666666666666";

describe.skipIf(!DB_URL)("M13 eMAR write lifecycle — LIVE Postgres (M13L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbEmarBackend>;
  const memberOf: Record<string, string> = {};
  const member2Of: Record<string, string> = {};
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};

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
  async function seedScheduledDose(org: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO scheduled_dose (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, medication_order_id, due_at, grace_window_minutes, expected_dose_amount,
           expected_dose_unit, expected_route, materialization_sequence)
         VALUES ($1,$2,$3,$4,$5,$6, now(), 60, 5.0000, 'mg', 'oral', 1) RETURNING id`,
        [org, providerOf[org], locationOf[org], PATIENT, ADMISSION, MED_ORDER],
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
  async function seedDeployment(org: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO comfort_kit_deployment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, deployed_at)
         VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
        [org, providerOf[org], locationOf[org], PATIENT, ADMISSION],
      )
    ).rows[0].id as string;
  }

  const recordArgs = (over: Record<string, unknown> = {}) => ({
    medicationOrderId: MED_ORDER,
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
        if (medicationOrderId !== MED_ORDER) return null;
        return {
          patientId: PATIENT,
          admissionId: ADMISSION,
          drugName: "Morphine Sulfate Oral Solution",
          route: "oral",
          // §2.11 D11 — this order authorises titration between 1 and 10 mg/hr. An order that stated no
          // bounds would authorise NO rate change; the last IV test below proves that arm.
          ivContinuousPolicy: { minRate: 1, maxRate: 10 },
        };
      },
    };
    svc = createDbEmarBackend(handle.db, outbox, undefined, () => medicationOrder);
  }, 120_000);

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
      medicationOrderId: MED_ORDER,
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
    const events = await eventsFor(view.id);
    expect(events).toContain("m13.administration.recorded");
    expect(events).toContain("m13.administration.controlled_witnessed");
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM administration_witness WHERE administration_record_id=$1",
      [view.id],
    );
    expect(rows[0].n).toBe(1);
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
      medicationOrderId: MED_ORDER,
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
          medicationOrderId: MED_ORDER,
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

  it("voidAdministration voids the row; recordRefusal logs a declined dose", async () => {
    const rec = await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs());
    const voided = await svc.voidAdministration(
      ORG_A,
      memberOf[ORG_A],
      rec.id,
      "recorded in error",
    );
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
    const afterCarry = await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
      lineKind: "m12_active",
      sourceId: MED_ORDER,
      decision: "carry_forward",
    });
    expect(afterCarry.status).toBe("in_progress");
    expect(afterCarry.decisions.length).toBe(1);
    expect(await eventsFor(ws)).toContain("m13.reconciliation.draft_order_requested");
    const lineId = afterCarry.decisions[0].lineId;
    await svc.updateDecision(ORG_A, memberOf[ORG_A], ws, lineId, "discontinue");
    await svc.addCaregiverReportedLine(ORG_A, ws, "home aspirin 81mg");
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

  it("RLS: org B cannot void or read org A's administration (404 under the wardenx_app policy)", async () => {
    const rec = await svc.recordAdministration(ORG_A, memberOf[ORG_A], recordArgs());
    await expect(svc.getAdministration(ORG_B, rec.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.voidAdministration(ORG_B, memberOf[ORG_B], rec.id, "x")).rejects.toMatchObject(
      { statusCode: 404 },
    );
  });
});
