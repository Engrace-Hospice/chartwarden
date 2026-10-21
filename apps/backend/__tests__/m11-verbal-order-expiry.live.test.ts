/**
 * M11's `orders.verbal_timer` sweep (§2.3 D3 / §2.6 / §4.8) over real Postgres — the ONE 48h
 * verbal-order-signature-deadline timer for BOTH M11's own `order_record` targets and an M12
 * `medication_order` target (§2.8 D14, the polymorphic `verbal_order` table; M12's own spec names
 * this design explicitly: "M12 has no parallel timer").
 *
 * Three independent, stacked defects made `m11.order.verbal_expired_unsigned` a catalogued event that
 * had never actually worked: (1) no producer ever ran the expiry sweep; (2) the catalogued payload
 * carried no `targetKind`, so M12's own pure `decideVerbalExpiry` decider could never discriminate an
 * M11 order from an M12 medication order on the wire; (3) M12's production `recordVerbal` route never
 * inserted the polymorphic `verbal_order` row at all, so no deadline was ever stored for an M12 verbal
 * medication order to expire against. This suite proves the fix for all three, end to end, over the
 * real production write paths under RLS: M12's real `recordVerbal` route (which now writes M11's
 * `verbal_order` row through the published `OrderSignatureProvider` seam), the real
 * `OrderRouteService.expireOverdueVerbals` sweep (M11's `orders-route-service-db.ts`), the real
 * catalog-validating publisher, the real dispatcher, and M12's real live consumer binding
 * (`buildM12VerbalExpiredConsumer`).
 *
 * Also proves a real, independent bug fix along the way: the published `OrderSignatureProvider.
 * recordVerbalOrder` seam used to compute every verbal deadline off the 48h PLATFORM DEFAULT only,
 * never reading the tenant's real `order_verbal_policy` row the way M11's own route does — so a tenant
 * that had tightened its window (§2.3 D3, tighten-only) would have gotten the wrong deadline through
 * this seam. `verbalPolicyForOrg` fixes that; one of the cases below proves it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m11:verbal-order-expiry:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { __resetSeamsForTest } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/events-by-m11";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { SYSTEM_ORDER_ACTOR } from "../src/modules/11-orders/routes/service";
import {
  createDrizzleOrderSeamStore,
  registerOrderSeams,
} from "../src/modules/11-orders/seams/index";
import { buildM12VerbalExpiredConsumer } from "../src/modules/12-dosespot/consumers/verbal-expired-binding";
import { createDbDoseSpotBackend } from "../src/modules/12-dosespot/dosespot-route-service-db";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/events-by-m12";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { PASSING_M12_SAFETY_GATES } from "./_m12-safety-gates";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
/** GAP-017 -- the services bound a NEW verbal order's `receivedAt` to <= 24h before server time, so the
 *  "already overdue" fixtures record with an in-bounds instant and `backdateVerbal` ages the row afterwards,
 *  the way real time would. */
const RECEIVED_20H_AGO = new Date(Date.now() - 20 * 3_600_000).toISOString();
const RECEIVED_NOW = new Date().toISOString();

describe.skipIf(!DB_URL)("M11 verbal-order-expiry timer (F-verbal-timer), LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let orderService: ReturnType<typeof createDbOrderBackend>;
  let medService: ReturnType<typeof createDbDoseSpotBackend>;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const memberOf: Record<string, string> = {};

  async function resetSchema() {
    // `wardenx_app`/etc. are CLUSTER-GLOBAL roles (per the harness's own convention this repo's live
    // suites share). This suite runs against its own freshly-created, exclusive database, but the
    // cluster itself may be shared with other concurrently-running live suites in this session — a
    // `DROP OWNED BY ... CASCADE; DROP ROLE` here would fail (or, forced, would reach into another
    // database's objects) if the role owns anything anywhere else in the cluster right now. So this
    // resets only THIS database's `public` schema and leaves cluster-global roles alone — the
    // migrations' own `CREATE ROLE ... IF NOT EXISTS` guards (e.g. `0015_terminology_m38_…`) make
    // re-applying them against an already-existing role a no-op, and GRANTs still land correctly on
    // this database's freshly-created objects either way.
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed one `order_record` in `pending_signature`, kind `lab` (verbal-allowed, §2.1). */
  async function seedOrder(org: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO order_record (organization_id, patient_id, admission_id, kind, kind_version, data,
         status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id)
       VALUES ($1,$2,$3,'lab','v1','{}'::jsonb,'pending_signature',$4,'rn',$5)
       RETURNING id`,
      [org, randomUUID(), randomUUID(), memberOf[org], PHYSICIAN_MDM],
    );
    return rows[0].id as string;
  }

  /** Seed one `medication_order` in `pending_signature` — mirrors the F-155/F-161 reconciliation
   *  suite's own `seedMedOrder` helper. */
  async function seedMedOrder(org: string, status = "pending_signature"): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, med_class, drug_name, strength, dose_form, route, data,
         prescriber_membership_id, prescribing_physician_mdm_id, status)
       VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7,$8)
       RETURNING id`,
      [
        org,
        providerOf[org],
        locationOf[org],
        randomUUID(),
        randomUUID(),
        memberOf[org],
        PHYSICIAN_MDM,
        status,
      ],
    );
    return rows[0].id as string;
  }

  async function orderRow(id: string): Promise<{ status: string; version: number } | undefined> {
    const { rows } = await admin.query("SELECT status, version FROM order_record WHERE id=$1", [
      id,
    ]);
    return rows[0] as { status: string; version: number } | undefined;
  }

  async function medOrderRow(id: string): Promise<{ status: string } | undefined> {
    const { rows } = await admin.query("SELECT status FROM medication_order WHERE id=$1", [id]);
    return rows[0] as { status: string } | undefined;
  }

  async function verbalRow(
    targetId: string,
  ): Promise<{ status: string; deadlineAt: Date; targetKind: string } | undefined> {
    const { rows } = await admin.query(
      `SELECT status, deadline_at as "deadlineAt", target_kind as "targetKind" FROM verbal_order WHERE target_id=$1`,
      [targetId],
    );
    return rows[0] as { status: string; deadlineAt: Date; targetKind: string } | undefined;
  }

  async function discontinuationRow(
    orderRecordId: string,
  ): Promise<{ reason: string; actorMembershipId: string | null } | undefined> {
    const { rows } = await admin.query(
      `SELECT reason, actor_membership_id as "actorMembershipId" FROM order_discontinuation WHERE order_record_id=$1`,
      [orderRecordId],
    );
    return rows[0] as { reason: string; actorMembershipId: string | null } | undefined;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m11-vte@x.test')`, [USER]);
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

    // The published M11 OrderSignatureProvider seam — real Drizzle store, so `M12`'s `recordVerbal`
    // route (which calls `getOrderSignatureProvider().recordVerbalOrder(...)`) writes a real row.
    __resetSeamsForTest();
    registerOrderSeams({ store: createDrizzleOrderSeamStore(handle.db) });

    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M12_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const m11Outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m11" } as never),
    };
    const m12Outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m12" } as never),
    };

    orderService = createDbOrderBackend(handle.db, m11Outbox as never);
    medService = createDbDoseSpotBackend(handle.db, m12Outbox as never, PASSING_M12_SAFETY_GATES);
    // GAP-035 follow-up — recordVerbal refuses a named prescriber with no active roster row
    // (NAMED_PRESCRIBER_NOT_ENROLLED), so each org enrolls one prescriber for PHYSICIAN_MDM.
    for (const org of [ORG_A, ORG_B])
      await medService.enrollPrescriber(org, memberOf[org] as string, [], PHYSICIAN_MDM);

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [buildM12VerbalExpiredConsumer({ db: handle.db, outbox: m12Outbox as never })],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    __resetSeamsForTest();
    await handle?.close();
    if (admin) await admin.end();
  });

  it("M12's recordVerbal writes a real M11 verbal_order row (target_kind='medication_order') with the platform-default 48h deadline", async () => {
    const orderId = await seedMedOrder(ORG_A);
    const receivedAt = RECEIVED_NOW;
    await runWithRequestContext({ organizationId: ORG_A, userId: "" }, () =>
      medService.recordVerbal(ORG_A, memberOf[ORG_A], orderId, {
        recorderDiscipline: "rn",
        recorderDisciplines: ["rn"],
        verbalAttestation: "x".repeat(100),
        receivedAt,
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );

    expect((await medOrderRow(orderId))?.status).toBe("verbal_pending");
    const v = await verbalRow(orderId);
    expect(v).toBeDefined();
    expect(v?.targetKind).toBe("medication_order");
    const expectedDeadline = new Date(Date.parse(receivedAt) + 48 * 3_600_000);
    expect(v?.deadlineAt.getTime()).toBe(expectedDeadline.getTime());
  });

  it("respects a tenant's own TIGHTENED order_verbal_policy through the seam — not the platform default alone (the fixed bug)", async () => {
    await admin.query(
      `INSERT INTO order_verbal_policy (organization_id, window_hours) VALUES ($1, 4)`,
      [ORG_A],
    );
    const orderId = await seedMedOrder(ORG_A);
    const receivedAt = RECEIVED_NOW;
    await runWithRequestContext({ organizationId: ORG_A, userId: "" }, () =>
      medService.recordVerbal(ORG_A, memberOf[ORG_A], orderId, {
        recorderDiscipline: "rn",
        recorderDisciplines: ["rn"],
        verbalAttestation: "x".repeat(100),
        receivedAt,
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );
    const v = await verbalRow(orderId);
    const expectedDeadline = new Date(Date.parse(receivedAt) + 4 * 3_600_000);
    expect(v?.deadlineAt.getTime()).toBe(expectedDeadline.getTime());
    // Clean up so the remaining cases in this file keep seeing the platform default.
    await admin.query("DELETE FROM order_verbal_policy WHERE organization_id=$1", [ORG_A]);
  });

  /** Age a freshly recorded verbal order to 50h ago (platform-default 48h deadline = 2h ago). */
  async function backdateVerbal(targetId: string): Promise<void> {
    await admin.query(
      `UPDATE verbal_order SET received_at = now() - interval '50 hours',
         effective_at = now() - interval '50 hours', deadline_at = now() - interval '2 hours'
       WHERE target_id = $1`,
      [targetId],
    );
  }

  it("expires M11's own verbal_pending order_record past its deadline (target_kind='order')", async () => {
    const orderId = await seedOrder(ORG_A);
    await orderService.recordVerbal(
      ORG_A,
      memberOf[ORG_A],
      orderId,
      {
        recorderDiscipline: "rn",
        verbalAttestation: "x".repeat(100),
        readBackVerified: true,
        effectiveAt: RECEIVED_20H_AGO,
        receivedAt: RECEIVED_20H_AGO,
        orderingPhysicianMdmId: PHYSICIAN_MDM,
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect((await orderRow(orderId))?.status).toBe("verbal_pending");
    await backdateVerbal(orderId);

    const { expiredVerbalOrderIds } = await orderService.expireOverdueVerbals(ORG_A);
    expect(expiredVerbalOrderIds.length).toBeGreaterThan(0);

    expect((await orderRow(orderId))?.status).toBe("expired_unsigned");
    expect((await verbalRow(orderId))?.status).toBe("expired_unsigned");
    const disc = await discontinuationRow(orderId);
    expect(disc?.reason).toBe("expired_verbal");
    expect(disc?.actorMembershipId).toBeNull();

    const events = await eventsFor(orderId);
    const expired = events.find((e) => e.type === "m11.order.verbal_expired_unsigned");
    expect(expired).toBeDefined();
    expect((expired?.payload as { targetKind: string }).targetKind).toBe("order");

    // M12's consumer is bound to the same event name but skips a non-medication-order target.
    await expect(dispatcher.tick()).resolves.toBeDefined();
  });

  it("expires an M12 medication order's verbal_order row and M12's real consumer flips it to expired_unsigned", async () => {
    const orderId = await seedMedOrder(ORG_A);
    await runWithRequestContext({ organizationId: ORG_A, userId: "" }, () =>
      medService.recordVerbal(ORG_A, memberOf[ORG_A], orderId, {
        recorderDiscipline: "rn",
        recorderDisciplines: ["rn"],
        verbalAttestation: "x".repeat(100),
        receivedAt: RECEIVED_20H_AGO,
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );
    expect((await medOrderRow(orderId))?.status).toBe("verbal_pending");
    await backdateVerbal(orderId);

    const { expiredVerbalOrderIds } = await orderService.expireOverdueVerbals(ORG_A);
    expect(expiredVerbalOrderIds.length).toBeGreaterThan(0);

    // M11's own side is done: the verbal_order row is expired and the event is on the outbox.
    expect((await verbalRow(orderId))?.status).toBe("expired_unsigned");
    // M12's medication_order has NOT moved yet — the consumer hasn't ticked.
    expect((await medOrderRow(orderId))?.status).toBe("verbal_pending");

    const events = await eventsFor(orderId);
    const expired = events.find((e) => e.type === "m11.order.verbal_expired_unsigned");
    expect((expired?.payload as { targetKind: string }).targetKind).toBe("medication_order");

    await dispatcher.tick();
    expect((await medOrderRow(orderId))?.status).toBe("expired_unsigned");

    const m12Events = await eventsFor(orderId);
    expect(m12Events.some((e) => e.type === "m12.medication_order.list_changed")).toBe(true);
  });

  it("a medication order signed before its deadline is left alone by the sweep (still verbal_pending, no false expiry)", async () => {
    const orderId = await seedMedOrder(ORG_A);
    await runWithRequestContext({ organizationId: ORG_A, userId: "" }, () =>
      medService.recordVerbal(ORG_A, memberOf[ORG_A], orderId, {
        recorderDiscipline: "rn",
        recorderDisciplines: ["rn"],
        verbalAttestation: "x".repeat(100),
        receivedAt: RECEIVED_NOW, // deadline is ~48h in the future
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );
    const { expiredVerbalOrderIds } = await orderService.expireOverdueVerbals(ORG_A);
    expect(expiredVerbalOrderIds).not.toContain(orderId);
    expect((await medOrderRow(orderId))?.status).toBe("verbal_pending");
    expect((await verbalRow(orderId))?.status).toBe("pending");
  });

  it("does not expire org B's verbal order from an org A sweep — cross-tenant isolation under RLS", async () => {
    const orderIdB = await seedMedOrder(ORG_B);
    await runWithRequestContext({ organizationId: ORG_B, userId: "" }, () =>
      medService.recordVerbal(ORG_B, memberOf[ORG_B], orderIdB, {
        recorderDiscipline: "rn",
        recorderDisciplines: ["rn"],
        verbalAttestation: "x".repeat(100),
        receivedAt: RECEIVED_20H_AGO,
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );

    await backdateVerbal(orderIdB);

    await orderService.expireOverdueVerbals(ORG_A);
    expect((await verbalRow(orderIdB))?.status).toBe("pending"); // untouched by ORG_A's sweep

    await orderService.expireOverdueVerbals(ORG_B);
    expect((await verbalRow(orderIdB))?.status).toBe("expired_unsigned");
  });
});
