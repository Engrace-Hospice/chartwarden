/**
 * GAP-062 — the M21 §4.6 crons, END TO END over real Postgres as the real NOBYPASSRLS `chartwarden_app` role.
 *
 * Before this change `runParMonitor`, `detectReturnEscalation` and `detectSupplyRequestFindings` had no
 * production caller: `m21.par.below_threshold` never fired, a kit never flipped to `overdue` at 30 days and a
 * `delivered` request never auto-confirmed at 72h. This suite drives the real cron entry points
 * (`runParMonitorCron`, `runUnreturnedKitMonitorCron`, `runSupplyRequestMonitorCron`) through the REAL
 * catalog-validating tx outbox publisher (a payload that disagrees with `M21_OUTBOX_EVENTS` is refused here
 * exactly as at the dispatcher) and proves:
 *   1. a par row below its reorder point emits `m21.par.below_threshold`; a depleted one also emits
 *      `stockout_imminent`; a healthy row and a Location whose local hour is not 04:00 emit nothing
 *   2. a return 31 days past `return_required_at` becomes `overdue` and emits `m21.comfort_kit.return_overdue`
 *      (a 10-day-old return is untouched); a second tick is a no-op (no duplicate flip / event)
 *   3. a request `delivered` 80h ago auto-confirms with the `system_auto_confirm` actor (a 10h-old one does
 *      not); an `ordered` request 30h old emits the vendor-confirmation advisory and does NOT move
 *   4. both orgs are swept independently under their own RLS context
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m21:cron-workers:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M21_OUTBOX_EVENTS,
  buildM21WorkerDeps,
  runParMonitorCron,
  runSupplyRequestMonitorCron,
  runUnreturnedKitMonitorCron,
} from "../src/modules/21-supplies/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** 04:30 UTC — local 04:00 hour for a `UTC` Location, 21:xx the previous day for America/Los_Angeles. */
const NOW = new Date("2026-10-05T04:30:00.000Z");

describe.skipIf(!DB_URL)("GAP-062 — M21 §4.6 cron workers — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const providerOf: Record<string, string> = {};
  const utcLocationOf: Record<string, string> = {};
  let laLocationA: string;
  let memberA: string;
  let templateA: string;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  async function seedLocation(org: string, timezone: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000',$2) RETURNING id`,
        [providerOf[org], timezone],
      )
    ).rows[0].id as string;
  }

  async function seedPar(
    org: string,
    location: string,
    current: number,
    reorder: number,
    min: number,
  ): Promise<string> {
    // One platform SKU per row (the partial unique is per (org, location, sku)).
    const sku = (
      await admin.query(
        `INSERT INTO supply_item (hcpcs, name, sku_class, default_unit, is_billable)
           VALUES (NULL, $1, 'internal', 'each', false) RETURNING id`,
        [`Gloves ${randomUUID().slice(0, 6)}`],
      )
    ).rows[0].id as string;
    return (
      await admin.query(
        `INSERT INTO par_stock (organization_id, provider_entity_id, location_id, sku_id,
            current_quantity, unit, reorder_point, reorder_quantity, min_safety_stock)
         VALUES ($1,$2,$3,$4,$5,'each',$6,20,$7) RETURNING id`,
        [org, providerOf[org], location, sku, current, reorder, min],
      )
    ).rows[0].id as string;
  }

  async function seedReturn(org: string, daysAgoRequired: number): Promise<string> {
    const patientId = randomUUID();
    const admissionId = randomUUID();
    const dispatch = (
      await admin.query(
        `INSERT INTO comfort_kit_dispatch
           (supply_request_id, organization_id, patient_id, admission_id, location_id,
            provider_entity_id, comfort_kit_template_id, deployment_site, dispatch_status,
            pharmacy_dispatch_mode, dispatch_source, kit_serial_number, dispatched_by_membership_id,
            deployed_at_patient_at, deployed_by_membership_id,
            controlled_substance_handling_policy_digest, dispatched_contents_jsonb)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'home','deployed_at_patient',
                 'supply_hub_dispatch','supply_hub',$7,$8, now(), $8, 'digest','[]'::jsonb)
         RETURNING id, dispatched_at`,
        [
          org,
          patientId,
          admissionId,
          utcLocationOf[org],
          providerOf[org],
          templateA,
          `KIT-${randomUUID().slice(0, 8)}`,
          memberA,
        ],
      )
    ).rows[0];
    const required = new Date(NOW.getTime() - daysAgoRequired * DAY_MS);
    return (
      await admin.query(
        `INSERT INTO comfort_kit_return
           (dispatch_id, dispatch_partition_dispatched_at, m13_deployment_id, organization_id,
            patient_id, admission_id, provider_entity_id, location_id, return_required_at, return_due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          dispatch.id,
          dispatch.dispatched_at,
          randomUUID(),
          org,
          patientId,
          admissionId,
          providerOf[org],
          utcLocationOf[org],
          required,
          new Date(required.getTime() + 3 * DAY_MS),
        ],
      )
    ).rows[0].id as string;
  }

  async function seedRequest(
    org: string,
    status: "ordered" | "delivered",
    hoursAgo: number,
  ): Promise<string> {
    const stamp = new Date(NOW.getTime() - hoursAgo * HOUR_MS);
    return (
      await admin.query(
        `INSERT INTO supply_request
           (organization_id, patient_id, admission_id, location_id, provider_entity_id,
            requested_by_membership_id, kind, data, status, routing_rule_resolved_jsonb,
            ordered_at, delivered_at, delivered_by_membership_id, delivery_method)
         VALUES ($1,$2,$3,$4,$5,$6,'dme','{}'::jsonb,$7::text::m21_supply_request_status,'{}'::jsonb,
                 $8, $9, $10, $11)
         RETURNING id`,
        [
          org,
          randomUUID(),
          randomUUID(),
          utcLocationOf[org],
          providerOf[org],
          memberA,
          status,
          status === "ordered" ? stamp : null,
          status === "delivered" ? stamp : null,
          status === "delivered" ? memberA : null,
          status === "delivered" ? "agency_courier" : null,
        ],
      )
    ).rows[0].id as string;
  }

  const eventsFor = async (eventType: string, aggregateId: string) =>
    (
      await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
        [eventType, aggregateId],
      )
    ).rows;

  let deps: ReturnType<typeof buildM21WorkerDeps>;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'gap062@x.test')`, [USER]);
    for (const [org, ccn, npi] of [
      [ORG_A, "CCN-A", "NPI-A"],
      [ORG_B, "CCN-B", "NPI-B"],
    ] as const) {
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,'Hospice',$3,'\\x00','12-31') RETURNING id`,
          [org, ccn, npi],
        )
      ).rows[0].id as string;
      utcLocationOf[org] = await seedLocation(org, "UTC");
    }
    laLocationA = await seedLocation(ORG_A, "America/Los_Angeles");
    memberA = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    templateA = (
      await admin.query(
        `INSERT INTO comfort_kit_template (organization_id, name, is_platform_floor, system_locked)
           VALUES ($1,'Tenant Kit',false,false) RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // THE REAL catalog-validating publisher (not NOOP_OUTBOX), with callerModule pinned to `m21` as boot does.
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M21_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, input: unknown) =>
        publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
          ...(input as Parameters<typeof publisher.publish>[1]),
          callerModule: "m21",
        }),
    };
    deps = {
      ...buildM21WorkerDeps({
        connection: {} as never,
        db: handle.db,
        outbox,
        // M1's owner read (the same one boot binds), so the Location zone gate is exercised for real.
        locationTimezone: (tx, locationId) =>
          buildFoundationSiteReader().locationTimezone(tx, locationId),
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
      }),
      now: () => NOW,
    };
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("par-monitor: emits below_threshold / stockout_imminent only at the Location's local 04:00", async () => {
    const below = await seedPar(ORG_A, utcLocationOf[ORG_A], 2, 5, 1);
    const depleted = await seedPar(ORG_A, utcLocationOf[ORG_A], 0, 5, 1);
    const healthy = await seedPar(ORG_A, utcLocationOf[ORG_A], 50, 5, 1);
    const wrongHour = await seedPar(ORG_A, laLocationA, 0, 5, 1);
    const belowB = await seedPar(ORG_B, utcLocationOf[ORG_B], 1, 5, 0);

    await runParMonitorCron(deps);

    expect(await eventsFor("m21.par.below_threshold", below)).toHaveLength(1);
    expect(await eventsFor("m21.par.stockout_imminent", below)).toHaveLength(0);
    expect(await eventsFor("m21.par.below_threshold", depleted)).toHaveLength(1);
    expect(await eventsFor("m21.par.stockout_imminent", depleted)).toHaveLength(1);
    expect(await eventsFor("m21.par.below_threshold", healthy)).toHaveLength(0);
    expect(await eventsFor("m21.par.below_threshold", wrongHour)).toHaveLength(0);
    const rowsB = await eventsFor("m21.par.below_threshold", belowB);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].organization_id).toBe(ORG_B);
  });

  it("unreturned-kit-monitor: flips a 31-day-old return to overdue once, leaves a 10-day-old one", async () => {
    const stale = await seedReturn(ORG_A, 31);
    const fresh = await seedReturn(ORG_A, 10);

    await runUnreturnedKitMonitorCron(deps);

    const state = async (id: string) =>
      (await admin.query("SELECT state FROM comfort_kit_return WHERE id=$1", [id])).rows[0].state;
    expect(await state(stale)).toBe("overdue");
    expect(await state(fresh)).toBe("requested");
    const events = await eventsFor("m21.comfort_kit.return_overdue", stale);
    expect(events).toHaveLength(1);
    expect(events[0].payload.escalation).toBe("overdue_30d");
    expect(await eventsFor("m21.comfort_kit.return_overdue", fresh)).toHaveLength(0);

    // A second tick finds the row already `overdue` at day 31: no flip, no duplicate event.
    await runUnreturnedKitMonitorCron(deps);
    expect(await eventsFor("m21.comfort_kit.return_overdue", stale)).toHaveLength(1);
  });

  it("supply-request monitor: 72h auto-confirm with the system actor; vendor advisory does not move the row", async () => {
    const dueA = await seedRequest(ORG_A, "delivered", 80);
    const notDue = await seedRequest(ORG_A, "delivered", 10);
    const dueB = await seedRequest(ORG_B, "delivered", 80);
    const lateOrder = await seedRequest(ORG_A, "ordered", 30);

    await runSupplyRequestMonitorCron(deps);

    const row = async (id: string) =>
      (
        await admin.query(
          "SELECT status, received_confirmed_actor, received_confirmed_at FROM supply_request WHERE id=$1",
          [id],
        )
      ).rows[0];
    for (const id of [dueA, dueB]) {
      const r = await row(id);
      expect(r.status).toBe("received_confirmed");
      expect(r.received_confirmed_actor).toBe("system_auto_confirm");
      expect(r.received_confirmed_at).not.toBeNull();
    }
    expect((await row(notDue)).status).toBe("delivered");
    expect((await row(lateOrder)).status).toBe("ordered");
    expect(
      await eventsFor("m21.supply_request.vendor_confirmation_overdue", lateOrder),
    ).toHaveLength(1);
    const changed = await eventsFor("m21.supply_request.status_changed", dueA);
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(changed[0].organization_id).toBe(ORG_A);
    expect((await eventsFor("m21.supply_request.status_changed", dueB))[0].organization_id).toBe(
      ORG_B,
    );
  });
});
