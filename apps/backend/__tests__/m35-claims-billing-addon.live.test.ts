/**
 * ADR-0108 — LIVE Postgres proof of the claims-billing add-on data path (migration 1321) and the M35 add-on service.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m35:claims-billing-addon:live
 *
 * Proves, as the real NOBYPASSRLS `chartwarden_app` role where it matters:
 *   - the app role can neither INSERT nor UPDATE `subscription_addon` (a tenant cannot grant itself the add-on);
 *   - the entitlement reader on the tenant pool sees only its own org (cross-tenant isolation under FORCE RLS);
 *   - the partial unique index admits one live row per (org, add-on), and the service answers 409 on a second grant;
 *   - grant / cancel write M4 audit rows and their outbox events through the REAL catalog-validating publisher;
 *   - a canceled add-on, a suspended base subscription and an expired trial all deny with their own reason.
 * The platform runner is the REAL provisioned `chartwarden_platform_login` (BYPASSRLS, but bound by its enumerated table
 * grants), so a missing grant in scripts/db/provision-runtime-roles.ts fails here, not in production.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildDrizzleAddonService } from "../src/modules/35-subscription/addon/addon-service";
import { createDrizzleClaimsBillingEntitlementReader } from "../src/modules/35-subscription/addon/entitlement";
import { M35_OUTBOX_EVENTS } from "../src/modules/35-subscription/events-by-m35";
import type { M35WriteActor } from "../src/modules/35-subscription/routes/actor";
import type {
  PlatformRunner,
  WriteOutboxPort,
} from "../src/modules/35-subscription/routes/service-drizzle";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-addon";

const ORG_A = "a1000000-0000-4000-8000-000000000001";
const ORG_B = "b2000000-0000-4000-8000-000000000002";
const MEMBERSHIP = "c3000000-0000-4000-8000-000000000003";

const actor = (organizationId: string): M35WriteActor => ({
  organizationId,
  userId: "d4000000-0000-4000-8000-000000000004",
  roles: ["platform_billing_admin"],
  membershipId: MEMBERSHIP,
  stepUpRecent: true,
});

describe.skipIf(!DB_URL)("ADR-0108 claims-billing add-on — LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let platformDb: ReturnType<typeof createDbClient>;
  let platformRunner: PlatformRunner;
  let outbox: WriteOutboxPort;
  let subA = "";
  let subB = "";
  let addonId = "";

  async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await admin.query(text, params)).rows as T[];
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await admin.query("CREATE SCHEMA IF NOT EXISTS public");
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "cb-addon-a"],
      [ORG_B, "cb-addon-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    const [plan] = await q<{ id: string }>(
      `INSERT INTO plan (slug,name,tier,cadence,base_price_cents,is_active)
       VALUES ('starter-monthly','Starter','starter','monthly',29900,true) RETURNING id`,
    );
    for (const org of [ORG_A, ORG_B]) {
      const [row] = await q<{ id: string }>(
        "INSERT INTO subscription (organization_id, plan_id, status) VALUES ($1,$2,'active') RETURNING id",
        [org, plan?.id],
      );
      if (org === ORG_A) subA = row?.id ?? "";
      else subB = row?.id ?? "";
    }
    addonId =
      (await q<{ id: string }>("SELECT id FROM addon WHERE slug='claims_billing'"))[0]?.id ?? "";

    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const provisioned = spawnSync("bun", ["run", "scripts/db/provision-runtime-roles.ts"], {
      cwd: join(__dirname, "../../.."),
      env: {
        ...process.env,
        PROVISION_DATABASE_URL: DB_URL,
        CHARTWARDEN_PLATFORM_PASSWORD: PLATFORM_PASSWORD,
      },
      encoding: "utf8",
    });
    expect(provisioned.status, provisioned.stderr).toBe(0);
    const platformUrl = new URL(DB_URL as string);
    platformUrl.username = "chartwarden_platform_login";
    platformUrl.password = PLATFORM_PASSWORD;
    platformDb = createDbClient({ connectionString: platformUrl.toString() });
    platformRunner = (fn) => platformDb.db.transaction((tx) => fn(tx as unknown as DbClient));
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M35_OUTBOX_EVENTS]));
    outbox = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m35" }),
    };
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await platformDb?.close();
    await admin?.end();
  });

  it("migration 1321 seeds the one claims_billing add-on, unpriced", async () => {
    const rows = await q<{
      slug: string;
      meter_event_type: string;
      unit_price_cents: string | null;
    }>("SELECT slug, meter_event_type, unit_price_cents FROM addon");
    expect(rows).toEqual([
      { slug: "claims_billing", meter_event_type: "billing_addon_patient", unit_price_cents: null },
    ]);
  });

  it("the app role cannot INSERT or UPDATE subscription_addon (no tenant self-grant)", async () => {
    const tenant = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await tenant.connect();
    try {
      await tenant.query("BEGIN");
      await tenant.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await expect(
        tenant.query(
          `INSERT INTO subscription_addon (organization_id, subscription_id, addon_id, status, grant_reason)
           VALUES ($1,$2,$3,'active','self grant')`,
          [ORG_A, subA, addonId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await tenant.query("ROLLBACK");
      await tenant.query("BEGIN");
      await tenant.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await expect(
        tenant.query("UPDATE subscription_addon SET status='active' WHERE organization_id=$1", [
          ORG_A,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await tenant.query("ROLLBACK");
    } finally {
      await tenant.end();
    }
  });

  it("grants through the platform runner, emits the event, audits, and entitles only that org", async () => {
    const addons = buildDrizzleAddonService(app.db, { platformRunner, outbox });
    const reader = createDrizzleClaimsBillingEntitlementReader(app.db);
    expect(await reader.entitlementForOrg(ORG_A)).toEqual({
      entitled: false,
      reason: "never_purchased",
    });

    const granted = await addons.grantAddon(actor(ORG_A), subA, {
      addonSlug: "claims_billing",
      mode: "grant",
      reason: "signed order form 2026-11",
    });
    expect(granted).toMatchObject({ status: "active", live: true, organizationId: ORG_A });

    expect(await reader.entitlementForOrg(ORG_A)).toEqual({ entitled: true });
    // Cross-tenant: org B's tenant-pool read sees none of org A's rows.
    expect(await reader.entitlementForOrg(ORG_B)).toEqual({
      entitled: false,
      reason: "never_purchased",
    });

    const events = await q<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_event WHERE event_type='m35.claims_billing_addon.granted' AND organization_id=$1",
      [ORG_A],
    );
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual([
      "effectiveAt",
      "organizationId",
      "status",
      "subscriptionAddonId",
      "subscriptionId",
    ]);
    const audits = await q(
      "SELECT 1 FROM audit_event WHERE event_type='subscription_addon.insert' AND organization_id=$1",
      [ORG_A],
    );
    expect(audits).toHaveLength(1);
  });

  it("refuses a second live grant: 409 from the service, unique violation from the index", async () => {
    const addons = buildDrizzleAddonService(app.db, { platformRunner, outbox });
    await expect(
      addons.grantAddon(actor(ORG_A), subA, {
        addonSlug: "claims_billing",
        mode: "grant",
        reason: "duplicate",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      admin.query(
        `INSERT INTO subscription_addon (organization_id, subscription_id, addon_id, status, grant_reason)
         VALUES ($1,$2,$3,'trialing',$4)`,
        [ORG_A, subA, addonId, "direct"],
      ),
    ).rejects.toMatchObject({ code: "23514" }); // trialing needs trial_ends_at (CHECK) …
    await expect(
      admin.query(
        `INSERT INTO subscription_addon (organization_id, subscription_id, addon_id, status, grant_reason)
         VALUES ($1,$2,$3,'active',$4)`,
        [ORG_A, subA, addonId, "direct"],
      ),
    ).rejects.toMatchObject({ code: "23505" }); // … and a second live row breaks the partial unique index
  });

  it("denies on a suspended base subscription, then lapses on cancel", async () => {
    const reader = createDrizzleClaimsBillingEntitlementReader(app.db);
    await admin.query("UPDATE subscription SET status='suspended' WHERE id=$1", [subA]);
    expect(await reader.entitlementForOrg(ORG_A)).toEqual({
      entitled: false,
      reason: "subscription_suspended",
    });
    await admin.query("UPDATE subscription SET status='active' WHERE id=$1", [subA]);

    const addons = buildDrizzleAddonService(app.db, { platformRunner, outbox });
    const canceled = await addons.cancelAddon(actor(ORG_A), subA, addonId);
    expect(canceled).toMatchObject({ status: "canceled", live: false });
    expect(await reader.entitlementForOrg(ORG_A)).toEqual({ entitled: false, reason: "lapsed" });
    const events = await q(
      "SELECT 1 FROM outbox_event WHERE event_type='m35.claims_billing_addon.canceled' AND organization_id=$1",
      [ORG_A],
    );
    expect(events).toHaveLength(1);
    // The cancel names its operator, on the row and so in the write-audit row's after-image.
    const [row] = await q<{ canceled_by_membership_id: string | null }>(
      "SELECT canceled_by_membership_id FROM subscription_addon WHERE id=$1",
      [canceled.id],
    );
    expect(row?.canceled_by_membership_id).toBe(MEMBERSHIP);
    const audited = await q<{ who: string | null }>(
      `SELECT after->>'canceled_by_membership_id' AS who FROM audit_event
        WHERE resource_kind='subscription_addon' AND resource_id=$1 AND after->>'status'='canceled'`,
      [canceled.id],
    );
    expect(audited.map((a) => a.who)).toEqual([MEMBERSHIP]);
  });

  it("the admin list and usage reads work on the platform credential (they back GET /api/admin/usage/:org/current)", async () => {
    const addons = buildDrizzleAddonService(app.db, { platformRunner, outbox });
    expect((await addons.listAddons()).map((a) => a.slug)).toContain("claims_billing");
    // Both orgs: one that holds the add-on and one that never did. A missing grant rejects here.
    await addons.adminAddonUsage(ORG_A);
    await addons.adminAddonUsage(ORG_B);
  });

  it("a trial entitles until it ends; a new grant then closes the expired row", async () => {
    let clock = new Date(Date.now() + 60_000);
    const addons = buildDrizzleAddonService(app.db, { platformRunner, outbox, now: () => clock });
    const trialEndsAt = new Date(Date.now() + 3_600_000);
    await addons.grantAddon(actor(ORG_B), subB, {
      addonSlug: "claims_billing",
      mode: "trial",
      trialEndsAt: trialEndsAt.toISOString(),
      reason: "30-day pilot",
    });
    expect(
      await createDrizzleClaimsBillingEntitlementReader(app.db).entitlementForOrg(ORG_B),
    ).toEqual({
      entitled: true,
    });
    const afterTrial = new Date(trialEndsAt.getTime() + 1_000);
    expect(
      await createDrizzleClaimsBillingEntitlementReader(app.db, () => afterTrial).entitlementForOrg(
        ORG_B,
      ),
    ).toEqual({ entitled: false, reason: "lapsed" });

    clock = afterTrial;
    const regranted = await addons.grantAddon(actor(ORG_B), subB, {
      addonSlug: "claims_billing",
      mode: "grant",
      reason: "converted after pilot",
    });
    expect(regranted.status).toBe("active");
    const rows = await q<{ status: string }>(
      "SELECT status FROM subscription_addon WHERE organization_id=$1 ORDER BY started_at",
      [ORG_B],
    );
    expect(rows.map((r) => r.status)).toEqual(["canceled", "active"]);
  });
});
