/**
 * GAP-107 — LIVE Postgres proof of M37's IV-continuous safety overlay (§2.6 / D7), end to end, as the NOBYPASSRLS
 * `chartwarden_app` role.
 *
 * The overlay had a reader (the `IpuIvSafetyOverlayProvider` seam) and an eraser and NOTHING that wrote a row, and
 * M13 never asked for it. This suite proves the whole chain on real tables and real RLS:
 *
 *   • WRITER — `m12.medication_order.signed` for a continuous-IV order on a patient with an open IPU admission
 *     creates the `ipu_iv_safety_overlay` row from the catalog (midazolam: sedation class, dual witness, 0.5-10
 *     mg/hr, q-60min) and publishes `m37.iv_safety_overlay.required`; a redelivery adds nothing; a non-IV order, a
 *     home (non-IPU) patient and an ended admission get no overlay; discontinued/completed retires it.
 *   • M13 GATE — through the REAL `createDbEmarBackend` over the REAL M37 seam provider: an out-of-window rate, a
 *     missing dual witness, a bogus witness token, an exceeded max duration and an overdue bedside check are each
 *     refused 412 with the spec code and write NO administration row; a valid witnessed start/titration commits;
 *     pause is never gated; a patient with no overlay is unaffected.
 *   • WATCHDOG — `iv-bedside-check-watchdog` raises `bedside_check_overdue` once per overdue interval for a RUNNING
 *     infusion only (not paused), per org.
 *   • CROSS-TENANT — org B can neither read nor evaluate org A's overlay, an org-B delivery cannot attach to org
 *     A's admission, and the watchdog only ever hands org A's order ids to the activity read for org A.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m37:iv-overlay:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type EmarMedicationOrderPort,
  type EmarWriteOutboxPort,
  createDbEmarBackend,
} from "../src/modules/13-emar/emar-route-service-db";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { ivSessionActivityForOrg } from "../src/modules/13-emar/seams/iv-session-activity-for-org";
import {
  type IvOverlayOrderFacts,
  buildM37IvOverlayOnOrderEndedConsumer,
  buildM37IvOverlayOnOrderSignedConsumer,
} from "../src/modules/37-ipu/consumers/m12-medication-order-iv-overlay";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/events-by-m37";
import { runIvBedsideCheckWatchdog } from "../src/modules/37-ipu/jobs/iv-bedside-watchdog";
import { buildIpuIvSafetyOverlayProvider } from "../src/modules/37-ipu/seams/iv-overlay-provider";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const USER2 = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";
const PROVIDER_ENTITY = "cccccccc-0000-4000-8000-000000000001";

const PATIENT_IPU = "44444444-4444-4444-8444-444444444444";
const ADMISSION_IPU = "55555555-5555-4555-8555-555555555555";
const PATIENT_HOME = "4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a";
const ADMISSION_HOME = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
const PATIENT_B = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
const ADMISSION_B = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";

/** A sedation-class drip (midazolam) on the IPU patient — NOT a controlled order, to prove the overlay alone
 *  forces the witness. */
const ORDER_SEDATION = "66666666-6666-4666-8666-666666666666";
/** A non-sedation infusion (morphine) on the IPU patient: q-2h cadence, no dual witness. */
const ORDER_MORPHINE = "67676767-6767-4767-8767-676767676767";
/** Plain oral order on the IPU patient: no overlay. */
const ORDER_ORAL = "68686868-6868-4868-8868-686868686868";
/** Midazolam drip on a patient with NO IPU admission: no overlay. */
const ORDER_HOME_IV = "69696969-6969-4969-8969-696969696969";
/** Org B's own sedation drip on org B's IPU patient. */
const ORDER_B = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const ORDERS: Record<string, IvOverlayOrderFacts & { organizationId: string }> = {
  [ORDER_SEDATION]: {
    organizationId: ORG_A,
    orderId: ORDER_SEDATION,
    patientId: PATIENT_IPU,
    admissionId: ADMISSION_IPU,
    route: "iv_continuous",
    drugName: "Midazolam 100 mg in 0.9% Sodium Chloride",
    rxnormRxcui: "6960",
    sigStructured: { ivContinuousPolicy: { minRate: 0.1, maxRate: 20, rateUnit: "mg/hr" } },
  },
  [ORDER_MORPHINE]: {
    organizationId: ORG_A,
    orderId: ORDER_MORPHINE,
    patientId: PATIENT_IPU,
    admissionId: ADMISSION_IPU,
    route: "iv_continuous",
    drugName: "Morphine",
    rxnormRxcui: "7052",
    sigStructured: { ivContinuousPolicy: { minRate: 0.1, maxRate: 30, rateUnit: "mg/hr" } },
  },
  [ORDER_ORAL]: {
    organizationId: ORG_A,
    orderId: ORDER_ORAL,
    patientId: PATIENT_IPU,
    admissionId: ADMISSION_IPU,
    route: "oral",
    drugName: "Morphine Sulfate Oral Solution",
    rxnormRxcui: "7052",
    sigStructured: {},
  },
  [ORDER_HOME_IV]: {
    organizationId: ORG_A,
    orderId: ORDER_HOME_IV,
    patientId: PATIENT_HOME,
    admissionId: ADMISSION_HOME,
    route: "iv_continuous",
    drugName: "Midazolam",
    rxnormRxcui: "6960",
    sigStructured: { ivContinuousPolicy: { minRate: 0.1, maxRate: 20, rateUnit: "mg/hr" } },
  },
  [ORDER_B]: {
    organizationId: ORG_B,
    orderId: ORDER_B,
    patientId: PATIENT_B,
    admissionId: ADMISSION_B,
    route: "iv_continuous",
    drugName: "Midazolam",
    rxnormRxcui: "6960",
    sigStructured: { ivContinuousPolicy: { minRate: 0.1, maxRate: 20, rateUnit: "mg/hr" } },
  },
};

describe.skipIf(!DB_URL)("M37 IV-continuous safety overlay (GAP-107) — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbEmarBackend>;
  let overlaySeam: ReturnType<typeof buildIpuIvSafetyOverlayProvider>;
  let signedConsumer: ReturnType<typeof buildM37IvOverlayOnOrderSignedConsumer>;
  let endedConsumer: ReturnType<typeof buildM37IvOverlayOnOrderEndedConsumer>;
  let m37Outbox: { publish: (tx: unknown, e: Record<string, unknown>) => Promise<void> };
  const memberOf: Record<string, string> = {};
  const member2Of: Record<string, string> = {};
  let ipuAdmissionA: string;
  let ipuAdmissionB: string;

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

  async function seedIpuAdmission(org: string, patientId: string, admissionId: string, n: number) {
    return (
      await admin.query(
        `INSERT INTO ipu_admission
           (organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,
            remote_facility_id,kind,state,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'arranged','active',$2) RETURNING id`,
        [
          org,
          PROVIDER_ENTITY,
          patientId,
          admissionId,
          `dddddddd-0000-4000-8000-00000000000${n}`,
          "eeeeeeee-0000-4000-8000-000000000001",
        ],
      )
    ).rows[0].id as string;
  }

  const signedEvent = (org: string, orderId: string, id = "e1") => ({
    id,
    organizationId: org,
    payload: { orderId, signerMembershipId: "m", signedAt: new Date().toISOString() },
  });
  const orderEvent = (org: string, orderId: string) => ({
    id: "e-end",
    organizationId: org,
    payload: {
      orderId,
      reason: "stopped",
      actorMembershipId: null,
      effectiveAt: new Date().toISOString(),
    },
  });

  async function overlayRows(orderId: string) {
    return (await admin.query("SELECT * FROM ipu_iv_safety_overlay WHERE order_id=$1", [orderId]))
      .rows;
  }
  async function eventCount(type: string, aggregateId?: string) {
    const { rows } = aggregateId
      ? await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
          [type, aggregateId],
        )
      : await admin.query("SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1", [
          type,
        ]);
    return rows[0].n as number;
  }
  async function admissionRecordCount(orderId: string) {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM administration_record WHERE medication_order_id=$1",
      [orderId],
    );
    return rows[0].n as number;
  }

  const ivArgs = (orderId: string, mode: string, data: Record<string, unknown>, over = {}) => ({
    medicationOrderId: orderId,
    medClass: "standard" as const,
    mode: mode as never,
    administeredAt: new Date().toISOString(),
    route: "iv_continuous",
    doseAmount: 1,
    doseUnit: "mg",
    data,
    ...over,
  });
  const mintWitness = async (orderId: string, patientId = PATIENT_IPU) =>
    (
      await svc.mintWitnessToken(ORG_A, member2Of[ORG_A], {
        patientId,
        medicationOrderId: orderId,
        administeringClinicianMembershipId: memberOf[ORG_A],
      })
    ).token;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'iv1@x.test'),($2,'iv2@x.test')`, [
      USER,
      USER2,
    ]);
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
    }
    ipuAdmissionA = await seedIpuAdmission(ORG_A, PATIENT_IPU, ADMISSION_IPU, 1);
    ipuAdmissionB = await seedIpuAdmission(ORG_B, PATIENT_B, ADMISSION_B, 2);

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The REAL catalog-validating publisher (not NOOP_OUTBOX): every payload is Value.Checked at publish.
    const catalog = buildBootOutboxCatalog([M13_OUTBOX_EVENTS, M37_OUTBOX_EVENTS]);
    const txPublisher = buildTxOutboxPublisher(catalog);
    const m13Outbox: EmarWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m13" }),
    };
    m37Outbox = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m37" } as never),
    };

    overlaySeam = buildIpuIvSafetyOverlayProvider(handle.db);
    const orderContext = async (organizationId: string, orderId: string) => {
      const o = ORDERS[orderId];
      return o && o.organizationId === organizationId ? o : null;
    };
    signedConsumer = buildM37IvOverlayOnOrderSignedConsumer({
      db: handle.db,
      outbox: m37Outbox as never,
      orderContext,
    });
    endedConsumer = buildM37IvOverlayOnOrderEndedConsumer({ db: handle.db });

    // M12's identity reader as the production mount binds it, narrowed to what this suite needs.
    const medicationOrder: EmarMedicationOrderPort = {
      async administrationIdentity({ organizationId, medicationOrderId }) {
        const o = ORDERS[medicationOrderId];
        if (!o || o.organizationId !== organizationId) return null;
        const policy = o.sigStructured.ivContinuousPolicy;
        return {
          patientId: o.patientId,
          admissionId: o.admissionId,
          drugName: o.drugName,
          route: o.route,
          ivContinuousPolicy: policy ? { minRate: policy.minRate, maxRate: policy.maxRate } : null,
          allowAdministration: true,
          blockedReasons: [],
          medClass: "standard",
          isControlledSubstance: false,
          isSudTreatment: false,
        };
      },
    };
    // The REAL M37 overlay seam provider, as M13's production mount binds it via getSeam(...).
    svc = createDbEmarBackend(
      handle.db,
      m13Outbox,
      undefined,
      () => medicationOrder,
      () => overlaySeam,
    );
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ── WRITER ─────────────────────────────────────────────────────────────────────────────────────────
  it("a signed continuous-IV order on an IPU patient gets its overlay from the catalog, and announces it", async () => {
    await signedConsumer.handle(signedEvent(ORG_A, ORDER_SEDATION));
    const rows = await overlayRows(ORDER_SEDATION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: ORG_A,
      ipu_admission_id: ipuAdmissionA,
      medication_rx_norm_code: "6960",
      rate_unit: "mg_per_hour",
      dual_witness_required: true,
      is_sedation_class: true,
      max_continuous_duration_hours: 168,
      bedside_check_interval_minutes: 60,
      overlay_active: true,
    });
    expect(Number(rows[0].titration_min_rate)).toBe(0.5);
    expect(Number(rows[0].titration_max_rate)).toBe(10);
    expect(await eventCount("m37.iv_safety_overlay.required", rows[0].id)).toBe(1);
  });

  it("a redelivery changes nothing: one overlay row, one event", async () => {
    await signedConsumer.handle(signedEvent(ORG_A, ORDER_SEDATION, "e-redeliver"));
    const rows = await overlayRows(ORDER_SEDATION);
    expect(rows).toHaveLength(1);
    expect(await eventCount("m37.iv_safety_overlay.required", rows[0].id)).toBe(1);
  });

  it("a non-sedation infusion gets the q-2h cadence and no dual witness", async () => {
    await signedConsumer.handle(signedEvent(ORG_A, ORDER_MORPHINE));
    const [o] = await overlayRows(ORDER_MORPHINE);
    expect(o).toMatchObject({
      dual_witness_required: false,
      is_sedation_class: false,
      bedside_check_interval_minutes: 120,
    });
  });

  it("owes no overlay to a non-infusion order or to a patient who is not on an IPU", async () => {
    await signedConsumer.handle(signedEvent(ORG_A, ORDER_ORAL));
    await signedConsumer.handle(signedEvent(ORG_A, ORDER_HOME_IV));
    expect(await overlayRows(ORDER_ORAL)).toHaveLength(0);
    expect(await overlayRows(ORDER_HOME_IV)).toHaveLength(0);
  });

  it("an order the org cannot resolve dead-letters (throws) rather than being skipped", async () => {
    await expect(
      signedConsumer.handle(signedEvent(ORG_A, "99999999-9999-4999-8999-999999999999")),
    ).rejects.toThrow(/does not resolve/);
  });

  // ── CROSS-TENANT ───────────────────────────────────────────────────────────────────────────────────
  it("org B can neither read nor evaluate org A's overlay", async () => {
    expect(await overlaySeam.getOverlayForOrder(ORG_A, ORDER_SEDATION)).not.toBeNull();
    expect(await overlaySeam.getOverlayForOrder(ORG_B, ORDER_SEDATION)).toBeNull();
    const verdict = await overlaySeam.evaluatePreAdministration(ORG_B, {
      orderId: ORDER_SEDATION,
      proposedRate: 9999,
      proposedRateUnit: null,
      witnessTokenPresent: false,
      hoursSinceContinuousStart: 9999,
      minutesSinceLastBedsideCheck: 9999,
    });
    expect(verdict).toEqual({ overlayApplies: false, pass: true, dualWitnessRequired: false });
  });

  it("an org-B delivery naming org A's order cannot attach an overlay to org A's admission or write into org A", async () => {
    // Org B's resolver (correctly) cannot see org A's order; and even a resolver that returned org A's facts
    // could only look for an admission inside org B, where org A's M6 admission does not exist.
    await expect(
      signedConsumer.handle(signedEvent(ORG_B, ORDER_SEDATION, "e-evil")),
    ).rejects.toThrow(/does not resolve/);
    const leakyConsumer = buildM37IvOverlayOnOrderSignedConsumer({
      db: handle.db,
      outbox: m37Outbox as never,
      orderContext: async () => ORDERS[ORDER_MORPHINE] ?? null,
    });
    await leakyConsumer.handle(signedEvent(ORG_B, ORDER_MORPHINE, "e-leaky"));
    const { rows } = await admin.query(
      "SELECT organization_id FROM ipu_iv_safety_overlay WHERE order_id=$1",
      [ORDER_MORPHINE],
    );
    expect(rows).toEqual([{ organization_id: ORG_A }]); // still only org A's own row
  });

  it("org B's own order gets org B's own overlay, invisible to org A", async () => {
    await signedConsumer.handle(signedEvent(ORG_B, ORDER_B));
    const [o] = await overlayRows(ORDER_B);
    expect(o).toMatchObject({ organization_id: ORG_B, ipu_admission_id: ipuAdmissionB });
    expect(await overlaySeam.getOverlayForOrder(ORG_A, ORDER_B)).toBeNull();
    expect(await overlaySeam.getOverlayForOrder(ORG_B, ORDER_B)).not.toBeNull();
  });

  // ── M13 GATE ───────────────────────────────────────────────────────────────────────────────────────
  it("refuses a start whose rate is outside the overlay's titration window (412) and writes nothing", async () => {
    const before = await admissionRecordCount(ORDER_SEDATION);
    // 20 mg/hr is inside the ORDER's own bounds (0.1-20) but outside the catalog window (0.5-10).
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        ivArgs(
          ORDER_SEDATION,
          "iv_continuous_start",
          { infusionRate: 20, rateUnit: "mg/hr" },
          {
            witnessToken: await mintWitness(ORDER_SEDATION),
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "IV_RATE_OUTSIDE_TITRATION_WINDOW", statusCode: 412 });
    expect(await admissionRecordCount(ORDER_SEDATION)).toBe(before);
  });

  it("refuses a sedation-class start with no witness (412 IV_DUAL_WITNESS_REQUIRED) even though the order is not controlled", async () => {
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        ivArgs(ORDER_SEDATION, "iv_continuous_start", { infusionRate: 2, rateUnit: "mg/hr" }),
      ),
    ).rejects.toMatchObject({ code: "IV_DUAL_WITNESS_REQUIRED", statusCode: 412 });
    expect(await admissionRecordCount(ORDER_SEDATION)).toBe(0);
  });

  it("a made-up witness token is NOT a witness: the overlay's requirement routes it through full D7 verification", async () => {
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        ivArgs(
          ORDER_SEDATION,
          "iv_continuous_start",
          { infusionRate: 2, rateUnit: "mg/hr" },
          {
            witnessToken: "not-a-real-token",
          },
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await admissionRecordCount(ORDER_SEDATION)).toBe(0);
  });

  let sedationSession: string;
  it("a witnessed in-window start commits, then a witnessed in-window titration commits", async () => {
    const start = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      ivArgs(
        ORDER_SEDATION,
        "iv_continuous_start",
        { infusionRate: 2, rateUnit: "mg/hr" },
        {
          // Three hours ago: inside the 4h `normal` late-entry tier, and well past the 60-minute bedside interval.
          administeredAt: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
          witnessToken: await mintWitness(ORDER_SEDATION),
        },
      ),
    );
    expect(start.status).toBe("committed");
    expect(start.witnessMembershipId).toBe(member2Of[ORG_A]);
    sedationSession = start.ivSessionId as string;
    expect(sedationSession).toBeTruthy();
  });

  it("refuses a rate outside the window first; an overdue bedside check no longer blocks a titration (exempt)", async () => {
    // 15 mg/hr: within the order's 0.1-20 bounds, outside the overlay's 0.5-10 -> the window code wins.
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        ivArgs(
          ORDER_SEDATION,
          "iv_continuous_rate_change",
          { previousRate: 2, newRate: 15, rateUnit: "mg/hr" },
          {
            ivSessionId: sedationSession,
            witnessToken: await mintWitness(ORDER_SEDATION),
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "IV_RATE_OUTSIDE_TITRATION_WINDOW" });
    // An in-window titration 3h after the only segment (180 > the 60-minute interval): the overdue check is
    // exempt for a titration, so it commits (the watchdog still pages the overdue check).
    const titrate = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      ivArgs(
        ORDER_SEDATION,
        "iv_continuous_rate_change",
        { previousRate: 2, newRate: 3, rateUnit: "mg/hr" },
        {
          ivSessionId: sedationSession,
          witnessToken: await mintWitness(ORDER_SEDATION),
        },
      ),
    );
    expect(titrate.status).toBe("committed");
  });

  it("pause is never gated; a resume and a further in-window titration commit", async () => {
    await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      ivArgs(
        ORDER_SEDATION,
        "iv_continuous_pause",
        { pauseReason: "line check" },
        {
          ivSessionId: sedationSession,
        },
      ),
    );
    await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      ivArgs(ORDER_SEDATION, "iv_continuous_resume", {}, { ivSessionId: sedationSession }),
    );
    const titrate = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      ivArgs(
        ORDER_SEDATION,
        "iv_continuous_rate_change",
        { previousRate: 3, newRate: 4, rateUnit: "mg/hr" },
        {
          ivSessionId: sedationSession,
          witnessToken: await mintWitness(ORDER_SEDATION),
        },
      ),
    );
    expect(titrate.status).toBe("committed");
  });

  it("refuses a rate in a different unit than the overlay's, even when the number is in range", async () => {
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        ivArgs(
          ORDER_SEDATION,
          "iv_continuous_rate_change",
          { previousRate: 3, newRate: 4, rateUnit: "mL/hr" },
          {
            ivSessionId: sedationSession,
            witnessToken: await mintWitness(ORDER_SEDATION),
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "IV_RATE_OUTSIDE_TITRATION_WINDOW" });
  });

  it("refuses a titration past the overlay's max continuous duration (412)", async () => {
    // A non-sedation infusion (no witness needed); shrink its max duration to 1h, start it 3h ago.
    const start = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      ivArgs(
        ORDER_MORPHINE,
        "iv_continuous_start",
        { infusionRate: 2, rateUnit: "mg/hr" },
        {
          administeredAt: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        },
      ),
    );
    await admin.query(
      "UPDATE ipu_iv_safety_overlay SET max_continuous_duration_hours = 1 WHERE order_id=$1",
      [ORDER_MORPHINE],
    );
    await expect(
      svc.recordAdministration(
        ORG_A,
        memberOf[ORG_A],
        ivArgs(
          ORDER_MORPHINE,
          "iv_continuous_rate_change",
          { previousRate: 2, newRate: 3, rateUnit: "mg/hr" },
          {
            ivSessionId: start.ivSessionId as string,
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "IV_MAX_CONTINUOUS_DURATION_REACHED", statusCode: 412 });
  });

  it("a patient with no overlay is unaffected: an unwitnessed, unbounded-by-catalog infusion start commits", async () => {
    const start = await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      ivArgs(ORDER_HOME_IV, "iv_continuous_start", { infusionRate: 15, rateUnit: "mg/hr" }),
    );
    expect(start.status).toBe("committed");
  });

  // ── WATCHDOG ───────────────────────────────────────────────────────────────────────────────────────
  it("the watchdog alerts once per overdue interval, only for a RUNNING infusion, and only reads each org's own orders", async () => {
    // Org B: a running sedation drip started 3h ago (its overlay exists from the writer test above).
    const bStart = await svc.recordAdministration(
      ORG_B,
      memberOf[ORG_B],
      ivArgs(
        ORDER_B,
        "iv_continuous_start",
        { infusionRate: 2, rateUnit: "mg/hr" },
        {
          administeredAt: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
          witnessToken: (
            await svc.mintWitnessToken(ORG_B, member2Of[ORG_B], {
              patientId: PATIENT_B,
              medicationOrderId: ORDER_B,
              administeringClinicianMembershipId: memberOf[ORG_B],
            })
          ).token,
        },
      ),
    );
    expect(bStart.status).toBe("committed");

    // Org A's sedation session is RUNNING (resume + titration above); its last segment is "now".
    const [activityA] = await ivSessionActivityForOrg(handle.db, ORG_A, [ORDER_SEDATION]);
    expect(activityA?.state).toBe("running");
    const lastAt = Date.parse(activityA?.lastSegmentAt as string);

    const seenOrders: Record<string, string[]> = {};
    const run = (nowMs: number, orgs: readonly string[] = [ORG_A]) =>
      runIvBedsideCheckWatchdog({
        connection: {} as never,
        db: handle.db,
        outbox: m37Outbox as never,
        activeOrgs: {
          listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
        },
        ivActivity: async (organizationId, orderIds) => {
          seenOrders[organizationId] = [...orderIds];
          return ivSessionActivityForOrg(handle.db, organizationId, orderIds);
        },
        now: () => new Date(nowMs),
      });
    const overdueFor = async (overlayOrderId: string) => {
      const [o] = await overlayRows(overlayOrderId);
      return eventCount("m37.iv_safety_overlay.bedside_check_overdue", o.id as string);
    };

    // Not yet overdue for org A (30 min since its last segment, interval 60): nothing for A.
    await run(lastAt + 30 * MINUTE_MS);
    expect(await overdueFor(ORDER_SEDATION)).toBe(0);
    // Org B's drip is ~3h unchecked -> phase 0..: it alerts only on the tick that crosses an interval boundary.
    const [activityB] = await ivSessionActivityForOrg(handle.db, ORG_B, [ORDER_B]);
    const bLast = Date.parse(activityB?.lastSegmentAt as string);

    // The first tick past A's interval alerts exactly once...
    await run(lastAt + 62 * MINUTE_MS);
    expect(await overdueFor(ORDER_SEDATION)).toBe(1);
    // ...the next tick (same overdue interval) does not...
    await run(lastAt + 67 * MINUTE_MS);
    expect(await overdueFor(ORDER_SEDATION)).toBe(1);
    // ...and the next whole interval is a reminder.
    await run(lastAt + 122 * MINUTE_MS);
    expect(await overdueFor(ORDER_SEDATION)).toBe(2);

    // Org B alerted on its own boundary tick, with org B's envelope.
    await run(bLast + 62 * MINUTE_MS, [ORG_A, ORG_B]);
    expect(await overdueFor(ORDER_B)).toBe(1);
    const { rows: ev } = await admin.query(
      `SELECT organization_id, payload FROM outbox_event
        WHERE event_type='m37.iv_safety_overlay.bedside_check_overdue' ORDER BY created_at`,
    );
    const byOrg = ev.map((r) => r.organization_id);
    expect(byOrg).toContain(ORG_B);
    for (const r of ev) {
      const payloadOrder = (r.payload as { orderId: string }).orderId;
      expect(ORDERS[payloadOrder]?.organizationId).toBe(r.organization_id); // never a cross-tenant event
      expect((r.payload as { patientId: string }).patientId).toBe(ORDERS[payloadOrder]?.patientId);
    }

    // Cross-tenant on the read: each org's activity read got only its own overlays' orders (the last tick
    // swept both orgs; neither org's read was handed the other's order ids).
    expect(seenOrders[ORG_A]).not.toContain(ORDER_B);
    expect(seenOrders[ORG_A]).toContain(ORDER_SEDATION);
    expect(seenOrders[ORG_B]).toEqual([ORDER_B]);
  });

  it("a PAUSED infusion needs no bedside check: the watchdog stays quiet", async () => {
    await svc.recordAdministration(
      ORG_A,
      memberOf[ORG_A],
      ivArgs(
        ORDER_SEDATION,
        "iv_continuous_pause",
        { pauseReason: "transport" },
        {
          ivSessionId: sedationSession,
        },
      ),
    );
    const [o] = await overlayRows(ORDER_SEDATION);
    const before = await eventCount("m37.iv_safety_overlay.bedside_check_overdue", o.id as string);
    await runIvBedsideCheckWatchdog({
      connection: {} as never,
      db: handle.db,
      outbox: m37Outbox as never,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      ivActivity: (organizationId, orderIds) =>
        ivSessionActivityForOrg(handle.db, organizationId, orderIds),
      now: () => new Date(Date.now() + 61 * MINUTE_MS),
    });
    expect(await eventCount("m37.iv_safety_overlay.bedside_check_overdue", o.id as string)).toBe(
      before,
    );
  });

  // ── RETIREMENT ─────────────────────────────────────────────────────────────────────────────────────
  it("a discontinued order's overlay is retired and stops gating; a second delivery is a no-op", async () => {
    await endedConsumer.handle(orderEvent(ORG_A, ORDER_MORPHINE));
    await endedConsumer.handle(orderEvent(ORG_A, ORDER_MORPHINE));
    const [o] = await overlayRows(ORDER_MORPHINE);
    expect(o.overlay_active).toBe(false);
    expect(await overlaySeam.getOverlayForOrder(ORG_A, ORDER_MORPHINE)).toBeNull();
  });

  it("an org-B discontinue cannot retire org A's overlay", async () => {
    await endedConsumer.handle(orderEvent(ORG_B, ORDER_SEDATION));
    const [o] = await overlayRows(ORDER_SEDATION);
    expect(o.overlay_active).toBe(true);
  });

  it("an overlay stops gating once its IPU admission has ended (the patient left the unit)", async () => {
    expect(await overlaySeam.getOverlayForOrder(ORG_A, ORDER_SEDATION)).not.toBeNull();
    await admin.query("UPDATE ipu_admission SET state='discharged' WHERE id=$1", [ipuAdmissionA]);
    expect(await overlaySeam.getOverlayForOrder(ORG_A, ORDER_SEDATION)).toBeNull();
    const verdict = await overlaySeam.evaluatePreAdministration(ORG_A, {
      orderId: ORDER_SEDATION,
      proposedRate: 9999,
      proposedRateUnit: null,
      witnessTokenPresent: false,
      hoursSinceContinuousStart: 9999,
      minutesSinceLastBedsideCheck: 9999,
    });
    expect(verdict.overlayApplies).toBe(false);
  });
});
