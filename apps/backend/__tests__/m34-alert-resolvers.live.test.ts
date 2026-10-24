/**
 * GAP-057 - LIVE Postgres proof that M34's two recipient resolvers are registered on the REAL emitter and that
 * every M34 alert rule is seeded: an `m34.tenant.shred_pending_approval` emit produces a notification row for the
 * platform security owner, and a compliance-officer rule reaches the tenant's compliance officer.
 *
 * Connects as the real NOBYPASSRLS `chartwarden_app` role. Proves migration 0740 (enum values + the SECURITY DEFINER
 * platform-role reader) applies and that a tenant member without the platform-owned role is not a recipient.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:alert-resolvers:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDrizzleM34AlertResolverPorts,
  m34ResolverExtension,
} from "../src/modules/34-saas-tenant-platform/alert-resolver-ports";
import { wireM34AlertRuleSeed } from "../src/modules/34-saas-tenant-platform/alert-rule-seed-persister";
import { M34_ALERT_RULES } from "../src/modules/34-saas-tenant-platform/alert-rules";
import {
  createDrizzleAlertEmitter,
  createDrizzleRoleSetMembersReader,
} from "../src/modules/36-messaging/alert-emitter-drizzle";
import { wireAlertRuleSeed } from "../src/modules/36-messaging/alert-rule-seed-persister";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const TENANT = "11111111-1111-4111-8111-111111111111";
const PLATFORM_ORG = "22222222-2222-4222-8222-222222222222";
const U_OFFICER = "a0000000-0000-4000-8000-000000000001";
const U_OWNER = "a0000000-0000-4000-8000-000000000002";
const U_SQUATTER = "a0000000-0000-4000-8000-000000000003";
const U_ADMIN = "a0000000-0000-4000-8000-000000000004";

describe.skipIf(!DB_URL)("M34 alert resolvers - LIVE Postgres (GAP-057)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let emitter: ReturnType<typeof createDrizzleAlertEmitter>;

  async function membership(user: string, org: string): Promise<string> {
    const { rows } = await admin.query(
      "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id",
      [user, org],
    );
    return rows[0].id as string;
  }
  async function bind(org: string, membershipId: string, roleId: string) {
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [org, membershipId, roleId],
    );
  }
  async function recipientsOf(alertId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1",
      [alertId],
    );
    return rows.map((r) => r.recipient_user_id as string);
  }

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
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'m34-res-tenant','T','T'), ($2,'m34-res-platform','P','P')`,
      [TENANT, PLATFORM_ORG],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'officer@m34res.test'),($2,'owner@m34res.test'),($3,'squatter@m34res.test'),($4,'admin@m34res.test')`,
      [U_OFFICER, U_OWNER, U_SQUATTER, U_ADMIN],
    );

    // A tenant compliance officer (tenant-owned role).
    const officerRole = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'compliance_officer','CO','clinical_staff',true) RETURNING id",
        [TENANT],
      )
    ).rows[0].id as string;
    await bind(TENANT, await membership(U_OFFICER, TENANT), officerRole);
    const adminRole = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'org_admin','OA','clinical_staff',true) RETURNING id",
        [TENANT],
      )
    ).rows[0].id as string;
    await bind(TENANT, await membership(U_ADMIN, TENANT), adminRole);

    // The platform security owner: a PLATFORM-OWNED role row (organization_id NULL), bound in the platform org.
    const platformRole = (
      await admin.query(
        `INSERT INTO role (organization_id,key,name,category,scope_level,enabled)
         VALUES (NULL,'platform_security_owner','PSO','platform_staff','organization',true) RETURNING id`,
      )
    ).rows[0].id as string;
    await bind(PLATFORM_ORG, await membership(U_OWNER, PLATFORM_ORG), platformRole);

    // A tenant cannot mint the look-alike at all: the DB backstop (migration 0318) refuses the row, so the
    // reader's `organization_id IS NULL` filter is defence in depth, not the only gate.
    await expect(
      admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'platform_security_owner','squat','clinical_staff',true)",
        [TENANT],
      ),
    ).rejects.toThrow(/role_platform_authority_platform_owned/);
    await membership(U_SQUATTER, TENANT);

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    emitter = createDrizzleAlertEmitter(handle.db, {
      extendResolvers: m34ResolverExtension(
        createDrizzleM34AlertResolverPorts(handle.db, {
          roleSetMembers: createDrizzleRoleSetMembersReader(handle.db),
        }),
      ),
    });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("seeds EVERY M34 rule, including the ones naming the two M34 resolvers", async () => {
    const result = await wireM34AlertRuleSeed(handle.db);
    expect(result.skipped).toBe(0);
    expect(result.seeded).toBe(M34_ALERT_RULES.length);
    const { rows } = await admin.query(
      "SELECT recipient_resolver::text AS r, count(*)::int AS n FROM alert_rule WHERE organization_id IS NULL AND event_type LIKE 'm34.%' GROUP BY 1",
    );
    const byResolver = Object.fromEntries(rows.map((r) => [r.r, r.n]));
    // No rule is overwritten by its companion (they share an event_type and differ by severity_floor).
    expect(Object.values(byResolver as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(
      M34_ALERT_RULES.length,
    );
    expect(byResolver.platform_security_owner).toBeGreaterThan(0);
    expect(byResolver.compliance_officer_for_tenant).toBeGreaterThan(0);
  });

  it("an m34.tenant.shred_pending_approval emit delivers to the platform security owner - and a tenant member without the platform-owned role does not", async () => {
    const rule = M34_ALERT_RULES.find((r) => r.ruleKey === "tenant.shred_pending_approval");
    const { alertId } = await emitter.emit(TENANT, {
      eventType: rule?.eventType ?? "",
      payload: { orgId: TENANT },
      severity: "critical",
      correlationId: "gap-057-shred-pending",
    });
    const recipients = await recipientsOf(alertId);
    expect(recipients).toContain(U_OWNER);
    expect(recipients).not.toContain(U_SQUATTER);
    const { rows } = await admin.query("SELECT outcome FROM alert WHERE id=$1", [alertId]);
    expect(rows[0].outcome).not.toBe("failed");
  });

  it("a compliance_officer_for_tenant rule reaches the tenant's compliance officer", async () => {
    const rule = M34_ALERT_RULES.find(
      (r) => r.recipientResolver === "compliance_officer_for_tenant",
    );
    const { alertId } = await emitter.emit(TENANT, {
      eventType: rule?.eventType ?? "",
      payload: { orgId: TENANT },
      severity: "warn",
      correlationId: "gap-057-officer",
    });
    expect(await recipientsOf(alertId)).toContain(U_OFFICER);
  });

  it("GAP-068: an mdm.physician_deactivated alert now resolves a recipient (the tenant admin)", async () => {
    await wireAlertRuleSeed(handle.db);
    const { alertId } = await emitter.emit(TENANT, {
      eventType: "mdm.physician_deactivated",
      payload: { canonicalId: "c1", npi: "1234567893", kind: "physician", deepLink: "/mdm" },
      severity: "warn",
      correlationId: "gap-068-deactivated",
    });
    expect(await recipientsOf(alertId)).toContain(U_ADMIN);
  });
});
