/**
 * M12 DoseSpot VENDOR BOUNDARY (F-230, #248) — OUR side of the boundary, over real Postgres as the real
 * NOBYPASSRLS `wardenx_app` role, with the REAL catalog-validating transactional publisher.
 *
 * The only thing faked is the vendor itself: `FakeDoseSpotVendor` / `FakeDoseSpotWebhookSender`
 * (`_fake-dosespot-vendor.ts`, a clearly-labelled TEST DOUBLE at the `DoseSpotClient` port / the HTTP delivery).
 * Everything behind it is real: the sync-queue worker, `ingestPullResult`, the `dosespot_patient_sync` mapping,
 * the webhook route + §7.4 envelope + DEK-encrypted receipt + dedup, the dispense persistence, RLS, the
 * publisher, and M12's org-explicit `idgMedicationHistoryForOrg` seam (the M14 packet slot's source).
 *
 * WHAT THIS PROVES: our code's behaviour given payloads of the shape OUR contract declares — ingest ->
 * persisted -> event -> M14 slot state; redelivery no-ops; bad signature rejected; unconfigured route disabled;
 * cross-tenant isolation; no event without a real ingest.
 * WHAT THIS DOES NOT PROVE: real DoseSpot wire compatibility (the script_status_update field names and the
 * MedicationHistory response mapping are provisional), real credentials, or the vendor signature scheme
 * against a real delivery — the fake signs with OUR `computeWebhookSignature`. See docs/history F-230.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m12:vendor-boundary:live
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { createUnboundDoseSpotClient } from "@wardenx/dosespot";
import { withOrgContext } from "@wardenx/tenancy";
import Fastify from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { dosespotSyncDemographicsForOrg } from "../src/modules/05-patient/index";
import type { DoseSpotWriteOutboxPort } from "../src/modules/12-dosespot/dosespot-route-service-db";
import {
  DosespotSyncQueueRepository,
  createDrizzleMedicationOrderEraseStore,
  eraseMedicationOrderRecord,
  ingestMedicationHistoryPull,
  M12_OUTBOX_EVENTS,
  createEnvWebhookSecretResolver,
  createUnboundWebhookSecretResolver,
  createWebhookBodyCipher,
  idgMedicationHistoryForOrg,
  registerDoseSpotWebhookRoute,
  runDoseSpotSyncQueueDrain,
  type ActiveOrgListPort,
  type DoseSpotSyncWorkerDeps,
} from "../src/modules/12-dosespot/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { FakeDoseSpotVendor, FakeDoseSpotWebhookSender } from "./_fake-dosespot-vendor";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
const PHARMACY_MDM = "88888888-8888-4888-8888-888888888888";
const SECRET_A = "org-a-webhook-secret-0123456789abcdef";
const SECRET_B = "org-b-webhook-secret-0123456789abcdef";

describe.skipIf(!DB_URL)("M12 DoseSpot vendor boundary (F-230) — LIVE Postgres, real publisher", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let outbox: DoseSpotWriteOutboxPort;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const memberOf: Record<string, string> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  async function seedPatient(org: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,'Ada','Lovelace','1980-01-01','F') RETURNING id`,
      [org, `MRN-${randomUUID().slice(0, 8)}`],
    );
    const patientId = rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_address (patient_id, organization_id, line1, city, state, postal_code, is_primary, effective_from)
       VALUES ($1,$2,'1 Infinite Loop','Portland','OR','97201', true, CURRENT_DATE)`,
      [patientId, org],
    );
    return patientId;
  }

  /** A transmitted medication order carrying the vendor prescription id the webhook resolves by. */
  async function seedOrder(org: string, patientId: string, prescriptionId: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, med_class, drug_name, strength, dose_form, route, data,
         prescriber_membership_id, prescribing_physician_mdm_id, dispensing_pharmacy_mdm_id, status,
         dosespot_prescription_id)
       VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7,$8,'active',$9)
       RETURNING id`,
      [
        org,
        providerOf[org],
        locationOf[org],
        patientId,
        randomUUID(),
        memberOf[org],
        PHYSICIAN_MDM,
        PHARMACY_MDM,
        prescriptionId,
      ],
    );
    return rows[0].id as string;
  }

  async function enqueueAs(
    org: string,
    kind: "patient_sync" | "medhx_fetch",
    patientId: string,
  ): Promise<string> {
    return withOrgContext(handle.db, { organizationId: org, userId: USER }, async (tx) => {
      const repo = new DosespotSyncQueueRepository(tx as DbClient);
      const { row } = await repo.enqueue(
        kind === "patient_sync"
          ? { organizationId: org, kind, reason: "created", patientId }
          : { organizationId: org, kind, reason: "admission_activated", patientId, admissionId: randomUUID() },
      );
      return row.id;
    });
  }

  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;
  const eventsOf = (type: string, org?: string) =>
    q(
      "SELECT payload, aggregate_id FROM outbox_event WHERE event_type=$1 AND ($2::uuid IS NULL OR organization_id=$2) ORDER BY created_at",
      [type, org ?? null],
    );

  const workerDeps = (
    orgs: readonly string[],
    extra: Partial<DoseSpotSyncWorkerDeps> = {},
  ): DoseSpotSyncWorkerDeps => {
    const activeOrgs: ActiveOrgListPort = {
      listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
    };
    return {
      db: handle.db,
      activeOrgs,
      outbox,
      demographicsForOrg: (o, p) => dosespotSyncDemographicsForOrg(handle.db, o, p),
      ...extra,
    };
  };

  /** Test key provider for the DEK envelope (real AES-256-GCM; a fixed per-org key stands in for M34's KMS). */
  const keys = {
    dekForOrg: async (org: string) => ({
      version: "test-dek-v1",
      key: createHash("sha256").update(`test-dek:${org}`).digest(),
    }),
  };
  const cipher = createWebhookBodyCipher(keys);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m12-vb@x.test')`, [USER]);
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
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M12_OUTBOX_EVENTS]));
    outbox = { publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m12" }) };
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ── PULL PATH ─────────────────────────────────────────────────────────────────────────────────────────
  describe("MedicationHistory pull -> ingestPullResult -> event -> M14 slot state", () => {
    it("patient_sync records the vendor id; medhx_fetch ingests the pull and emits m12.medication_history_pulled", async () => {
      const patientId = await seedPatient(ORG_A);
      const vendor = new FakeDoseSpotVendor({
        dosespotPatientId: "ds-patient-777",
        medHistory: {
          pulledAt: "2026-09-29T12:00:00.000Z",
          items: [
            {
              rxnormRxcui: "197696",
              drugName: "Warfarin 5 mg tablet",
              lastFillDate: "2026-09-01",
              sourcePharmacy: "Corner Pharmacy",
              strength: "5 mg",
              fillDates: ["2026-08-01", "2026-09-01"],
              pharmacyNcpdp: "1234567",
            },
            { rxnormRxcui: null, drugName: "Unknown NDC item", lastFillDate: null, sourcePharmacy: null },
          ],
        },
      });

      // before any pull: the M14 slot's source says NOT PULLED — never "no external history".
      expect((await idgMedicationHistoryForOrg(handle.db, ORG_A, [patientId])).get(patientId)).toEqual({
        state: "not_pulled",
        recordCount: 0,
        lastPulledAt: null,
      });

      const syncJob = await enqueueAs(ORG_A, "patient_sync", patientId);
      await runDoseSpotSyncQueueDrain(workerDeps([ORG_A], { doseSpotClient: vendor }));
      expect((await q("SELECT status FROM dosespot_sync_queue WHERE id=$1", [syncJob]))[0].status).toBe("completed");
      const sync = await q("SELECT last_dosespot_patient_id, last_sync_outcome, retry_count FROM dosespot_patient_sync WHERE patient_id=$1", [patientId]);
      expect(sync).toEqual([{ last_dosespot_patient_id: "ds-patient-777", last_sync_outcome: "success", retry_count: 0 }]);
      expect((await eventsOf("m12.dosespot_patient_synced", ORG_A)).length).toBeGreaterThanOrEqual(1);

      const pullJob = await enqueueAs(ORG_A, "medhx_fetch", patientId);
      await runDoseSpotSyncQueueDrain(workerDeps([ORG_A], { doseSpotClient: vendor }));

      // the vendor was asked for THIS vendor-side patient id, with the 12-month window.
      const pullCall = vendor.calls.find((c) => c.method === "pullMedicationHistory");
      expect((pullCall?.payload as { dosespotPatientId: string }).dosespotPatientId).toBe("ds-patient-777");
      expect((pullCall?.payload as { sinceDate?: string }).sinceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      expect((await q("SELECT status FROM dosespot_sync_queue WHERE id=$1", [pullJob]))[0].status).toBe("completed");
      const ledger = await q("SELECT total_returned, rows_created, dosespot_patient_id, source_job_id FROM medication_history_pull WHERE patient_id=$1", [patientId]);
      expect(ledger).toEqual([{ total_returned: 2, rows_created: 2, dosespot_patient_id: "ds-patient-777", source_job_id: pullJob }]);
      const records = await q("SELECT drug_name, rxnorm_rxcui, ndc, pharmacy_ncpdp, fill_dates FROM medication_history_record WHERE patient_id=$1 ORDER BY line_index", [patientId]);
      expect(records.map((r) => r.drug_name)).toEqual(["Warfarin 5 mg tablet", "Unknown NDC item"]);
      expect(records[1].rxnorm_rxcui).toBeNull(); // §5.5: no RxCUI is carried as null, not invented

      // never auto-linked to a medication order (§2.8) — the history table has no order reference at all.
      const ev = (await eventsOf("m12.medication_history_pulled", ORG_A)).filter((e) => e.payload.patientId === patientId);
      expect(ev).toHaveLength(1);
      expect(ev[0].payload).toEqual({ patientId, rowsCreated: 2, sourceJobId: pullJob }); // id-only + a count

      expect((await idgMedicationHistoryForOrg(handle.db, ORG_A, [patientId])).get(patientId)).toEqual({
        state: "available",
        recordCount: 2,
        lastPulledAt: "2026-09-29T12:00:00.000Z",
      });
    });

    it("a pull that returns ZERO entries is ingested and is 'none_available' (distinct from never-pulled)", async () => {
      const patientId = await seedPatient(ORG_A);
      const vendor = new FakeDoseSpotVendor({
        dosespotPatientId: "ds-patient-000",
        medHistory: { items: [], pulledAt: "2026-09-29T13:00:00.000Z" },
      });
      await enqueueAs(ORG_A, "patient_sync", patientId);
      await runDoseSpotSyncQueueDrain(workerDeps([ORG_A], { doseSpotClient: vendor }));
      const job = await enqueueAs(ORG_A, "medhx_fetch", patientId);
      await runDoseSpotSyncQueueDrain(workerDeps([ORG_A], { doseSpotClient: vendor }));

      expect((await q("SELECT count(*)::int n FROM medication_history_record WHERE patient_id=$1", [patientId]))[0].n).toBe(0);
      const ev = (await eventsOf("m12.medication_history_pulled", ORG_A)).filter((e) => e.payload.sourceJobId === job);
      expect(ev).toHaveLength(1);
      expect(ev[0].payload.rowsCreated).toBe(0);
      expect((await idgMedicationHistoryForOrg(handle.db, ORG_A, [patientId])).get(patientId)).toEqual({
        state: "none_available",
        recordCount: 0,
        lastPulledAt: "2026-09-29T13:00:00.000Z",
      });
    });

    it("the LATEST pull decides the slot state", async () => {
      const patientId = await seedPatient(ORG_A);
      const ingest = (job: string, n: number, at: string) =>
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          ingestMedicationHistoryPull(tx as DbClient, outbox, {
            organizationId: ORG_A,
            patientId,
            dosespotPatientId: "ds-x",
            sourceJobId: job,
            result: {
              pulledAt: at,
              items: Array.from({ length: n }, (_, i) => ({
                rxnormRxcui: String(i),
                drugName: `Drug ${i}`,
                lastFillDate: null,
                sourcePharmacy: null,
              })),
            },
          }),
        );
      await ingest(randomUUID(), 3, "2026-09-01T00:00:00.000Z");
      await ingest(randomUUID(), 0, "2026-09-20T00:00:00.000Z");
      expect((await idgMedicationHistoryForOrg(handle.db, ORG_A, [patientId])).get(patientId)?.state).toBe("none_available");
    });

    it("re-ingesting the same job id is a no-op: one ledger row, one record set, one event", async () => {
      const patientId = await seedPatient(ORG_A);
      const job = randomUUID();
      const run = () =>
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          ingestMedicationHistoryPull(tx as DbClient, outbox, {
            organizationId: ORG_A,
            patientId,
            dosespotPatientId: "ds-x",
            sourceJobId: job,
            result: {
              pulledAt: "2026-09-29T00:00:00.000Z",
              items: [{ rxnormRxcui: "1", drugName: "Only", lastFillDate: null, sourcePharmacy: null }],
            },
          }),
        );
      expect((await run()).ingested).toBe(true);
      expect(await run()).toEqual({ ingested: false, rowsCreated: 0, pullId: null });
      expect((await q("SELECT count(*)::int n FROM medication_history_pull WHERE source_job_id=$1", [job]))[0].n).toBe(1);
      expect((await q("SELECT count(*)::int n FROM medication_history_record WHERE source_event_id=$1", [job]))[0].n).toBe(1);
      expect((await eventsOf("m12.medication_history_pulled", ORG_A)).filter((e) => e.payload.sourceJobId === job)).toHaveLength(1);
    });

    it("PRODUCTION POSTURE: the unbound client ingests nothing and emits nothing; the failure is honest", async () => {
      const patientId = await seedPatient(ORG_A);
      // a mapping exists (as if a past sync succeeded) so the worker reaches the vendor call
      await admin.query(
        `INSERT INTO dosespot_patient_sync (organization_id, patient_id, last_dosespot_patient_id, last_sync_at, last_sync_outcome)
         VALUES ($1,$2,'ds-old',now(),'success')`,
        [ORG_A, patientId],
      );
      const before = (await eventsOf("m12.medication_history_pulled")).length;
      const job = await enqueueAs(ORG_A, "medhx_fetch", patientId);
      await runDoseSpotSyncQueueDrain(workerDeps([ORG_A], { doseSpotClient: createUnboundDoseSpotClient() }));
      const row = (await q("SELECT status, last_error FROM dosespot_sync_queue WHERE id=$1", [job]))[0];
      expect(row.status).toBe("failed");
      expect(row.last_error).toMatch(/e-prescribe is not enabled/i);
      expect((await q("SELECT count(*)::int n FROM medication_history_pull WHERE patient_id=$1", [patientId]))[0].n).toBe(0);
      expect((await eventsOf("m12.medication_history_pulled")).length).toBe(before);
      expect((await idgMedicationHistoryForOrg(handle.db, ORG_A, [patientId])).get(patientId)?.state).toBe("not_pulled");
    });

    it("medhx_fetch with no recorded DoseSpot patient id fails honestly and never calls the vendor", async () => {
      const patientId = await seedPatient(ORG_A);
      const vendor = new FakeDoseSpotVendor();
      const job = await enqueueAs(ORG_A, "medhx_fetch", patientId);
      await runDoseSpotSyncQueueDrain(workerDeps([ORG_A], { doseSpotClient: vendor }));
      const row = (await q("SELECT status, last_error FROM dosespot_sync_queue WHERE id=$1", [job]))[0];
      expect(row.status).toBe("failed");
      expect(row.last_error).toMatch(/no DoseSpot-side patient id is recorded/i);
      expect(vendor.calls).toHaveLength(0);
    });

    it("cross-tenant: org B cannot read or write org A's history/ledger/mapping (real NOBYPASSRLS role)", async () => {
      const patientId = await seedPatient(ORG_A);
      await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        ingestMedicationHistoryPull(tx as DbClient, outbox, {
          organizationId: ORG_A,
          patientId,
          dosespotPatientId: "ds-a",
          sourceJobId: randomUUID(),
          result: {
            pulledAt: "2026-09-29T00:00:00.000Z",
            items: [{ rxnormRxcui: "1", drugName: "A-only", lastFillDate: null, sourcePharmacy: null }],
          },
        }),
      );
      // org B's seam read for org A's patient id sees nothing -> not_pulled
      expect((await idgMedicationHistoryForOrg(handle.db, ORG_B, [patientId])).get(patientId)?.state).toBe("not_pulled");
      // a raw read under org B's context returns no org-A rows (RLS on the real app role)
      const asB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, async (tx) =>
        (tx as DbClient)
          .select({ id: schema.medicationHistoryRecords.id })
          .from(schema.medicationHistoryRecords),
      );
      expect(asB).toHaveLength(0);
      // org B's tx cannot INSERT an org-A row (WITH CHECK)
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
          ingestMedicationHistoryPull(tx as DbClient, outbox, {
            organizationId: ORG_A, // forged
            patientId,
            dosespotPatientId: "ds-a",
            sourceJobId: randomUUID(),
            result: { pulledAt: "2026-09-29T00:00:00.000Z", items: [] },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ── ERASURE ───────────────────────────────────────────────────────────────────────────────────────────
  describe("patient erasure (M12 eraser)", () => {
    it("removes the erased patient's history/ledger/dispense/mapping rows and leaves other patients' intact", async () => {
      const gone = await seedPatient(ORG_A);
      const kept = await seedPatient(ORG_A);
      for (const p of [gone, kept]) {
        await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          ingestMedicationHistoryPull(tx as DbClient, outbox, {
            organizationId: ORG_A,
            patientId: p,
            dosespotPatientId: `ds-${p.slice(0, 4)}`,
            sourceJobId: randomUUID(),
            result: {
              pulledAt: "2026-09-29T00:00:00.000Z",
              items: [{ rxnormRxcui: "1", drugName: "X", lastFillDate: null, sourcePharmacy: null }],
            },
          }),
        );
        await admin.query(
          `INSERT INTO dosespot_patient_sync (organization_id, patient_id, last_dosespot_patient_id, last_sync_at, last_sync_outcome)
           VALUES ($1,$2,'ds',now(),'success')`,
          [ORG_A, p],
        );
        const rx = `rx-${randomUUID()}`;
        const orderId = await seedOrder(ORG_A, p, rx);
        const receipt = (
          await admin.query(
            `INSERT INTO dosespot_webhook_event (organization_id, dosespot_event_id, event_type, raw_body_cipher, raw_body_dek,
               body_digest, signature_verified_at, correlation_id)
             VALUES ($1,$2,'script_status_update','c','d','h',now(),'corr') RETURNING id`,
            [ORG_A, `ev-${randomUUID()}`],
          )
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO medication_order_dispense (organization_id, patient_id, medication_order_id, dosespot_prescription_id,
             webhook_event_id, dosespot_event_id, script_status, dispensed_at)
           VALUES ($1,$2,$3,$4,$5,$6,'Dispensed',now())`,
          [ORG_A, p, orderId, rx, receipt, `ev-${randomUUID()}`],
        );
      }
      // The eraser runs on the admin/destruction credential in production (`destructionDb`); wardenx_app has no DELETE.
      const eraseHandle = createDbClient({ connectionString: DB_URL as string });
      try {
        const store = createDrizzleMedicationOrderEraseStore(eraseHandle.db);
        const { counts } = await eraseMedicationOrderRecord(ORG_A, gone, store, {
          retentionAsOf: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(counts).toMatchObject({
          medicationHistoryRecords: 1,
          medicationHistoryPulls: 1,
          dispenses: 1,
          patientSyncRows: 1,
        });
      } finally {
        await eraseHandle.close();
      }
      for (const [table, n] of [
        ["medication_history_record", 0],
        ["medication_history_pull", 0],
        ["medication_order_dispense", 0],
        ["dosespot_patient_sync", 0],
      ] as const) {
        expect((await q(`SELECT count(*)::int n FROM ${table} WHERE patient_id=$1`, [gone]))[0].n).toBe(n);
        expect((await q(`SELECT count(*)::int n FROM ${table} WHERE patient_id=$1`, [kept]))[0].n).toBe(1);
      }
      // the org-scoped encrypted receipts survive (not patient rows — M12 §7.7 #5)
      expect((await q("SELECT count(*)::int n FROM dosespot_webhook_event"))[0].n).toBeGreaterThanOrEqual(2);
    });
  });

  // ── WEBHOOK / DISPENSE PATH ───────────────────────────────────────────────────────────────────────────
  describe("POST /webhooks/dosespot -> dispense -> m12.medication_order.dispensed_at_pharmacy", () => {
    const sender = new FakeDoseSpotWebhookSender(SECRET_A);
    const senderB = new FakeDoseSpotWebhookSender(SECRET_B);

    async function makeApp(secrets: ReturnType<typeof createEnvWebhookSecretResolver>) {
      const app = Fastify();
      registerDoseSpotWebhookRoute(app, { db: handle.db, outbox, secrets, cipher, log: () => undefined });
      await app.ready();
      return app;
    }
    const configured = () =>
      createEnvWebhookSecretResolver({
        DOSESPOT_WEBHOOK_SECRETS: JSON.stringify({ [ORG_A]: SECRET_A, [ORG_B]: SECRET_B }),
      });
    const body = (org: string, eventId: string, payload: Record<string, unknown>, type = "script_status_update") => ({
      dosespot_event_id: eventId,
      organization_id: org,
      event_type: type,
      occurred_at: "2026-09-29T15:00:00.000Z",
      payload,
    });
    const counts = async () => ({
      receipts: (await q("SELECT count(*)::int n FROM dosespot_webhook_event"))[0].n as number,
      dispenses: (await q("SELECT count(*)::int n FROM medication_order_dispense"))[0].n as number,
      events: (await eventsOf("m12.medication_order.dispensed_at_pharmacy")).length,
    });

    it("UNCONFIGURED: no webhook secret bound -> the route is disabled (503) and touches nothing", async () => {
      const before = await counts();
      const app = await makeApp(createUnboundWebhookSecretResolver());
      const d = sender.delivery(body(ORG_A, `ev-${randomUUID()}`, { dosespot_prescription_id: "x", status: "Dispensed" }));
      const res = await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: d.rawBody, headers: d.headers });
      expect(res.statusCode).toBe(503);
      expect(await counts()).toEqual(before);
      // a malformed env map is also "unconfigured", never a default secret
      const app2 = await makeApp(createEnvWebhookSecretResolver({ DOSESPOT_WEBHOOK_SECRETS: "{not json" }));
      expect((await app2.inject({ method: "POST", url: "/webhooks/dosespot", payload: d.rawBody, headers: d.headers })).statusCode).toBe(503);
      await app.close();
      await app2.close();
    });

    it("a signed Dispensed delivery is persisted (encrypted), dispense recorded, and the event emitted with the REAL publisher", async () => {
      const patientId = await seedPatient(ORG_A);
      const rx = `rx-${randomUUID()}`;
      const orderId = await seedOrder(ORG_A, patientId, rx);
      const app = await makeApp(configured());
      const evId = `ev-${randomUUID()}`;
      const d = sender.delivery(
        body(ORG_A, evId, { dosespot_prescription_id: rx, status: "Dispensed", fill_number: 2, status_at: "2026-09-29T14:30:00.000Z" }),
      );
      const res = await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: d.rawBody, headers: d.headers });
      expect(res.statusCode).toBe(200);

      const receipt = (await q("SELECT * FROM dosespot_webhook_event WHERE dosespot_event_id=$1", [evId]))[0];
      expect(receipt.processing_outcome).toBe("dispense_recorded");
      expect(receipt.body_digest).toBe(createHash("sha256").update(d.rawBody).digest("hex"));
      expect(receipt.raw_body_cipher).not.toContain(rx); // at rest: DEK envelope, never plaintext
      expect(await cipher.decrypt(ORG_A, receipt.raw_body_cipher, receipt.raw_body_dek)).toBe(d.rawBody);

      const disp = (await q("SELECT * FROM medication_order_dispense WHERE dosespot_event_id=$1", [evId]))[0];
      expect(disp).toMatchObject({ medication_order_id: orderId, patient_id: patientId, script_status: "Dispensed", fill_number: 2, dosespot_prescription_id: rx });

      const ev = (await eventsOf("m12.medication_order.dispensed_at_pharmacy", ORG_A)).filter((e) => e.payload.orderId === orderId);
      expect(ev).toHaveLength(1);
      expect(ev[0].payload).toEqual({
        orderId,
        dosespotPrescriptionId: rx,
        dispensedAt: "2026-09-29T14:30:00.000Z",
        dispensingPharmacyMdmId: PHARMACY_MDM,
        fillNumber: 2,
      });
      await app.close();
    });

    it("REDELIVERY: the same vendor event id (even freshly signed) is a 200 no-op — no second receipt, dispense, or event", async () => {
      const patientId = await seedPatient(ORG_A);
      const rx = `rx-${randomUUID()}`;
      await seedOrder(ORG_A, patientId, rx);
      const app = await makeApp(configured());
      const evId = `ev-${randomUUID()}`;
      const payload = { dosespot_prescription_id: rx, status: "PickedUp" };
      const first = sender.delivery(body(ORG_A, evId, payload));
      expect((await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: first.rawBody, headers: first.headers })).statusCode).toBe(200);
      const mid = await counts();
      const again = sender.delivery(body(ORG_A, evId, payload), { nowMs: Date.now() + 1000 });
      expect((await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: again.rawBody, headers: again.headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: first.rawBody, headers: first.headers })).statusCode).toBe(200);
      expect(await counts()).toEqual(mid);
      await app.close();
    });

    it("rejects a bad signature (401), a missing signature (401), a tampered body (401), a stale timestamp (400) and a malformed envelope (400) — nothing persisted, nothing emitted", async () => {
      const patientId = await seedPatient(ORG_A);
      const rx = `rx-${randomUUID()}`;
      await seedOrder(ORG_A, patientId, rx);
      const app = await makeApp(configured());
      const before = await counts();
      const post = (d: { rawBody: string; headers: Record<string, string> }) =>
        app.inject({ method: "POST", url: "/webhooks/dosespot", payload: d.rawBody, headers: d.headers });
      const b = body(ORG_A, `ev-${randomUUID()}`, { dosespot_prescription_id: rx, status: "Dispensed" });

      expect((await post(sender.delivery(b, { secret: "wrong-secret-wrong-secret-wrong" }))).statusCode).toBe(401);
      expect((await post(sender.delivery(b, { omitSignature: true }))).statusCode).toBe(401);
      const signed = sender.delivery(b);
      expect((await post({ ...signed, rawBody: signed.rawBody.replace("Dispensed", "PickedUp") })).statusCode).toBe(401);
      expect((await post(sender.delivery(b, { nowMs: Date.now() - 10 * 60 * 1000 }))).statusCode).toBe(400);
      expect((await post(sender.delivery({ hello: "world" }))).statusCode).toBe(400);
      expect((await post({ rawBody: "not json", headers: { "content-type": "application/json" } })).statusCode).toBe(400);
      expect(await counts()).toEqual(before);
      await app.close();
    });

    it("FORGED TENANT: org A's secret cannot post as org B, and a tenant with no secret is rejected like a bad signature", async () => {
      const app = await makeApp(configured());
      const before = await counts();
      const forged = sender.delivery(body(ORG_B, `ev-${randomUUID()}`, { dosespot_prescription_id: "x", status: "Dispensed" }));
      expect((await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: forged.rawBody, headers: forged.headers })).statusCode).toBe(401);
      const onlyA = await makeApp(createEnvWebhookSecretResolver({ DOSESPOT_WEBHOOK_SECRETS: JSON.stringify({ [ORG_A]: SECRET_A }) }));
      const noSecret = senderB.delivery(body(ORG_B, `ev-${randomUUID()}`, { dosespot_prescription_id: "x", status: "Dispensed" }));
      expect((await onlyA.inject({ method: "POST", url: "/webhooks/dosespot", payload: noSecret.rawBody, headers: noSecret.headers })).statusCode).toBe(401);
      expect(await counts()).toEqual(before);
      await app.close();
      await onlyA.close();
    });

    it("non-dispense statuses and unknown prescriptions are persisted honestly but emit nothing", async () => {
      const patientId = await seedPatient(ORG_A);
      const rx = `rx-${randomUUID()}`;
      await seedOrder(ORG_A, patientId, rx);
      const app = await makeApp(configured());
      const before = await counts();
      const sent = sender.delivery(body(ORG_A, `ev-${randomUUID()}`, { dosespot_prescription_id: rx, status: "Sent" }));
      expect((await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: sent.rawBody, headers: sent.headers })).statusCode).toBe(200);
      const unknown = sender.delivery(body(ORG_A, `ev-${randomUUID()}`, { dosespot_prescription_id: "no-such-rx", status: "Dispensed" }));
      expect((await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: unknown.rawBody, headers: unknown.headers })).statusCode).toBe(200);
      const refill = sender.delivery(body(ORG_A, `ev-${randomUUID()}`, { anything: 1 }, "refill_request"));
      expect((await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: refill.rawBody, headers: refill.headers })).statusCode).toBe(200);
      const after = await counts();
      expect(after.receipts).toBe(before.receipts + 3);
      expect(after.dispenses).toBe(before.dispenses);
      expect(after.events).toBe(before.events);
      const outcomes = (await q("SELECT processing_outcome o FROM dosespot_webhook_event ORDER BY received_at DESC LIMIT 3")).map((r) => r.o);
      expect(outcomes.sort()).toEqual(["event_type_not_handled", "order_not_found", "status_not_handled"]);
      await app.close();
    });

    it("cross-tenant: org B's validly-signed delivery naming org A's prescription id matches nothing (no cross-tenant dispense)", async () => {
      const patientId = await seedPatient(ORG_A);
      const rx = `rx-${randomUUID()}`;
      await seedOrder(ORG_A, patientId, rx);
      const app = await makeApp(configured());
      const before = await counts();
      const d = senderB.delivery(body(ORG_B, `ev-${randomUUID()}`, { dosespot_prescription_id: rx, status: "Dispensed" }));
      expect((await app.inject({ method: "POST", url: "/webhooks/dosespot", payload: d.rawBody, headers: d.headers })).statusCode).toBe(200);
      const after = await counts();
      expect(after.dispenses).toBe(before.dispenses);
      expect(after.events).toBe(before.events);
      expect((await q("SELECT organization_id, processing_outcome FROM dosespot_webhook_event ORDER BY received_at DESC LIMIT 1"))[0]).toEqual({
        organization_id: ORG_B,
        processing_outcome: "order_not_found",
      });
      await app.close();
    });
  });
});
