/**
 * GAP-102 — a tenant may only TIGHTEN a `system_locked` platform alert rule, LIVE Postgres.
 *
 * Before migration 0334 a tenant admin could clone `field_safety.sos` with a lower severity floor or a
 * different resolver (the INSERT policy never looked at it), the emitter used the org row instead of the
 * platform rule, and the clone could never be edited again (the UPDATE policy demanded
 * system_locked=false). Proved as the real NOBYPASSRLS `chartwarden_app` role (a superuser would bypass RLS):
 * the service refuses (422/403), the DB trigger independently rejects the same row written with raw SQL,
 * a tightening edit works and stays editable, and the emitter's rule lookup ignores a legacy weak row.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m36:locked-alert-rule:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbMessagingRouteService,
  createDrizzleAlertEmitterPorts,
} from "../src/modules/36-messaging/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const SOS = "field_safety.sos";
const SOS_CHANNELS = "ARRAY['in_app','push','sms','voice']";

describe.skipIf(!DB_URL)("GAP-102 — locked alert rules are tighten-only, LIVE Postgres", () => {
  let admin: Client;
  let app: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let sosPlatformId: string;

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

  /** Run one statement as chartwarden_app inside ORG_A's tenant context; returns the pg error (or null). */
  async function asAppInOrgA(sqlText: string, params: unknown[] = []): Promise<Error | null> {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await app.query(sqlText, params);
      await app.query("COMMIT");
      return null;
    } catch (e) {
      await app.query("ROLLBACK");
      return e as Error;
    }
  }

  const insertOrgSos = (over: {
    severity?: string;
    resolver?: string;
    locked?: boolean;
    channels?: string;
    enabled?: boolean;
  }) =>
    `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,channels_override,system_locked,enabled)
     VALUES ('${ORG_A}','${SOS}','field_safety','${over.severity ?? "critical"}','${over.resolver ?? "on_call"}',
             '{"providerEntityIdPath":"providerEntityId"}'::jsonb, ${over.channels ?? SOS_CHANNELS},
             ${over.locked ?? true}, ${over.enabled ?? true})`;

  const orgRows = async () =>
    (
      await admin.query("SELECT * FROM alert_rule WHERE organization_id=$1 AND event_type=$2", [
        ORG_A,
        SOS,
      ])
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    const { rows } = await admin.query(
      `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,channels_override,system_locked,enabled)
       VALUES (NULL,'${SOS}','field_safety','critical','on_call','{"providerEntityIdPath":"providerEntityId"}'::jsonb,${SOS_CHANNELS},true,true)
       RETURNING id`,
    );
    sosPlatformId = rows[0].id;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await app.connect();
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    service = createDbMessagingRouteService(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (app) await app.end();
    if (admin) await admin.end();
  });

  it("service: a severity downgrade is refused (422) and no org row is inserted", async () => {
    await expect(
      service.patchAlertRule(ORG_A, { ruleId: sosPlatformId, patch: { severityFloor: "info" } }),
    ).rejects.toMatchObject({ code: "LOCKED_RULE_SEVERITY_DOWNGRADE" });
    expect(await orgRows()).toHaveLength(0);
  });

  it("service: a resolver change is refused (422) and no org row is inserted", async () => {
    await expect(
      service.patchAlertRule(ORG_A, {
        ruleId: sosPlatformId,
        patch: { recipientResolver: "broadcast" },
      }),
    ).rejects.toMatchObject({ code: "LOCKED_RULE_RESOLVER_IMMUTABLE" });
    expect(await orgRows()).toHaveLength(0);
  });

  it("DB backstop (as chartwarden_app): raw INSERTs that weaken the locked rule are rejected", async () => {
    for (const weak of [
      { severity: "info" },
      { severity: "warn" },
      { resolver: "broadcast" },
      { locked: false },
      { enabled: false },
      { channels: "ARRAY['in_app']" },
      { channels: "NULL" },
    ]) {
      const err = await asAppInOrgA(insertOrgSos(weak));
      expect(err, JSON.stringify(weak)).not.toBeNull();
      expect(err?.message).toMatch(/alert_rule/);
    }
    expect(await orgRows()).toHaveLength(0);
  });

  it("DB: a tenant cannot mint a locked row for a non-locked event type", async () => {
    const err = await asAppInOrgA(
      `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,system_locked)
       VALUES ('${ORG_A}','visit.late','operational','warn','broadcast',true)`,
    );
    expect(err?.message).toMatch(/system_locked/);
  });

  it("a tightening edit clones the locked rule, and the clone stays editable (no dead end)", async () => {
    const first = await service.patchAlertRule(ORG_A, {
      ruleId: sosPlatformId,
      patch: { severityFloor: "critical" },
    });
    expect(first.organizationId).toBe(ORG_A);
    expect(first.systemLocked).toBe(true);
    const again = await service.patchAlertRule(ORG_A, {
      ruleId: first.ruleId,
      patch: { severityFloor: "critical" },
    });
    expect(again.ruleId).toBe(first.ruleId);
    await expect(
      service.patchAlertRule(ORG_A, { ruleId: first.ruleId, patch: { severityFloor: "warn" } }),
    ).rejects.toMatchObject({ code: "LOCKED_RULE_SEVERITY_DOWNGRADE" });
  });

  it("DB: UPDATE of the locked clone as chartwarden_app may tighten (add a channel) but not weaken", async () => {
    const ok = await asAppInOrgA(
      `UPDATE alert_rule SET channels_override = ARRAY['in_app','push','sms','voice','email']
        WHERE organization_id='${ORG_A}' AND event_type='${SOS}'`,
    );
    expect(ok).toBeNull();
    const bad = await asAppInOrgA(
      `UPDATE alert_rule SET severity_floor='info' WHERE organization_id='${ORG_A}' AND event_type='${SOS}'`,
    );
    expect(bad?.message).toMatch(/downgraded/);
    const unlock = await asAppInOrgA(
      `UPDATE alert_rule SET system_locked=false WHERE organization_id='${ORG_A}' AND event_type='${SOS}'`,
    );
    expect(unlock?.message).toMatch(/system_locked/);
  });

  it("emitter: a legacy weak org row (written with triggers off) is ignored; the platform floor fires", async () => {
    await admin.query("DELETE FROM alert_rule WHERE organization_id=$1", [ORG_A]);
    await admin.query("SET session_replication_role = replica");
    await admin.query(insertOrgSos({ severity: "info", resolver: "broadcast", locked: false }));
    await admin.query("SET session_replication_role = DEFAULT");
    const ports = createDrizzleAlertEmitterPorts(handle.db);
    const rules = await ports.rulesFor(ORG_A, SOS);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ severityFloor: "critical", recipientResolver: "on_call" });
    expect(rules[0]?.channelsOverride).toContain("voice");
  });

  it("service: PATCH on a weak legacy clone (reduced channels, different resolver_args) restores the floor instead of a raw 500", async () => {
    await admin.query("DELETE FROM alert_rule WHERE organization_id=$1", [ORG_A]);
    await admin.query("SET session_replication_role = replica");
    await admin.query(
      `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,channels_override,system_locked,enabled)
       VALUES ('${ORG_A}','${SOS}','field_safety','critical','on_call','{"providerEntityIdPath":"weakened"}'::jsonb, NULL, true, true)`,
    );
    await admin.query("SET session_replication_role = DEFAULT");

    const view = await service.patchAlertRule(ORG_A, {
      ruleId: sosPlatformId,
      patch: { severityFloor: "critical" },
    });
    expect(view.systemLocked).toBe(true);

    const [row] = await orgRows();
    expect(row.resolver_args).toEqual({ providerEntityIdPath: "providerEntityId" });
    expect(row.channels_override).toEqual(
      expect.arrayContaining(["in_app", "push", "sms", "voice"]),
    );
    const rules = await createDrizzleAlertEmitterPorts(handle.db).rulesFor(ORG_A, SOS);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.channelsOverride).toContain("voice");
  });

  // Migration 0346 — the M20 coverage-gap rule joins the locked set. The trigger is data-driven, so the
  // proof is: an already-seeded UNLOCKED platform row is flipped by the migration, after which a tenant
  // clone cannot weaken it (as the real NOBYPASSRLS chartwarden_app role).
  it("0346: flips a seeded unlocked coverage-gap platform rule, after which a tenant cannot loosen it", async () => {
    const GAP = "m20.safety.coverage_gap_detected";
    await admin.query("DELETE FROM alert_rule WHERE event_type=$1", [GAP]);
    await admin.query(
      `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,system_locked,enabled)
       VALUES (NULL,'${GAP}','field_safety','critical','role_set','{"roleKeys":["don","org_admin"]}'::jsonb,false,true)`,
    );
    const weakClone = (over: string) =>
      `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,system_locked,enabled)
       VALUES ('${ORG_A}','${GAP}','field_safety',${over})`;
    const loose = `'warn','role_set','{"roleKeys":["don","org_admin"]}'::jsonb,true,true`;
    // Before the migration the rule is not locked: a tenant may not mint a locked clone of an unlocked rule.
    expect((await asAppInOrgA(weakClone(loose)))?.message).toMatch(/system_locked/);

    await admin.query(
      readFileSync(join(MIGRATIONS_DIR, "0346_m20_coverage_gap_alert_rule_lock.sql"), "utf8"),
    );
    const { rows } = await admin.query(
      "SELECT system_locked, enabled FROM alert_rule WHERE organization_id IS NULL AND event_type=$1",
      [GAP],
    );
    expect(rows).toEqual([{ system_locked: true, enabled: true }]);

    for (const weak of [
      loose, // severity downgrade
      `'critical','role_set','{"roleKeys":["don"]}'::jsonb,true,true`, // resolver args changed
      `'critical','role_set','{"roleKeys":["don","org_admin"]}'::jsonb,true,false`, // disabled
      `'critical','role_set','{"roleKeys":["don","org_admin"]}'::jsonb,false,true`, // lock dropped
    ]) {
      const err = await asAppInOrgA(weakClone(weak));
      expect(err, weak).not.toBeNull();
      expect(err?.message).toMatch(/alert_rule/);
    }
    expect(
      await asAppInOrgA(
        weakClone(`'critical','role_set','{"roleKeys":["don","org_admin"]}'::jsonb,true,true`),
      ),
    ).toBeNull();
  });
});
