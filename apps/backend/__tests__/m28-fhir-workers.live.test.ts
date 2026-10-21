/**
 * GAP-084 — the M28 §4.8 workers, END TO END over real Postgres as the real NOBYPASSRLS `chartwarden_app` role.
 *
 * Before this change `POST /$export` inserted an `accepted` job that nothing ever ran (the poll answered
 * `output: []` forever), an unreviewed inbound proposal sat `pending` for ever, a rejected proposal's raw FHIR
 * payload outlived its +30-day retention, and `fhir_client_session` was never purged. This suite drives the real
 * entry points (`runBulkExportJob`, `runBulkExportSweeper`, `runInboundSlaWatch`, `runInboundPayloadDestruction`,
 * `runClientSessionSweeper`) through the REAL catalog-validating tx outbox publisher (a payload that disagrees
 * with `M28_OUTBOX_EVENTS` is refused here exactly as at the dispatcher) and proves:
 *   1. an `$export` job is claimed exactly once, projects ONLY its own org's patients (M5's real keyset
 *      enumeration under RLS), writes NDJSON under `tenants/<org>/...` in that org's bucket, completes with a
 *      24h `expires_at`, artifact rows and the `completed` event; a re-run is a no-op
 *   2. cross-tenant: org B's job never sees org A's patients, an explicit `patientIds` naming another tenant's
 *      patient yields nothing, and org B cannot read org A's job / artifact rows under its own RLS context
 *   3. the request-time checks are re-run at execution: a revoked client, a removed scope and a lapsed BAA FAIL
 *      the job with no object written; a D3-suppressed patient surfaces as an OperationOutcome file
 *   4. the per-client one-active-job rule (429) holds under the advisory lock
 *   5. the sweeper expires + purges, purges leftovers of eraser-expired jobs, re-queues orphans, cancels abandoned
 *      jobs, fails stalled ones, never flips a job whose destroy failed, and is per-org
 *   6. the inbound SLA watch expires per the TENANT's SLA, schedules the +30d shred, emits the event once and
 *      raises the alert; the payload destruction shreds only due rejected/expired rows and keeps the digest
 *   7. the session sweeper deletes only sessions past the 90-day retention, per org
 *   8. one org's failure does not stop the others (AggregateError at the end)
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m28:workers:live
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { patientIdsPageForOrg } from "../src/modules/05-patient/index";
import {
  CAPABILITY_RELEASE_TAG,
  M28_OUTBOX_EVENTS,
  buildBulkExportEnqueuePort,
  buildGatewayCapabilityStatement,
  createDrizzleFhirGatewayEraseStore,
  createDrizzleFhirGatewayStore,
  registerM28Workers,
  runBulkExportJob,
  runBulkExportSweeper,
  runCapabilitySnapshotValidator,
  runClientSessionSweeper,
  runInboundPayloadDestruction,
  runInboundSlaWatch,
} from "../src/modules/28-fhir/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date();

describe.skipIf(!DB_URL)("GAP-084 — M28 §4.8 workers — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const clientOf: Record<string, string> = {};
  const patientsOf: Record<string, string[]> = {};
  /** The fake bucket: `${org}|${key}` -> bytes. The adapter contract is "bucket resolved from the org". */
  const bucket = new Map<string, Buffer>();
  const destroyed: { organizationId: string; objectKey: string }[] = [];
  let failDestroy = false;
  const enqueued: { organizationId: string; jobId: string }[] = [];
  const alerts: { organizationId: string; kind: string; correlationId: string }[] = [];
  let baaOn = true;
  let outbox: {
    publish: (tx: unknown, input: Record<string, unknown>) => Promise<void>;
  };

  const objects = {
    async put(a: { organizationId: string; objectKey: string; bytes: Uint8Array }) {
      const buf = Buffer.from(a.bytes);
      bucket.set(`${a.organizationId}|${a.objectKey}`, buf);
      return { sha256Hex: createHash("sha256").update(buf).digest("hex") };
    },
    async presignGet() {
      return { url: "https://minio.test/x", expiresAt: NOW.toISOString() };
    },
    async destroy(a: { organizationId: string; objectKey: string }) {
      if (failDestroy) throw new Error("minio unavailable");
      bucket.delete(`${a.organizationId}|${a.objectKey}`);
      destroyed.push(a);
    },
  };

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

  /** A projection that reads through the worker's tenant context exactly as an owner-module seam would. */
  const project = async (
    ctx: { organizationId: string; recipientClientId: string },
    type: string,
    params: { _id?: string; patient?: string },
  ) => {
    const id = params._id ?? params.patient;
    if (id === undefined || (type !== "Patient" && type !== "Encounter")) {
      return { resources: [], warnings: [] };
    }
    const rows = await withOrgContext(
      handle.db,
      { organizationId: ctx.organizationId, userId: "" },
      async (tx) =>
        (tx as unknown as typeof handle.db)
          .select({ id: schema.patients.id, mrn: schema.patients.mrn })
          .from(schema.patients)
          .where(eq(schema.patients.id, id)),
    );
    const row = rows[0];
    if (row === undefined) return { resources: [], warnings: [] };
    if (row.mrn.startsWith("SUD")) {
      return {
        resources: [],
        warnings: [
          {
            resourceType: "OperationOutcome",
            issue: [
              { severity: "warning", code: "suppressed", details: { text: "Part 2 withheld" } },
            ],
          },
        ],
      };
    }
    return {
      resources: [
        type === "Patient"
          ? { resourceType: "Patient", id: row.id, org: ctx.organizationId }
          : { resourceType: "Encounter", id: `enc-${row.id}`, subject: row.id },
      ],
      warnings: [],
    };
  };

  const workerDeps = () => ({
    db: handle.db,
    outbox,
    objects,
    patients: {
      patientIdsPage: (org: string, after: string | null, limit: number) =>
        patientIdsPageForOrg(handle.db, org, after, limit),
    },
    baa: { isBaaActive: async () => baaOn },
    now: () => NOW,
    project: project as never,
  });
  const orgs = (...ids: string[]) => ({
    listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })),
  });
  const sweeperDeps = (...ids: string[]) => ({
    db: handle.db,
    outbox,
    objects,
    enqueue: {
      enqueue: async (organizationId: string, jobId: string) => {
        enqueued.push({ organizationId, jobId });
      },
    },
    activeOrgs: orgs(...ids),
    now: () => NOW,
  });
  const inboundDeps = (...ids: string[]) => ({
    db: handle.db,
    outbox,
    activeOrgs: orgs(...ids),
    alerts: {
      emit: async (a: { organizationId: string; kind: string; correlationId: string }) => {
        alerts.push(a);
      },
    },
    now: () => NOW,
  });

  async function events(eventType: string, aggregateId: string) {
    return (
      await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
        [eventType, aggregateId],
      )
    ).rows as { organization_id: string; payload: Record<string, unknown> }[];
  }

  async function seedJob(
    org: string,
    over: {
      status?: string;
      createdAgoMs?: number;
      startedAgoMs?: number;
      expiresAtMs?: number;
      types?: string[];
      patientIds?: string[];
    } = {},
  ): Promise<string> {
    const created = new Date(NOW.getTime() - (over.createdAgoMs ?? 0));
    return (
      await admin.query(
        `INSERT INTO fhir_bulk_export_job
           (organization_id, client_id, request_kind, patient_ids, resource_types, request_envelope_sha256,
            status, created_at, started_at, expires_at, completed_at)
         VALUES ($1,$2,'system',$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          org,
          clientOf[org],
          over.patientIds ? JSON.stringify(over.patientIds) : null,
          JSON.stringify(over.types ?? ["Patient"]),
          randomUUID().replace(/-/g, "").padEnd(64, "0"),
          over.status ?? "accepted",
          created,
          over.startedAgoMs === undefined ? null : new Date(NOW.getTime() - over.startedAgoMs),
          over.expiresAtMs === undefined ? null : new Date(over.expiresAtMs),
          over.status === "completed" ? created : null,
        ],
      )
    ).rows[0].id as string;
  }
  async function seedArtifact(org: string, job: string, type: string, key: string) {
    await admin.query(
      `INSERT INTO fhir_bulk_export_artifact (organization_id, job_id, resource_type, minio_object_key, byte_size, row_count, checksum_sha256)
       VALUES ($1,$2,$3,$4,1,1,'abc')`,
      [org, job, type, key],
    );
    if (key !== "") bucket.set(`${org}|${key}`, Buffer.from("x"));
  }
  const jobStatus = async (id: string) =>
    (await admin.query("SELECT status, failure_reason FROM fhir_bulk_export_job WHERE id=$1", [id]))
      .rows[0] as {
      status: string;
      failure_reason: string | null;
    };

  async function seedProposal(
    org: string,
    over: {
      status?: string;
      proposedAgoMs: number;
      decidedAgoMs?: number;
      eraseInMs?: number | null;
      payload?: string;
    },
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO fhir_inbound_resource
           (organization_id, source_client_id, resource_type, payload, payload_sha256, owner_module,
            proposal_status, proposed_at, decided_at, payload_erase_scheduled_at)
         VALUES ($1,$2,'Patient',$3::jsonb,$4,'m5',$5,$6,$7,$8) RETURNING id`,
        [
          org,
          clientOf[org],
          over.payload ?? '{"resourceType":"Patient","name":[{"family":"Doe"}]}',
          createHash("sha256").update(randomUUID()).digest("hex"),
          over.status ?? "pending",
          new Date(NOW.getTime() - over.proposedAgoMs),
          over.decidedAgoMs === undefined ? null : new Date(NOW.getTime() - over.decidedAgoMs),
          over.eraseInMs === undefined || over.eraseInMs === null
            ? null
            : new Date(NOW.getTime() + over.eraseInMs),
        ],
      )
    ).rows[0].id as string;
  }
  const proposal = async (id: string) =>
    (
      await admin.query(
        "SELECT proposal_status, payload, payload_sha256, payload_erase_scheduled_at FROM fhir_inbound_resource WHERE id=$1",
        [id],
      )
    ).rows[0] as {
      proposal_status: string;
      payload: Record<string, unknown>;
      payload_sha256: string;
      payload_erase_scheduled_at: Date | null;
    };

  async function seedSession(org: string, expiredAgoMs: number): Promise<string> {
    const issued = new Date(NOW.getTime() - expiredAgoMs - HOUR_MS);
    return (
      await admin.query(
        `INSERT INTO fhir_client_session (jti, organization_id, client_id, scopes_granted, issued_at, expires_at, token_key_fingerprint)
         VALUES (gen_random_uuid(),$1,$2,'["system/Patient.read"]'::jsonb,$3,$4,'tkf') RETURNING jti`,
        [org, clientOf[org], issued, new Date(NOW.getTime() - expiredAgoMs)],
      )
    ).rows[0].jti as string;
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
    const slaHours: Record<string, number> = { [ORG_A]: 24, [ORG_B]: 72 };
    for (const org of [ORG_A, ORG_B]) {
      await admin.query(
        `INSERT INTO tenant_fhir_config (organization_id, tenant_fhir_host, identifier_uri_base, cursor_signing_key_cipher, inbound_review_sla_hours)
         VALUES ($1,'h.example','https://fhir.example/sid','\\x01'::bytea,$2)`,
        [org, slaHours[org]],
      );
      clientOf[org] = (
        await admin.query(
          `INSERT INTO fhir_client (organization_id, name, type, allowed_scopes, tier, rate_limit_rps, baa_contract_reference, status)
           VALUES ($1,'consumer','api_key','["system/Patient.read","system/Encounter.read"]'::jsonb,'tier-2',10,'BAA-1','active') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      patientsOf[org] = [];
      const mrns = org === ORG_A ? ["A1", "A2", "SUD-A3"] : ["B1", "B2"];
      for (const mrn of mrns) {
        patientsOf[org].push(
          (
            await admin.query(
              `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
               VALUES ($1,$2,'First','Last','1950-01-01','F') RETURNING id`,
              [org, mrn],
            )
          ).rows[0].id as string,
        );
      }
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // THE REAL catalog-validating publisher (not NOOP_OUTBOX), with callerModule pinned to `m28` as boot does.
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M28_OUTBOX_EVENTS]));
    outbox = {
      publish: (tx, input) =>
        publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
          ...(input as unknown as Parameters<typeof publisher.publish>[1]),
          callerModule: "m28",
        }),
    };
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    bucket.clear();
    destroyed.length = 0;
    enqueued.length = 0;
    alerts.length = 0;
    failDestroy = false;
    baaOn = true;
    await admin.query("DELETE FROM fhir_bulk_export_artifact");
    await admin.query("DELETE FROM fhir_bulk_export_job");
    await admin.query("DELETE FROM fhir_inbound_resource");
    await admin.query("DELETE FROM fhir_client_session");
    await admin.query(
      `UPDATE fhir_client SET status='active', allowed_scopes='["system/Patient.read","system/Encounter.read"]'::jsonb`,
    );
  });

  describe("bulk export worker", () => {
    it("claims once, exports ONLY the org's patients under tenants/<org>/, completes with a 24h TTL; a re-run is a no-op", async () => {
      const store = createDrizzleFhirGatewayStore(handle.db, { outbox: outbox as never });
      const created = await store.createJob(ORG_A, {
        clientId: clientOf[ORG_A],
        requestKind: "system",
        resourceTypes: ["Patient", "Encounter"],
        initiatedByMembershipId: null,
      });
      expect(created.status).toBe("accepted");
      expect(await events("m28.fhir.bulk_export.accepted", created.id)).toHaveLength(1);

      const result = await runBulkExportJob(workerDeps(), {
        organizationId: ORG_A,
        jobId: created.id,
      });

      // A1 + A2 for both types; the Part 2 patient contributes no resource but one advisory.
      expect(result).toEqual({ status: "completed", totalResources: 4, artifacts: 3 });
      const rows = (
        await admin.query(
          "SELECT resource_type, minio_object_key, row_count, checksum_sha256, byte_size FROM fhir_bulk_export_artifact WHERE job_id=$1 ORDER BY resource_type",
          [created.id],
        )
      ).rows;
      expect(rows.map((r) => r.resource_type)).toEqual([
        "Encounter",
        "OperationOutcome",
        "Patient",
      ]);
      for (const row of rows) {
        expect(row.minio_object_key).toBe(
          `tenants/${ORG_A}/fhir-exports/${created.id}/${row.resource_type}.ndjson`,
        );
        const bytes = bucket.get(`${ORG_A}|${row.minio_object_key}`);
        expect(bytes).toBeDefined();
        expect(
          createHash("sha256")
            .update(bytes as Buffer)
            .digest("hex"),
        ).toBe(row.checksum_sha256);
        expect(bytes?.length).toBe(row.byte_size);
      }
      // Nothing was written into the other tenant's bucket.
      expect([...bucket.keys()].every((k) => k.startsWith(`${ORG_A}|`))).toBe(true);
      const patientLines = (
        bucket.get(`${ORG_A}|tenants/${ORG_A}/fhir-exports/${created.id}/Patient.ndjson`) as Buffer
      )
        .toString("utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(patientLines.map((l) => l.id).sort()).toEqual(
        [patientsOf[ORG_A][0], patientsOf[ORG_A][1]].sort(),
      );
      expect(patientLines.every((l) => l.org === ORG_A)).toBe(true);

      const job = (
        await admin.query(
          "SELECT status, total_resources, artifact_count, completed_at, expires_at, started_at FROM fhir_bulk_export_job WHERE id=$1",
          [created.id],
        )
      ).rows[0];
      expect(job.status).toBe("completed");
      expect(job.total_resources).toBe(4);
      expect(job.artifact_count).toBe(3);
      expect(new Date(job.expires_at).getTime() - new Date(job.completed_at).getTime()).toBe(
        DAY_MS,
      );
      expect(job.started_at).not.toBeNull();
      const completed = await events("m28.fhir.bulk_export.completed", created.id);
      expect(completed).toHaveLength(1);
      expect(completed[0].organization_id).toBe(ORG_A);

      // Idempotent: the job is no longer `accepted`, so a duplicate delivery claims nothing and writes nothing.
      const before = bucket.size;
      expect(
        await runBulkExportJob(workerDeps(), { organizationId: ORG_A, jobId: created.id }),
      ).toEqual({
        status: "skipped",
      });
      expect(bucket.size).toBe(before);
      expect(await events("m28.fhir.bulk_export.completed", created.id)).toHaveLength(1);
    });

    it("cross-tenant: org B's export carries only B's patients, and B cannot see A's job or artifacts", async () => {
      const jobA = await seedJob(ORG_A);
      const jobB = await seedJob(ORG_B);
      await runBulkExportJob(workerDeps(), { organizationId: ORG_A, jobId: jobA });
      const resultB = await runBulkExportJob(workerDeps(), { organizationId: ORG_B, jobId: jobB });
      expect(resultB).toMatchObject({ status: "completed", totalResources: 2 });
      const lines = (
        bucket.get(`${ORG_B}|tenants/${ORG_B}/fhir-exports/${jobB}/Patient.ndjson`) as Buffer
      )
        .toString("utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).id);
      expect(lines.sort()).toEqual([...patientsOf[ORG_B]].sort());

      // The real chartwarden_app role under B's context sees exactly B's rows.
      const seenByB = await withOrgContext(
        handle.db,
        { organizationId: ORG_B, userId: "" },
        async (tx) => {
          const t = tx as unknown as typeof handle.db;
          return {
            jobs: await t
              .select({ id: schema.fhirBulkExportJob.id })
              .from(schema.fhirBulkExportJob),
            artifacts: await t
              .select({ jobId: schema.fhirBulkExportArtifact.jobId })
              .from(schema.fhirBulkExportArtifact),
          };
        },
      );
      expect(seenByB.jobs.map((j) => j.id)).toEqual([jobB]);
      expect(seenByB.artifacts.every((a) => a.jobId === jobB)).toBe(true);
    });

    it("an explicit patientIds naming ANOTHER tenant's patient exports nothing for it (RLS under the job's org)", async () => {
      const job = await seedJob(ORG_B, { patientIds: [patientsOf[ORG_A][0]], types: ["Patient"] });
      const result = await runBulkExportJob(workerDeps(), { organizationId: ORG_B, jobId: job });
      expect(result).toEqual({ status: "completed", totalResources: 0, artifacts: 0 });
      expect(bucket.size).toBe(0);
    });

    it("a job id from another org is never claimed (the org in the job data is the wall)", async () => {
      const jobA = await seedJob(ORG_A);
      expect(await runBulkExportJob(workerDeps(), { organizationId: ORG_B, jobId: jobA })).toEqual({
        status: "skipped",
      });
      expect((await jobStatus(jobA)).status).toBe("accepted");
    });

    it.each([
      [
        "a revoked client",
        `UPDATE fhir_client SET status='revoked'`,
        "the requesting client is no longer active",
      ],
      [
        "a scope removed after the request",
        `UPDATE fhir_client SET allowed_scopes='["system/Patient.read"]'::jsonb`,
        "scope system/Encounter.read is no longer held by the client",
      ],
    ])("fails the job and writes nothing after %s", async (_label, sql, reason) => {
      const job = await seedJob(ORG_A, { types: ["Patient", "Encounter"] });
      await admin.query(`${sql} WHERE organization_id='${ORG_A}'`);
      const result = await runBulkExportJob(workerDeps(), { organizationId: ORG_A, jobId: job });
      expect(result).toEqual({ status: "failed", reason });
      expect(bucket.size).toBe(0);
      expect(await jobStatus(job)).toEqual({ status: "failed", failure_reason: reason });
      expect(await events("m28.fhir.bulk_export.failed", job)).toHaveLength(1);
    });

    it("fails when the BAA has lapsed", async () => {
      const job = await seedJob(ORG_A);
      baaOn = false;
      const result = await runBulkExportJob(workerDeps(), { organizationId: ORG_A, jobId: job });
      expect(result.status).toBe("failed");
      expect(bucket.size).toBe(0);
    });

    it("a job cancelled before pickup stays cancelled (never claimed)", async () => {
      const job = await seedJob(ORG_A, { status: "cancelled" });
      expect(
        (await runBulkExportJob(workerDeps(), { organizationId: ORG_A, jobId: job })).status,
      ).toBe("skipped");
      expect((await jobStatus(job)).status).toBe("cancelled");
    });

    it("the per-client active-job rule: a second createJob is a 429 until the first is terminal", async () => {
      const store = createDrizzleFhirGatewayStore(handle.db, { outbox: outbox as never });
      const args = {
        clientId: clientOf[ORG_A],
        requestKind: "system" as const,
        resourceTypes: ["Patient"],
        initiatedByMembershipId: null,
      };
      const first = await store.createJob(ORG_A, args);
      await expect(store.createJob(ORG_A, args)).rejects.toMatchObject({ httpStatus: 429 });
      // A concurrent pair for the same client: exactly one wins.
      await store.cancelJob(ORG_A, first.id, null);
      const settled = await Promise.allSettled([
        store.createJob(ORG_A, args),
        store.createJob(ORG_A, args),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
      // The other tenant's client is unaffected.
      await expect(
        store.createJob(ORG_B, { ...args, clientId: clientOf[ORG_B] }),
      ).resolves.toBeDefined();
    });
  });

  describe("BullMQ wiring (needs CHARTWARDEN_TEST_REDIS_URL — a throwaway valkey/valkey:8)", () => {
    it.skipIf(!REDIS_URL)(
      "the producer's deterministic job id reaches the real processor, which completes the job",
      async () => {
        const url = new URL(REDIS_URL as string);
        const connection = { host: url.hostname, port: Number(url.port || 6379) };
        const producer = buildBulkExportEnqueuePort(connection);
        const noop = {} as never;
        const workers = registerM28Workers({
          connection,
          bulkExport: workerDeps(),
          sweeper: { ...sweeperDeps(ORG_A), db: noop },
          inbound: { ...inboundDeps(ORG_A), db: noop },
          sessions: { db: noop, activeOrgs: orgs(ORG_A) },
          capability: {
            db: noop,
            signingKey: undefined,
            buildStatement: buildGatewayCapabilityStatement,
            releaseTag: CAPABILITY_RELEASE_TAG,
          },
        });
        try {
          const job = await seedJob(ORG_A);
          await producer.port.enqueue(ORG_A, job);
          // Re-enqueueing the same job (the sweeper's orphan recovery) is a no-op, never a second run.
          await producer.port.enqueue(ORG_A, job);
          const deadline = Date.now() + 20_000;
          let status = "accepted";
          while (Date.now() < deadline && status !== "completed") {
            await new Promise((r) => setTimeout(r, 250));
            status = (await jobStatus(job)).status;
          }
          expect(status).toBe("completed");
          expect(await events("m28.fhir.bulk_export.completed", job)).toHaveLength(1);
        } finally {
          await Promise.all(workers.map((w) => w.close()));
          await producer.queue.obliterate({ force: true });
          await producer.queue.close();
        }
      },
      40_000,
    );
  });

  describe("bulk export sweeper", () => {
    it("expires a completed job past its TTL, purging its objects first; a fresh one is left alone; a re-run is a no-op", async () => {
      const due = await seedJob(ORG_A, { status: "completed", expiresAtMs: NOW.getTime() - 1000 });
      const fresh = await seedJob(ORG_A, {
        status: "completed",
        expiresAtMs: NOW.getTime() + HOUR_MS,
      });
      const key = (job: string) => `tenants/${ORG_A}/fhir-exports/${job}/Patient.ndjson`;
      await seedArtifact(ORG_A, due, "Patient", key(due));
      await seedArtifact(ORG_A, fresh, "Patient", key(fresh));

      const result = await runBulkExportSweeper(sweeperDeps(ORG_A, ORG_B));
      expect(result.expired).toBe(1);
      expect((await jobStatus(due)).status).toBe("expired");
      expect((await jobStatus(fresh)).status).toBe("completed");
      expect(bucket.has(`${ORG_A}|${key(due)}`)).toBe(false);
      expect(bucket.has(`${ORG_A}|${key(fresh)}`)).toBe(true);
      // The row metadata survives as accounting evidence; only the key is blanked.
      const art = (
        await admin.query(
          "SELECT minio_object_key, row_count, checksum_sha256 FROM fhir_bulk_export_artifact WHERE job_id=$1",
          [due],
        )
      ).rows[0];
      expect(art).toEqual({ minio_object_key: "", row_count: 1, checksum_sha256: "abc" });

      destroyed.length = 0;
      expect((await runBulkExportSweeper(sweeperDeps(ORG_A, ORG_B))).expired).toBe(0);
      expect(destroyed).toHaveLength(0);
    });

    it("does NOT flip a job to expired when a destroy fails; the next tick retries it", async () => {
      const due = await seedJob(ORG_A, { status: "completed", expiresAtMs: NOW.getTime() - 1000 });
      const key = `tenants/${ORG_A}/fhir-exports/${due}/Patient.ndjson`;
      await seedArtifact(ORG_A, due, "Patient", key);
      failDestroy = true;
      await expect(runBulkExportSweeper(sweeperDeps(ORG_A))).rejects.toBeInstanceOf(AggregateError);
      expect((await jobStatus(due)).status).toBe("completed");
      expect(bucket.has(`${ORG_A}|${key}`)).toBe(true);
      failDestroy = false;
      expect((await runBulkExportSweeper(sweeperDeps(ORG_A))).expired).toBe(1);
      expect((await jobStatus(due)).status).toBe("expired");
    });

    it("purges the objects of a job the offboarding eraser flipped to expired without touching MinIO", async () => {
      const erased = await seedJob(ORG_B, { status: "expired" });
      const key = `tenants/${ORG_B}/fhir-exports/${erased}/Patient.ndjson`;
      await seedArtifact(ORG_B, erased, "Patient", key);
      await runBulkExportSweeper(sweeperDeps(ORG_A, ORG_B));
      expect(bucket.has(`${ORG_B}|${key}`)).toBe(false);
      expect(destroyed).toEqual([{ organizationId: ORG_B, objectKey: key }]);
    });

    it("re-queues an orphaned accepted job, cancels an abandoned one, and fails a stalled in-progress one", async () => {
      const orphan = await seedJob(ORG_A, { status: "accepted", createdAgoMs: 10 * 60 * 1000 });
      const young = await seedJob(ORG_B, { status: "accepted", createdAgoMs: 30 * 1000 });
      const abandoned = await seedJob(ORG_B, { status: "accepted", createdAgoMs: 2 * DAY_MS });
      const stalled = await seedJob(ORG_A, { status: "in_progress", startedAgoMs: 2 * HOUR_MS });
      const running = await seedJob(ORG_B, { status: "in_progress", startedAgoMs: 5 * 60 * 1000 });

      const result = await runBulkExportSweeper(sweeperDeps(ORG_A, ORG_B));

      expect(result).toMatchObject({ requeued: 1, abandonedCancelled: 1, stalledFailed: 1 });
      expect(enqueued).toEqual([{ organizationId: ORG_A, jobId: orphan }]);
      expect((await jobStatus(young)).status).toBe("accepted");
      expect((await jobStatus(abandoned)).status).toBe("cancelled");
      expect(await events("m28.fhir.bulk_export.cancelled", abandoned)).toHaveLength(1);
      expect((await jobStatus(stalled)).status).toBe("failed");
      expect(await events("m28.fhir.bulk_export.failed", stalled)).toHaveLength(1);
      expect((await jobStatus(running)).status).toBe("in_progress");
    });
  });

  describe("inbound SLA watch", () => {
    it("expires per the TENANT's SLA (A=24h, B=72h), schedules the +30d shred, emits once, alerts; re-run is a no-op", async () => {
      const aLate = await seedProposal(ORG_A, { proposedAgoMs: 30 * HOUR_MS });
      const aFresh = await seedProposal(ORG_A, { proposedAgoMs: HOUR_MS });
      const bSame30h = await seedProposal(ORG_B, { proposedAgoMs: 30 * HOUR_MS });
      const bLate = await seedProposal(ORG_B, { proposedAgoMs: 80 * HOUR_MS });
      const accepted = await seedProposal(ORG_A, {
        status: "accepted",
        proposedAgoMs: 90 * HOUR_MS,
      });

      const result = await runInboundSlaWatch(inboundDeps(ORG_A, ORG_B));

      expect(result.expired).toBe(2);
      expect((await proposal(aLate)).proposal_status).toBe("expired");
      expect((await proposal(aFresh)).proposal_status).toBe("pending");
      expect((await proposal(bSame30h)).proposal_status).toBe("pending");
      expect((await proposal(bLate)).proposal_status).toBe("expired");
      expect((await proposal(accepted)).proposal_status).toBe("accepted");
      const scheduled = (await proposal(aLate)).payload_erase_scheduled_at as Date;
      expect(scheduled.getTime()).toBe(NOW.getTime() + 30 * DAY_MS);
      expect((await events("m28.fhir.inbound.expired", aLate))[0].organization_id).toBe(ORG_A);
      expect(await events("m28.fhir.inbound.expired", bLate)).toHaveLength(1);
      expect(alerts).toHaveLength(2);
      expect(alerts.find((a) => a.organizationId === ORG_A)).toMatchObject({
        kind: "fhir.inbound.proposal_overdue",
        correlationId: `fhir-inbound-overdue-${aLate}`,
      });

      alerts.length = 0;
      expect((await runInboundSlaWatch(inboundDeps(ORG_A, ORG_B))).expired).toBe(0);
      expect(await events("m28.fhir.inbound.expired", aLate)).toHaveLength(1);
      expect(alerts).toHaveLength(0);
    });

    it("one org's failure does not stop the others, and the tick still fails loudly", async () => {
      const aLate = await seedProposal(ORG_A, { proposedAgoMs: 30 * HOUR_MS });
      const bLate = await seedProposal(ORG_B, { proposedAgoMs: 80 * HOUR_MS });
      const flaky = {
        ...inboundDeps(ORG_A, ORG_B),
        outbox: {
          publish: async (tx: unknown, input: Record<string, unknown>) => {
            if (input.organizationId === ORG_A) throw new Error("outbox down for A");
            return outbox.publish(tx, input);
          },
        },
      };
      await expect(runInboundSlaWatch(flaky)).rejects.toBeInstanceOf(AggregateError);
      expect((await proposal(aLate)).proposal_status).toBe("pending"); // rolled back with its event
      expect((await proposal(bLate)).proposal_status).toBe("expired");
    });
  });

  describe("inbound payload destruction", () => {
    it("shreds only due rejected/expired payloads, keeps the digest, never touches accepted/pending, is idempotent", async () => {
      const dueExpired = await seedProposal(ORG_A, {
        status: "expired",
        proposedAgoMs: 40 * DAY_MS,
        eraseInMs: -HOUR_MS,
      });
      const notYet = await seedProposal(ORG_A, {
        status: "expired",
        proposedAgoMs: 5 * DAY_MS,
        eraseInMs: 25 * DAY_MS,
      });
      const rejectedLegacy = await seedProposal(ORG_B, {
        status: "rejected",
        proposedAgoMs: 40 * DAY_MS,
        decidedAgoMs: 31 * DAY_MS,
        eraseInMs: null,
      });
      const rejectedRecent = await seedProposal(ORG_B, {
        status: "rejected",
        proposedAgoMs: 10 * DAY_MS,
        decidedAgoMs: 5 * DAY_MS,
        eraseInMs: null,
      });
      const accepted = await seedProposal(ORG_A, {
        status: "accepted",
        proposedAgoMs: 60 * DAY_MS,
        decidedAgoMs: 59 * DAY_MS,
        eraseInMs: -DAY_MS,
      });
      const pending = await seedProposal(ORG_B, {
        status: "pending",
        proposedAgoMs: 60 * DAY_MS,
        eraseInMs: -DAY_MS,
      });
      const sha = (await proposal(dueExpired)).payload_sha256;

      expect((await runInboundPayloadDestruction(inboundDeps(ORG_A, ORG_B))).destroyed).toBe(2);

      expect((await proposal(dueExpired)).payload).toEqual({ _destroyed: true });
      expect((await proposal(dueExpired)).payload_sha256).toBe(sha);
      expect((await proposal(rejectedLegacy)).payload).toEqual({ _destroyed: true });
      for (const keep of [notYet, rejectedRecent, accepted, pending]) {
        expect((await proposal(keep)).payload).toMatchObject({ resourceType: "Patient" });
      }
      expect((await runInboundPayloadDestruction(inboundDeps(ORG_A, ORG_B))).destroyed).toBe(0);
    });

    it("a rejection recorded through the real store now schedules its own +30d shred", async () => {
      const id = await seedProposal(ORG_A, { proposedAgoMs: HOUR_MS });
      // (A real membership id now works too — see "admin writes with a REAL membership id" below; this test
      // only exercises the shred scheduling, so a plain uuid stands in as the decider.)
      const actor = "99999999-9999-9999-9999-999999999999";
      await admin.query(
        "INSERT INTO \"user\" (id,email) VALUES ($1,'m28w@x.test') ON CONFLICT DO NOTHING",
        [actor],
      );
      const store = createDrizzleFhirGatewayStore(handle.db, { outbox: outbox as never });
      await store.rejectProposal(ORG_A, id, actor, "r".repeat(45));
      const row = await proposal(id);
      expect(row.proposal_status).toBe("rejected");
      const delta = (row.payload_erase_scheduled_at as Date).getTime() - Date.now();
      expect(delta).toBeGreaterThan(29 * DAY_MS);
      expect(delta).toBeLessThanOrEqual(30 * DAY_MS);
    });
  });

  describe("client session sweeper", () => {
    it("deletes only sessions expired past the 90-day retention, per org", async () => {
      const oldA = await seedSession(ORG_A, 100 * DAY_MS);
      const recentA = await seedSession(ORG_A, 10 * DAY_MS);
      const liveA = await seedSession(ORG_A, -HOUR_MS);
      const oldB = await seedSession(ORG_B, 120 * DAY_MS);

      expect(
        await runClientSessionSweeper({
          db: handle.db,
          activeOrgs: orgs(ORG_A, ORG_B),
          now: () => NOW,
        }),
      ).toBe(2);

      const left = (await admin.query("SELECT jti FROM fhir_client_session")).rows.map(
        (r) => r.jti,
      );
      expect(left.sort()).toEqual([recentA, liveA].sort());
      expect(left).not.toContain(oldA);
      expect(left).not.toContain(oldB);
      expect(
        await runClientSessionSweeper({
          db: handle.db,
          activeOrgs: orgs(ORG_A, ORG_B),
          now: () => NOW,
        }),
      ).toBe(0);
    });
  });
  describe("admin writes with a REAL membership id (audit actor is the user, never the membership)", () => {
    const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const MEMBERSHIP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const asRequest = <T>(fn: () => Promise<T>) =>
      runWithRequestContext({ organizationId: ORG_A, userId: USER }, fn);
    const actorsOf = async (resourceId: string) =>
      (
        await admin.query(
          "SELECT actor_user_id FROM audit_event WHERE organization_id=$1 AND resource_id=$2",
          [ORG_A, resourceId],
        )
      ).rows.map((r) => r.actor_user_id as string | null);

    beforeAll(async () => {
      await admin.query(
        "INSERT INTO \"user\" (id,email) VALUES ($1,'m28-real@x.test') ON CONFLICT DO NOTHING",
        [USER],
      );
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active') ON CONFLICT DO NOTHING",
        [MEMBERSHIP, USER, ORG_A],
      );
    });

    it("accept / reject / cancel / revoke succeed as chartwarden_app and the audit actor is the request's USER", async () => {
      const store = createDrizzleFhirGatewayStore(handle.db, { outbox: outbox as never });
      const toAccept = await seedProposal(ORG_A, { proposedAgoMs: HOUR_MS });
      const toReject = await seedProposal(ORG_A, { proposedAgoMs: HOUR_MS });

      const accepted = await asRequest(() =>
        store.acceptProposal(ORG_A, toAccept, MEMBERSHIP, randomUUID(), "matched to the chart"),
      );
      expect(accepted.proposalStatus).toBe("accepted");
      await asRequest(() => store.rejectProposal(ORG_A, toReject, MEMBERSHIP, "r".repeat(45)));
      const job = await store.createJob(ORG_A, {
        clientId: clientOf[ORG_A],
        requestKind: "system",
        resourceTypes: ["Patient"],
        initiatedByMembershipId: MEMBERSHIP,
      });
      await asRequest(() => store.cancelJob(ORG_A, job.id, MEMBERSHIP));
      await asRequest(() => store.revokeClient(ORG_A, clientOf[ORG_A], MEMBERSHIP, "rotated away"));

      // The accountable MEMBERSHIP is stamped on the row; the AUDIT actor is the user.
      const decided = await admin.query(
        "SELECT decided_by_membership_id FROM fhir_inbound_resource WHERE id=$1",
        [toAccept],
      );
      expect(decided.rows[0].decided_by_membership_id).toBe(MEMBERSHIP);
      // The inbound table audits through the PHI trigger, which records `app.user_id` as the actor (the job
      // and client tables use the baseline trigger, which records no actor — their writes just must succeed).
      for (const id of [toAccept, toReject]) {
        const actors = await actorsOf(id);
        expect(actors).toContain(USER);
        expect(actors).not.toContain(MEMBERSHIP);
      }
      expect((await jobStatus(job.id)).status).toBe("cancelled");
      const revoked = await admin.query("SELECT status FROM fhir_client WHERE id=$1", [
        clientOf[ORG_A],
      ]);
      expect(revoked.rows[0].status).toBe("revoked");
    });

    it("outside a request (no ambient actor) the same writes record the NULL system actor — still valid", async () => {
      const store = createDrizzleFhirGatewayStore(handle.db, { outbox: outbox as never });
      const id = await seedProposal(ORG_A, { proposedAgoMs: HOUR_MS });
      await store.rejectProposal(ORG_A, id, MEMBERSHIP, "r".repeat(45));
      const actors = await actorsOf(id);
      expect(actors.length).toBeGreaterThan(0);
      expect(actors.every((a) => a === null)).toBe(true);
    });
  });

  describe("offboarding eraser", () => {
    it("a second erase is a no-op (count 0); the destroyed marker is read from the payload, not the digest", async () => {
      const store = createDrizzleFhirGatewayEraseStore(handle.db);
      const live = await seedProposal(ORG_A, { proposedAgoMs: HOUR_MS });
      const alreadyShredded = await seedProposal(ORG_A, {
        proposedAgoMs: HOUR_MS,
        status: "rejected",
        decidedAgoMs: HOUR_MS,
        payload: '{"_destroyed":true}',
      });
      const orgBRow = await seedProposal(ORG_B, { proposedAgoMs: HOUR_MS });
      const sha = (await proposal(live)).payload_sha256;

      const first = await store.eraseOrg(ORG_A);
      expect(first).toBeGreaterThan(0);
      expect((await proposal(live)).payload).toEqual({ _destroyed: true });
      expect((await proposal(live)).payload_sha256).toBe(sha);
      expect((await proposal(alreadyShredded)).payload).toEqual({ _destroyed: true });
      // Cross-tenant: org B's payload is untouched by org A's erase.
      expect((await proposal(orgBRow)).payload).toMatchObject({ resourceType: "Patient" });

      expect(await store.eraseOrg(ORG_A)).toBe(0);
      expect(await store.eraseOrg(ORG_A)).toBe(0);
    });

    it("flips the jobs to expired without touching MinIO; the sweeper then purges them (no duplicate purge in the eraser)", async () => {
      const job = await seedJob(ORG_A, {
        status: "completed",
        expiresAtMs: NOW.getTime() + DAY_MS,
      });
      await seedArtifact(ORG_A, job, "Patient", `tenants/${ORG_A}/exports/${job}/Patient.ndjson`);

      await createDrizzleFhirGatewayEraseStore(handle.db).eraseOrg(ORG_A);
      expect((await jobStatus(job)).status).toBe("expired");
      expect(bucket.size).toBe(1); // the eraser never touches the object store

      // `expired` counts status FLIPS; the job was already flipped by the eraser, so the leftover purge shows
      // in the bucket and the blanked key, not in that counter.
      await runBulkExportSweeper(sweeperDeps(ORG_A));
      expect(bucket.size).toBe(0);
      const keys = await admin.query(
        "SELECT minio_object_key FROM fhir_bulk_export_artifact WHERE job_id=$1",
        [job],
      );
      expect(keys.rows.map((r) => r.minio_object_key)).toEqual([""]);
    });
  });

  describe("fhir.capability-snapshot-validator", () => {
    let platform: ReturnType<typeof createDbClient>;
    const signingKey = "k".repeat(40);
    const deps = (over: Record<string, unknown> = {}) => ({
      db: handle.db,
      runPlatform: <T>(fn: (tx: typeof handle.db) => Promise<T>) =>
        platform.db.transaction((tx) => fn(tx as unknown as typeof handle.db)),
      signingKey,
      buildStatement: buildGatewayCapabilityStatement,
      releaseTag: CAPABILITY_RELEASE_TAG,
      ...over,
    });
    const snapshotRows = async () =>
      (await admin.query("SELECT id, checksum_sha256 FROM fhir_capability_snapshot")).rows;

    beforeAll(() => {
      // The platform pool (superuser here: the audited platform credential's grants are provisioned by
      // scripts/db/provision-runtime-roles.ts, outside the migration chain).
      platform = createDbClient({ connectionString: DB_URL as string });
    });
    afterAll(async () => {
      await platform?.close();
    });
    beforeEach(async () => {
      await admin.query("DELETE FROM fhir_capability_snapshot");
    });

    it("persists exactly one signed snapshot per release, verifies it, and a re-run (or a concurrent pair) writes nothing", async () => {
      const [a, b] = await Promise.all([
        runCapabilitySnapshotValidator(deps()),
        runCapabilitySnapshotValidator(deps()),
      ]);
      expect([a.persisted, b.persisted].filter(Boolean)).toHaveLength(1);
      expect(await snapshotRows()).toHaveLength(1);

      const again = await runCapabilitySnapshotValidator(deps());
      expect(again).toEqual({ persisted: false, verified: 1, drifted: false });
      expect(await snapshotRows()).toHaveLength(1);
      // The tenant role can read the platform-shared row but cannot write it (writes are platform-only).
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, async (tx) =>
          (tx as unknown as typeof handle.db).insert(schema.fhirCapabilitySnapshot).values({
            fhirVersion: "4.0.1",
            releaseTag: "forged",
            capabilityStatement: {},
            checksumSha256: "x",
            signature: Buffer.from("x"),
          }),
        ),
      ).rejects.toThrow();
    });

    it("FAILS the tick when the persisted statement is tampered with", async () => {
      await runCapabilitySnapshotValidator(deps());
      await admin.query(
        `UPDATE fhir_capability_snapshot SET capability_statement = jsonb_set(capability_statement, '{status}', '"retired"')`,
      );
      await expect(runCapabilitySnapshotValidator(deps())).rejects.toThrow(
        /failed signature verification/,
      );
    });

    it("FAILS when the signature was made with another key, and when no key is bound", async () => {
      await runCapabilitySnapshotValidator(deps());
      await expect(
        runCapabilitySnapshotValidator(deps({ signingKey: "z".repeat(40) })),
      ).rejects.toThrow(/failed signature verification/);
      await expect(runCapabilitySnapshotValidator(deps({ signingKey: undefined }))).rejects.toThrow(
        /FHIR_CAPABILITY_SIGNING_KEY is not bound/,
      );
    });

    it("reports (does not fail on) drift when the served statement changed under the same release tag", async () => {
      await runCapabilitySnapshotValidator(deps());
      const drifted = await runCapabilitySnapshotValidator(
        deps({
          buildStatement: () => ({ ...buildGatewayCapabilityStatement(), date: "2030-01-01" }),
        }),
      );
      expect(drifted).toMatchObject({ persisted: false, verified: 1, drifted: true });
    });

    it("without a platform pool it verifies but persists nothing", async () => {
      const r = await runCapabilitySnapshotValidator(deps({ runPlatform: undefined }));
      expect(r).toEqual({ persisted: false, verified: 0, drifted: false });
      expect(await snapshotRows()).toHaveLength(0);
    });
  });
});
