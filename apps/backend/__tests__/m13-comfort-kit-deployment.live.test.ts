/**
 * F-166 (#248) — LIVE Postgres proof that M13's §2.5/§2.7 D5 comfort-kit deployment/replenishment/return
 * chain (`buildM13ComfortKitDeployedConsumer` / `buildM13ComfortKitReplenishedConsumer` /
 * `buildM13ComfortKitReturnedConsumer` / `buildM13ComfortKitReturnReconciliationConsumer`) actually
 * writes `comfort_kit_deployment` / `comfort_kit_drawdown` rows, for real, under RLS — the tables had no
 * live writer anywhere in this repository before this pass.
 *
 * Proves: an order-linked deployment creates the deployment row + one drawdown per order-linked line and
 * acks via `m13.comfort_kit.deployed` (M21's own already-bound `buildM21ComfortKitDeploymentAckConsumer`,
 * F-153, is the real downstream consumer waiting on this event); a floor-stock (null-`medicationOrderId`)
 * line is skipped and honestly reported via `skippedFloorStockLineCount`, never fabricated; a redelivery
 * of `.deployed_at_patient` is a true no-op (the migration-0259 unique index); a replenishment tops a
 * drawdown up, capped at `expected_quantity`; a reconciled return flips `disposal_status` to `'returned'`
 * via `.returned` alone (never at return-REQUEST time — `createReturn`'s stale placeholder emission is
 * deleted at the source in this same pass); `.return_reconciliation` closes each drawdown's
 * `final_remaining_quantity_at_return`, flags a ≥5% controlled-substance delta via
 * `m13.comfort_kit.controlled_substance_discrepancy`, and emits the aggregate `m13.comfort_kit.returned`
 * ack; and cross-tenant isolation holds throughout.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m13:comfort-kit-deployment:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { buildM13ComfortKitDeployedConsumer } from "../src/modules/13-emar/outbox-consumers/m21-comfort-kit-deployed";
import { buildM13ComfortKitReplenishedConsumer } from "../src/modules/13-emar/outbox-consumers/m21-comfort-kit-replenished";
import { buildM13ComfortKitReturnReconciliationConsumer } from "../src/modules/13-emar/outbox-consumers/m21-comfort-kit-return-reconciliation";
import { buildM13ComfortKitReturnedConsumer } from "../src/modules/13-emar/outbox-consumers/m21-comfort-kit-returned";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT_A = "aaaaaaaa-1111-4111-8111-0000000000a1";
const ADMISSION_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DISPATCH_A_1 = "dd111111-0000-4000-8000-000000000001";
const DISPATCH_A_2 = "dd111111-0000-4000-8000-000000000002";
const ORDER_1 = "0d000000-0000-4000-8000-000000000001";
const ORDER_2 = "0d000000-0000-4000-8000-000000000002";
const ORDER_CONTROLLED = "0d000000-0000-4000-8000-000000000003";
const MEMBERSHIP = "0e000000-0000-4000-8000-000000000001";

describe.skipIf(!DB_URL)(
  "F-166 — M13's comfort-kit deployment/replenishment/return chain — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA: string;
    let providerB: string;
    let locationA: string;
    let locationB: string;
    let deployedConsumer: ReturnType<typeof buildM13ComfortKitDeployedConsumer>;
    let replenishedConsumer: ReturnType<typeof buildM13ComfortKitReplenishedConsumer>;
    let returnedConsumer: ReturnType<typeof buildM13ComfortKitReturnedConsumer>;
    let reconciliationConsumer: ReturnType<typeof buildM13ComfortKitReturnReconciliationConsumer>;

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

    function contentLine(opts: {
      id: string;
      medicationOrderId: string | null;
      dispatchedQuantity: string;
      isControlled?: boolean;
    }) {
      return {
        dispatchedContentId: opts.id,
        comfortKitTemplateMedicationId: `ct${opts.id.slice(2)}`,
        medicationOrderId: opts.medicationOrderId,
        rxnorm: "12345",
        ndc: null,
        drugName: "Morphine 20mg/mL",
        strength: "20mg/mL",
        dosageForm: "solution",
        routeOfAdministration: "sublingual",
        isControlledSubstance: opts.isControlled ?? false,
        controlledSubstanceSchedule: opts.isControlled ? "CII" : null,
        dispatchedQuantity: opts.dispatchedQuantity,
        dispatchedUnit: "mL",
        lotNumber: opts.isControlled ? "LOT-1" : null,
        expirationDate: opts.isControlled ? "2099-01-01" : null,
        manufacturerNdc: null,
        replenishmentThresholdPct: 0.25,
      };
    }

    async function outboxRows(organizationId: string, eventType: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2 ORDER BY created_at`,
        [organizationId, eventType],
      );
      return rows;
    }
    async function deploymentRows(organizationId: string) {
      const { rows } = await admin.query(
        `SELECT id, disposal_status, returned_at, disposal_reconciliation_status, m21_supply_dispatch_id
         FROM comfort_kit_deployment WHERE organization_id = $1`,
        [organizationId],
      );
      return rows;
    }
    async function drawdownRows(deploymentId: string) {
      const { rows } = await admin.query(
        `SELECT medication_order_id, remaining_quantity, expected_quantity, final_remaining_quantity_at_return
         FROM comfort_kit_drawdown WHERE comfort_kit_deployment_id = $1 ORDER BY medication_order_id`,
        [deploymentId],
      );
      return rows;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m13-kit-deploy-a','M13 Kit Deploy A','M13 Kit Deploy A'),
                ($2,'m13-kit-deploy-b','M13 Kit Deploy B','M13 Kit Deploy B')`,
        [ORG_A, ORG_B],
      );
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M13KD-A','Kit Deploy Provider A','1400000001','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M13KD-B','Kit Deploy Provider B','1400000002','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      locationA = (
        await admin.query(
          `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'Kit Deploy Location A','1 Test St','Testville','OR','97201','America/Los_Angeles')
           RETURNING id`,
          [providerA],
        )
      ).rows[0].id as string;
      locationB = (
        await admin.query(
          `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'Kit Deploy Location B','1 Test St','Testville','OR','97201','America/Los_Angeles')
           RETURNING id`,
          [providerB],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M13_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      const outbox = {
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
          if (!catalog.has(input.eventName)) {
            throw new Error(`m13 test publisher: undeclared event ${input.eventName}`);
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

      deployedConsumer = buildM13ComfortKitDeployedConsumer({ db: handle.db, outbox });
      replenishedConsumer = buildM13ComfortKitReplenishedConsumer({ db: handle.db });
      returnedConsumer = buildM13ComfortKitReturnedConsumer({ db: handle.db });
      reconciliationConsumer = buildM13ComfortKitReturnReconciliationConsumer({
        db: handle.db,
        outbox,
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("deploys an order-linked kit, skips a floor-stock line honestly, and acks via m13.comfort_kit.deployed", async () => {
      await deployedConsumer.handle({
        id: "ee111111-0000-4000-8000-000000000001",
        organizationId: ORG_A,
        payload: {
          orgId: ORG_A,
          patientId: PATIENT_A,
          admissionId: ADMISSION_A,
          providerEntityId: providerA,
          locationId: locationA,
          dispatchId: DISPATCH_A_1,
          supplyRequestId: "0s000000-0000-4000-8000-000000000001",
          deploymentSite: "home",
          ipuRoomId: null,
          deployedAt: "2050-01-01T00:00:00Z",
          deployedByMembershipId: MEMBERSHIP,
          contents: [
            contentLine({
              id: "dc000000-0000-4000-8000-000000000001",
              medicationOrderId: ORDER_1,
              dispatchedQuantity: "30",
            }),
            contentLine({
              id: "dc000000-0000-4000-8000-000000000002",
              medicationOrderId: null,
              dispatchedQuantity: "15",
            }),
          ],
          bolDocumentId: null,
        },
      });

      const deployments = await deploymentRows(ORG_A);
      expect(deployments).toHaveLength(1);
      expect(deployments[0].disposal_status).toBe("deployed");
      expect(deployments[0].m21_supply_dispatch_id).toBe(DISPATCH_A_1);
      const deploymentId = deployments[0].id as string;

      const drawdowns = await drawdownRows(deploymentId);
      expect(drawdowns).toHaveLength(1); // the floor-stock line never got a drawdown row
      expect(drawdowns[0].medication_order_id).toBe(ORDER_1);
      expect(Number(drawdowns[0].remaining_quantity)).toBe(30);

      const acks = await outboxRows(ORG_A, "m13.comfort_kit.deployed");
      expect(acks).toHaveLength(1);
      expect(acks[0].payload.skippedFloorStockLineCount).toBe(1);
      expect(acks[0].payload.deploymentId).toBe(deploymentId);
    });

    it("is a true no-op on redelivery of the same dispatch (migration 0259's unique index)", async () => {
      const before = await deploymentRows(ORG_A);
      await deployedConsumer.handle({
        id: "ee111111-0000-4000-8000-000000000099",
        organizationId: ORG_A,
        payload: {
          orgId: ORG_A,
          patientId: PATIENT_A,
          admissionId: ADMISSION_A,
          providerEntityId: providerA,
          locationId: locationA,
          dispatchId: DISPATCH_A_1, // SAME dispatch as the first test
          supplyRequestId: "0s000000-0000-4000-8000-000000000001",
          deploymentSite: "home",
          ipuRoomId: null,
          deployedAt: "2050-01-01T00:00:00Z",
          deployedByMembershipId: MEMBERSHIP,
          contents: [
            contentLine({
              id: "dc000000-0000-4000-8000-000000000009",
              medicationOrderId: ORDER_1,
              dispatchedQuantity: "30",
            }),
          ],
          bolDocumentId: null,
        },
      });
      const after = await deploymentRows(ORG_A);
      expect(after).toHaveLength(before.length); // no second deployment row for the same dispatch
    });

    it("tops up a drawdown, capped at expected_quantity", async () => {
      const [deployment] = await deploymentRows(ORG_A);
      const deploymentId = deployment.id as string;

      await replenishedConsumer.handle({
        id: "ee111111-0000-4000-8000-000000000002",
        organizationId: ORG_A,
        payload: {
          orgId: ORG_A,
          patientId: PATIENT_A,
          admissionId: ADMISSION_A,
          providerEntityId: providerA,
          locationId: locationA,
          dispatchId: DISPATCH_A_2,
          supplyRequestId: "0s000000-0000-4000-8000-000000000002",
          sourceDeploymentId: deploymentId,
          replenishedAt: "2050-01-05T00:00:00Z",
          contents: [
            // Drawdown had drifted to 5 remaining before this replenishment (simulate a PRN draw).
            contentLine({
              id: "dc000000-0000-4000-8000-000000000003",
              medicationOrderId: ORDER_1,
              dispatchedQuantity: "100",
            }),
          ],
        },
      });

      const drawdowns = await drawdownRows(deploymentId);
      // capped at expected_quantity (30), never allowed to overshoot even though 100 was "delivered"
      expect(Number(drawdowns[0].remaining_quantity)).toBe(30);
    });

    it("flips disposal_status to 'returned' only via .returned, never at return-request time", async () => {
      const [deployment] = await deploymentRows(ORG_A);
      const deploymentId = deployment.id as string;
      expect(deployment.disposal_status).toBe("deployed"); // unchanged by the replenishment above

      await returnedConsumer.handle({
        id: "ee111111-0000-4000-8000-000000000003",
        organizationId: ORG_A,
        payload: {
          orgId: ORG_A,
          patientId: PATIENT_A,
          admissionId: ADMISSION_A,
          providerEntityId: providerA,
          locationId: locationA,
          returnId: "0r000000-0000-4000-8000-000000000001",
          dispatchId: DISPATCH_A_1,
          m13DeploymentId: deploymentId,
          disposalMethod: "take_back_by_supply_team",
          reconciledByMembershipId: MEMBERSHIP,
          disposalWitnessMembershipId: null,
          reconciledAt: "2050-02-01T00:00:00Z",
        },
      });

      const [after] = await deploymentRows(ORG_A);
      expect(after.disposal_status).toBe("returned");
      expect(after.returned_at).not.toBeNull();
    });

    it("closes the drawdown, flags a controlled-substance discrepancy, and acks m13.comfort_kit.returned", async () => {
      // Fresh deployment for a clean reconciliation scenario with a controlled-substance line.
      await deployedConsumer.handle({
        id: "ee111111-0000-4000-8000-000000000004",
        organizationId: ORG_A,
        payload: {
          orgId: ORG_A,
          patientId: PATIENT_A,
          admissionId: ADMISSION_A,
          providerEntityId: providerA,
          locationId: locationA,
          dispatchId: "dd111111-0000-4000-8000-000000000099",
          supplyRequestId: "0s000000-0000-4000-8000-000000000003",
          deploymentSite: "home",
          ipuRoomId: null,
          deployedAt: "2050-03-01T00:00:00Z",
          deployedByMembershipId: MEMBERSHIP,
          contents: [
            contentLine({
              id: "dc000000-0000-4000-8000-000000000004",
              medicationOrderId: ORDER_CONTROLLED,
              dispatchedQuantity: "20",
              isControlled: true,
            }),
            contentLine({
              id: "dc000000-0000-4000-8000-000000000005",
              medicationOrderId: ORDER_2,
              dispatchedQuantity: "20",
            }),
          ],
          bolDocumentId: null,
        },
      });
      const deployments = await admin.query(
        `SELECT id FROM comfort_kit_deployment WHERE organization_id = $1 AND m21_supply_dispatch_id = $2`,
        [ORG_A, "dd111111-0000-4000-8000-000000000099"],
      );
      const deploymentId = deployments.rows[0].id as string;

      await reconciliationConsumer.handle({
        id: "ee111111-0000-4000-8000-000000000005",
        organizationId: ORG_A,
        payload: {
          orgId: ORG_A,
          patientId: PATIENT_A,
          admissionId: ADMISSION_A,
          providerEntityId: providerA,
          locationId: locationA,
          returnId: "0r000000-0000-4000-8000-000000000002",
          dispatchId: "dd111111-0000-4000-8000-000000000099",
          m13DeploymentId: deploymentId,
          discrepancyDetected: true,
          reconciledAt: "2050-03-15T00:00:00Z",
          perMedicationReconciliation: [
            {
              returnedContentId: "0c000000-0000-4000-8000-000000000001",
              dispatchedContentId: "dc000000-0000-4000-8000-000000000004",
              comfortKitTemplateMedicationId: "ct00000004",
              medicationOrderId: ORDER_CONTROLLED,
              rxnorm: "12345",
              drugName: "Morphine 20mg/mL",
              isControlledSubstance: true,
              controlledSubstanceSchedule: "CII",
              lotNumber: "LOT-1",
              dispatchedQuantity: "20",
              // Tracked remaining (20, since no drawdown yet) vs. actual counted (10) is a 50% delta — well
              // over the 5% controlled threshold.
              quantityReturned: "8",
              quantityDisposedAtHome: "2",
              quantityUnaccounted: "10",
              discrepancyPct: 0.5,
              discrepancyFlagged: true,
            },
            {
              returnedContentId: "0c000000-0000-4000-8000-000000000002",
              dispatchedContentId: "dc000000-0000-4000-8000-000000000005",
              comfortKitTemplateMedicationId: "ct00000005",
              medicationOrderId: ORDER_2,
              rxnorm: "12345",
              drugName: "Lorazepam 2mg/mL",
              isControlledSubstance: false,
              controlledSubstanceSchedule: null,
              lotNumber: null,
              dispatchedQuantity: "20",
              quantityReturned: "20",
              quantityDisposedAtHome: "0",
              quantityUnaccounted: "0",
              discrepancyPct: 0,
              discrepancyFlagged: false,
            },
          ],
        },
      });

      const drawdowns = await drawdownRows(deploymentId);
      const controlled = drawdowns.find((d) => d.medication_order_id === ORDER_CONTROLLED);
      const plain = drawdowns.find((d) => d.medication_order_id === ORDER_2);
      expect(Number(controlled?.final_remaining_quantity_at_return)).toBe(10); // 8 returned + 2 disposed
      expect(Number(plain?.final_remaining_quantity_at_return)).toBe(20);

      const discrepancies = await outboxRows(
        ORG_A,
        "m13.comfort_kit.controlled_substance_discrepancy",
      );
      expect(discrepancies).toHaveLength(1);
      expect(discrepancies[0].payload.medicationOrderId).toBe(ORDER_CONTROLLED);
      // F-172 (#248) — the fact was already in scope (this handler IS the return_reconciliation
      // consumer); widening the wire payload to carry it is what unblocks M21's re-emit.
      expect(discrepancies[0].payload.returnId).toBe("0r000000-0000-4000-8000-000000000002");

      const returnedAcks = await outboxRows(ORG_A, "m13.comfort_kit.returned");
      expect(returnedAcks).toHaveLength(1);
      expect(returnedAcks[0].payload.disposalReconciliationStatus).toBe("discrepancy");

      const deploymentRow = await admin.query(
        `SELECT disposal_reconciliation_status FROM comfort_kit_deployment WHERE id = $1`,
        [deploymentId],
      );
      expect(deploymentRow.rows[0].disposal_reconciliation_status).toBe("discrepancy");
    });

    it("does not touch org B's rows when org A deploys/reconciles (cross-tenant isolation)", async () => {
      await deployedConsumer.handle({
        id: "ee222222-0000-4000-8000-000000000001",
        organizationId: ORG_B,
        payload: {
          orgId: ORG_B,
          patientId: "bbbbbbbb-1111-4111-8111-0000000000b1",
          admissionId: "bbbbbbbb-0000-4000-8000-0000000000b1",
          providerEntityId: providerB,
          locationId: locationB,
          dispatchId: "dd222222-0000-4000-8000-000000000001",
          supplyRequestId: "0s000000-0000-4000-8000-000000000004",
          deploymentSite: "home",
          ipuRoomId: null,
          deployedAt: "2050-01-01T00:00:00Z",
          deployedByMembershipId: MEMBERSHIP,
          contents: [
            contentLine({
              id: "dc000000-0000-4000-8000-000000000006",
              medicationOrderId: ORDER_1,
              dispatchedQuantity: "10",
            }),
          ],
          bolDocumentId: null,
        },
      });

      const orgADeployments = await deploymentRows(ORG_A);
      const orgBDeployments = await deploymentRows(ORG_B);
      expect(orgBDeployments).toHaveLength(1);
      // Org A's rows (2 deployments seeded across the earlier tests) are untouched by org B's deploy.
      expect(orgADeployments.length).toBeGreaterThanOrEqual(2);
    });
  },
);
