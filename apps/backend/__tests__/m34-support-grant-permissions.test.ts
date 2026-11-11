/**
 * Slice 7 (7S) - the support-session and consent-grant permissions, and the migrations and provisioning that carry them:
 *   * a freshly materialized tenant gives the compliance_officer the three support_consent_grant keys (migration 1484 covers existing roles);
 *   * the platform_ops role holds the three support_session keys, the elevate key nowhere;
 *   * migration 1484 is `contract` (it drops policies and revokes), grants exactly those keys, pins the tenant role and the carrier, and
 *     adds the ledger's default partition; migration 1485 is the enum value ALONE; the provisioning script mirrors the carrier's grants.
 * The live suite (m34-support-session.live.test.ts) proves the same against a real catalog, roles and RLS.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  M34_COMPLIANCE_OFFICER_SUPPORT_GRANT_KEYS,
  M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS,
  PLATFORM_OPS_ROLE_GRANTS,
  ROLE_TEMPLATES,
  allPermissionMirrorRows,
  planRoleTemplateMaterialization,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const migration = (name: string) =>
  readFileSync(join(ROOT, "packages/db/migrations", name), "utf8");
const mirror = allPermissionMirrorRows().map((r) => ({ key: r.key, category: r.category }));
const plan = planRoleTemplateMaterialization({
  templates: ROLE_TEMPLATES,
  existingRoleKeys: new Set(),
  mirror,
});
const holders = (key: string) =>
  plan
    .filter((r) => r.permissionKeys.includes(key))
    .map((r) => r.key)
    .sort();

describe("consent-grant keys on a freshly materialized tenant", () => {
  it("are in the permission mirror", () => {
    for (const key of M34_COMPLIANCE_OFFICER_SUPPORT_GRANT_KEYS) {
      expect(
        mirror.some((p) => p.key === key),
        key,
      ).toBe(true);
    }
  });

  it("go to the compliance officer, the org admin and the administrator: the officer can finally issue, list and revoke", () => {
    for (const key of M34_COMPLIANCE_OFFICER_SUPPORT_GRANT_KEYS) {
      expect(holders(key), key).toEqual(["administrator", "compliance_officer", "org_admin"]);
    }
  });
});

describe("support-session keys on the platform roles", () => {
  it("platform_ops holds list, start and close; no role holds elevate", () => {
    for (const key of M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS) {
      expect(PLATFORM_OPS_ROLE_GRANTS.platform_ops).toContain(key);
    }
    for (const grants of Object.values(PLATFORM_OPS_ROLE_GRANTS)) {
      expect(grants).not.toContain("support_session.elevate_phi_read");
    }
  });
});

describe("migration 1484 (the repair at the database)", () => {
  const sql = migration("1484_m34_support_session_grants.sql");

  it("declares itself contract: it drops the permissive policies and revokes", () => {
    expect(sql).toMatch(/^-- compat: contract/);
  });

  it("gives the ledger a default partition (no code ever created a per-organization one)", () => {
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS "support_session_event_default" PARTITION OF "support_session_event" DEFAULT/,
    );
  });

  it("pins the tenant role: no FOR ALL policy, only the cascade's writes", () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "support_grant_org" ON "support_consent_grant"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "support_session_org" ON "support_session"/);
    expect(sql).toMatch(
      /DROP POLICY IF EXISTS "support_session_event_org" ON "support_session_event"/,
    );
    const code = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/FOR ALL/);
    expect(sql).toMatch(/AND event_kind = 'session\.close'/);
    expect(sql).toMatch(/AND close_reason = 'grant_revoked'/);
    expect(sql).toMatch(/REVOKE INSERT, UPDATE ON "support_session" FROM chartwarden_app/);
    expect(sql).toMatch(
      /GRANT UPDATE \("closed_at", "close_reason"\) ON "support_session" TO chartwarden_app/,
    );
    expect(sql).toMatch(
      /GRANT UPDATE \("revoked_at", "revoked_by_membership_id", "revocation_reason"\) ON "support_consent_grant" TO chartwarden_app/,
    );
    expect(code).not.toMatch(/OR organization_id IS NULL/i);
  });

  it("grants the carrier only inside a pg_roles check, and by column", () => {
    const block = sql.slice(sql.indexOf("DO $$"), sql.indexOf("END $$"));
    expect(block).toMatch(/pg_roles WHERE rolname = 'chartwarden_platform'/);
    expect(block).toMatch(/GRANT INSERT ON "support_session" TO chartwarden_platform/);
    expect(block).toMatch(/GRANT UPDATE \("closed_at", "close_reason"\) ON "support_session"/);
    expect(block).toMatch(
      /GRANT UPDATE \("revoked_at", "revoked_by_membership_id", "revocation_reason"\) ON "support_consent_grant"/,
    );
  });

  it("grants the three platform keys to the platform-owned platform_ops role and the three grant keys to every officer role, idempotently", () => {
    for (const key of M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS) expect(sql).toContain(`'${key}'`);
    for (const key of M34_COMPLIANCE_OFFICER_SUPPORT_GRANT_KEYS) expect(sql).toContain(`'${key}'`);
    expect(sql).toMatch(/r\."key" = 'platform_ops'\s+AND r\."organization_id" IS NULL/);
    expect(sql).toMatch(/r\."key" = 'compliance_officer'\s+AND r\."organization_id" IS NOT NULL/);
    expect(sql.match(/ON CONFLICT \("role_id", "permission_key"\) DO NOTHING/g)).toHaveLength(2);
    expect(sql).not.toContain("support_session.elevate_phi_read");
  });
});

describe("migration 1485 (the assist scope)", () => {
  const sql = migration("1485_m34_support_consent_scope_assist.sql");

  it("is expand and the enum value ALONE: nothing else shares the file that adds it", () => {
    expect(sql).toMatch(/^-- compat: expand/);
    const statements = sql
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("--"));
    expect(statements).toEqual([
      `ALTER TYPE "public"."support_consent_grant_scope" ADD VALUE IF NOT EXISTS 'assist';`,
    ]);
  });
});

describe("the provisioning script's carrier grants", () => {
  const script = readFileSync(join(ROOT, "scripts/db/provision-runtime-roles.ts"), "utf8");

  it("inserts support_session and updates it by column, never table-wide", () => {
    const insertList = script.slice(
      script.indexOf("const PLATFORM_PROVISION_INSERT_TABLES"),
      script.indexOf("const PLATFORM_PROVISION_UPDATE_TABLES"),
    );
    const updateList = script.slice(
      script.indexOf("const PLATFORM_PROVISION_UPDATE_TABLES"),
      script.indexOf("const SUBSCRIPTION_PLATFORM_UPDATE_COLUMNS"),
    );
    expect(insertList).toContain('"support_session",');
    expect(updateList).not.toContain("support_session");
    expect(script).toContain(
      `'GRANT UPDATE ("closed_at", "close_reason") ON "support_session" TO chartwarden_platform;'`,
    );
    expect(script).toContain(
      `'GRANT UPDATE ("revoked_at", "revoked_by_membership_id", "revocation_reason") ON "support_consent_grant" TO chartwarden_platform;'`,
    );
  });
});
