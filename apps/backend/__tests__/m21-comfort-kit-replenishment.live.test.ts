/**
 * F-1xx (#248) — LIVE Postgres proof that M21's third `m13-comfort-kit.ts` binding,
 * `buildM21ComfortKitReplenishmentIntakeConsumer` (`outbox-consumers/m13-comfort-kit-replenishment.ts`),
 * writes a real `comfort_kit_replenish` supply_request under RLS.
 *
 * `decideReplenishmentIntake` (§2.1) has been complete, exported and unit-tested since M21-T04;
 * `m13-comfort-kit-cascade.ts`'s own header explains why it was not bound alongside `.deployed`/
 * `.return_required`: it needs the same shared creation path `write-service-drizzle.ts`'s `createDirect`
 * seam calls, which was closure-scoped until `insertSupplyRequest` was hoisted to module scope (this pass).
 *
 * The wire shape mismatch is the point of half these cases: `decideReplenishmentIntake`'s own
 * `ReplenishmentRequestDraft` is a decision-level record, not `ComfortKitReplenishRequestDataSchema` — the
 * consumer resolves the missing pharmacy identity from the ORIGINAL `comfort_kit_dispatched_content` line
 * and the missing `deliveryAddress` from the dispatch's ORIGINATING `supply_request.data`, and refuses
 * (dead-letters) rather than fabricate either when they are not there to find.
 *
 * Nothing on the M13 side emits this event yet (M13 has no comfort-kit consumer/producer directory bound
 * for its own outbound side either), so this drives the consumer directly with a synthetic
 * `DispatchableOutboxEvent`, the same style `m21-comfort-kit-cascade.live.test.ts` already uses.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m21:comfort-kit-replenishment:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import { buildM21ComfortKitReplenishmentIntakeConsumer } from "../src/modules/21-supplies/outbox-consumers/m13-comfort-kit-replenishment";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

const DELIVERY_ADDRESS = {
  line1: "1 Hospice Way",
  city: "Portland",
  state: "OR",
  postalCode: "97201",
  capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
};

describe.skipIf(!DB_URL)(
  "F-1xx — M21's m13-comfort-kit-replenishment consumer (§2.1 intake) — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA: string;
    let providerB: string;
    let locationA: string;
    let locationB: string;
    let memberA: string;
    let templateA: string;
    let templateMedA: string;
    let consumer: ReturnType<typeof buildM21ComfortKitReplenishmentIntakeConsumer>;

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

    /** Seed the ORIGINATING `comfort_kit_deploy` request a dispatch always comes from. */
    async function seedOriginalRequest(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      patientId: string;
      admissionId: string;
      withAddress: boolean;
    }): Promise<string> {
      const data = opts.withAddress
        ? {
            comfortKitTemplateId: templateA,
            deploymentSite: "home",
            deliveryAddress: DELIVERY_ADDRESS,
            pharmacyDispatchMode: "supply_hub_dispatch",
            contents: [],
          }
        : {
            comfortKitTemplateId: templateA,
            deploymentSite: "ipu_room",
            ipuRoomId: randomUUID(),
            pharmacyDispatchMode: "supply_hub_dispatch",
            contents: [],
          };
      const { rows } = await admin.query(
        `INSERT INTO supply_request
           (organization_id, patient_id, admission_id, location_id, provider_entity_id,
            requested_by_membership_id, kind, data, status)
         VALUES ($1,$2,$3,$4,$5,$6,'comfort_kit_deploy',$7,'requested')
         RETURNING id`,
        [
          opts.organizationId,
          opts.patientId,
          opts.admissionId,
          opts.locationId,
          opts.providerEntityId,
          memberA,
          JSON.stringify(data),
        ],
      );
      return rows[0].id as string;
    }

    async function seedLinkedDispatch(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      patientId: string;
      admissionId: string;
      supplyRequestId: string;
      m13DeploymentId: string;
    }): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO comfort_kit_dispatch
           (supply_request_id, organization_id, patient_id, admission_id, location_id,
            provider_entity_id, comfort_kit_template_id, deployment_site, dispatch_status,
            pharmacy_dispatch_mode, dispatch_source, kit_serial_number, dispatched_by_membership_id,
            deployed_at_patient_at, deployed_by_membership_id, m13_deployment_id,
            controlled_substance_handling_policy_digest, dispatched_contents_jsonb)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'home','deployed_at_patient','supply_hub_dispatch','supply_hub',
                 $8,$9,now(),$9,$10,'digest','[]'::jsonb)
         RETURNING id`,
        [
          opts.supplyRequestId,
          opts.organizationId,
          opts.patientId,
          opts.admissionId,
          opts.locationId,
          opts.providerEntityId,
          templateA,
          `KIT-${randomUUID().slice(0, 8)}`,
          memberA,
          opts.m13DeploymentId,
        ],
      );
      return rows[0].id as string;
    }

    async function seedDispatchedLine(opts: {
      dispatchId: string;
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      medicationOrderId: string;
    }): Promise<void> {
      await admin.query(
        `INSERT INTO comfort_kit_dispatched_content
           (dispatch_id, dispatch_partition_dispatched_at, organization_id, provider_entity_id,
            location_id, comfort_kit_template_medication_id, medication_order_id, rxnorm, ndc, drug_name,
            strength, dosage_form, route_of_administration, is_controlled_substance,
            controlled_substance_schedule, dispatched_quantity, dispatched_unit, lot_number,
            expiration_date)
         SELECT $1, dispatched_at, $2, $3, $4, $5, $6, 'RX-1', NULL, 'Saline Flush', '1mL',
                'solution', 'irrigation', false, NULL, 10, 'mL', NULL, NULL
         FROM comfort_kit_dispatch WHERE id = $1`,
        [
          opts.dispatchId,
          opts.organizationId,
          opts.providerEntityId,
          opts.locationId,
          templateMedA,
          opts.medicationOrderId,
        ],
      );
    }

    async function replenishRequestsFor(deploymentId: string, organizationId: string) {
      const { rows } = await admin.query(
        `SELECT id, status, source_replenishment_event_id, data
           FROM supply_request
          WHERE organization_id = $1 AND kind = 'comfort_kit_replenish'
            AND data->>'sourceDeploymentId' = $2`,
        [organizationId, deploymentId],
      );
      return rows as Array<{
        id: string;
        status: string;
        source_replenishment_event_id: string | null;
        data: Record<string, unknown>;
      }>;
    }

    function replenishmentEvent(
      id: string,
      organizationId: string,
      payload: {
        deploymentId: string;
        medicationOrderId: string;
        drugName: string;
        remainingQuantity: number;
        requestedQuantity: number;
        urgencyKind: string;
      },
    ): DispatchableOutboxEvent {
      return {
        id,
        organizationId,
        eventType: "m13.comfort_kit.replenishment_needed",
        aggregateKind: "comfort_kit_deployment",
        aggregateId: payload.deploymentId,
        payload,
        attemptCount: 1,
        createdAt: new Date(),
      };
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
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f1xxreplenish@x.test')`, [USER]);
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,'CCN-A','Hospice A','NPI-A','\\x00','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,'CCN-B','Hospice B','NPI-B','\\x00','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      locationA = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc A','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerA],
        )
      ).rows[0].id as string;
      locationB = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc B','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerB],
        )
      ).rows[0].id as string;
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
      templateMedA = (
        await admin.query(
          `INSERT INTO comfort_kit_template_medication
             (template_id, organization_id, is_platform_floor, rxnorm, drug_name, strength, dosage_form,
              route_of_administration, is_controlled_substance, controlled_substance_schedule,
              expected_quantity, expected_unit, replenishment_threshold_pct)
           VALUES ($1,$2,false,'RX-1','Saline Flush','1mL','solution','irrigation',false,NULL,10,'mL',0.25)
           RETURNING id`,
          [templateA, ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = buildBootOutboxCatalog([M21_OUTBOX_EVENTS]);
      const publisher = buildTxOutboxPublisher(catalog);
      const outbox = {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m21" } as never),
      };

      consumer = buildM21ComfortKitReplenishmentIntakeConsumer({
        db: handle.db,
        outbox: outbox as never,
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("opens a comfort_kit_replenish request carrying the reused address + resolved pharmacy identity", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const deploymentId = randomUUID();
      const medicationOrderId = randomUUID();
      const originalRequestId = await seedOriginalRequest({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        withAddress: true,
      });
      const dispatchId = await seedLinkedDispatch({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        supplyRequestId: originalRequestId,
        m13DeploymentId: deploymentId,
      });
      await seedDispatchedLine({
        dispatchId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        medicationOrderId,
      });

      const eventId = randomUUID();
      await consumer.handle(
        replenishmentEvent(eventId, ORG_A, {
          deploymentId,
          medicationOrderId,
          drugName: "Saline Flush",
          remainingQuantity: 2,
          requestedQuantity: 10,
          urgencyKind: "routine",
        }),
      );

      const rows = await replenishRequestsFor(deploymentId, ORG_A);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe("requested");
      expect(row.source_replenishment_event_id).toBe(eventId);
      expect(row.data.deliveryAddress).toMatchObject({ line1: DELIVERY_ADDRESS.line1 });
      expect(row.data.urgencyKind).toBe("routine");
      const contents = row.data.contents as Array<Record<string, unknown>>;
      expect(contents).toHaveLength(1);
      expect(contents[0]).toMatchObject({
        medicationOrderId,
        rxNorm: "RX-1",
        drugName: "Saline Flush",
        expectedQuantity: 10,
        expectedUnit: "mL",
        isControlledSubstance: false,
      });
    });

    it("does not emit created_from_external — a system cascade is not a coordinator's direct entry", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const deploymentId = randomUUID();
      const medicationOrderId = randomUUID();
      const originalRequestId = await seedOriginalRequest({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        withAddress: true,
      });
      const dispatchId = await seedLinkedDispatch({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        supplyRequestId: originalRequestId,
        m13DeploymentId: deploymentId,
      });
      await seedDispatchedLine({
        dispatchId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        medicationOrderId,
      });

      await consumer.handle(
        replenishmentEvent(randomUUID(), ORG_A, {
          deploymentId,
          medicationOrderId,
          drugName: "Saline Flush",
          remainingQuantity: 2,
          requestedQuantity: 10,
          urgencyKind: "urgent",
        }),
      );

      const rows = await replenishRequestsFor(deploymentId, ORG_A);
      const requestId = rows[0]!.id;
      const { rows: outboxRows } = await admin.query(
        "SELECT event_type FROM outbox_event WHERE aggregate_id = $1",
        [requestId],
      );
      const eventTypes = outboxRows.map((r: { event_type: string }) => r.event_type);
      expect(eventTypes).toContain("m21.supply_request.status_changed");
      expect(eventTypes).not.toContain("m21.supply_request.created_from_external");
    });

    it("is idempotent on redelivery — the same outbox event id opens no second request", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const deploymentId = randomUUID();
      const medicationOrderId = randomUUID();
      const originalRequestId = await seedOriginalRequest({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        withAddress: true,
      });
      const dispatchId = await seedLinkedDispatch({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        supplyRequestId: originalRequestId,
        m13DeploymentId: deploymentId,
      });
      await seedDispatchedLine({
        dispatchId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        medicationOrderId,
      });
      const event = replenishmentEvent(randomUUID(), ORG_A, {
        deploymentId,
        medicationOrderId,
        drugName: "Saline Flush",
        remainingQuantity: 2,
        requestedQuantity: 10,
        urgencyKind: "routine",
      });

      await consumer.handle(event);
      await consumer.handle(event);

      const rows = await replenishRequestsFor(deploymentId, ORG_A);
      expect(rows).toHaveLength(1);
    });

    it("does not stack a second open request for the same dispatch + medication (already_pending)", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const deploymentId = randomUUID();
      const medicationOrderId = randomUUID();
      const originalRequestId = await seedOriginalRequest({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        withAddress: true,
      });
      const dispatchId = await seedLinkedDispatch({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        supplyRequestId: originalRequestId,
        m13DeploymentId: deploymentId,
      });
      await seedDispatchedLine({
        dispatchId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        medicationOrderId,
      });

      // Two DIFFERENT outbox deliveries (M13's own retry cadence re-fires this on every subsequent
      // administration until the kit is topped up) for the SAME dispatch + medication.
      await consumer.handle(
        replenishmentEvent(randomUUID(), ORG_A, {
          deploymentId,
          medicationOrderId,
          drugName: "Saline Flush",
          remainingQuantity: 2,
          requestedQuantity: 10,
          urgencyKind: "routine",
        }),
      );
      await consumer.handle(
        replenishmentEvent(randomUUID(), ORG_A, {
          deploymentId,
          medicationOrderId,
          drugName: "Saline Flush",
          remainingQuantity: 1,
          requestedQuantity: 10,
          urgencyKind: "urgent",
        }),
      );

      const rows = await replenishRequestsFor(deploymentId, ORG_A);
      expect(rows).toHaveLength(1);
    });

    it("dead-letters (throws) when the deploymentId maps to no dispatch", async () => {
      await expect(
        consumer.handle(
          replenishmentEvent(randomUUID(), ORG_A, {
            deploymentId: randomUUID(),
            medicationOrderId: randomUUID(),
            drugName: "Morphine Sulfate",
            remainingQuantity: 1,
            requestedQuantity: 30,
            urgencyKind: "urgent",
          }),
        ),
      ).rejects.toThrow(/no comfort_kit_dispatch is linked to M13 deployment/);
    });

    it("dead-letters (throws) when the dispatch has no DISPATCHED line for the named medication", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const deploymentId = randomUUID();
      const originalRequestId = await seedOriginalRequest({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        withAddress: true,
      });
      await seedLinkedDispatch({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        supplyRequestId: originalRequestId,
        m13DeploymentId: deploymentId,
      });
      // No comfort_kit_dispatched_content row inserted — the dispatch has no line for this medication.

      await expect(
        consumer.handle(
          replenishmentEvent(randomUUID(), ORG_A, {
            deploymentId,
            medicationOrderId: randomUUID(),
            drugName: "Saline Flush",
            remainingQuantity: 2,
            requestedQuantity: 10,
            urgencyKind: "routine",
          }),
        ),
      ).rejects.toThrow(/no dispatched line for medication/);
    });

    it("dead-letters (throws) rather than fabricate an address for an IPU-room deployment with none", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const deploymentId = randomUUID();
      const medicationOrderId = randomUUID();
      const originalRequestId = await seedOriginalRequest({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        withAddress: false, // ipu_room deploy — no deliveryAddress snapshot to reuse
      });
      const dispatchId = await seedLinkedDispatch({
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId,
        admissionId,
        supplyRequestId: originalRequestId,
        m13DeploymentId: deploymentId,
      });
      await seedDispatchedLine({
        dispatchId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        medicationOrderId,
      });

      await expect(
        consumer.handle(
          replenishmentEvent(randomUUID(), ORG_A, {
            deploymentId,
            medicationOrderId,
            drugName: "Saline Flush",
            remainingQuantity: 2,
            requestedQuantity: 10,
            urgencyKind: "routine",
          }),
        ),
      ).rejects.toThrow(/carries no deliveryAddress snapshot/);
    });

    it("does not resolve a dispatch across tenants — org B's deploymentId is invisible to org A's RLS scope", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const deploymentId = randomUUID();
      // Seed under org B directly (bypassing RLS via the admin connection); the consumer opens its own
      // org-A-scoped transaction and must not see it.
      const { rows: reqRows } = await admin.query(
        `INSERT INTO supply_request
           (organization_id, patient_id, admission_id, location_id, provider_entity_id,
            requested_by_membership_id, kind, data, status)
         VALUES ($1,$2,$3,$4,$5,$6,'comfort_kit_deploy',$7,'requested') RETURNING id`,
        [
          ORG_B,
          patientId,
          admissionId,
          locationB,
          providerB,
          memberA,
          JSON.stringify({
            comfortKitTemplateId: templateA,
            deploymentSite: "home",
            deliveryAddress: DELIVERY_ADDRESS,
            pharmacyDispatchMode: "supply_hub_dispatch",
            contents: [],
          }),
        ],
      );
      await admin.query(
        `INSERT INTO comfort_kit_dispatch
           (supply_request_id, organization_id, patient_id, admission_id, location_id,
            provider_entity_id, comfort_kit_template_id, deployment_site, dispatch_status,
            pharmacy_dispatch_mode, dispatch_source, kit_serial_number, dispatched_by_membership_id,
            deployed_at_patient_at, deployed_by_membership_id, m13_deployment_id,
            controlled_substance_handling_policy_digest, dispatched_contents_jsonb)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'home','deployed_at_patient','supply_hub_dispatch','supply_hub','KIT-B',
                 $8,now(),$8,$9,'digest','[]'::jsonb)`,
        [
          reqRows[0].id,
          ORG_B,
          patientId,
          admissionId,
          locationB,
          providerB,
          templateA,
          memberA,
          deploymentId,
        ],
      );

      await expect(
        consumer.handle(
          replenishmentEvent(randomUUID(), ORG_A, {
            deploymentId,
            medicationOrderId: randomUUID(),
            drugName: "Saline Flush",
            remainingQuantity: 2,
            requestedQuantity: 10,
            urgencyKind: "routine",
          }),
        ),
      ).rejects.toThrow(/no comfort_kit_dispatch is linked to M13 deployment/);
    });
  },
);
