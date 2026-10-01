/**
 * M12 `handlers-unbound` group — the §2.6 D4 patient-sync / §2.8 D10 MedHx-fetch triggers, over real
 * Postgres. `decidePatientSyncTrigger`/`decideMedHxFetch` (`consumers/sync-triggers.ts`) have been
 * complete, pure, unit-tested deciders since M12-T08 with no job-queue tier for their output to reach.
 *
 * COORDINATION NOTE: a concurrent pass built a SECOND mechanism for the identical six events
 * (`consumers/sync-trigger-bindings.ts` + `jobs/{queues,patient-sync-worker,medhx-fetch-worker}.ts`,
 * pure BullMQ, `jobId: sourceEventId`), already wired into the real composition root. This suite proves
 * THIS pass's mechanism instead (`jobs/{schema,repository,worker,vendor-boundary}.ts` — a Postgres
 * debounce table + fan-out drain worker), which is NOT wired as the active path (see `jobs/index.ts`'s
 * header) but resolves a real gap the other mechanism does not: patient-level debounce across DIFFERENT
 * trigger events, not just exact-redelivery dedup of the identical one.
 *
 * Proves: the partial-unique debounce collapses two close-together triggers onto one pending row; the
 * fan-out drain claims rows per-org (`FOR UPDATE SKIP LOCKED`) and settles them; the `patient_sync` path
 * genuinely reads M5's own schema (a real patient/address/phone snapshot — not a deferred stub) and THEN
 * fails honestly at the (always-unbound-in-this-environment) DoseSpot vendor call; the `medhx_fetch` path
 * fails honestly at the (genuinely-unbuilt) DoseSpot-patient-id resolver; a patient absent under an org
 * settles as a clean `completed` skip, never a failure; and cross-tenant isolation holds.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m12:sync-triggers:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import { isDegradedError } from "@wardenx/dosespot";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dosespotSyncDemographicsForOrg } from "../src/modules/05-patient/index";
import {
  DosespotSyncQueueRepository,
  type EnqueueInput,
  type EnqueueResult,
} from "../src/modules/12-dosespot/jobs/repository";
import { M12DosespotPatientIdUnbound } from "../src/modules/12-dosespot/jobs/vendor-boundary";
import {
  type ActiveOrgListPort,
  type DoseSpotSyncWorkerDeps,
  runDoseSpotSyncQueueDrain,
} from "../src/modules/12-dosespot/jobs/worker";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)(
  "M12 dosespot_sync_queue — jobs/repository + jobs/worker, LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    const providerOf: Record<string, string> = {};
    const locationOf: Record<string, string> = {};

    /** `ROLES` (wardenx_app et al.) are CLUSTER-GLOBAL, not per-database — this suite runs against its own
     *  fresh, dedicated database on a shared Postgres server (per this pass's own instruction never to run
     *  a destructive role reset against a container that might be shared), so it drops/recreates only the
     *  LOCAL `public` schema and leaves the cluster-wide roles alone; migration 0001's own `IF NOT EXISTS`
     *  guards make re-running every migration against a role set that already exists idempotent-safe. */
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

    /** Seed a real M5 patient with a primary current address + phone (the real snapshot the drizzle
     *  resolver reads) — proves `createDrizzlePatientSyncSnapshotResolver` is a genuine read, not a stub. */
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
      await admin.query(
        `INSERT INTO patient_phone (patient_id, organization_id, e164, is_primary) VALUES ($1,$2,'+15035551234', true)`,
        [patientId, org],
      );
      return patientId;
    }

    async function queueRow(id: string): Promise<
      | {
          status: string;
          attempt_count: number;
          last_error: string | null;
          admission_id: string | null;
        }
      | undefined
    > {
      const { rows } = await admin.query(
        "SELECT status, attempt_count, last_error, admission_id FROM dosespot_sync_queue WHERE id=$1",
        [id],
      );
      return rows[0];
    }

    async function pendingCountFor(org: string, kind: string, patientId: string): Promise<number> {
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM dosespot_sync_queue WHERE organization_id=$1 AND kind=$2 AND patient_id=$3 AND status='pending'",
        [org, kind, patientId],
      );
      return rows[0].n as number;
    }

    /** Enqueue through a real `withOrgContext` transaction — the shape every real `OutboxConsumerBinding`
     *  would run inside (the dispatcher wraps `handle()` in one), and the only way an RLS-enforced
     *  `wardenx_app` connection can write this table at all (`app.org_id` must be set for the WITH CHECK to
     *  match). */
    async function enqueueAs(org: string, input: EnqueueInput): Promise<EnqueueResult> {
      return withOrgContext(handle.db, { organizationId: org, userId: USER }, async (tx) => {
        const repo = new DosespotSyncQueueRepository(tx as DbClient);
        return repo.enqueue(input);
      });
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
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m12-sync@x.test')`, [USER]);
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
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
          [USER, org],
        );
      }
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    /**
     * The worker deps exactly as the composition root builds them (apps/backend/src/index.ts,
     * `registerDoseSpotSyncQueueWorker`): M5's REAL org-explicit `dosespotSyncDemographicsForOrg` seam is
     * injected as the `demographicsForOrg` port. The worker refuses to run `patient_sync` without it
     * (M5's patient tables are not readable from M12 directly), so a drain without it never reaches the
     * snapshot read this suite exists to prove. The vendor client stays the unbound deny-stub.
     */
    const workerDeps = (activeOrgs: ActiveOrgListPort): DoseSpotSyncWorkerDeps => ({
      db: handle.db,
      activeOrgs,
      demographicsForOrg: (organizationId, patientId) =>
        dosespotSyncDemographicsForOrg(handle.db, organizationId, patientId),
    });

    it("enqueue() debounces — two triggers for the same patient close together collapse onto one pending row", async () => {
      const patientId = await seedPatient(ORG_A);

      const first = await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "patient_sync",
        reason: "created",
        patientId,
      });
      expect(first.debounced).toBe(false);

      // A DIFFERENT trigger (an `updated` shortly after `created`) for the SAME patient — the case the
      // other (BullMQ jobId=sourceEventId) mechanism does NOT collapse, because each has its own source
      // event id.
      const second = await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "patient_sync",
        reason: "updated",
        patientId,
      });
      expect(second.debounced).toBe(true);
      expect(second.row.id).toBe(first.row.id);

      expect(await pendingCountFor(ORG_A, "patient_sync", patientId)).toBe(1);
    });

    it("a redelivery of the identical event debounces too — the general case, not merely a special one", async () => {
      const patientId = await seedPatient(ORG_A);
      await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "patient_sync",
        reason: "created",
        patientId,
      });
      await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "patient_sync",
        reason: "created",
        patientId,
      });
      expect(await pendingCountFor(ORG_A, "patient_sync", patientId)).toBe(1);
    });

    it("patient_sync: reads the REAL M5 snapshot, then fails honestly at the unbound DoseSpot client", async () => {
      const patientId = await seedPatient(ORG_A);
      const { row } = await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "patient_sync",
        reason: "created",
        patientId,
      });

      const orgs: ActiveOrgListPort = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
      await runDoseSpotSyncQueueDrain(workerDeps(orgs));

      const after = await queueRow(row.id);
      expect(after?.status).toBe("failed");
      expect(after?.attempt_count).toBe(1);
      // The honest, structured INT-009 DegradedError message — not a fabricated success, and not the
      // snapshot-resolver's error either (proving the REAL M5 read succeeded and the vendor call is what
      // failed).
      expect(after?.last_error).toMatch(/e-prescribe is not enabled/i);
    });

    it("patient_sync: a patient absent under this org resolves as a clean 'completed' skip, never a failure", async () => {
      const ghost = randomUUID();
      const { row } = await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "patient_sync",
        reason: "created",
        patientId: ghost,
      });

      const orgs: ActiveOrgListPort = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
      await runDoseSpotSyncQueueDrain(workerDeps(orgs));

      const after = await queueRow(row.id);
      expect(after?.status).toBe("completed");
      expect(after?.last_error).toBeNull();
    });

    it("medhx_fetch: fails honestly at the genuinely-unbuilt DoseSpot-patient-id resolver", async () => {
      const patientId = await seedPatient(ORG_A);
      const admissionId = randomUUID();
      const { row } = await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "medhx_fetch",
        reason: "admission_activated",
        patientId,
        admissionId,
      });
      expect(row.admissionId).toBe(admissionId);

      const orgs: ActiveOrgListPort = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
      await runDoseSpotSyncQueueDrain(workerDeps(orgs));

      const after = await queueRow(row.id);
      expect(after?.status).toBe("failed");
      expect(after?.last_error).toMatch(/no DoseSpot-side patient id is recorded/i);
    });

    it("medhx_fetch (recertification): admission_id is honestly null when the source event carries none", async () => {
      const patientId = await seedPatient(ORG_A);
      const { row } = await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "medhx_fetch",
        reason: "recertification",
        patientId,
        // no admissionId — mirrors `m6.cti.signed`'s real payload, which carries none (see
        // jobs/schema.ts's migration CHECK constraint comment).
      });
      expect(row.admissionId).toBeNull();
      const stored = await queueRow(row.id);
      expect(stored?.admission_id).toBeNull();
    });

    it("cross-tenant isolation: draining org A never claims or touches org B's rows", async () => {
      const patientA = await seedPatient(ORG_A);
      const patientB = await seedPatient(ORG_B);
      const { row: rowA } = await enqueueAs(ORG_A, {
        organizationId: ORG_A,
        kind: "patient_sync",
        reason: "created",
        patientId: patientA,
      });
      const { row: rowB } = await enqueueAs(ORG_B, {
        organizationId: ORG_B,
        kind: "patient_sync",
        reason: "created",
        patientId: patientB,
      });

      // Drain ONLY org A.
      const orgs: ActiveOrgListPort = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
      await runDoseSpotSyncQueueDrain(workerDeps(orgs));

      expect((await queueRow(rowA.id))?.status).toBe("failed"); // processed
      expect((await queueRow(rowB.id))?.status).toBe("pending"); // untouched
    });

    it("isDegradedError narrows the real client's rejection (the worker's own retry/fail branch)", async () => {
      // A direct, lower-level proof of the exact narrowing the worker's catch block performs, independent
      // of the DB — the honest "not configured" contract INT-009 promises.
      const { createUnboundDoseSpotClient } = await import("@wardenx/dosespot");
      const client = createUnboundDoseSpotClient();
      await expect(client.upsertPatient("org", {} as never, "key")).rejects.toSatisfy(
        (e: unknown) => {
          expect(isDegradedError(e)).toBe(true);
          return isDegradedError(e) && e.retryable === false;
        },
      );
    });

    it("M12DosespotPatientIdUnbound carries the patient id and a precise, non-generic reason", () => {
      const err = new M12DosespotPatientIdUnbound("patient-123");
      expect(err.patientId).toBe("patient-123");
      expect(err.message).toMatch(/no.*mapping table/i);
    });
  },
);
