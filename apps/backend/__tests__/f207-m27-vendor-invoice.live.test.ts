/**
 * F-207 (#248) — the M21 vendor-invoice forward seam (M21 spec §1.1 D16), the 4th cost-basis precedence
 * tier additive to D17's M13 administration ▸ M12 ordered ▸ manual entry chain, END TO END over real
 * Postgres. `m21.supply_request.invoice_accrued`/`.invoice_reconciled` declared m27 a consumer since M21
 * locked; nothing ever subscribed. `buildM27VendorInvoiceConsumer` resolves the fiscal-year cost_report
 * by `(providerEntityId, factDate)` and writes/updates one `vendor_invoice_line` row per supply_request,
 * through the REAL catalog-validating transactional publisher, the REAL `createOutboxDispatcher`, and the
 * REAL consumer, as the NOBYPASSRLS `chartwarden_app` role.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f207:m27-vendor-invoice:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
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
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import {
  M27_OUTBOX_EVENTS,
  buildM27VendorInvoiceConsumer,
} from "../src/modules/27-cost-report/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("F-207 — M27 vendor-invoice forward seam, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  const memberOf: Record<string, string> = {};

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

  async function seedCostReport(org: string, providerEntityId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO cost_report (id,organization_id,provider_entity_id,fiscal_year_start_date,fiscal_year_end_date,state)
       VALUES ($1,$2,$3,'2027-01-01','2027-12-31','populating')`,
      [id, org, providerEntityId],
    );
    return id;
  }

  async function invoiceLine(org: string, supplyRequestId: string) {
    const { rows } = await admin.query(
      `SELECT organization_id, cost_report_id, status, accrued_amount_cents, reconciled_amount_cents,
              variance_cents
         FROM vendor_invoice_line WHERE organization_id=$1 AND supply_request_id=$2`,
      [org, supplyRequestId],
    );
    return rows[0] ?? null;
  }

  async function outboxRow(supplyRequestId: string, eventType: string) {
    const { rows } = await admin.query(
      `SELECT id, status, attempt_count FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2
         ORDER BY created_at LIMIT 1`,
      [supplyRequestId, eventType],
    );
    return rows[0] ?? null;
  }

  async function redeliver(eventTypes: string[]) {
    await admin.query(
      `DELETE FROM outbox_consumer_receipt r USING outbox_event e
        WHERE r.event_id = e.id AND e.event_type = ANY($1::text[])`,
      [eventTypes],
    );
    await admin.query(
      "UPDATE outbox_event SET status='pending', attempt_count=0 WHERE event_type = ANY($1::text[])",
      [eventTypes],
    );
    await dispatcher.tick();
  }

  async function publishAccrued(
    org: string,
    args: {
      providerEntityId: string;
      supplyRequestId: string;
      vendorId: string | null;
      invoiceTotalCents: number;
      accruedAt: string;
    },
  ) {
    await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: "m21.supply_request.invoice_accrued",
        payload: {
          orgId: org,
          patientId: randomUUID(),
          admissionId: randomUUID(),
          providerEntityId: args.providerEntityId,
          locationId: randomUUID(),
          supplyRequestId: args.supplyRequestId,
          vendorId: args.vendorId,
          invoiceTotalCents: args.invoiceTotalCents,
          invoiceCurrency: "USD",
          accruedAt: args.accruedAt,
        },
        organizationId: org,
        aggregateKind: "supply_request",
        aggregateId: args.supplyRequestId,
        callerModule: "m21",
      }),
    );
  }

  async function publishReconciled(
    org: string,
    args: {
      providerEntityId: string;
      supplyRequestId: string;
      invoiceTotalCents: number;
      varianceCents: number;
      reconciledAt: string;
    },
  ) {
    await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: "m21.supply_request.invoice_reconciled",
        payload: {
          orgId: org,
          patientId: randomUUID(),
          admissionId: randomUUID(),
          providerEntityId: args.providerEntityId,
          locationId: randomUUID(),
          supplyRequestId: args.supplyRequestId,
          invoiceTotalCents: args.invoiceTotalCents,
          varianceCents: args.varianceCents,
          reconciledAt: args.reconciledAt,
        },
        organizationId: org,
        aggregateKind: "supply_request",
        aggregateId: args.supplyRequestId,
        callerModule: "m21",
      }),
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f207-m27-vendor-invoice@x.test')`,
      [USER],
    );
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = buildBootOutboxCatalog([M21_OUTBOX_EVENTS, M27_OUTBOX_EVENTS]);
    publisher = buildTxOutboxPublisher(catalog);

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [buildM27VendorInvoiceConsumer({ db: handle.db })],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("an accrual resolves the fiscal-year cost report and writes a tier-4 source row", async () => {
    const providerEntityId = randomUUID();
    const reportId = await seedCostReport(ORG_A, providerEntityId);
    const supplyRequestId = randomUUID();
    const vendorId = randomUUID();

    await publishAccrued(ORG_A, {
      providerEntityId,
      supplyRequestId,
      vendorId,
      invoiceTotalCents: 50_000,
      accruedAt: "2027-03-15T00:00:00.000Z",
    });
    await dispatcher.tick();

    const row = await invoiceLine(ORG_A, supplyRequestId);
    expect(row).not.toBeNull();
    expect(row.cost_report_id).toBe(reportId);
    expect(row.status).toBe("accrued");
    expect(Number(row.accrued_amount_cents)).toBe(50_000);
    expect(row.reconciled_amount_cents).toBeNull();

    // idempotent redelivery — the accrual fact is never overwritten
    await redeliver(["m21.supply_request.invoice_accrued"]);
    const after = await invoiceLine(ORG_A, supplyRequestId);
    expect(Number(after.accrued_amount_cents)).toBe(50_000);

    // reconciliation updates the SAME row
    await publishReconciled(ORG_A, {
      providerEntityId,
      supplyRequestId,
      invoiceTotalCents: 52_000,
      varianceCents: 2_000,
      reconciledAt: "2027-04-01T00:00:00.000Z",
    });
    await dispatcher.tick();
    const reconciled = await invoiceLine(ORG_A, supplyRequestId);
    expect(reconciled.status).toBe("reconciled");
    expect(Number(reconciled.reconciled_amount_cents)).toBe(52_000);
    expect(Number(reconciled.variance_cents)).toBe(2_000);

    // idempotent redelivery of the reconciliation — a no-op, not a second update cycle
    await redeliver(["m21.supply_request.invoice_reconciled"]);
    const reconciledAgain = await invoiceLine(ORG_A, supplyRequestId);
    expect(Number(reconciledAgain.reconciled_amount_cents)).toBe(52_000);
    expect(Number(reconciledAgain.variance_cents)).toBe(2_000);
  });

  it("an accrual with no open cost report for the fact date retries rather than guessing", async () => {
    const providerEntityId = randomUUID(); // no cost_report seeded for this provider at all
    const supplyRequestId = randomUUID();

    await publishAccrued(ORG_A, {
      providerEntityId,
      supplyRequestId,
      vendorId: null,
      invoiceTotalCents: 12_345,
      accruedAt: "2027-06-01T00:00:00.000Z",
    });
    await dispatcher.tick();

    expect(await invoiceLine(ORG_A, supplyRequestId)).toBeNull();
    const outboxState = await outboxRow(supplyRequestId, "m21.supply_request.invoice_accrued");
    expect(outboxState.status).not.toBe("dispatched");
    expect(outboxState.attempt_count).toBeGreaterThan(0);
  });

  it("org A's invoice never reaches org B's cost report", async () => {
    const providerEntityId = randomUUID();
    await seedCostReport(ORG_A, providerEntityId);
    const bReportId = await seedCostReport(ORG_B, providerEntityId);
    const supplyRequestId = randomUUID();

    // Published under ORG_A while the same providerEntityId also has an ORG_B report — the RLS-scoped
    // lookup inside withOrgContext(ORG_A, …) must never resolve org B's report.
    await publishAccrued(ORG_A, {
      providerEntityId,
      supplyRequestId,
      vendorId: null,
      invoiceTotalCents: 7_000,
      accruedAt: "2027-05-01T00:00:00.000Z",
    });
    await dispatcher.tick();

    const rowA = await invoiceLine(ORG_A, supplyRequestId);
    expect(rowA).not.toBeNull();
    expect(rowA.organization_id).toBe(ORG_A);
    expect(rowA.cost_report_id).not.toBe(bReportId);
    expect(await invoiceLine(ORG_B, supplyRequestId)).toBeNull();
  });
});
