/**
 * M4 §4.4 `audit.seal_partition` + `audit.integrity_sample` (the batch-11 GAP-014 deferral) — LIVE Postgres as
 * the real NOBYPASSRLS `wardenx_app` role. Proves on a real database:
 *   1. a disabled org is `skipped` (recorded, never a clean pass) and nothing is sealed;
 *   2. closed months are sealed in order, each linked to the previous seal; the open month is never sealed;
 *   3. an intact chain verifies (`match`);
 *   4. a row altered out of band (as superuser — the app role cannot, asserted) is DETECTED: the run is
 *      `mismatch`, evidence is committed, an `audit.integrity_mismatch` critical audit event is written, the
 *      M36 alert is emitted and the job THROWS (fail closed);
 *   5. an inserted row, a deleted row and a tampered seal link are each detected;
 *   6. an alert-emit failure still fails the job after the evidence row is committed;
 *   7. org isolation: org B's chain is independent and still `match`;
 *   8. a month covered by an executed destruction certificate is exempt (legitimately erased rows);
 *   9. `GET /api/v1/audit/integrity/report` shows `sealChain.contiguous=false` + `brokenAt` for the tampered org.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m4:audit-integrity:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbAuditChainReader } from "@chartwarden/audit";
import {
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleSeams } from "../src/index";
import { mountAuditRoutes } from "../src/modules/04-audit/index";
import {
  AUDIT_INTEGRITY_ALERT_TYPE,
  type AuditIntegrityDeps,
  AuditIntegrityMismatchError,
  runIntegritySampleForOrg,
  runSealPartitionsForOrg,
} from "../src/modules/04-audit/jobs/audit-integrity-job";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_report_writer",
];

const ORG_A = "11111111-1111-4111-8111-111111a40401";
const ORG_B = "11111111-1111-4111-8111-111111b40401";
const USER = "22222222-2222-4222-8222-222222a40401";
const SESSION = "sess-m4-integrity";
/** Months 2026-03 … 2026-05 are closed at NOW; the system clock's own month (open) is never sealed. */
const NOW = new Date("2026-06-10T12:00:00Z");
const MONTHS = ["2026-03", "2026-04", "2026-05"] as const;

describe.skipIf(!DB_URL)("M4 audit hash-chain seal + sampled verification — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const alerts: Array<{ orgId: string; eventType: string; severity: string; payload: unknown }> =
    [];
  let flags: Record<string, boolean> = {};
  let failAlert = false;
  let clockTicks = 0;

  const deps = (over: Partial<AuditIntegrityDeps> = {}): AuditIntegrityDeps => ({
    db: handle.db,
    listOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    reader: createDbAuditChainReader(handle.db),
    alerts: {
      async emit(orgId, input) {
        if (failAlert) throw new Error("alert transport down");
        alerts.push({ orgId, ...input });
      },
    },
    isHashChainEnabled: (organizationId) => flags[organizationId] === true,
    sampleSize: 10, // every sealed month, so the test does not depend on the random draw
    // strictly increasing, so run rows order deterministically (finished_at is the report's sort key)
    now: () => new Date(NOW.getTime() + clockTicks++ * 1000),
    ...over,
  });

  async function seedEvents(
    organizationId: string,
    month: string,
    count: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= count; i += 1) {
      const day = String(i).padStart(2, "0");
      const { rows } = await admin.query(
        `INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind,
           resource_id, outcome, severity, before, after, context, correlation_id, retention_class, created_at)
         VALUES ($1,$2,'user','patient.updated','patient', gen_random_uuid(),'success','info',
           '{"status":"a"}','{"status":"b","n":1}', $5::jsonb, $3, 'compliance',
           ($4 || '-' || $6 || 'T10:00:00.123456Z')::timestamptz)
         RETURNING id`,
        [organizationId, USER, `corr-${month}-${i}`, month, JSON.stringify({ i, month }), day],
      );
      ids.push(rows[0].id);
    }
    return ids;
  }

  const sealsOf = async (organizationId: string) =>
    (
      await admin.query(
        "SELECT partition, prev_chain_hash, chain_hash, event_count FROM audit_seal WHERE organization_id=$1 ORDER BY partition",
        [organizationId],
      )
    ).rows;

  const runsOf = async (organizationId: string, kind = "sample") =>
    (
      await admin.query(
        "SELECT result, mismatches, detail, seals_total, events_hashed, backup_cross_reference FROM audit_integrity_run WHERE organization_id=$1 AND kind=$2 ORDER BY finished_at, id",
        [organizationId, kind],
      )
    ).rows;

  const idsByMonth: Record<string, string[]> = {};

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'m4i-a','A','A','active'),($2,'m4i-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m4i@x.test')`, [USER]);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    for (const month of MONTHS) idsByMonth[month] = await seedEvents(ORG_A, month, 4);
    await seedEvents(ORG_B, "2026-04", 3);
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("is SKIPPED (recorded, nothing sealed) while audit_hash_chain_enabled is off", async () => {
    const out = await runIntegritySampleForOrg(deps(), ORG_A);
    expect(out.result).toBe("skipped");
    expect(await sealsOf(ORG_A)).toHaveLength(0);
    const runs = await runsOf(ORG_A);
    expect(runs.at(-1)).toMatchObject({ result: "skipped" });
    expect(runs.at(-1).backup_cross_reference).toBe("unavailable_no_backup_reader");
    expect(alerts).toHaveLength(0);
  });

  it("seals the closed months in order, each linked to the previous seal, and never the open month", async () => {
    flags = { [ORG_A]: true, [ORG_B]: true };
    const { sealed } = await runSealPartitionsForOrg(deps(), ORG_A);
    expect(sealed).toEqual([...MONTHS]);
    const seals = await sealsOf(ORG_A);
    expect(seals.map((s) => s.partition)).toEqual(
      MONTHS.map((m) => `audit_event_${m.replace("-", "_")}`),
    );
    expect(seals[0].prev_chain_hash).toBeNull();
    expect(seals[1].prev_chain_hash).toBe(seals[0].chain_hash);
    expect(seals[2].prev_chain_hash).toBe(seals[1].chain_hash);
    expect(seals.every((s) => s.event_count === 4)).toBe(true);
    // idempotent: a second pass seals nothing new
    expect((await runSealPartitionsForOrg(deps(), ORG_A)).sealed).toEqual([]);
    expect((await runsOf(ORG_A, "seal"))[0]).toMatchObject({ result: "match" });
    // org B has its own independent chain
    expect((await runSealPartitionsForOrg(deps(), ORG_B)).sealed).toEqual(["2026-04"]);
    expect((await sealsOf(ORG_B))[0].prev_chain_hash).toBeNull();
  });

  it("verifies an intact chain as `match`", async () => {
    const out = await runIntegritySampleForOrg(deps(), ORG_A);
    expect(out).toMatchObject({
      result: "match",
      sealsTotal: 3,
      sealsSampled: 3,
      eventsHashed: 12,
    });
    expect(alerts).toHaveLength(0);
  });

  it("the app role cannot rewrite the log or the seals (append-only grants)", async () => {
    const asApp = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await asApp.connect();
    try {
      await expect(asApp.query("UPDATE audit_event SET event_type='x'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(asApp.query("DELETE FROM audit_seal")).rejects.toThrow(/permission denied/);
      await expect(asApp.query("UPDATE audit_integrity_run SET result='match'")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await asApp.end();
    }
  });

  it("DETECTS a row altered out of band: mismatch row + critical audit event + M36 alert + the job THROWS", async () => {
    const victim = idsByMonth["2026-04"]?.[1] as string;
    const upd = await admin.query(
      `UPDATE audit_event SET after = '{"status":"tampered"}'::jsonb WHERE id = $1 AND organization_id = $2`,
      [victim, ORG_A],
    );
    expect(upd.rowCount).toBe(1);

    const err = await runIntegritySampleForOrg(deps(), ORG_A).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditIntegrityMismatchError);
    expect((err as AuditIntegrityMismatchError).breaks).toEqual([
      { partition: "audit_event_2026_04", reason: "chain_hash_mismatch" },
    ]);

    const run = (await runsOf(ORG_A)).at(-1);
    expect(run).toMatchObject({ result: "mismatch", mismatches: 1 });
    expect(run.detail.breaks).toEqual([
      { partition: "audit_event_2026_04", reason: "chain_hash_mismatch" },
    ]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      orgId: ORG_A,
      eventType: AUDIT_INTEGRITY_ALERT_TYPE,
      severity: "critical",
    });

    const ev = await admin.query(
      `SELECT severity::text AS severity, outcome::text AS outcome, organization_id FROM audit_event
        WHERE event_type='audit.integrity_mismatch' AND organization_id=$1`,
      [ORG_A],
    );
    expect(ev.rows).toEqual([{ severity: "critical", outcome: "failure", organization_id: ORG_A }]);
  });

  it("org isolation: org B's chain is independent and still verifies", async () => {
    const out = await runIntegritySampleForOrg(deps(), ORG_B);
    expect(out).toMatchObject({ result: "match", sealsTotal: 1, eventsHashed: 3 });
  });

  it("an alert transport failure still FAILS the job, after the evidence row is committed", async () => {
    const before = (await runsOf(ORG_A)).length;
    failAlert = true;
    try {
      await expect(runIntegritySampleForOrg(deps(), ORG_A)).rejects.toThrow(/alert transport down/);
    } finally {
      failAlert = false;
    }
    const runs = await runsOf(ORG_A);
    expect(runs).toHaveLength(before + 1);
    expect(runs.at(-1)).toMatchObject({ result: "mismatch" });
  });

  it("the report route shows the broken chain for the tampered org", async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG_A,
          userId: USER,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["audit.integrity"],
            },
          ],
        },
      ]).store,
    );
    const { store: sessionStore } = createInMemorySessionContextStore([]);
    wireModuleSeams({ sessionContextStore: sessionStore });
    const headerAuth = (request: FastifyRequest): void => {
      request.context.userId = USER;
      request.context.organizationId = ORG_A;
      request.context.roles = ["compliance"];
      request.context.attributes = { sessionId: SESSION };
    };
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountAuditRoutes(app, handle.db);
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/audit/integrity/report" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.appendOnly.grantsVerified).toBe(true);
      expect(body.sealChain).toEqual({
        contiguous: false,
        lastSealedPartition: "audit_event_2026_05",
        brokenAt: "audit_event_2026_04",
      });
      expect(body.integritySample).toMatchObject({
        result: "mismatch",
        sealsTotal: 3,
        backupCrossReference: "unavailable_no_backup_reader",
      });
    } finally {
      await app.close();
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
    }
  });

  it("detects an INSERTED row, a DELETED row and a tampered seal link in turn", async () => {
    // restore the altered row so each scenario is isolated
    await admin.query(
      `UPDATE audit_event SET after = '{"status":"b","n":1}'::jsonb WHERE id = $1`,
      [idsByMonth["2026-04"]?.[1]],
    );
    expect(await runIntegritySampleForOrg(deps(), ORG_A).then((o) => o.result)).toBe("match");

    const inserted = await seedEvents(ORG_A, "2026-05", 5); // 5 more rows in a SEALED month
    await expect(runIntegritySampleForOrg(deps(), ORG_A)).rejects.toBeInstanceOf(
      AuditIntegrityMismatchError,
    );
    expect((await runsOf(ORG_A)).at(-1).detail.breaks).toEqual([
      { partition: "audit_event_2026_05", reason: "event_count_mismatch" },
    ]);
    await admin.query(`DELETE FROM audit_event WHERE id = ANY($1::uuid[])`, [inserted]);
    expect(await runIntegritySampleForOrg(deps(), ORG_A).then((o) => o.result)).toBe("match");

    const del = await admin.query(`DELETE FROM audit_event WHERE id = $1`, [
      idsByMonth["2026-03"]?.[0],
    ]);
    expect(del.rowCount).toBe(1);
    await expect(runIntegritySampleForOrg(deps(), ORG_A)).rejects.toBeInstanceOf(
      AuditIntegrityMismatchError,
    );
    expect((await runsOf(ORG_A)).at(-1).detail.breaks[0]).toMatchObject({
      partition: "audit_event_2026_03",
    });
  });

  it("a tampered seal (broken prev_chain_hash link) is detected without recomputing rows", async () => {
    await admin.query(
      `UPDATE audit_seal SET prev_chain_hash = 'deadbeef' WHERE organization_id=$1 AND partition='audit_event_2026_05'`,
      [ORG_A],
    );
    await expect(runIntegritySampleForOrg(deps({ sampleSize: 1 }), ORG_A)).rejects.toBeInstanceOf(
      AuditIntegrityMismatchError,
    );
    const breaks = (await runsOf(ORG_A)).at(-1).detail.breaks as Array<{
      partition: string;
      reason: string;
    }>;
    expect(breaks).toContainEqual({
      partition: "audit_event_2026_05",
      reason: "prev_link_mismatch",
    });
  });

  it("a month covered by an executed audit destruction certificate is exempt (rows were legitimately erased)", async () => {
    // Org B: corrupt its sealed month, then record an executed destruction covering it.
    await admin.query(
      `UPDATE audit_event SET event_type='tampered.event' WHERE organization_id=$1 AND created_at < '2026-05-01'`,
      [ORG_B],
    );
    await expect(runIntegritySampleForOrg(deps(), ORG_B)).rejects.toBeInstanceOf(
      AuditIntegrityMismatchError,
    );
    await admin.query(
      `INSERT INTO destruction_certificate (organization_id, data_class, record_count, date_range_start, date_range_end, method, status)
       VALUES ($1,'audit_event.compliance',3,'2026-04-01T00:00:00Z','2026-04-30T23:59:59Z','secure_delete','executed')`,
      [ORG_B],
    );
    const out = await runIntegritySampleForOrg(deps(), ORG_B);
    expect(out.result).toBe("match");
    expect((await runsOf(ORG_B)).at(-1).detail.skippedDestroyed).toEqual(["audit_event_2026_04"]);
  });
});
