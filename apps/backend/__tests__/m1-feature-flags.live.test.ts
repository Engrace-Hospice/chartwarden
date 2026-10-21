/**
 * F-091 — the `feature_flag` table is live: one reader, one writer, and the RLS floor between them.
 *
 * THE FINDING. `feature_flag` had no reader and no writer anywhere in the running system.
 * `createDefaultFeatureFlagReader()` answered `{}` for every org and the composition root never replaced
 * it, so `GET /api/v1/system/feature-flags` served an empty map and every capability gate reading the same
 * fact — M22's `documents.doclens`, M38's §7.7 `ai.full`, M16's Layer-2 ladder, M32's invocation pipeline —
 * resolved permanently OFF. The surface that exists to turn one on, M34's three §4.7 platform-ops admin
 * routes, was bound to a stub that threw on all three methods. Both halves dead is what hid it: a flag that
 * cannot be set and a flag that reads off are indistinguishable from a Phase-1 capability correctly off.
 *
 * AND THE WRITER COULD NOT HAVE WORKED. `feature_flag_key_org_idx` is `UNIQUE (flag_key, organization_id)`
 * and `organization_id` is NULL for a platform-global flag; Postgres treats two NULLs as distinct for
 * uniqueness, so the global scope was unconstrained AND `ON CONFLICT (flag_key, organization_id)` could
 * never match a global row — the create-or-update contract silently degraded to create-only for exactly
 * the flags a platform operator sets. Migration 0237 adds `NULLS NOT DISTINCT`. The first two tests below
 * are that migration's regression guard, and both fail against the pre-0237 schema.
 *
 * THIS SUITE IS LIVE BY NECESSITY. Every claim here is a statement about Postgres: NULL-distinctness in a
 * unique index, `ON CONFLICT` inference, and migration 0002's `feature_flag_org_read` policy (own org OR
 * org-NULL) which is the whole reason a tenant may read a global flag and not another tenant's. An
 * in-memory double answers all of it happily and proves none of it.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m1:feature-flags:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type FeatureFlagKillSwitchPorts,
  createDrizzleFeatureFlagAdmin,
  createDrizzleFeatureFlagReader,
} from "../src/bootstrap/feature-flag-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f0910001";
const ORG_B = "22222222-2222-4222-8222-2222f0910002";
const OPERATOR = "33333333-3333-4333-8333-3333f0910003";

describe.skipIf(!DB_URL)("F-091 M1 feature flags — LIVE Postgres", () => {
  let admin: Client;
  /** The TENANT pool: the NOBYPASSRLS `chartwarden_app` the reader runs on, exactly as production connects. */
  let tenantHandle: ReturnType<typeof createDbClient>;
  /** The PLATFORM pool: RLS-bypass, which is what the admin seam requires — migration 0001's write
   *  policies never admit a NULL org, so a global flag is uncreatable from any tenant connection. */
  let platformHandle: ReturnType<typeof createDbClient>;
  let readFlags: (orgId: string) => Promise<Record<string, boolean>>;
  let flagAdmin: ReturnType<typeof createDrizzleFeatureFlagAdmin>;

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f091-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f091-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops@f091.test')`, [OPERATOR]);

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    tenantHandle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    platformHandle = createDbClient({ connectionString: DB_URL as string });

    readFlags = (orgId) => createDrizzleFeatureFlagReader(tenantHandle.db).forOrg(orgId);
    flagAdmin = createDrizzleFeatureFlagAdmin(platformHandle.db as DbClient);
  }, 240_000);

  afterAll(async () => {
    await tenantHandle?.close();
    await platformHandle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM feature_flag");
  });

  // ── migration 0237: the unique index finally constrains the GLOBAL scope ───────────────────────────

  it("a second platform-global row for the same key is refused (0237 NULLS NOT DISTINCT)", async () => {
    await admin.query(
      `INSERT INTO feature_flag (organization_id,flag_key,value_type,value)
       VALUES (NULL,'ai.full','bool','true'::jsonb)`,
    );
    // Before 0237 this second insert SUCCEEDED — two rival platform-global values for one key, with
    // nothing to say which is authoritative and no error to notice.
    await expect(
      admin.query(
        `INSERT INTO feature_flag (organization_id,flag_key,value_type,value)
         VALUES (NULL,'ai.full','bool','false'::jsonb)`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("upsert UPDATES a global flag rather than appending a rival row", async () => {
    const created = await flagAdmin.upsert(OPERATOR, {
      flagKey: "ai.full",
      organizationId: null,
      flagKind: "product",
      valueType: "bool",
      value: true,
      rolloutPercent: null,
      rationale: "phase-2 pilot",
    });
    const updated = await flagAdmin.upsert(OPERATOR, {
      flagKey: "ai.full",
      organizationId: null,
      flagKind: "product",
      valueType: "bool",
      value: false,
      rolloutPercent: null,
      rationale: "rolled back",
    });
    // Same row, new value — the create-or-update contract. Pre-0237 `ON CONFLICT` could not infer the
    // index for a NULL org, so this produced a SECOND row and the first value stayed live.
    expect(updated.id).toBe(created.id);
    expect(updated.value).toBe(false);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM feature_flag");
    expect(rows[0].n).toBe(1);
  });

  // ── the read path: what a tenant actually sees ─────────────────────────────────────────────────────

  it("a global flag written by the admin seam is visible to every tenant's reader", async () => {
    await flagAdmin.upsert(OPERATOR, {
      flagKey: "ai.full",
      organizationId: null,
      flagKind: "product",
      valueType: "bool",
      value: true,
      rolloutPercent: null,
      rationale: null,
    });
    expect(await readFlags(ORG_A)).toEqual({ "ai.full": true });
    expect(await readFlags(ORG_B)).toEqual({ "ai.full": true });
  });

  it("one tenant's flag is invisible to another (migration 0002's read policy, on the app role)", async () => {
    await flagAdmin.upsert(OPERATOR, {
      flagKey: "documents.doclens",
      organizationId: ORG_A,
      flagKind: "product",
      valueType: "bool",
      value: true,
      rolloutPercent: null,
      rationale: null,
    });
    expect(await readFlags(ORG_A)).toEqual({ "documents.doclens": true });
    // Not `{documents.doclens:false}` — ABSENT. Org B has no opinion recorded about this flag at all,
    // and RLS, not the WHERE clause, is what makes that true.
    expect(await readFlags(ORG_B)).toEqual({});
  });

  it("a tenant row wins over the global row, and the global is not a fallback", async () => {
    await flagAdmin.upsert(OPERATOR, {
      flagKey: "ai.full",
      organizationId: null,
      flagKind: "product",
      valueType: "bool",
      value: true,
      rolloutPercent: null,
      rationale: null,
    });
    await flagAdmin.upsert(OPERATOR, {
      flagKey: "ai.full",
      organizationId: ORG_B,
      flagKind: "product",
      valueType: "bool",
      value: false,
      rolloutPercent: null,
      rationale: "tenant opted out",
    });
    expect(await readFlags(ORG_A)).toEqual({ "ai.full": true });
    expect(await readFlags(ORG_B)).toEqual({ "ai.full": false });
  });

  it("an active kill switch reads false even though the flag's value is true", async () => {
    await admin.query(
      `INSERT INTO feature_flag (organization_id,flag_key,flag_kind,value_type,value,kill_switch_active)
       VALUES (NULL,'ai.full','kill_switch','bool','true'::jsonb,true)`,
    );
    expect(await readFlags(ORG_A)).toEqual({ "ai.full": false });
  });

  it("an expired flag stops applying, and a non-boolean one is never coerced", async () => {
    await admin.query(
      `INSERT INTO feature_flag (organization_id,flag_key,flag_kind,value_type,value,expires_at)
       VALUES (NULL,'m1.migration_shim','migration','bool','true'::jsonb, now() - interval '1 day')`,
    );
    // A non-empty string is truthy in JS; coercing it would fail OPEN on a capability gate.
    await admin.query(
      `INSERT INTO feature_flag (organization_id,flag_key,value_type,value)
       VALUES (NULL,'ai.model_tier','string','"premium"'::jsonb)`,
    );
    // Subject-dependent: `forOrg` carries no subject, so a percentage has no per-org answer.
    await admin.query(
      `INSERT INTO feature_flag (organization_id,flag_key,flag_kind,value_type,value,rollout_percent)
       VALUES ($1,'ai.beta','rollout','bool','true'::jsonb,50)`,
      [ORG_A],
    );
    expect(await readFlags(ORG_A)).toEqual({});
  });

  // ── the admin listing + the one method that still refuses ──────────────────────────────────────────

  it("list(null) is unfiltered (global AND every tenant); list(org) narrows to that tenant", async () => {
    await flagAdmin.upsert(OPERATOR, {
      flagKey: "ai.full",
      organizationId: null,
      flagKind: "product",
      valueType: "bool",
      value: true,
      rolloutPercent: null,
      rationale: null,
    });
    await flagAdmin.upsert(OPERATOR, {
      flagKey: "documents.doclens",
      organizationId: ORG_A,
      flagKind: "product",
      valueType: "bool",
      value: true,
      rolloutPercent: null,
      rationale: null,
    });
    // The §4.1 route documents this listing as "platform-global + per-tenant", and its caller collapses
    // an absent filter to null — so null meaning "global only" would render the platform-ops screen
    // empty on a platform full of per-tenant flags.
    expect((await flagAdmin.list(null, undefined)).map((f) => f.flagKey).sort()).toEqual([
      "ai.full",
      "documents.doclens",
    ]);
    expect((await flagAdmin.list(ORG_A, undefined)).map((f) => f.flagKey)).toEqual([
      "documents.doclens",
    ]);
    expect(await flagAdmin.list(null, "rollout")).toEqual([]);
  });

  it("upsert never clears an active kill switch as a side effect of editing the value", async () => {
    await admin.query(
      `INSERT INTO feature_flag (organization_id,flag_key,flag_kind,value_type,value,kill_switch_active)
       VALUES (NULL,'ai.full','kill_switch','bool','true'::jsonb,true)`,
    );
    const edited = await flagAdmin.upsert(OPERATOR, {
      flagKey: "ai.full",
      organizationId: null,
      flagKind: "kill_switch",
      valueType: "bool",
      value: false,
      rolloutPercent: null,
      rationale: "value edit while disabled",
    });
    expect(edited.killSwitchActive).toBe(true);
    expect(await readFlags(ORG_A)).toEqual({ "ai.full": false });
  });

  it("setKillSwitch with no platform ports refuses 501 (never an unaudited flip)", async () => {
    await admin.query(
      `INSERT INTO feature_flag (organization_id,flag_key,flag_kind,value_type,value)
       VALUES (NULL,'ai.full','kill_switch','bool','true'::jsonb)`,
    );
    await expect(
      flagAdmin.setKillSwitch(OPERATOR, {
        flagKey: "ai.full",
        organizationId: null,
        killSwitchActive: true,
        actorOrganizationId: ORG_A,
        actorMembershipId: null,
      }),
    ).rejects.toMatchObject({ code: "FEATURE_FLAG_KILL_SWITCH_UNAVAILABLE", statusCode: 501 });
    const { rows } = await admin.query("SELECT kill_switch_active FROM feature_flag");
    expect(rows[0].kill_switch_active).toBe(false);
  });

  describe("setKillSwitch with the audited platform ports (M34 §4.7)", () => {
    const emitted: string[] = [];
    const portsFor = (failAlert = false): FeatureFlagKillSwitchPorts => ({
      runPlatform: (_reason, fn) => platformHandle.db.transaction((tx) => fn(tx as DbClient)),
      publish: async () => {
        emitted.push("publish");
      },
      audit: async () => {
        emitted.push("audit");
      },
      alert: async () => {
        emitted.push("alert");
        if (failAlert) throw new Error("alert down");
        return { alertId: "a" };
      },
    });
    const toggle = (organizationId: string | null, ports: FeatureFlagKillSwitchPorts) =>
      createDrizzleFeatureFlagAdmin(platformHandle.db as DbClient, ports).setKillSwitch(OPERATOR, {
        flagKey: "ai.full",
        organizationId,
        killSwitchActive: true,
        actorOrganizationId: ORG_A,
        actorMembershipId: null,
      });

    beforeEach(async () => {
      emitted.length = 0;
      await admin.query(
        `INSERT INTO feature_flag (organization_id,flag_key,flag_kind,value_type,value) VALUES
           (NULL,'ai.full','kill_switch','bool','true'::jsonb),
           ($1,'ai.full','kill_switch','bool','true'::jsonb)`,
        [ORG_B],
      );
    });

    it("flips a GLOBAL flag, emits the three carriers, and the reader then reads false", async () => {
      const view = await toggle(null, portsFor());
      expect(view).toMatchObject({ organizationId: null, killSwitchActive: true });
      expect(emitted).toEqual(["publish", "audit", "alert"]);
      expect(await readFlags(ORG_A)).toEqual({ "ai.full": false });
    });

    it("flips ONLY the org's own row when scoped - the same-key global row stays live", async () => {
      await toggle(ORG_B, portsFor());
      const { rows } = await admin.query(
        "SELECT organization_id, kill_switch_active FROM feature_flag ORDER BY organization_id NULLS FIRST",
      );
      expect(rows.map((r) => r.kill_switch_active)).toEqual([false, true]);
    });

    it("rolls the flip back when the alert carrier fails (in-tx with the write)", async () => {
      await expect(toggle(null, portsFor(true))).rejects.toThrow("alert down");
      const { rows } = await admin.query(
        "SELECT kill_switch_active FROM feature_flag WHERE organization_id IS NULL",
      );
      expect(rows[0].kill_switch_active).toBe(false);
    });

    it("404s a toggle at a scope with no row, and emits nothing", async () => {
      await admin.query("DELETE FROM feature_flag WHERE organization_id = $1", [ORG_B]);
      await expect(toggle(ORG_B, portsFor())).rejects.toMatchObject({ statusCode: 404 });
      expect(emitted).toEqual([]);
    });
  });
});
