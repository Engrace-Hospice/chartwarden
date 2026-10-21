/**
 * GAP-096 (M32) — a tenant admin who mints `ai_safety_owner` cannot stop an AI capability platform-wide.
 *
 * Proven over real Postgres, connected AS the RLS-enforced `wardenx_app` role (never the superuser):
 *   1. the mint itself is refused — migration 0321's CHECK rejects a tenant-owned role row keyed
 *      `ai_safety_owner` / `platform_ops` on INSERT (the DB backstop beside M3's route refusal);
 *   2. a tenant-scope caller asking for the platform (NULL-org) kill switch is refused by the SERVICE and
 *      the platform credential is never opened — no NULL-org `ai_kill_switch_state` row exists after;
 *   3. a tenant-scope caller naming another org is refused and writes nothing;
 *   4. the legitimate tenant path (own org, `withOrgContext`) still works and affects only that org.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m32-kill-switch-tenant-role-key.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleAiCapabilityRegistryStore } from "../src/modules/32-ai-platform/governance/store-drizzle";
import {
  type AiSafetyServiceDeps,
  activateAiKillSwitchAs,
  createDrizzleAiKillSwitchStore,
  readAiKillSwitchVerdict,
} from "../src/modules/32-ai-platform/safety";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBERSHIP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JOB_ID = "m32.platform_ops";

describe.skipIf(!DB_URL)("GAP-096 M32 — tenant-minted role key vs the platform kill switch", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let capabilityId: string;
  let platformOpened = 0;
  let deps: AiSafetyServiceDeps;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  const nullOrgRows = async () =>
    (await admin.query("SELECT 1 FROM ai_kill_switch_state WHERE organization_id IS NULL"))
      .rowCount;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    for (const [id, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    capabilityId = (
      await admin.query(
        `INSERT INTO ai_capability (capability_key, display_name, description, risk_tier,
           default_backend_key, allowed_backend_keys, fallback_chain_keys)
         VALUES ('gap096_cap','GAP-096 cap','live test','low','local','["local"]','[]') RETURNING id`,
      )
    ).rows[0].id as string;

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    // The platform credential must never be opened for a tenant caller: a handle that throws, counted.
    const platformDb = {
      transaction: async () => {
        platformOpened += 1;
        throw new Error("platform credential opened");
      },
    } as unknown as DbClient;
    const auditBypass = async () => {};
    const storeDeps = {
      db: handle.db,
      platformDb,
      auditBypass,
      jobId: JOB_ID,
      userId: MEMBERSHIP,
    };
    deps = {
      killSwitches: createDrizzleAiKillSwitchStore(storeDeps),
      registry: createDrizzleAiCapabilityRegistryStore(storeDeps),
      reports: undefined as never,
      evaluations: undefined as never,
    };
  });

  afterAll(async () => {
    await handle?.close?.();
    await admin?.end();
  });

  const request = (organizationId: string | null) => ({
    organizationId,
    capabilityId,
    reason: "manual_safety_pause" as const,
    actorKind: "ai_safety_owner" as const,
    actorMembershipId: MEMBERSHIP,
    activationMessage: "GAP-096 live check",
  });

  it("refuses to mint a tenant role keyed ai_safety_owner or platform_ops (wardenx_app)", async () => {
    for (const key of ["ai_safety_owner", "platform_ops"]) {
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: MEMBERSHIP }, (tx) =>
          (tx as DbClient).execute(
            sql`INSERT INTO role (organization_id, key, name, category) VALUES (${ORG_A}::uuid, ${key}, 'x', 'operations')`,
          ),
        ),
      ).rejects.toThrow();
    }
  });

  it("refuses a tenant caller the platform (NULL-org) switch and never opens the platform credential", async () => {
    await expect(
      activateAiKillSwitchAs(deps, { kind: "tenant", organizationId: ORG_A }, request(null)),
    ).rejects.toThrow(/platform/i);
    expect(platformOpened).toBe(0);
    expect(await nullOrgRows()).toBe(0);
  });

  it("refuses a tenant caller another org's switch and writes nothing", async () => {
    await expect(
      activateAiKillSwitchAs(deps, { kind: "tenant", organizationId: ORG_A }, request(ORG_B)),
    ).rejects.toThrow(/own organization/i);
    expect(
      (await admin.query("SELECT 1 FROM ai_kill_switch_state WHERE organization_id = $1", [ORG_B]))
        .rowCount,
    ).toBe(0);
  });

  it("lets a tenant caller stop the capability for its own org only, under RLS", async () => {
    const outcome = await activateAiKillSwitchAs(
      deps,
      { kind: "tenant", organizationId: ORG_A },
      request(ORG_A),
    );
    expect(outcome.usedPlatformCredential).toBe(false);
    expect(platformOpened).toBe(0);
    expect((await readAiKillSwitchVerdict(deps, ORG_A, capabilityId)).killed).toBe(true);
    expect((await readAiKillSwitchVerdict(deps, ORG_B, capabilityId)).killed).toBe(false);
    expect(await nullOrgRows()).toBe(0);
  });
});
