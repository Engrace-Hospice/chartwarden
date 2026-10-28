/**
 * Migration 1144 — tenant slug rules and rename aliases (ADR-0049 D3) — the LIVE Postgres proof.
 *
 * Applies every migration to a fresh schema and drives the rules as the real NOBYPASSRLS `chartwarden_app` role:
 * the slug CHECK, the rename → alias trigger, "a slug is never reused", and that an alias is readable only by its
 * own tenant and writable by nobody but the trigger.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… (SUPERUSER, THROWAWAY db) bun run test:m1:slug-alias:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "../../../../apps/backend/__tests__/_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

describe.skipIf(!DB_URL)("migration 1144 — slug rules and aliases — LIVE Postgres", () => {
  let db: Client;

  const insertOrg = (id: string, slug: string) =>
    db.query("INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'L','D')", [
      id,
      slug,
    ]);
  const rename = (id: string, slug: string) =>
    db.query("UPDATE organization SET slug=$2 WHERE id=$1", [id, slug]);
  const aliasesOf = async (id: string) =>
    (
      await db.query(
        "SELECT alias FROM organization_slug_alias WHERE organization_id=$1 ORDER BY alias",
        [id],
      )
    ).rows.map((r) => r.alias as string);
  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return undefined;
  };

  /** Runs `fn` as chartwarden_app with `app.org_id` bound, in a transaction that is always rolled back. */
  async function asApp<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE chartwarden_app");
      await db.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      return await fn();
    } finally {
      await db.query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    await dropLiveRoles(db);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await insertOrg(ORG_A, "sunrise");
    await insertOrg(ORG_B, "eagle");
  }, 600_000);

  afterAll(async () => {
    await db?.end();
  });

  // Every isolation assertion below would pass vacuously on a BYPASSRLS role.
  it("chartwarden_app is NOBYPASSRLS", async () => {
    const { rows } = await db.query(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it.each([
    "www",
    "admin",
    "api",
    "portal",
    "storage",
    "app",
    "status",
    "docs",
    "mail",
    "Upper",
    "ab",
    "-lead",
    "trail-",
    "snake_case",
    "xn--bcher-kva",
  ])("refuses the slug %s", async (slug) => {
    expect(await errorCode(() => insertOrg("33333333-3333-3333-3333-333333333333", slug))).toBe(
      CHECK_VIOLATION,
    );
  });

  it("refuses a rename to an invalid slug and leaves the row unchanged", async () => {
    expect(await errorCode(() => rename(ORG_A, "www"))).toBe(CHECK_VIOLATION);
    expect(
      (await db.query("SELECT slug FROM organization WHERE id=$1", [ORG_A])).rows[0].slug,
    ).toBe("sunrise");
  });

  it("still lets a legacy non-conforming slug be suspended (rules bind only a new or changed slug)", async () => {
    const legacy = "44444444-4444-4444-4444-444444444444";
    await db.query("ALTER TABLE organization DISABLE TRIGGER organization_slug_guard");
    try {
      await insertOrg(legacy, "Legacy_Org");
    } finally {
      await db.query("ALTER TABLE organization ENABLE TRIGGER organization_slug_guard");
    }
    await db.query("UPDATE organization SET status = 'suspended' WHERE id = $1", [legacy]);
    expect(
      (await db.query("SELECT status FROM organization WHERE id=$1", [legacy])).rows[0].status,
    ).toBe("suspended");
    expect(await errorCode(() => rename(legacy, "Still_Bad"))).toBe(CHECK_VIOLATION);
  });

  it("records the old slug as an alias when an organization is renamed", async () => {
    await rename(ORG_A, "sunrise-hospice");
    expect(await aliasesOf(ORG_A)).toEqual(["sunrise"]);
  });

  it("never lets another organization take an alias", async () => {
    expect(await errorCode(() => rename(ORG_B, "sunrise"))).toBe(UNIQUE_VIOLATION);
    expect(
      await errorCode(() => insertOrg("44444444-4444-4444-4444-444444444444", "sunrise")),
    ).toBe(UNIQUE_VIOLATION);
  });

  it("lets the holder return to its own earlier slug, which then stops being an alias", async () => {
    await rename(ORG_A, "sunrise");
    expect(await aliasesOf(ORG_A)).toEqual(["sunrise-hospice"]);
    await rename(ORG_A, "sunrise-hospice");
    expect(await aliasesOf(ORG_A)).toEqual(["sunrise"]);
  });

  it("refuses an alias that equals a live organization slug", async () => {
    expect(
      await errorCode(() =>
        db.query(
          "INSERT INTO organization_slug_alias (organization_id, alias) VALUES ($1,'eagle')",
          [ORG_A],
        ),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it("keeps the alias after the holder is closed", async () => {
    await db.query("UPDATE organization SET status='closed' WHERE id=$1", [ORG_A]);
    expect(await aliasesOf(ORG_A)).toEqual(["sunrise"]);
    expect(await errorCode(() => rename(ORG_B, "sunrise"))).toBe(UNIQUE_VIOLATION);
  });

  it("shows a tenant its own aliases and nobody else's", async () => {
    const own = await asApp(
      ORG_A,
      async () => (await db.query("SELECT alias FROM organization_slug_alias")).rows,
    );
    expect(own.map((r) => r.alias)).toEqual(["sunrise"]);
    const other = await asApp(
      ORG_B,
      async () => (await db.query("SELECT alias FROM organization_slug_alias")).rows,
    );
    expect(other).toEqual([]);
  });

  // Migration 1142 — resolve_tenant_host: callable BEFORE an org is bound, answering for one label only.
  const resolveAsApp = async (label: string) =>
    asApp("", async () => (await db.query("SELECT * FROM resolve_tenant_host($1)", [label])).rows);

  it("resolves a current slug and a retired alias with no org bound (pre-GUC)", async () => {
    // By now org A's current slug is `sunrise-hospice` and `sunrise` is its retired alias.
    expect(await resolveAsApp("sunrise-hospice")).toEqual([
      { organization_id: ORG_A, slug: "sunrise-hospice", status: "closed", via_alias: false },
    ]);
    expect(await resolveAsApp("sunrise")).toEqual([
      { organization_id: ORG_A, slug: "sunrise-hospice", status: "closed", via_alias: true },
    ]);
  });

  it("answers nothing for an unknown label and enumerates nobody", async () => {
    expect(await resolveAsApp("nobody")).toEqual([]);
    expect(await resolveAsApp("%")).toEqual([]);
    expect(await resolveAsApp("")).toEqual([]);
  });

  it("leaves the organization table itself unreadable to the app role without an org", async () => {
    const rows = await asApp("", async () => (await db.query("SELECT id FROM organization")).rows);
    expect(rows).toEqual([]);
  });

  it("is executable by the app role only", async () => {
    const { rows } = await db.query(
      "SELECT has_function_privilege('chartwarden_app','resolve_tenant_host(text)','EXECUTE') AS app, has_function_privilege('chartwarden_readonly','resolve_tenant_host(text)','EXECUTE') AS ro",
    );
    expect(rows[0]).toEqual({ app: true, ro: false });
  });

  it("denies the app role any write to an alias", async () => {
    for (const sql of [
      "INSERT INTO organization_slug_alias (organization_id, alias) VALUES (current_setting('app.org_id')::uuid, 'forged')",
      "UPDATE organization_slug_alias SET alias = 'forged'",
      "DELETE FROM organization_slug_alias",
    ]) {
      expect(await asApp(ORG_A, () => errorCode(() => db.query(sql)))).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
  // Migration 1146 — the two public, pre-sign-in lookups. Both are callable with no org bound and answer for ONE input.
  describe("migration 1146 — public tenant lookups", () => {
    const ORG_C = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1"; // active
    const ORG_D = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"; // created
    const ORG_E = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1"; // suspended
    const USER_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const USER_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const publicAsApp = (label: string) =>
      asApp(
        "",
        async () => (await db.query("SELECT * FROM resolve_tenant_public($1)", [label])).rows,
      );
    const linksAsApp = (email: string) =>
      asApp(
        "",
        async () => (await db.query("SELECT * FROM tenant_links_for_email($1)", [email])).rows,
      );

    beforeAll(async () => {
      for (const [id, slug, name, status] of [
        [ORG_C, "beacon", "Beacon Care", "active"],
        [ORG_D, "dawn", "Dawn Hospice", "created"],
        [ORG_E, "stopped", "Stopped Hospice", "suspended"],
      ]) {
        await db.query(
          "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,'L',$3,$4)",
          [id, slug, name, status],
        );
      }
      await db.query(
        "INSERT INTO \"user\" (id,email) VALUES ($1,'Nurse@Example.test'),($2,'pending@example.test')",
        [USER_1, USER_2],
      );
      for (const [user, org, status] of [
        [USER_1, ORG_C, "active"],
        [USER_1, ORG_D, "active"], // org not active yet
        [USER_1, ORG_E, "active"], // org suspended
        [USER_2, ORG_C, "pending"], // membership not active
      ]) {
        await db.query(
          "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,$3)",
          [user, org, status],
        );
      }
      await rename(ORG_C, "beacon-care"); // `beacon` becomes a retired alias
    });

    it("resolve_tenant_public: name only for an active or created organization, via slug or alias", async () => {
      expect(await publicAsApp("beacon-care")).toEqual([
        { status: "active", display_name: "Beacon Care" },
      ]);
      expect(await publicAsApp("beacon")).toEqual([
        { status: "active", display_name: "Beacon Care" },
      ]);
      expect(await publicAsApp("dawn")).toEqual([
        { status: "created", display_name: "Dawn Hospice" },
      ]);
      expect(await publicAsApp("stopped")).toEqual([{ status: "suspended", display_name: null }]);
      expect(await publicAsApp("nobody")).toEqual([]);
      expect(await publicAsApp("%")).toEqual([]);
    });

    it("tenant_links_for_email: only ACTIVE memberships in ACTIVE organizations, matched case-insensitively", async () => {
      expect(await linksAsApp("nurse@example.test")).toEqual([
        { slug: "beacon-care", display_name: "Beacon Care" },
      ]);
      expect(await linksAsApp("NURSE@EXAMPLE.TEST")).toEqual([
        { slug: "beacon-care", display_name: "Beacon Care" },
      ]);
      expect(await linksAsApp("pending@example.test")).toEqual([]);
      expect(await linksAsApp("unknown@example.test")).toEqual([]);
      expect(await linksAsApp("%")).toEqual([]);
    });

    it("both functions are executable by the app role only", async () => {
      const { rows } = await db.query(
        `SELECT has_function_privilege('chartwarden_app','resolve_tenant_public(text)','EXECUTE') AS pub_app,
                has_function_privilege('chartwarden_readonly','resolve_tenant_public(text)','EXECUTE') AS pub_ro,
                has_function_privilege('chartwarden_app','tenant_links_for_email(text)','EXECUTE') AS links_app,
                has_function_privilege('chartwarden_readonly','tenant_links_for_email(text)','EXECUTE') AS links_ro`,
      );
      expect(rows[0]).toEqual({ pub_app: true, pub_ro: false, links_app: true, links_ro: false });
    });
  });

  // Migration 1147 — email_belongs_to_tenant: membership OR portal account, current slug only, active/created org only.
  describe("migration 1147 — email_belongs_to_tenant", () => {
    const ORG_P = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1"; // active
    const ORG_Q = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2"; // suspended
    const staff = "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3";
    const patient = "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4";
    const revoked = "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5";
    const stranger = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
    const belongs = (email: string, label: string) =>
      asApp(
        "",
        async () =>
          (await db.query("SELECT email_belongs_to_tenant($1,$2) AS ok", [email, label])).rows[0]
            .ok as boolean,
      );

    beforeAll(async () => {
      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'harbor','L','Harbor','active'),($2,'quiet','L','Quiet','suspended')",
        [ORG_P, ORG_Q],
      );
      await db.query(
        "INSERT INTO \"user\" (id,email) VALUES ($1,'staff@x.test'),($2,'Patient@X.test'),($3,'revoked@x.test'),($4,'stranger@x.test')",
        [staff, patient, revoked, stranger],
      );
      await db.query(
        "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active')",
        [staff, ORG_P],
      );
      for (const [user, org, status, revokedAt] of [
        [patient, ORG_P, "active", null],
        [patient, ORG_Q, "active", null],
        [revoked, ORG_P, "revoked", new Date()],
      ] as const) {
        await db.query(
          "INSERT INTO portal_account (organization_id,user_id,relationship,status,display_name_cipher,email_cipher,revoked_at) VALUES ($1,$2,'patient_self',$3,'x','x',$4)",
          [org, user, status, revokedAt],
        );
      }
      await rename(ORG_P, "harbor-care"); // `harbor` becomes a retired alias
    });

    it("is true for a member and for a portal-only person (no membership) at the CURRENT slug", async () => {
      expect(await belongs("staff@x.test", "harbor-care")).toBe(true);
      expect(await belongs("PATIENT@x.test", "harbor-care")).toBe(true);
    });

    it("is false for a retired alias, a stranger, a revoked portal account, a suspended org and an unknown label", async () => {
      expect(await belongs("patient@x.test", "harbor")).toBe(false);
      expect(await belongs("stranger@x.test", "harbor-care")).toBe(false);
      expect(await belongs("revoked@x.test", "harbor-care")).toBe(false);
      expect(await belongs("patient@x.test", "quiet")).toBe(false);
      expect(await belongs("staff@x.test", "nobody")).toBe(false);
      expect(await belongs("%", "harbor-care")).toBe(false);
    });

    it("is executable by the app role only", async () => {
      const { rows } = await db.query(
        `SELECT has_function_privilege('chartwarden_app','email_belongs_to_tenant(text,text)','EXECUTE') AS app,
                has_function_privilege('chartwarden_readonly','email_belongs_to_tenant(text,text)','EXECUTE') AS ro`,
      );
      expect(rows[0]).toEqual({ app: true, ro: false });
    });
  });
});
