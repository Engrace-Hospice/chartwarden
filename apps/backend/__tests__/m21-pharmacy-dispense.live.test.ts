/**
 * F-233 (#248) — LIVE Postgres proof of M21's Option-B consumer of
 * `m12.medication_order.dispensed_at_pharmacy` (`outbox-consumers/m12-pharmacy-dispense.ts`).
 *
 * The event is emitted through the REAL catalog-validating publisher under M12's catalog (not a hand-built
 * row), read back from `outbox_event`, and fed to the consumer, which runs as the real NOBYPASSRLS
 * `wardenx_app` role. The contract under test:
 *   - correlation by `data.contents[].medicationOrderId` -> one append-only fact per correlated request;
 *   - NO `comfort_kit_dispatch` row is ever created and no request status changes (no fabricated §1304
 *     chain-of-custody);
 *   - idempotent on the outbox event id; an uncorrelated event is settled with a recorded reason;
 *   - org-scoped RLS (FORCE), no UPDATE/DELETE for the app role.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m21:pharmacy-dispense:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import {
  NO_CORRELATING_REQUEST_REASON,
  buildM21PharmacyDispenseConsumer,
} from "../src/modules/21-supplies/outbox-consumers/m12-pharmacy-dispense";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const EVENT = "m12.medication_order.dispensed_at_pharmacy";

describe.skipIf(!DB_URL)(
  "F-233 — M21 pharmacy-dispense consumer (Option B) — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let consumer: ReturnType<typeof buildM21PharmacyDispenseConsumer>;
    let publisher: ReturnType<typeof buildTxOutboxPublisher>;
    const provider: Record<string, string> = {};
    const location: Record<string, string> = {};
    const member: Record<string, string> = {};

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

    async function seedRequest(
      org: string,
      kind: "comfort_kit_deploy" | "comfort_kit_replenish" | "supply",
      medicationOrderIds: string[],
      patientId = randomUUID(),
    ): Promise<{ id: string; patientId: string }> {
      const data = {
        contents: medicationOrderIds.map((medicationOrderId) => ({ medicationOrderId })),
      };
      const { rows } = await admin.query(
        `INSERT INTO supply_request
         (organization_id, patient_id, admission_id, location_id, provider_entity_id,
          requested_by_membership_id, kind, data, status, source_replenishment_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::m21_supply_request_kind,$8,'requested',
               CASE WHEN $7 = 'comfort_kit_replenish' THEN gen_random_uuid() END) RETURNING id`,
        [
          org,
          patientId,
          randomUUID(),
          location[org],
          provider[org],
          member[org],
          kind,
          JSON.stringify(data),
        ],
      );
      return { id: rows[0].id as string, patientId };
    }

    /** Emit through the REAL catalog-validating publisher, then read the persisted row back as the event. */
    async function emit(
      org: string,
      payload: Record<string, unknown>,
      orderId: string,
    ): Promise<DispatchableOutboxEvent> {
      await withOrgContext(handle.db, { organizationId: org, userId: "" }, async (tx) => {
        await publisher.publish(
          tx as never,
          {
            eventName: EVENT,
            organizationId: org,
            aggregateKind: "medication_order",
            aggregateId: orderId,
            payload,
            callerModule: "m12",
          } as never,
        );
      });
      const { rows } = await admin.query(
        "SELECT id, payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2 ORDER BY created_at DESC LIMIT 1",
        [EVENT, orderId],
      );
      return {
        id: rows[0].id as string,
        organizationId: org,
        eventType: EVENT,
        aggregateKind: "medication_order",
        aggregateId: orderId,
        payload: rows[0].payload,
        attemptCount: 1,
        createdAt: new Date(),
      };
    }

    const factsFor = async (eventId: string) =>
      (
        await admin.query(
          "SELECT * FROM supply_request_pharmacy_dispense WHERE source_event_id=$1 ORDER BY created_at",
          [eventId],
        )
      ).rows as Array<Record<string, unknown>>;

    const DISPENSED_AT = "2026-09-29T15:30:00.000Z";
    const basePayload = (orderId: string, extra: Record<string, unknown> = {}) => ({
      orderId,
      dosespotPrescriptionId: "rx-1",
      dispensedAt: DISPENSED_AT,
      ...extra,
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
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f233@x.test')`, [USER]);
      for (const org of [ORG_A, ORG_B]) {
        provider[org] = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,'Hospice',$3,'\\x00','12-31') RETURNING id`,
            [org, `CCN-${org.slice(0, 2)}`, `NPI-${org.slice(0, 2)}`],
          )
        ).rows[0].id as string;
        location[org] = (
          await admin.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
            [provider[org]],
          )
        ).rows[0].id as string;
        member[org] = (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
            [USER, org],
          )
        ).rows[0].id as string;
      }
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M12_OUTBOX_EVENTS]));
      consumer = buildM21PharmacyDispenseConsumer({ db: handle.db });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("records 'dispensed at T' on the correlated request and creates NO dispatch / changes no status", async () => {
      const orderId = randomUUID();
      const pharmacy = randomUUID();
      const req = await seedRequest(ORG_A, "comfort_kit_deploy", [randomUUID(), orderId]);
      const ev = await emit(
        ORG_A,
        basePayload(orderId, { dispensingPharmacyMdmId: pharmacy, fillNumber: 2 }),
        orderId,
      );

      await consumer.handle(ev);

      const facts = await factsFor(ev.id);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        organization_id: ORG_A,
        outcome: "recorded",
        supply_request_id: req.id,
        patient_id: req.patientId,
        medication_order_id: orderId,
        dosespot_prescription_id: "rx-1",
        fill_number: 2,
        dispensing_pharmacy_mdm_id: pharmacy,
        source: "dosespot",
        outcome_reason: null,
      });
      expect(new Date(facts[0]?.dispensed_at as string).toISOString()).toBe(DISPENSED_AT);

      const dispatches = await admin.query(
        "SELECT count(*)::int AS n FROM comfort_kit_dispatch WHERE supply_request_id=$1",
        [req.id],
      );
      expect(dispatches.rows[0].n).toBe(0);
      const status = await admin.query("SELECT status FROM supply_request WHERE id=$1", [req.id]);
      expect(status.rows[0].status).toBe("requested");
      const audit = await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='supply_request_pharmacy_dispense' AND event_type='supply_request_pharmacy_dispense.insert'",
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("is idempotent on the outbox event id — a redelivery writes no second row", async () => {
      const orderId = randomUUID();
      await seedRequest(ORG_A, "comfort_kit_replenish", [orderId]);
      const ev = await emit(ORG_A, basePayload(orderId), orderId);
      await consumer.handle(ev);
      await consumer.handle(ev);
      expect(await factsFor(ev.id)).toHaveLength(1);
    });

    it("a distinct event (another fill) for the same request is a distinct fact", async () => {
      const orderId = randomUUID();
      await seedRequest(ORG_A, "comfort_kit_deploy", [orderId]);
      const e1 = await emit(ORG_A, basePayload(orderId, { fillNumber: 1 }), orderId);
      const e2 = await emit(ORG_A, basePayload(orderId, { fillNumber: 2 }), orderId);
      await consumer.handle(e1);
      await consumer.handle(e2);
      expect(await factsFor(e1.id)).toHaveLength(1);
      expect(await factsFor(e2.id)).toHaveLength(1);
    });

    it("every request naming the order gets its own fact (deploy + replenish)", async () => {
      const orderId = randomUUID();
      const a = await seedRequest(ORG_A, "comfort_kit_deploy", [orderId]);
      const b = await seedRequest(ORG_A, "comfort_kit_replenish", [orderId]);
      const ev = await emit(ORG_A, basePayload(orderId), orderId);
      await consumer.handle(ev);
      const facts = await factsFor(ev.id);
      expect(facts.map((f) => f.supply_request_id).sort()).toEqual([a.id, b.id].sort());
      await consumer.handle(ev);
      expect(await factsFor(ev.id)).toHaveLength(2);
    });

    it("settles an uncorrelated event with a recorded reason (no request names the order); redelivery is a no-op", async () => {
      const orderId = randomUUID();
      // a non-comfort-kit kind naming the same id must NOT correlate
      await seedRequest(ORG_A, "supply", [orderId]);
      const ev = await emit(ORG_A, basePayload(orderId), orderId);
      await consumer.handle(ev);
      await consumer.handle(ev);
      const facts = await factsFor(ev.id);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        outcome: "no_correlating_request",
        supply_request_id: null,
        patient_id: null,
        outcome_reason: NO_CORRELATING_REQUEST_REASON,
        medication_order_id: orderId,
      });
    });

    it("a request with no contents[].medicationOrderId (IPU floor stock) is not matched", async () => {
      const orderId = randomUUID();
      await seedRequest(ORG_A, "comfort_kit_deploy", []);
      const ev = await emit(ORG_A, basePayload(orderId), orderId);
      await consumer.handle(ev);
      expect((await factsFor(ev.id))[0]?.outcome).toBe("no_correlating_request");
    });

    it("does not correlate across tenants, and RLS hides the other tenant's facts from wardenx_app", async () => {
      const orderId = randomUUID();
      const reqB = await seedRequest(ORG_B, "comfort_kit_deploy", [orderId]);
      const evA = await emit(ORG_A, basePayload(orderId), orderId);
      await consumer.handle(evA);
      expect((await factsFor(evA.id))[0]?.outcome).toBe("no_correlating_request");

      const evB = await emit(ORG_B, basePayload(orderId), orderId);
      await consumer.handle(evB);
      expect((await factsFor(evB.id))[0]).toMatchObject({
        outcome: "recorded",
        supply_request_id: reqB.id,
      });

      const seenByA = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        tx.execute(sql`SELECT source_event_id FROM supply_request_pharmacy_dispense`),
      );
      const idsA =
        (seenByA as unknown as { rows?: Array<{ source_event_id: string }> }).rows ??
        (seenByA as never as Array<{ source_event_id: string }>);
      expect(idsA.some((r) => r.source_event_id === evB.id)).toBe(false);
      expect(idsA.some((r) => r.source_event_id === evA.id)).toBe(true);
    });

    it("wardenx_app cannot UPDATE or DELETE a fact (append-only)", async () => {
      const orderId = randomUUID();
      await seedRequest(ORG_A, "comfort_kit_deploy", [orderId]);
      const ev = await emit(ORG_A, basePayload(orderId), orderId);
      await consumer.handle(ev);
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          tx.execute(sql`UPDATE supply_request_pharmacy_dispense SET fill_number = 9`),
        ),
      ).rejects.toThrow();
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          tx.execute(sql`DELETE FROM supply_request_pharmacy_dispense`),
        ),
      ).rejects.toThrow();
    });

    it("the real publisher rejects a payload the consumer would be unable to read (no orderId)", async () => {
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) => {
          await publisher.publish(
            tx as never,
            {
              eventName: EVENT,
              organizationId: ORG_A,
              aggregateKind: "medication_order",
              aggregateId: randomUUID(),
              payload: { dosespotPrescriptionId: "x", dispensedAt: DISPENSED_AT },
              callerModule: "m12",
            } as never,
          );
        }),
      ).rejects.toThrow();
    });
  },
);
