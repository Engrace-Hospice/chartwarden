/**
 * F-15x/F-172 (#248) — LIVE Postgres proof that M21's three comfort-kit consumer bindings write real rows
 * under RLS:
 *
 *   - `buildM21ComfortKitDeploymentAckConsumer` (`outbox-consumers/m13-comfort-kit-cascade.ts`) — the
 *     §2.5 `m13.comfort_kit.deployed` ack: links `comfort_kit_dispatch.m13_deployment_id` to the M13
 *     deployment that was built off M21's own `deployed_at_patient` emission.
 *   - `buildM21ComfortKitReturnRequiredConsumer` — the §2.6 `m13.comfort_kit.return_required` cascade:
 *     opens the chain-of-custody `comfort_kit_return` obligation.
 *   - `buildM21ComfortKitControlledSubstanceReemitConsumer` (F-172) — the §4.5.1
 *     `m13.comfort_kit.controlled_substance_discrepancy` re-emit: joins M13's bedside delta to M21's
 *     dispatch/return custody chain and re-publishes as `m21.controlled_substance.discrepancy_detected`
 *     with `detectionSource: "m13_reemit"`.
 *
 * The first two deciders (`decideDeploymentAck`, `decideReturnRequired`, `consumers/m13-comfort-kit.ts`)
 * have been complete, exported and unit-tested since M21-T04 and named on M21's own
 * `M21_SUBSCRIBED_EVENT_NAMES`; none of the three had a live `OutboxConsumerBinding` before F-153/F-172.
 * M13's own comfort-kit consumer directory exists (F-166) but this file still drives all three M21
 * consumers directly with a synthetic `DispatchableOutboxEvent` for isolation, the same style
 * `m11-m9-m21-outbox-consumers.live.test.ts` uses.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m21:comfort-kit-cascade:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  M21_OUTBOX_EVENTS,
  buildM21ComfortKitControlledSubstanceReemitConsumer,
  buildM21ComfortKitDeploymentAckConsumer,
  buildM21ComfortKitReturnRequiredConsumer,
} from "../src/modules/21-supplies/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)(
  "F-15x — M21's m13-comfort-kit-cascade consumers (deployment ack / return required) — LIVE Postgres",
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
    let templateMedControlledA: string;
    let ackConsumer: ReturnType<typeof buildM21ComfortKitDeploymentAckConsumer>;
    let returnConsumer: ReturnType<typeof buildM21ComfortKitReturnRequiredConsumer>;
    let reemitConsumer: ReturnType<typeof buildM21ComfortKitControlledSubstanceReemitConsumer>;

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

    async function seedDispatch(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      patientId: string;
      admissionId: string;
      dispatchStatus: string;
      deployedAtPatientAt: Date | null;
      m13DeploymentId: string | null;
      controlled: boolean;
    }): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO comfort_kit_dispatch
           (supply_request_id, organization_id, patient_id, admission_id, location_id,
            provider_entity_id, comfort_kit_template_id, deployment_site, dispatch_status,
            pharmacy_dispatch_mode, dispatch_source, kit_serial_number, dispatched_by_membership_id,
            deployed_at_patient_at, deployed_by_membership_id, m13_deployment_id,
            controlled_substance_handling_policy_digest, dispatched_contents_jsonb)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'home',$7,'supply_hub_dispatch','supply_hub',
                 $8,$9,$10,$11,$12,'digest','[]'::jsonb)
         RETURNING id`,
        [
          opts.organizationId,
          opts.patientId,
          opts.admissionId,
          opts.locationId,
          opts.providerEntityId,
          templateA,
          opts.dispatchStatus,
          `KIT-${randomUUID().slice(0, 8)}`,
          memberA,
          opts.deployedAtPatientAt,
          opts.deployedAtPatientAt ? memberA : null,
          opts.m13DeploymentId,
        ],
      );
      const dispatchId = rows[0].id as string;
      await admin.query(
        `INSERT INTO comfort_kit_dispatched_content
           (dispatch_id, dispatch_partition_dispatched_at, organization_id, provider_entity_id,
            location_id, comfort_kit_template_medication_id, medication_order_id, rxnorm, drug_name,
            strength, dosage_form, route_of_administration, is_controlled_substance,
            controlled_substance_schedule, dispatched_quantity, dispatched_unit, lot_number,
            expiration_date)
         SELECT $1, dispatched_at, $2, $3, $4, $5, gen_random_uuid(), 'RX-1', 'Saline Flush', '1mL',
                'solution', 'irrigation', false, NULL, 10, 'mL', NULL, NULL
         FROM comfort_kit_dispatch WHERE id = $1`,
        [dispatchId, opts.organizationId, opts.providerEntityId, opts.locationId, templateMedA],
      );
      if (opts.controlled) {
        await admin.query(
          `INSERT INTO comfort_kit_dispatched_content
             (dispatch_id, dispatch_partition_dispatched_at, organization_id, provider_entity_id,
              location_id, comfort_kit_template_medication_id, medication_order_id, rxnorm, drug_name,
              strength, dosage_form, route_of_administration, is_controlled_substance,
              controlled_substance_schedule, dispatched_quantity, dispatched_unit, lot_number,
              expiration_date)
           SELECT $1, dispatched_at, $2, $3, $4, $5, gen_random_uuid(), '7052', 'Morphine Sulfate',
                  '20mg/mL', 'solution', 'sublingual', true, 'CII', 30, 'mL', 'LOT-1',
                  (CURRENT_DATE + INTERVAL '90 days')
           FROM comfort_kit_dispatch WHERE id = $1`,
          [dispatchId, opts.organizationId, opts.providerEntityId, opts.locationId, templateMedControlledA],
        );
      }
      return dispatchId;
    }

    async function dispatchRow(id: string) {
      const { rows } = await admin.query(
        "SELECT dispatch_status, m13_deployment_id, m13_deployment_link_resolved_at FROM comfort_kit_dispatch WHERE id=$1",
        [id],
      );
      return rows[0] as {
        dispatch_status: string;
        m13_deployment_id: string | null;
        m13_deployment_link_resolved_at: Date | null;
      };
    }

    async function returnRowsFor(dispatchId: string) {
      const { rows } = await admin.query(
        "SELECT id, state, m13_deployment_id, return_required_at, return_due_at FROM comfort_kit_return WHERE dispatch_id=$1",
        [dispatchId],
      );
      return rows as Array<{
        id: string;
        state: string;
        m13_deployment_id: string;
        return_required_at: Date;
        return_due_at: Date;
      }>;
    }

    // F-172 — a fully reconciled return with a discrepant controlled-substance line, plus the
    // `comfort_kit_return`/`comfort_kit_returned_content` rows the re-emit consumer resolves by
    // `returnId`. Distinct retriever/witness/reconciler membership ids so the CHECK constraint
    // (`m21_ckit_return_witness_distinct`) and the custody-chain assertion below can both be exact.
    async function seedControlledReturn(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      patientId: string;
      admissionId: string;
      m13DeploymentId: string;
      dispatchedByMembershipId: string;
      retrievingMembershipId: string | null;
      disposalWitnessMembershipId: string | null;
      reconciledByMembershipId: string;
    }): Promise<{ dispatchId: string; returnId: string; medicationOrderId: string }> {
      const medicationOrderId = randomUUID();
      const { rows: dispatchRows } = await admin.query(
        `INSERT INTO comfort_kit_dispatch
           (supply_request_id, organization_id, patient_id, admission_id, location_id,
            provider_entity_id, comfort_kit_template_id, deployment_site, dispatch_status,
            pharmacy_dispatch_mode, dispatch_source, kit_serial_number, dispatched_by_membership_id,
            deployed_at_patient_at, deployed_by_membership_id, m13_deployment_id,
            controlled_substance_handling_policy_digest, dispatched_contents_jsonb)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'home','deployed_at_patient',
                 'supply_hub_dispatch','supply_hub',$7,$8,now(),$8,$9,'digest','[]'::jsonb)
         RETURNING id, dispatched_at`,
        [
          opts.organizationId,
          opts.patientId,
          opts.admissionId,
          opts.locationId,
          opts.providerEntityId,
          templateA,
          `KIT-${randomUUID().slice(0, 8)}`,
          opts.dispatchedByMembershipId,
          opts.m13DeploymentId,
        ],
      );
      const dispatchId = dispatchRows[0].id as string;
      const dispatchedAt = dispatchRows[0].dispatched_at as Date;
      const { rows: contentRows } = await admin.query(
        `INSERT INTO comfort_kit_dispatched_content
           (dispatch_id, dispatch_partition_dispatched_at, organization_id, provider_entity_id,
            location_id, comfort_kit_template_medication_id, medication_order_id, rxnorm, drug_name,
            strength, dosage_form, route_of_administration, is_controlled_substance,
            controlled_substance_schedule, dispatched_quantity, dispatched_unit, lot_number,
            expiration_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'7052','Morphine Sulfate','20mg/mL','solution','sublingual',
                 true,'CII',20,'mL','LOT-172',(CURRENT_DATE + INTERVAL '90 days'))
         RETURNING id`,
        [
          dispatchId,
          dispatchedAt,
          opts.organizationId,
          opts.providerEntityId,
          opts.locationId,
          templateMedControlledA,
          medicationOrderId,
        ],
      );
      const dispatchedContentId = contentRows[0].id as string;
      const { rows: returnRows } = await admin.query(
        `INSERT INTO comfort_kit_return
           (dispatch_id, dispatch_partition_dispatched_at, m13_deployment_id, organization_id,
            patient_id, admission_id, provider_entity_id, location_id, return_required_at,
            return_due_at, assigned_retrieving_membership_id, disposal_method,
            disposal_witness_membership_id, reconciled_by_membership_id, reconciled_at, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now() + interval '2 days',$9,
                 'take_back_by_supply_team',$10,$11,now(),'reconciled')
         RETURNING id`,
        [
          dispatchId,
          dispatchedAt,
          opts.m13DeploymentId,
          opts.organizationId,
          opts.patientId,
          opts.admissionId,
          opts.providerEntityId,
          opts.locationId,
          opts.retrievingMembershipId,
          opts.disposalWitnessMembershipId,
          opts.reconciledByMembershipId,
        ],
      );
      const returnId = returnRows[0].id as string;
      await admin.query(
        `INSERT INTO comfort_kit_returned_content
           (return_id, dispatched_content_id, organization_id, provider_entity_id, location_id,
            quantity_returned, quantity_disposed_at_home, is_controlled_substance,
            controlled_substance_schedule)
         VALUES ($1,$2,$3,$4,$5,15,0,true,'CII')`,
        [returnId, dispatchedContentId, opts.organizationId, opts.providerEntityId, opts.locationId],
      );
      return { dispatchId, returnId, medicationOrderId };
    }

    async function discrepancyDetectedRows(returnId: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event
         WHERE event_type = 'm21.controlled_substance.discrepancy_detected' AND aggregate_id = $1
         ORDER BY created_at`,
        [returnId],
      );
      return rows as Array<{ payload: Record<string, unknown> }>;
    }

    function controlledDiscrepancyEvent(
      organizationId: string,
      payload: { deploymentId: string; medicationOrderId: string; returnId: string },
    ): DispatchableOutboxEvent {
      return {
        id: randomUUID(),
        organizationId,
        eventType: "m13.comfort_kit.controlled_substance_discrepancy",
        aggregateKind: "comfort_kit_deployment",
        aggregateId: payload.deploymentId,
        payload: { ...payload, deltaQuantity: 5, deltaPercent: 25 },
        attemptCount: 1,
        createdAt: new Date(),
      };
    }

    function ackEvent(payload: {
      deploymentId: string;
      patientId: string;
      admissionId: string;
    }): DispatchableOutboxEvent {
      return {
        id: randomUUID(),
        organizationId: ORG_A,
        eventType: "m13.comfort_kit.deployed",
        aggregateKind: "comfort_kit_deployment",
        aggregateId: payload.deploymentId,
        payload: { ...payload, contents: {} },
        attemptCount: 1,
        createdAt: new Date(),
      };
    }

    function returnRequiredEvent(
      organizationId: string,
      payload: { deploymentId: string; patientId: string; admissionId: string; returnRequiredAt: string },
    ): DispatchableOutboxEvent {
      return {
        id: randomUUID(),
        organizationId,
        eventType: "m13.comfort_kit.return_required",
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
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f15xckit@x.test')`, [USER]);
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
      templateMedControlledA = (
        await admin.query(
          `INSERT INTO comfort_kit_template_medication
             (template_id, organization_id, is_platform_floor, rxnorm, drug_name, strength, dosage_form,
              route_of_administration, is_controlled_substance, controlled_substance_schedule,
              expected_quantity, expected_unit, replenishment_threshold_pct)
           VALUES ($1,$2,false,'7052','Morphine Sulfate','20mg/mL','solution','sublingual',true,'CII',
                   30,'mL',0.25)
           RETURNING id`,
          [templateA, ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      ackConsumer = buildM21ComfortKitDeploymentAckConsumer({ db: handle.db });
      returnConsumer = buildM21ComfortKitReturnRequiredConsumer({ db: handle.db });

      // F-172 — the real catalog-validating publisher, mirroring the M13 live test's own pattern: any
      // payload the decider builds that disagrees with `M21_OUTBOX_EVENTS`' TypeBox schema is refused
      // here exactly as it would be at the real dispatcher.
      const m21Catalog = new Map<string, unknown>(M21_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      const m21Outbox = {
        async publish(
          tx: unknown,
          input: {
            eventName: string;
            organizationId: string;
            aggregateKind: string;
            aggregateId: string;
            payload: Record<string, unknown>;
          },
        ) {
          if (!m21Catalog.has(input.eventName)) {
            throw new Error(`m21 test publisher: undeclared event ${input.eventName}`);
          }
          const { sql } = await import("drizzle-orm");
          await (tx as typeof handle.db).execute(sql`
            INSERT INTO outbox_event
              (organization_id, event_type, aggregate_kind, aggregate_id, payload)
            VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                    ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
          `);
        },
      };
      reemitConsumer = buildM21ComfortKitControlledSubstanceReemitConsumer({
        db: handle.db,
        outbox: m21Outbox,
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    describe("deployment ack (§2.5)", () => {
      it("links the newest unlinked, deployed dispatch for the patient", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const dispatchId = await seedDispatch({
          organizationId: ORG_A,
          providerEntityId: providerA,
          locationId: locationA,
          patientId,
          admissionId,
          dispatchStatus: "deployed_at_patient",
          deployedAtPatientAt: new Date(),
          m13DeploymentId: null,
          controlled: false,
        });
        const deploymentId = randomUUID();

        await ackConsumer.handle(ackEvent({ deploymentId, patientId, admissionId }));

        const row = await dispatchRow(dispatchId);
        expect(row.m13_deployment_id).toBe(deploymentId);
        expect(row.m13_deployment_link_resolved_at).not.toBeNull();
      });

      it("is idempotent on redelivery — a second ack for an already-linked dispatch is a no-op", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const deploymentId = randomUUID();
        const dispatchId = await seedDispatch({
          organizationId: ORG_A,
          providerEntityId: providerA,
          locationId: locationA,
          patientId,
          admissionId,
          dispatchStatus: "deployed_at_patient",
          deployedAtPatientAt: new Date(),
          m13DeploymentId: null,
          controlled: false,
        });
        await ackConsumer.handle(ackEvent({ deploymentId, patientId, admissionId }));
        const first = await dispatchRow(dispatchId);

        await expect(
          ackConsumer.handle(ackEvent({ deploymentId, patientId, admissionId })),
        ).resolves.not.toThrow();

        const second = await dispatchRow(dispatchId);
        expect(second.m13_deployment_id).toBe(deploymentId);
        expect(second.m13_deployment_link_resolved_at?.getTime()).toBe(
          first.m13_deployment_link_resolved_at?.getTime(),
        );
      });

      it("is a silent no-op when no dispatch matches the (patient, admission)", async () => {
        const deploymentId = randomUUID();
        await expect(
          ackConsumer.handle(
            ackEvent({ deploymentId, patientId: randomUUID(), admissionId: randomUUID() }),
          ),
        ).resolves.not.toThrow();
      });
    });

    describe("return required (§2.6)", () => {
      it("opens a return obligation with the correct due-by window", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const deploymentId = randomUUID();
        const dispatchId = await seedDispatch({
          organizationId: ORG_A,
          providerEntityId: providerA,
          locationId: locationA,
          patientId,
          admissionId,
          dispatchStatus: "deployed_at_patient",
          deployedAtPatientAt: new Date(),
          m13DeploymentId: deploymentId,
          controlled: true,
        });
        const returnRequiredAt = new Date().toISOString();

        await returnConsumer.handle(
          returnRequiredEvent(ORG_A, { deploymentId, patientId, admissionId, returnRequiredAt }),
        );

        const rows = await returnRowsFor(dispatchId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.state).toBe("requested");
        expect(rows[0]?.m13_deployment_id).toBe(deploymentId);
        expect(rows[0]?.return_due_at.getTime()).toBeGreaterThan(rows[0]!.return_required_at.getTime());
      });

      it("is idempotent on redelivery — a second return-required for the same dispatch opens no second row", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const deploymentId = randomUUID();
        const dispatchId = await seedDispatch({
          organizationId: ORG_A,
          providerEntityId: providerA,
          locationId: locationA,
          patientId,
          admissionId,
          dispatchStatus: "deployed_at_patient",
          deployedAtPatientAt: new Date(),
          m13DeploymentId: deploymentId,
          controlled: false,
        });
        const returnRequiredAt = new Date().toISOString();
        const event = returnRequiredEvent(ORG_A, {
          deploymentId,
          patientId,
          admissionId,
          returnRequiredAt,
        });

        await returnConsumer.handle(event);
        await returnConsumer.handle(event);

        const rows = await returnRowsFor(dispatchId);
        expect(rows).toHaveLength(1);
      });

      it("dead-letters (throws) when the deploymentId maps to no dispatch — a wrong Location must not be guessed at", async () => {
        await expect(
          returnConsumer.handle(
            returnRequiredEvent(ORG_A, {
              deploymentId: randomUUID(),
              patientId: randomUUID(),
              admissionId: randomUUID(),
              returnRequiredAt: new Date().toISOString(),
            }),
          ),
        ).rejects.toThrow(/no comfort_kit_dispatch is linked to M13 deployment/);
      });

      it("does not resolve a dispatch across tenants — org B's deploymentId is invisible to org A's RLS scope", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const deploymentId = randomUUID();
        // Seed the dispatch under org B directly (bypassing RLS via the admin connection) so the fixture
        // exists; the consumer opens its own org-A-scoped transaction and must not see it.
        await admin.query(
          `INSERT INTO comfort_kit_dispatch
             (supply_request_id, organization_id, patient_id, admission_id, location_id,
              provider_entity_id, comfort_kit_template_id, deployment_site, dispatch_status,
              pharmacy_dispatch_mode, dispatch_source, kit_serial_number, dispatched_by_membership_id,
              deployed_at_patient_at, deployed_by_membership_id, m13_deployment_id,
              controlled_substance_handling_policy_digest, dispatched_contents_jsonb)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,
                   $5,$6,'home','deployed_at_patient','supply_hub_dispatch','supply_hub','KIT-B',$7,
                   now(),$7,$8,'digest','[]'::jsonb)`,
          [ORG_B, patientId, admissionId, locationB, providerB, templateA, memberA, deploymentId],
        );

        await expect(
          returnConsumer.handle(
            returnRequiredEvent(ORG_A, {
              deploymentId,
              patientId,
              admissionId,
              returnRequiredAt: new Date().toISOString(),
            }),
          ),
        ).rejects.toThrow(/no comfort_kit_dispatch is linked to M13 deployment/);
      });
    });

    describe("controlled-substance re-emit (§4.5.1, F-172)", () => {
      it("re-emits with the real returned-content row and the full custody chain", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const deploymentId = randomUUID();
        const retriever = randomUUID();
        const witness = randomUUID();
        const reconciler = randomUUID();
        const { returnId, medicationOrderId } = await seedControlledReturn({
          organizationId: ORG_A,
          providerEntityId: providerA,
          locationId: locationA,
          patientId,
          admissionId,
          m13DeploymentId: deploymentId,
          dispatchedByMembershipId: memberA,
          retrievingMembershipId: retriever,
          disposalWitnessMembershipId: witness,
          reconciledByMembershipId: reconciler,
        });

        await reemitConsumer.handle(
          controlledDiscrepancyEvent(ORG_A, { deploymentId, medicationOrderId, returnId }),
        );

        const rows = await discrepancyDetectedRows(returnId);
        expect(rows).toHaveLength(1);
        const payload = rows[0]!.payload;
        expect(payload.returnId).toBe(returnId);
        expect(payload.detectionSource).toBe("m13_reemit");
        expect(payload.patientId).toBe(patientId);
        expect(payload.admissionId).toBe(admissionId);
        const discrepantMedications = payload.discrepantMedications as Array<Record<string, unknown>>;
        expect(discrepantMedications).toHaveLength(1);
        expect(discrepantMedications[0]!.medicationOrderId).toBe(medicationOrderId);
        expect(discrepantMedications[0]!.lotNumber).toBe("LOT-172");
        expect(discrepantMedications[0]!.controlledSubstanceSchedule).toBe("CII");
        // A real, non-empty id from `comfort_kit_returned_content` — not the empty-string placeholder
        // `write-service-drizzle.ts`'s own `reconcileReturn` path carries (a separate, pre-existing,
        // unrelated defect — see the file header/report).
        expect(typeof discrepantMedications[0]!.returnedContentId).toBe("string");
        expect((discrepantMedications[0]!.returnedContentId as string).length).toBeGreaterThan(0);
        expect(payload.custodyChain).toEqual({
          dispatchedByMembershipId: memberA,
          retrievingMembershipId: retriever,
          disposalWitnessMembershipId: witness,
          reconciledByMembershipId: reconciler,
        });
      });

      it("tolerates a return with no retriever/witness recorded — both stay honestly null", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const deploymentId = randomUUID();
        const reconciler = randomUUID();
        const { returnId, medicationOrderId } = await seedControlledReturn({
          organizationId: ORG_A,
          providerEntityId: providerA,
          locationId: locationA,
          patientId,
          admissionId,
          m13DeploymentId: deploymentId,
          dispatchedByMembershipId: memberA,
          retrievingMembershipId: null,
          disposalWitnessMembershipId: null,
          reconciledByMembershipId: reconciler,
        });

        await reemitConsumer.handle(
          controlledDiscrepancyEvent(ORG_A, { deploymentId, medicationOrderId, returnId }),
        );

        const rows = await discrepancyDetectedRows(returnId);
        expect(rows).toHaveLength(1);
        const custodyChain = rows[0]!.payload.custodyChain as Record<string, unknown>;
        expect(custodyChain.retrievingMembershipId).toBeNull();
        expect(custodyChain.disposalWitnessMembershipId).toBeNull();
        expect(custodyChain.reconciledByMembershipId).toBe(reconciler);
      });

      it("is a silent no-op when the deploymentId maps to no dispatch", async () => {
        await expect(
          reemitConsumer.handle(
            controlledDiscrepancyEvent(ORG_A, {
              deploymentId: randomUUID(),
              medicationOrderId: randomUUID(),
              returnId: randomUUID(),
            }),
          ),
        ).resolves.not.toThrow();
      });

      it("is a silent no-op when the returnId names no comfort_kit_return row (never fabricates a returnedContentId)", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const deploymentId = randomUUID();
        // A dispatch exists (so `dispatch` resolves), but the event below names a DIFFERENT (unseeded)
        // returnId — no `comfort_kit_return`/`comfort_kit_returned_content` row for THAT id exists.
        const { medicationOrderId } = await seedControlledReturn({
          organizationId: ORG_A,
          providerEntityId: providerA,
          locationId: locationA,
          patientId,
          admissionId,
          m13DeploymentId: deploymentId,
          dispatchedByMembershipId: memberA,
          retrievingMembershipId: null,
          disposalWitnessMembershipId: null,
          reconciledByMembershipId: memberA,
        });
        const unknownReturnId = randomUUID();

        await expect(
          reemitConsumer.handle(
            controlledDiscrepancyEvent(ORG_A, { deploymentId, medicationOrderId, returnId: unknownReturnId }),
          ),
        ).resolves.not.toThrow();

        const rows = await discrepancyDetectedRows(unknownReturnId);
        expect(rows).toHaveLength(0);
      });

      it("does not resolve a return across tenants — org B's returnId is invisible to org A's RLS scope", async () => {
        const patientId = randomUUID();
        const admissionId = randomUUID();
        const deploymentId = randomUUID();
        const { returnId, medicationOrderId } = await seedControlledReturn({
          organizationId: ORG_B,
          providerEntityId: providerB,
          locationId: locationB,
          patientId,
          admissionId,
          m13DeploymentId: deploymentId,
          dispatchedByMembershipId: memberA,
          retrievingMembershipId: null,
          disposalWitnessMembershipId: null,
          reconciledByMembershipId: memberA,
        });

        await expect(
          reemitConsumer.handle(
            controlledDiscrepancyEvent(ORG_A, { deploymentId, medicationOrderId, returnId }),
          ),
        ).resolves.not.toThrow();

        const rows = await discrepancyDetectedRows(returnId);
        expect(rows).toHaveLength(0);
      });
    });
  },
);
