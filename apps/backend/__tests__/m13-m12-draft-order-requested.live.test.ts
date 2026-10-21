/**
 * F-16x (#248) — M12's `m13.reconciliation.draft_order_requested` binding, over real Postgres.
 *
 * The real M13 write path (`emar-route-service-db.ts`'s `recordDecision`) used to emit this event with a
 * hardcoded `medicationOrderDraftPayload: {}` for EVERY `carry_forward`/`new_order` decision — a payload no
 * consumer could ever have safely minted a `medication_order` from (`drug_name`/`strength`/`dose_form`/
 * `route` are all NOT NULL). It now sources real, typed drug content from the pure `@chartwarden/emar`
 * `planReconciliationDecision` core: `carry_forward` of an already-`m12_active` line is correctly a no-op
 * (no event — the order already exists), `carry_forward`/`new_order` of an `m12_medhx` line is REFUSED
 * (`RECONCILIATION_MEDHX_UNAVAILABLE`, 501 — no medication-history-record projection exists anywhere in
 * this codebase), and `carry_forward` of a `caregiver_reported` line / any `new_order` mints a draft from
 * the caller-supplied `medicationDetails` — never fabricated.
 *
 * This suite proves the OTHER half — M12's `buildM12DraftOrderRequestedConsumer` — end to end: real drug
 * content flows all the way from a real `recordDecision` call, through the real catalog-validating
 * publisher and dispatcher, into a real `medication_order` row, siting + `prescribing_physician_mdm_id`
 * resolved from the patient's real active admission (M6's `activeAdmissionDraftContextForPatient` seam),
 * `prescriber_membership_id` attributed to the membership who actually recorded the decision (never a
 * system sentinel — the column is a NOT NULL FK to `membership`), idempotent redelivery via
 * `medication_order_reconciliation_decision_application`, cross-tenant isolation, and the honest refusal
 * (event preserved, not swallowed) when the patient has no active admission to site the draft against.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m13:m12-draft-order-requested:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { activeAdmissionDraftContextForPatient } from "../src/modules/06-admission/seams/drizzle-store";
import { buildM12DraftOrderRequestedConsumer } from "../src/modules/12-dosespot/consumers/draft-order-requested-binding";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import {
  type EmarWriteOutboxPort,
  M13_OUTBOX_EVENTS,
  createDbEmarBackend,
} from "../src/modules/13-emar/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

const MELATONIN = {
  drugName: "Melatonin",
  strength: "3 mg",
  doseForm: "tablet",
  route: "oral",
  medClass: "standard" as const,
};

describe.skipIf(!DB_URL)("F-16x — M12 reconciliation-draft-order consumer, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let svc: ReturnType<typeof createDbEmarBackend>;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const memberOf: Record<string, string> = {};

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

  /** Seed an active admission (siting + attending physician) directly — reaching `active` through the
   *  real M6 lifecycle is that module's own suite's subject, not this one's (mirrors
   *  `m6-discharge-cascade.live.test.ts`'s own `seedMedOrder`-style shortcut). */
  async function seedActiveAdmission(
    org: string,
    patientId: string,
    opts: { attendingPhysicianId?: string | null } = {},
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id, status,
           admission_at, activated_at, attending_physician_id)
         VALUES ($1,$2,$3,$4,'active',now(),now(),$5)
         RETURNING id`,
      [
        org,
        providerOf[org],
        locationOf[org],
        patientId,
        opts.attendingPhysicianId ?? PHYSICIAN_MDM,
      ],
    );
    return rows[0].id as string;
  }

  async function seedWorksheet(
    org: string,
    patientId: string,
    admissionId: string,
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO medication_reconciliation_worksheet
           (organization_id, provider_entity_id, location_id, patient_id, admission_id, trigger_kind,
            trigger_outbox_event_id, triggered_at, due_at, status)
         VALUES ($1,$2,$3,$4,$5,'admission',$6,now(),now() + interval '5 days','pending')
         RETURNING id`,
      [org, providerOf[org], locationOf[org], patientId, admissionId, randomUUID()],
    );
    return rows[0].id as string;
  }

  async function medOrderRows(patientId: string): Promise<
    Array<{
      id: string;
      drug_name: string;
      strength: string;
      dose_form: string;
      route: string;
      med_class: string;
      status: string;
      provider_entity_id: string;
      location_id: string;
      prescriber_membership_id: string;
      prescribing_physician_mdm_id: string;
      triggering_reconciliation_decision_id: string | null;
    }>
  > {
    const { rows } = await admin.query(
      `SELECT id, drug_name, strength, dose_form, route, med_class, status, provider_entity_id,
                location_id, prescriber_membership_id, prescribing_physician_mdm_id,
                triggering_reconciliation_decision_id
         FROM medication_order WHERE patient_id = $1`,
      [patientId],
    );
    return rows;
  }

  async function applicationRows(org: string): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM medication_order_reconciliation_decision_application WHERE organization_id = $1",
      [org],
    );
    return rows[0].n as number;
  }

  async function eventsFor(
    aggregateId: string,
  ): Promise<Array<{ type: string; payload: unknown }>> {
    const { rows } = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at",
      [aggregateId],
    );
    return rows.map((r) => ({ type: r.event_type as string, payload: r.payload }));
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f16xa@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
               VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
          [org, `CCN-${org.slice(0, 4)}`, `Hospice ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
               VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerOf[org]],
        )
      ).rows[0].id as string;
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = buildBootOutboxCatalog([M12_OUTBOX_EVENTS, M13_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const m13Outbox: EmarWriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m13" } as never),
    };
    svc = createDbEmarBackend(handle.db, m13Outbox);
    const bindM12 = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m12" } as never),
    };

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM12DraftOrderRequestedConsumer({
          db: handle.db,
          outbox: bindM12 as never,
          resolveAdmissionContext: (organizationId, patientId) =>
            activeAdmissionDraftContextForPatient(handle.db, organizationId, patientId),
        }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("mints a real draft medication_order from a caregiver_reported carry_forward with real drug content", async () => {
    const patientId = randomUUID();
    const admissionId = await seedActiveAdmission(ORG_A, patientId);
    const ws = await seedWorksheet(ORG_A, patientId, admissionId);

    const view = await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
      lineKind: "caregiver_reported",
      sourceId: "home-melatonin",
      decision: "carry_forward",
      medicationDetails: MELATONIN,
    });
    const decisionId = view.decisions[0]!.lineId;

    expect(await medOrderRows(patientId)).toHaveLength(0); // pending row only, until the tick
    await dispatcher.tick();

    const rows = await medOrderRows(patientId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.drug_name).toBe("Melatonin");
    expect(row.strength).toBe("3 mg");
    expect(row.dose_form).toBe("tablet");
    expect(row.route).toBe("oral");
    expect(row.med_class).toBe("standard");
    expect(row.status).toBe("draft");
    expect(row.provider_entity_id).toBe(providerOf[ORG_A]);
    expect(row.location_id).toBe(locationOf[ORG_A]);
    expect(row.prescribing_physician_mdm_id).toBe(PHYSICIAN_MDM);
    // The reconciling clinician, not a system sentinel — `prescriber_membership_id` is a NOT NULL FK.
    expect(row.prescriber_membership_id).toBe(memberOf[ORG_A]);
    expect(row.triggering_reconciliation_decision_id).toBe(decisionId);

    const events = await eventsFor(row.id);
    expect(events.some((e) => e.type === "m12.medication_order.draft_created")).toBe(true);
  });

  it("mints a real draft medication_order from a new_order decision with real drug content", async () => {
    const patientId = randomUUID();
    const admissionId = await seedActiveAdmission(ORG_A, patientId);
    const ws = await seedWorksheet(ORG_A, patientId, admissionId);

    await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
      lineKind: "caregiver_reported",
      sourceId: "new-oxycodone",
      decision: "new_order",
      medicationDetails: {
        drugName: "Oxycodone",
        strength: "5 mg",
        doseForm: "tablet",
        route: "oral",
        medClass: "controlled_substance",
        deaSchedule: "II",
      },
    });
    await dispatcher.tick();

    const rows = await medOrderRows(patientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.drug_name).toBe("Oxycodone");
    expect(rows[0]!.med_class).toBe("controlled_substance");
  });

  it("carry_forward of an m12_active line mints nothing — the order already exists, no event at all", async () => {
    const patientId = randomUUID();
    const admissionId = await seedActiveAdmission(ORG_A, patientId);
    const ws = await seedWorksheet(ORG_A, patientId, admissionId);
    const existingOrderId = randomUUID();

    await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
      lineKind: "m12_active",
      sourceId: existingOrderId,
      decision: "carry_forward",
    });
    await dispatcher.tick();

    expect(await medOrderRows(patientId)).toHaveLength(0);
  });

  it("carry_forward of an m12_medhx line is refused at the M13 side — RECONCILIATION_MEDHX_UNAVAILABLE, no event ever reaches M12", async () => {
    const patientId = randomUUID();
    const admissionId = await seedActiveAdmission(ORG_A, patientId);
    const ws = await seedWorksheet(ORG_A, patientId, admissionId);

    await expect(
      svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
        lineKind: "m12_medhx",
        sourceId: "hist-1",
        decision: "carry_forward",
        medicationDetails: MELATONIN,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "RECONCILIATION_MEDHX_UNAVAILABLE" }));
    await dispatcher.tick();
    expect(await medOrderRows(patientId)).toHaveLength(0);
  });

  it("is idempotent on redelivery — a genuinely second delivery for the same decision mints no second order", async () => {
    const patientId = randomUUID();
    const admissionId = await seedActiveAdmission(ORG_A, patientId);
    const ws = await seedWorksheet(ORG_A, patientId, admissionId);

    const view = await svc.recordDecision(ORG_A, memberOf[ORG_A], ws, {
      lineKind: "caregiver_reported",
      sourceId: "home-melatonin-2",
      decision: "carry_forward",
      medicationDetails: MELATONIN,
    });
    const decisionId = view.decisions[0]!.lineId;
    await dispatcher.tick();
    const first = await medOrderRows(patientId);
    expect(first).toHaveLength(1);
    const appliedCountAfterFirst = await applicationRows(ORG_A);

    // A genuinely SECOND delivery (its own outbox row, its own dispatcher receipt) carrying the SAME
    // decisionId — the consumer's own `medication_order_reconciliation_decision_application` check, not
    // the dispatcher's (eventId, consumerName) receipt (a different eventId this time).
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, async (tx) => {
      const catalog = buildBootOutboxCatalog([M12_OUTBOX_EVENTS, M13_OUTBOX_EVENTS]);
      const publisher = buildTxOutboxPublisher(catalog);
      await publisher.publish(
        tx as never,
        {
          eventName: "m13.reconciliation.draft_order_requested",
          organizationId: ORG_A,
          aggregateKind: "reconciliation_worksheet",
          aggregateId: ws,
          callerModule: "m13",
          payload: {
            worksheetId: ws,
            decisionId,
            patientId,
            decisionMadeByMembershipId: memberOf[ORG_A],
            lineKind: "caregiver_reported",
            medicationOrderDraftPayload: MELATONIN,
            derivedFromHistoryId: null,
          },
        } as never,
      );
    });
    await dispatcher.tick();

    const after = await medOrderRows(patientId);
    expect(after).toHaveLength(1); // still one order, not two
    expect(after[0]!.id).toBe(first[0]!.id);
    expect(await applicationRows(ORG_A)).toBe(appliedCountAfterFirst); // no second ledger row either
  });

  it("does not leak org B's patient/admission into org A's draft, and refuses (preserves the event) rather than minting unsited", async () => {
    const patientIdB = randomUUID();
    await seedActiveAdmission(ORG_B, patientIdB);
    const wsA = await seedWorksheet(ORG_A, patientIdB, randomUUID());

    // Publish under ORG_A naming ORG_B's real patient id — RLS scopes the admission read to ORG_A, so it
    // resolves to no active admission at all (not a cross-tenant hit).
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, async (tx) => {
      const catalog = buildBootOutboxCatalog([M12_OUTBOX_EVENTS, M13_OUTBOX_EVENTS]);
      const publisher = buildTxOutboxPublisher(catalog);
      await publisher.publish(
        tx as never,
        {
          eventName: "m13.reconciliation.draft_order_requested",
          organizationId: ORG_A,
          aggregateKind: "reconciliation_worksheet",
          aggregateId: wsA,
          callerModule: "m13",
          payload: {
            worksheetId: wsA,
            decisionId: randomUUID(),
            patientId: patientIdB,
            decisionMadeByMembershipId: memberOf[ORG_A],
            lineKind: "caregiver_reported",
            medicationOrderDraftPayload: MELATONIN,
            derivedFromHistoryId: null,
          },
        } as never,
      );
    });
    await expect(dispatcher.tick()).resolves.toBeDefined();

    expect(await medOrderRows(patientIdB)).toHaveLength(0);
    // The event is preserved (retried later), never silently dropped — the dispatcher recorded the
    // "no active admission" throw as a pending retry, not a swallow.
    const { rows } = await admin.query(
      "SELECT status FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [wsA, "m13.reconciliation.draft_order_requested"],
    );
    expect(rows[0]?.status).toBe("pending");
  });

  it("no active admission for the patient refuses rather than minting an unsited draft", async () => {
    const patientId = randomUUID(); // no admission seeded at all
    const ws = await seedWorksheet(ORG_A, patientId, randomUUID());

    await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, async (tx) => {
      const catalog = buildBootOutboxCatalog([M12_OUTBOX_EVENTS, M13_OUTBOX_EVENTS]);
      const publisher = buildTxOutboxPublisher(catalog);
      await publisher.publish(
        tx as never,
        {
          eventName: "m13.reconciliation.draft_order_requested",
          organizationId: ORG_A,
          aggregateKind: "reconciliation_worksheet",
          aggregateId: ws,
          callerModule: "m13",
          payload: {
            worksheetId: ws,
            decisionId: randomUUID(),
            patientId,
            decisionMadeByMembershipId: memberOf[ORG_A],
            lineKind: "caregiver_reported",
            medicationOrderDraftPayload: MELATONIN,
            derivedFromHistoryId: null,
          },
        } as never,
      );
    });
    await expect(dispatcher.tick()).resolves.toBeDefined();
    expect(await medOrderRows(patientId)).toHaveLength(0);
  });
});
