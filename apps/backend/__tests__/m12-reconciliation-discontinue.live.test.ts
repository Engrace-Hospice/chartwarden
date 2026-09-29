/**
 * F-155/F-161 (#248) — M12's `m13.reconciliation.discontinue_requested` binding, over real Postgres.
 *
 * `events-by-m13.ts` has declared `m12` a consumer of this event since it was catalogued, and the real M13
 * write path (`emar-route-service-db.ts`'s `recordDecision`) has emitted it — carrying `medicationOrderId`
 * and the fixed reason `"reconciled_discontinue"` — every time a reconciliation `discontinue` decision is
 * recorded against an `m12_active` line. Nothing on the M12 side ever consumed it: a medication order M13
 * had already decided to reconcile away stayed `active` (still prescribable, still refillable) forever,
 * because the decision recorded on `medication_reconciliation_decision` never reached `medication_order`.
 *
 * This suite does not drive the real M13 reconciliation route (the module is under active, unrelated work
 * elsewhere in this same effort) — it publishes the exact catalogued payload through the REAL
 * catalog-validating publisher, exactly as M13's own write path does, which is what actually proves the
 * wire contract rather than a hand-rolled shortcut would.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m12:reconciliation-discontinue:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM12ReconciliationDiscontinueConsumer } from "../src/modules/12-dosespot/consumers/reconciliation-discontinue-binding";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

describe.skipIf(!DB_URL)("F-155/F-161 — M12 reconciliation-discontinue consumer, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let publish: (
    tx: unknown,
    e: {
      eventName: string;
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
  ) => Promise<void>;
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

  /** Seed one `medication_order` directly in a given status — mirrors `m6-discharge-cascade.live.test.ts`'s
   *  own `seedMedOrder` helper; reaching a status through the real lifecycle is that suite's subject, not
   *  this one's. */
  async function seedMedOrder(org: string, status: string): Promise<string> {
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

  async function medRow(id: string): Promise<{ status: string; version: number } | undefined> {
    const { rows } = await admin.query(
      "SELECT status, version FROM medication_order WHERE id=$1",
      [id],
    );
    return rows[0] as { status: string; version: number } | undefined;
  }

  async function publishDiscontinueRequested(
    org: string,
    medicationOrderId: string,
    reason = "reconciled_discontinue",
  ): Promise<string> {
    const worksheetId = randomUUID();
    await withOrgContext(handle.db, { organizationId: org, userId: USER }, async (tx) => {
      await publish(tx, {
        eventName: "m13.reconciliation.discontinue_requested",
        organizationId: org,
        aggregateKind: "reconciliation_worksheet",
        aggregateId: worksheetId,
        payload: {
          worksheetId,
          decisionId: randomUUID(),
          medicationOrderId,
          reason,
        },
      });
    });
    return worksheetId;
  }

  async function eventsFor(aggregateId: string): Promise<Array<{ type: string; payload: unknown }>> {
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f155a@x.test')`, [USER]);
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
    publish = (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m13" } as never);
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
        buildM12ReconciliationDiscontinueConsumer({ db: handle.db, outbox: bindM12 as never }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("discontinues an active medication order on a reconciliation discontinue decision", async () => {
    const orderId = await seedMedOrder(ORG_A, "active");
    await publishDiscontinueRequested(ORG_A, orderId);

    expect((await medRow(orderId))?.status).toBe("active"); // pending row only, until the tick
    await dispatcher.tick();

    const row = await medRow(orderId);
    expect(row?.status).toBe("discontinued");

    const events = await eventsFor(orderId);
    const discontinued = events.find((e) => e.type === "m12.medication_order.discontinued");
    expect(discontinued).toBeDefined();
    const payload = discontinued?.payload as {
      reason: string;
      actorMembershipId: string | null;
    };
    // §3.3 — a system cascade names no acting membership, and carries the real M13 reason, not a
    // fabricated one from the closed `MedicationOrderDiscontinuationReason` union.
    expect(payload.actorMembershipId).toBeNull();
    expect(payload.reason).toBe("reconciled_discontinue");
  });

  it("discontinues a still-pending-signature order (cascadeDiscontinue's wider legal set, not just active)", async () => {
    const orderId = await seedMedOrder(ORG_A, "pending_signature");
    await publishDiscontinueRequested(ORG_A, orderId);
    await dispatcher.tick();
    expect((await medRow(orderId))?.status).toBe("discontinued");
  });

  it("is idempotent on redelivery — an already-discontinued order is a true no-op, not a second event", async () => {
    const orderId = await seedMedOrder(ORG_A, "active");
    await publishDiscontinueRequested(ORG_A, orderId);
    await dispatcher.tick();
    const afterFirst = await medRow(orderId);
    expect(afterFirst?.status).toBe("discontinued");

    // A genuinely SECOND delivery (its own outbox row, its own dispatcher receipt) against a row the first
    // delivery already closed out — the decider's own `already_discontinued` skip branch, not the
    // dispatcher's `(eventId, consumerName)` receipt (a different eventId this time).
    await publishDiscontinueRequested(ORG_A, orderId);
    await dispatcher.tick();

    const events = await eventsFor(orderId);
    const discontinuedEvents = events.filter((e) => e.type === "m12.medication_order.discontinued");
    expect(discontinuedEvents).toHaveLength(1);
    expect((await medRow(orderId))?.version).toBe(afterFirst?.version);
  });

  it("refuses rather than reinterprets an illegal source status (completed) — the machine's own guard, not a guess", async () => {
    const orderId = await seedMedOrder(ORG_A, "completed");
    const worksheetId = await publishDiscontinueRequested(ORG_A, orderId);
    await expect(dispatcher.tick()).resolves.toBeDefined();

    // The transition guard throws before any write; the dispatcher catches it, records `last_error`, and
    // retries later rather than crashing the tick — the row is untouched and no discontinued event fired.
    expect((await medRow(orderId))?.status).toBe("completed");
    const events = await eventsFor(orderId);
    expect(events.some((e) => e.type === "m12.medication_order.discontinued")).toBe(false);
    const { rows } = await admin.query(
      "SELECT last_error, status FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [worksheetId, "m13.reconciliation.discontinue_requested"],
    );
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.last_error as string).toMatch(/ILLEGAL_MEDICATION_ORDER_TRANSITION|completed/i);
  });

  it("does not discontinue org B's order from an org A event, and a same-id lookup across orgs finds nothing", async () => {
    const orderIdB = await seedMedOrder(ORG_B, "active");
    // Publish under ORG_A naming ORG_B's real order id — RLS scopes the read to ORG_A, so it resolves to no
    // row at all (not a cross-tenant hit), the identical no-op path as a genuinely nonexistent id.
    await publishDiscontinueRequested(ORG_A, orderIdB);
    await dispatcher.tick();

    expect((await medRow(orderIdB))?.status).toBe("active");
  });

  it("no-ops cleanly when the medicationOrderId names no row at all", async () => {
    const ghost = randomUUID();
    await publishDiscontinueRequested(ORG_A, ghost);
    await expect(dispatcher.tick()).resolves.toBeDefined();
    expect(await medRow(ghost)).toBeUndefined();
  });
});
