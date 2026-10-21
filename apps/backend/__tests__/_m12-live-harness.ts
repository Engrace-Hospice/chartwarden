// apps/backend/__tests__/_m12-live-harness.ts — shared setup for the GAP-037 M12 cron live suites: a fresh schema
// (all migrations), two tenants, the real NOBYPASSRLS `wardenx_app` connection, and the REAL catalog-validating
// transactional publisher. Only the DoseSpot vendor is a test double (`_fake-dosespot-vendor.ts`).
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import type { DoseSpotWriteOutboxPort } from "../src/modules/12-dosespot/dosespot-route-service-db";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
export const ORG_A = "11111111-1111-1111-1111-111111111111";
export const ORG_B = "22222222-2222-2222-2222-222222222222";
export const USER = "33333333-3333-3333-3333-333333333333";
export const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

export interface M12Live {
  readonly admin: Client;
  readonly handle: ReturnType<typeof createDbClient>;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly providerOf: Record<string, string>;
  readonly locationOf: Record<string, string>;
  readonly memberOf: Record<string, string>;
  q(sql: string, params?: unknown[]): Promise<Record<string, any>[]>;
  eventsOf(type: string, org?: string): Promise<Record<string, any>[]>;
  seedPatient(org: string, opts?: { synced?: string }): Promise<string>;
  seedPrescriber(
    org: string,
    opts?: { dosespotId?: string; ial2ExpiresAt?: Date; ial2Status?: string },
  ): Promise<string>;
  /** An order in an arbitrary status; `transmission: true` also inserts its `medication_order_transmission` row. */
  seedOrder(input: {
    org: string;
    patientId: string;
    status: string;
    sendState: string;
    data?: Record<string, unknown> | null;
    rxnormRxcui?: string | null;
    dosespotPrescriptionId?: string | null;
    transmittedAt?: Date | null;
    updatedAt?: Date;
    transmission?: boolean;
  }): Promise<{ orderId: string; transmissionId: string | null; idempotencyKey: string }>;
  close(): Promise<void>;
}

export const GOOD_DATA = {
  sigStructured: {
    doseQuantity: 1,
    doseUnit: "tablet",
    route: "oral",
    frequencyCode: "BID",
    asNeeded: false,
  },
  sigFreeText: "Take 1 tablet by mouth twice daily",
  dispenseQuantity: { value: 30, unit: "tablet" },
  daysSupply: 15,
  refillsAuthorized: 0,
};

export async function setupM12Live(dbUrl: string): Promise<M12Live> {
  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  await admin.query(
    "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
    [ORG_A, ORG_B],
  );
  await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m12-cron@x.test')`, [USER]);
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const memberOf: Record<string, string> = {};
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
  const handle = createDbClient({ connectionString: appRoleUrl(dbUrl) });
  const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M12_OUTBOX_EVENTS]));
  const outbox: DoseSpotWriteOutboxPort = {
    publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m12" }),
  };
  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;

  return {
    admin,
    handle,
    outbox,
    providerOf,
    locationOf,
    memberOf,
    q,
    eventsOf: (type, org) =>
      q(
        "SELECT payload, aggregate_id FROM outbox_event WHERE event_type=$1 AND ($2::uuid IS NULL OR organization_id=$2) ORDER BY created_at",
        [type, org ?? null],
      ),
    async seedPatient(org, opts) {
      const { rows } = await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
         VALUES ($1,$2,'Ada','Lovelace','1980-01-01','F') RETURNING id`,
        [org, `MRN-${randomUUID().slice(0, 8)}`],
      );
      const patientId = rows[0].id as string;
      if (opts?.synced) {
        await admin.query(
          `INSERT INTO dosespot_patient_sync (organization_id, patient_id, last_dosespot_patient_id, last_sync_at, last_sync_outcome)
           VALUES ($1,$2,$3,now(),'success')`,
          [org, patientId, opts.synced],
        );
      }
      return patientId;
    },
    async seedPrescriber(org, opts) {
      const { rows } = await admin.query(
        `INSERT INTO dosespot_prescriber (organization_id, membership_id, dosespot_prescriber_id, ial2_status,
           ial2_expires_at, enrolled_at)
         VALUES ($1,$2,$3,$4,$5,now()) RETURNING id`,
        [
          org,
          memberOf[org],
          opts?.dosespotId ?? "700",
          opts?.ial2Status ?? "verified",
          opts?.ial2ExpiresAt ?? null,
        ],
      );
      return rows[0].id as string;
    },
    async seedOrder(i) {
      const idempotencyKey = `idem-${randomUUID()}`;
      const { rows } = await admin.query(
        `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, med_class, drug_name, strength, dose_form, route, data, rxnorm_rxcui,
           prescriber_membership_id, prescribing_physician_mdm_id, status, dosespot_send_state,
           dosespot_prescription_id, transmitted_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral',$6::jsonb,$7,$8,$9,$10::medication_order_status,
           $11::dosespot_send_state,$12,$13,COALESCE($14, now()))
         RETURNING id`,
        [
          i.org,
          providerOf[i.org],
          locationOf[i.org],
          i.patientId,
          randomUUID(),
          JSON.stringify(i.data === undefined ? GOOD_DATA : (i.data ?? {})),
          i.rxnormRxcui === undefined ? "197361" : i.rxnormRxcui,
          memberOf[i.org],
          PHYSICIAN_MDM,
          i.status,
          i.sendState,
          i.dosespotPrescriptionId ?? null,
          i.transmittedAt ?? null,
          i.updatedAt ?? null,
        ],
      );
      const orderId = rows[0].id as string;
      let transmissionId: string | null = null;
      if (i.transmission !== false) {
        transmissionId = (
          await admin.query(
            `INSERT INTO medication_order_transmission (organization_id, medication_order_id, idempotency_key,
               rx_business_key, correlation_id)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [i.org, orderId, idempotencyKey, `rbk-${randomUUID()}`, randomUUID()],
          )
        ).rows[0].id as string;
      }
      return { orderId, transmissionId, idempotencyKey };
    },
    async close() {
      await handle.close();
      await admin.end();
    },
  };
}
