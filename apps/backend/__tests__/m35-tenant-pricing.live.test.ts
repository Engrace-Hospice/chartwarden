/**
 * Slice 2 (tenant pricing) — LIVE Postgres proof, on synthetic data only.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m35:tenant-pricing:live
 *
 * Two real connections, never a superuser for the code under test: the NOBYPASSRLS `chartwarden_app` (the tenant) and the provisioned
 * `chartwarden_platform_login` (the platform carrier, BYPASSRLS but bound by its enumerated grants). The superuser only seeds and reads
 * back. Proves:
 *   1. the plan editor: draft -> published (frozen by the database, not by convention) -> new version -> archived; platform-only writes
 *      (the app role writes none of it); the retired flat tiers stay readable and a tenant can neither pick nor leave a contracted plan;
 *   2. onboarding step 2: the subscription, history, contract, event and audit rows land in one platform transaction, the wizard's
 *      `plan_contract` step is settled THROUGH the wizard, a locked step / a live tenant / an unpublished plan refuse and write nothing,
 *      and a failed settlement resumes without a duplicate subscription;
 *   3. the meters on seeded data: the active-staff definition (auditors, operators, never-signed-in, revoked-before-the-month, pending,
 *      and a user with two memberships), the daily census through M5's reader, net collections through M25's reader;
 *   4. the statement: both sides of the greater-of rule, the billing percentage per mode (none pays none), the one-time fee on the first
 *      statement only, an idempotent draft, a final month frozen by its trigger (and by the grace window), the Stripe seam;
 *   5. tenant isolation of contracts, census and statements, and what the tenant is never shown.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditPlatformEvent } from "@chartwarden/audit";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { computeBillingPseudonym } from "@chartwarden/subscription-billing";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildPatientCensusReader } from "../src/modules/05-patient/census-reader";
import { buildNetCollectionsReader } from "../src/modules/25-remittance/net-collections-reader";
import { buildPricingOnboardingPort } from "../src/modules/34-saas-tenant-platform/onboarding/pricing-port";
import { M35_OUTBOX_EVENTS } from "../src/modules/35-subscription/events-by-m35";
import { buildM35SessionCreatedConsumer } from "../src/modules/35-subscription/outbox-consumers/m2-session-created";
import { recordDailyCensusForOrg } from "../src/modules/35-subscription/pricing/census-daily";
import {
  type ContractService,
  buildContractService,
  readBillingServiceMode,
} from "../src/modules/35-subscription/pricing/contract-service";
import {
  type CreatePricingPlanInput,
  type PricingPlanService,
  buildPricingPlanService,
} from "../src/modules/35-subscription/pricing/plan-service";
import { countActiveStaffForMonth } from "../src/modules/35-subscription/pricing/staff-meter";
import {
  type StatementStripePort,
  calendarMonthOf,
  runStatementsForOrg,
} from "../src/modules/35-subscription/pricing/statement-service";
import type { M35WriteActor } from "../src/modules/35-subscription/routes/actor";
import type { PlatformRunner, WriteOutboxPort } from "../src/modules/35-subscription/routes/index";
import { buildDrizzleM35RouteService } from "../src/modules/35-subscription/routes/service-drizzle";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-pricing";

const ORG_A = "a1000000-0000-4000-8000-0000000000a1"; // the main pricing tenant, onboarding
const ORG_B = "b2000000-0000-4000-8000-0000000000b2"; // a second tenant, for isolation
const ORG_C = "c3000000-0000-4000-8000-0000000000c3"; // per-user side of the greater-of rule
const ORG_D = "d4000000-0000-4000-8000-0000000000d4"; // bills outside ChartWarden
const ORG_E = "e5000000-0000-4000-8000-0000000000e5"; // already live: refuses a new subscription
const ORG_F = "f6000000-0000-4000-8000-0000000000f6"; // provisioning: signs, step stays pending
const OPERATOR_USER = "0a000000-0000-4000-8000-000000000001";
const OPERATOR_MEMBERSHIP = "0b000000-0000-4000-8000-000000000001";
const KEY = {
  keyEpoch: "epoch-20261101T0000Z-pricing",
  keyMaterial: "pricing-live-suite-key-material",
};
const keyProvider = { activeKey: async () => KEY };

const NOV = calendarMonthOf(new Date("2026-11-15T00:00:00Z"));
const DEC = calendarMonthOf(new Date("2026-12-15T00:00:00Z"));
const at = (iso: string) => () => new Date(iso);

const operator: M35WriteActor = {
  organizationId: "00000000-0000-4000-8000-000000000000",
  userId: OPERATOR_USER,
  roles: ["platform_ops"],
  membershipId: OPERATOR_MEMBERSHIP,
  stepUpRecent: true,
};

// Demo prices only: the platform hardcodes none, a plan carries them.
const plan = (over: Partial<CreatePricingPlanInput> = {}): CreatePricingPlanInput => ({
  familySlug: "hospice-standard",
  name: "Hospice standard",
  perUserPriceCents: 10_000,
  bands: [
    { minAdc: 0, monthlyFeeCents: 100_000 },
    { minAdc: 10, monthlyFeeCents: 200_000 },
    { minAdc: 17, monthlyFeeCents: 300_000 },
    { minAdc: 26, monthlyFeeCents: 400_000 },
  ],
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  contractTermMonths: 12,
  implementationFeeCents: 250_000,
  minimumMonthlyCents: null,
  ...over,
});

describe.skipIf(!DB_URL)("slice 2 tenant pricing — LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let platformDb: ReturnType<typeof createDbClient>;
  let platformRunner: PlatformRunner;
  let outbox: WriteOutboxPort;
  let plans: PricingPlanService;
  let wizardCalls: {
    attests: Array<Record<string, unknown>>;
    failAttest: boolean;
    locked: string | null;
  };
  let contracts: ContractService;
  let planV1 = "";
  let planV1Slug = "";
  let planV2Id = "";
  let planV2Slug = "";
  let perUserPlanSlug = "";

  async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await admin.query(text, params)).rows as T[];
  }

  async function tenant(client: Client, org: string, fn: () => Promise<void>): Promise<void> {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await fn();
    } finally {
      await client.query("ROLLBACK");
    }
  }

  async function seedOrg(id: string, slug: string, status: string): Promise<void> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
      [id, slug],
    );
    await admin.query(
      `INSERT INTO tenant_account (organization_id,status,legal_business_name,billing_contact_email,breach_notification_email)
       VALUES ($1,$2::tenant_account_status,$3,'billing@pricing.example','breach@pricing.example')`,
      [id, status, `${slug} hospice`],
    );
  }

  async function seedUser(n: string): Promise<string> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO "user" (email,name) VALUES ($1,$2) RETURNING id`,
      [`${n}@pricing.example`, n],
    );
    return row?.id ?? "";
  }

  async function seedMembership(
    org: string,
    userId: string,
    o: { accepted?: string | null; revoked?: string | null; status?: string } = {},
  ): Promise<string> {
    const accepted = o.accepted === undefined ? "2026-01-01T00:00:00Z" : o.accepted;
    const [row] = await q<{ id: string }>(
      `INSERT INTO membership (organization_id,user_id,status,accepted_at,revoked_at)
       VALUES ($1,$2,$3::membership_status,$4,$5) RETURNING id`,
      [org, userId, o.status ?? (o.revoked ? "revoked" : "active"), accepted, o.revoked ?? null],
    );
    return row?.id ?? "";
  }

  async function grantOrgRole(
    org: string,
    membershipId: string,
    key: string,
    category: string,
  ): Promise<void> {
    const found = await q<{ id: string }>(
      "SELECT id FROM role WHERE organization_id=$1 AND key=$2",
      [org, key],
    );
    const roleId =
      found[0]?.id ??
      (
        await q<{ id: string }>(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,$3::role_category,true) RETURNING id",
          [org, key, category],
        )
      )[0]?.id;
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [org, membershipId, roleId],
    );
  }

  async function grantPlatformRole(org: string, membershipId: string): Promise<void> {
    const [role] = await q<{ id: string }>(
      "SELECT id FROM role WHERE organization_id IS NULL AND key='platform_alert_audience'",
    );
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [org, membershipId, role?.id],
    );
  }

  /** A staff sign-in through the REAL consumer (the same path `select-organization` feeds), on the tenant pool. */
  async function signIn(org: string, userId: string, when: string): Promise<void> {
    const consumer = buildM35SessionCreatedConsumer({ db: app.db, keyProvider, now: at(when) });
    await consumer.handle({
      eventType: "m2.session.created",
      organizationId: org,
      payload: { sessionId: `s-${userId}-${when}`, userId, organizationId: org },
    });
  }

  async function ledgerRow(org: string, membershipId: string, period: string): Promise<void> {
    await admin.query(
      `INSERT INTO user_active_period (organization_id, membership_pseudonym, pseudonym_key_epoch, period_year_month, was_active,
         first_session_at, last_session_at) VALUES ($1,$2,$3,$4,true,now(),now())`,
      [org, computeBillingPseudonym(KEY.keyMaterial, membershipId), KEY.keyEpoch, period],
    );
  }

  async function censusDays(
    org: string,
    from: number,
    to: number,
    count: number,
    month = "2026-11",
  ): Promise<void> {
    for (let d = from; d <= to; d++) {
      await admin.query(
        `INSERT INTO patient_census_daily (organization_id, census_date, active_patient_count, observed_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id, census_date) DO NOTHING`,
        [
          org,
          `${month}-${String(d).padStart(2, "0")}`,
          count,
          `${month}-${String(d).padStart(2, "0")}T18:00:00Z`,
        ],
      );
    }
  }

  let adviceSeq = 0;
  async function remittance(
    org: string,
    o: { dollars: string; productionDate: string; status?: string; kind?: string; method?: string },
  ): Promise<void> {
    adviceSeq += 1;
    await admin.query(
      `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind, interchange_control_number,
         transaction_set_control_number, payment_method, total_payment_amount, production_date, minio_object_key, file_sha256, parse_status)
       VALUES ($1,$2,$3,$4::m25_payer_kind,$5,$6,$7::m25_payment_method_kind,$8,$9,$10,$11,$12::m25_parse_status)`,
      [
        org,
        "99000000-0000-4000-8000-000000000001",
        "99000000-0000-4000-8000-000000000002",
        o.kind ?? "medicare",
        String(100_000_000 + adviceSeq),
        String(1_000 + adviceSeq),
        o.method ?? "eft",
        o.dollars,
        o.productionDate,
        `synthetic/${adviceSeq}.835`,
        String(adviceSeq).padStart(64, "0"),
        o.status ?? "posted",
      ],
    );
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
    outbox = { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m35" }) };

    // The operator is a real user; tenants and their accounts are real rows (the onboarding port reads them on the platform carrier).
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'operator@pricing.example','operator')`,
      [OPERATOR_USER],
    );
    await seedOrg(ORG_A, "pricing-a", "onboarding");
    await seedOrg(ORG_B, "pricing-b", "onboarding");
    await seedOrg(ORG_C, "pricing-c", "onboarding");
    await seedOrg(ORG_D, "pricing-d", "onboarding");
    await seedOrg(ORG_E, "pricing-e", "active");
    await seedOrg(ORG_F, "pricing-f", "provisioning");

    // A wizard double: the port is the real one, the wizard behind it records what it is asked.
    wizardCalls = { attests: [], failAttest: false, locked: null };
    const slugs = new Map([
      ["pricing-a", ORG_A],
      ["pricing-b", ORG_B],
      ["pricing-c", ORG_C],
      ["pricing-d", ORG_D],
      ["pricing-e", ORG_E],
      ["pricing-f", ORG_F],
    ]);
    const stepStatus = new Map<string, "pending" | "done">();
    const wizard = {
      getPlatform: async (slug: string) => {
        if (!slugs.has(slug)) throw new NotFoundError("tenant");
        return {
          steps: [
            {
              key: "plan_contract",
              id: `task-${slug}`,
              status: stepStatus.get(slug) ?? "pending",
              lockedBy: wizardCalls.locked,
            },
          ],
        } as never;
      },
      attestPlatform: async (
        slug: string,
        taskId: string,
        actor: unknown,
        input: Record<string, unknown>,
      ) => {
        if (wizardCalls.failAttest)
          throw new ChartWardenError("ONBOARDING_TASK_CHANGED", "changed concurrently", 409);
        wizardCalls.attests.push({ slug, taskId, actor, input });
        stepStatus.set(slug, "done");
        return {} as never;
      },
    };
    const audit = {
      record: (
        tx: DbClient,
        e: Parameters<
          NonNullable<Parameters<typeof buildContractService>[0]["audit"]>["record"]
        >[1],
      ) =>
        auditPlatformEvent(tx as never, {
          eventType: e.eventType,
          resourceKind: e.resourceKind,
          resourceId: e.resourceId,
          outcome: "success",
          severity: "warn",
          correlationId: `live:${e.eventType}:${e.resourceId}:${Math.random()}`,
          context: {
            ...(e.organizationId ? { organizationId: e.organizationId } : {}),
            operatorUserId: e.operator.userId,
            operatorMembershipId: e.operator.membershipId,
            reason: e.reason,
            ...e.detail,
          },
        }),
    };
    plans = buildPricingPlanService({ platformRunner, audit });
    contracts = buildContractService({
      db: app.db,
      platformRunner,
      outbox,
      audit,
      onboarding: buildPricingOnboardingPort({ wizard }),
      now: at("2026-11-05T12:00:00Z"),
    });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await platformDb?.close();
    await admin?.end();
  });

  // ── 1. the plan editor ─────────────────────────────────────────────────────────────────────────────
  describe("the plan editor", () => {
    it("creates a draft, publishes it, and the database then FREEZES the published prices and bands", async () => {
      const draft = await plans.create(operator, plan(), "the 2027 standard price list");
      planV1 = draft.id;
      planV1Slug = draft.slug;
      expect(draft).toMatchObject({
        slug: "hospice-standard-v1",
        version: 1,
        status: "draft",
        offered: false,
      });
      expect(draft.bands.map((b) => [b.minAdc, b.maxAdc])).toEqual([
        [0, 9],
        [10, 16],
        [17, 25],
        [26, null],
      ]);

      // a draft is editable in place
      const edited = await plans.replaceDraft(
        operator,
        planV1,
        plan({ perUserPriceCents: 12_000 }),
        "price list correction",
      );
      expect(edited.perUserPriceCents).toBe(12_000);
      expect((await plans.listOffered()).map((p) => p.id)).not.toContain(planV1); // a draft is never offered

      const published = await plans.publish(operator, planV1, "approved by the owner");
      expect(published).toMatchObject({ status: "published", offered: true });
      expect(published.publishedAt).not.toBeNull();

      // frozen: not even the superuser can change a published price, rewrite a band or add one
      await expect(
        admin.query("UPDATE plan SET per_user_price_cents = 1 WHERE id = $1", [planV1]),
      ).rejects.toThrow(/frozen/);
      await expect(
        admin.query("UPDATE plan SET billing_software_bps = 9 WHERE id = $1", [planV1]),
      ).rejects.toThrow(/frozen/);
      await expect(
        admin.query("UPDATE plan_census_band SET monthly_fee_cents = 1 WHERE plan_id = $1", [
          planV1,
        ]),
      ).rejects.toThrow(/published/);
      await expect(
        admin.query("DELETE FROM plan_census_band WHERE plan_id = $1", [planV1]),
      ).rejects.toThrow(/published/);
      await expect(
        admin.query(
          "INSERT INTO plan_census_band (plan_id,min_adc,monthly_fee_cents) VALUES ($1,40,1)",
          [planV1],
        ),
      ).rejects.toThrow(/published/);
      await expect(
        plans.replaceDraft(operator, planV1, plan(), "try to edit a published plan"),
      ).rejects.toThrow(/draft/);
      // ... while its name and offered state can still move (archive does)
      await expect(
        admin.query("UPDATE plan SET description = 'x' WHERE id = $1", [planV1]),
      ).resolves.toBeDefined();
    });

    it("refuses invalid prices with every problem listed, and a duplicate family", async () => {
      const bad = plan({
        familySlug: "bad-plan",
        bands: [
          { minAdc: 5, monthlyFeeCents: 100 },
          { minAdc: 5, monthlyFeeCents: 50 },
        ],
        managedBillingBps: 50,
      });
      const err = await plans.create(operator, bad, "a plan that cannot be valid").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      const codes = ((err as { details?: Array<{ code: string }> }).details ?? []).map(
        (d) => d.code,
      );
      expect(codes).toEqual(
        expect.arrayContaining([
          "BAND_ZERO_REQUIRED",
          "BAND_THRESHOLD_DUPLICATE",
          "MANAGED_RATE_BELOW_SOFTWARE",
        ]),
      );
      await expect(plans.create(operator, plan(), "same family again")).rejects.toThrow(/family/);
      // a reason is required, and a patient identifier is refused
      await expect(
        plans.create(operator, plan({ familySlug: "no-reason" }), "short"),
      ).rejects.toThrow(/reason/);
      await expect(
        plans.create(
          operator,
          plan({ familySlug: "phi-reason" }),
          "customer read out 900-12-3456 on the call",
        ),
      ).rejects.toThrow(/patient identifier/);
    });

    it("a price change is a NEW VERSION that supersedes the old one; archiving stops offering the old one", async () => {
      const v2 = await plans.newVersion(operator, planV1, "2028 price increase");
      planV2Id = v2.id;
      planV2Slug = v2.slug;
      expect(v2).toMatchObject({
        slug: "hospice-standard-v2",
        version: 2,
        status: "draft",
        supersedesPlanId: planV1,
      });
      expect(v2.bands).toHaveLength(4);
      await expect(
        plans.newVersion(operator, planV1, "a second draft of the same family"),
      ).rejects.toThrow(/draft/);
      await plans.replaceDraft(
        operator,
        planV2Id,
        plan({ perUserPriceCents: 15_000 }),
        "2028 prices",
      );
      await plans.publish(operator, planV2Id, "approved by the owner");
      await plans.archive(operator, planV1, "superseded by v2");
      const offered = await plans.listOffered();
      expect(offered.map((p) => p.slug)).toEqual([planV2Slug]);
      const all = await plans.list();
      expect(all.map((p) => [p.slug, p.status])).toEqual([
        ["hospice-standard-v2", "published"],
        ["hospice-standard-v1", "archived"],
      ]);
      // v1 is archived but its prices are untouched: a subscription that signed it keeps them
      expect((await plans.get(planV1)).perUserPriceCents).toBe(12_000);
      await expect(plans.archive(operator, planV1, "archive twice")).rejects.toThrow(/published/);
    });

    it("writes one structured audit row per change, naming the operator and the reason", async () => {
      const rows = await q<{ event_type: string; context: Record<string, string> }>(
        `SELECT event_type, context FROM audit_event WHERE event_type LIKE 'm35.plan.%' ORDER BY created_at`,
      );
      expect(rows.map((r) => r.event_type)).toEqual(
        expect.arrayContaining([
          "m35.plan.draft_created",
          "m35.plan.draft_updated",
          "m35.plan.published",
          "m35.plan.version_created",
          "m35.plan.archived",
        ]),
      );
      expect(rows[0]?.context).toMatchObject({
        operatorUserId: OPERATOR_USER,
        operatorMembershipId: OPERATOR_MEMBERSHIP,
      });
      expect(rows.some((r) => r.context.reason === "superseded by v2")).toBe(true);
    });

    it("the app role (a tenant) writes none of the pricing tables", async () => {
      const tenantClient = new Client({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await tenantClient.connect();
      try {
        const denied = async (sqlText: string, params: unknown[] = []) => {
          await tenant(tenantClient, ORG_A, async () => {
            await expect(tenantClient.query(sqlText, params)).rejects.toMatchObject({
              code: "42501",
            });
          });
        };
        await denied("UPDATE plan SET per_user_price_cents = 1 WHERE id = $1", [planV2Id]);
        await denied(
          "INSERT INTO plan_census_band (plan_id,min_adc,monthly_fee_cents) VALUES ($1,99,1)",
          [planV2Id],
        );
        await denied("UPDATE plan_census_band SET monthly_fee_cents = 1");
        await denied("DELETE FROM plan_census_band");
        await denied(
          "INSERT INTO patient_census_daily (organization_id,census_date,active_patient_count,observed_at) VALUES ($1,'2026-11-01',1,now())",
          [ORG_A],
        );
        await denied("UPDATE patient_census_daily SET active_patient_count = 0");
        await denied("UPDATE subscription_statement SET total_cents = 0");
        await denied("DELETE FROM subscription_statement");
        await denied("UPDATE subscription_contract SET billing_service_mode = 'none'");
        await denied(
          "INSERT INTO subscription_contract (organization_id,subscription_id,plan_id,contract_start_on,signed_by_membership_id,signed_reason) VALUES ($1,$1,$1,'2026-11-01',$1,'a self-signed contract')",
          [ORG_A],
        );
      } finally {
        await tenantClient.end();
      }
    });

    it("the platform carrier holds exactly the grants slice 2 writes with, and no more", async () => {
      const platformUrl = new URL(DB_URL as string);
      platformUrl.username = "chartwarden_platform_login";
      platformUrl.password = PLATFORM_PASSWORD;
      const carrier = new Client({ connectionString: platformUrl.toString() });
      await carrier.connect();
      try {
        for (const [sqlText, why] of [
          ["UPDATE subscription SET status = 'canceled'", "subscription: INSERT only"],
          [
            "UPDATE subscription_contract SET plan_id = plan_id",
            "contract: only the billing service mode may be updated",
          ],
          [
            "UPDATE subscription_contract SET signed_reason = 'rewritten for the audit'",
            "contract: signed terms are not updatable",
          ],
          ["DELETE FROM subscription_statement", "statement: never deleted"],
          ["DELETE FROM patient_census_daily", "census: never deleted"],
          ["DELETE FROM plan", "plan: never deleted"],
        ] as const) {
          await expect(carrier.query(sqlText), why).rejects.toMatchObject({ code: "42501" });
        }
      } finally {
        await carrier.end();
      }
    });

    it("the retired flat tiers stay readable, and a contracted plan is assigned by operations (a tenant can neither pick nor leave one)", async () => {
      const route = buildDrizzleM35RouteService(app.db, { platformRunner, outbox });
      await admin.query(
        `INSERT INTO plan (slug,name,tier,cadence,base_price_cents,is_active,trial_period_days)
         VALUES ('starter-monthly','Starter','starter','monthly',29900,true,0)`,
      );
      // the migration's retirement statement, run against a still-active flat plan
      const retire =
        readFileSync(join(MIGRATIONS_DIR, "1341_m35_census_banded_plan.sql"), "utf8").split(
          "-- Retire the flat tiers",
        )[1] ?? "";
      await admin.query(retire.replace(/^[^\n]*\n(--[^\n]*\n)*/, ""));
      const [legacy] = await q<{ is_active: boolean; deprecated_at: Date | null }>(
        "SELECT is_active, deprecated_at FROM plan WHERE slug='starter-monthly'",
      );
      expect(legacy).toMatchObject({ is_active: false });
      expect(legacy?.deprecated_at).not.toBeNull();
      await admin.query(
        "UPDATE plan SET is_active = true, deprecated_at = NULL WHERE slug='starter-monthly'",
      ); // an operator re-offers it

      const tenantActor = {
        organizationId: ORG_B,
        userId: await seedUser("tenant-b-admin"),
        roles: ["org_admin"],
        membershipId: OPERATOR_MEMBERSHIP,
        stepUpRecent: true,
      };
      // the tenant catalog lists the flat plan and never a contracted one
      expect((await route.listActivePlans()).map((p) => p.slug)).toEqual(["starter-monthly"]);
      // a tenant cannot select a contracted plan
      await expect(
        route.createSubscription(tenantActor, { planSlug: planV2Slug }),
      ).rejects.toMatchObject({ code: "PLAN_ASSIGNED_BY_OPERATIONS" });
      // the legacy admin editor cannot activate one (publishing has its own rules)
      await expect(route.adminActivatePlan(operator, planV2Id)).rejects.toMatchObject({
        code: "PLAN_ASSIGNED_BY_OPERATIONS",
      });
      // a flat plan still works exactly as before
      const flat = await route.createSubscription(tenantActor, { planSlug: "starter-monthly" });
      expect(flat).toMatchObject({ planSlug: "starter-monthly" });
      // ... and that tenant cannot move onto a contracted plan
      await expect(
        route.changePlan(tenantActor, { newPlanSlug: planV2Slug, prorationBehavior: "none" }),
      ).rejects.toMatchObject({
        code: "PLAN_ASSIGNED_BY_OPERATIONS",
      });
      await admin.query(
        "UPDATE subscription SET status='canceled', canceled_at=now() WHERE organization_id=$1",
        [ORG_B],
      );
      await admin.query("UPDATE plan SET is_active=false WHERE slug='starter-monthly'");
    });
  });

  // ── 2. onboarding step 2 ───────────────────────────────────────────────────────────────────────────
  describe("onboarding step 2: sign the tenant and settle plan_contract", () => {
    const body = (
      planSlug: string,
      mode: "none" | "billing_software" | "managed_billing" = "billing_software",
    ) => ({
      planSlug,
      billingServiceMode: mode,
      orderFormRef: "OF-2026-0042",
      reason: "order form signed by the customer's administrator",
    });

    it("refuses an unpublished, an archived and a non-census plan, writing nothing", async () => {
      const draft = await plans.newVersion(
        operator,
        planV2Id,
        "a v3 draft that is never published",
      );
      await expect(
        contracts.createForTenant(operator, "pricing-a", body(draft.slug)),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        contracts.createForTenant(operator, "pricing-a", body(planV1Slug)),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        contracts.createForTenant(operator, "pricing-a", body("starter-monthly")),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        contracts.createForTenant(operator, "no-such-tenant", body(planV2Slug)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await q("SELECT 1 FROM subscription WHERE organization_id=$1", [ORG_A])).toHaveLength(
        0,
      );
      await admin.query("DELETE FROM plan_census_band WHERE plan_id=$1", [draft.id]);
      await admin.query("DELETE FROM plan WHERE id=$1", [draft.id]);
    });

    it("a step locked behind an earlier one refuses (strict sequence), and nothing is created", async () => {
      wizardCalls.locked = "account_created";
      await expect(
        contracts.createForTenant(operator, "pricing-a", body(planV2Slug)),
      ).rejects.toMatchObject({
        code: "ONBOARDING_STEP_OUT_OF_ORDER",
      });
      wizardCalls.locked = null;
      expect(await q("SELECT 1 FROM subscription WHERE organization_id=$1", [ORG_A])).toHaveLength(
        0,
      );
    });

    it("a live tenant refuses: onboarding data is locked once the tenant is active", async () => {
      await expect(
        contracts.createForTenant(operator, "pricing-e", body(planV2Slug)),
      ).rejects.toMatchObject({ code: "TENANT_NOT_ONBOARDING" });
      expect(await q("SELECT 1 FROM subscription WHERE organization_id=$1", [ORG_E])).toHaveLength(
        0,
      );
    });

    it("signs the tenant: subscription, history, contract, event and audit in one transaction, and the step is attested THROUGH the wizard", async () => {
      const result = await contracts.createForTenant(operator, "pricing-a", body(planV2Slug));
      expect(result.resumed).toBe(false);
      expect(result.planContractStep).toEqual({ status: "settled" });
      expect(result.contract).toMatchObject({
        plan: { slug: planV2Slug, version: 2 },
        billingServiceMode: "billing_software",
        billingBps: 100,
        contractStartOn: "2026-11-05",
        contractEndsOn: "2027-11-05",
        implementationFeeCents: 250_000,
        signedByMembershipId: OPERATOR_MEMBERSHIP,
        orderFormRef: "OF-2026-0042",
      });

      const [sub] = await q<{ id: string; status: string; plan_id: string }>(
        "SELECT id, status, plan_id FROM subscription WHERE organization_id=$1",
        [ORG_A],
      );
      expect(sub).toMatchObject({ status: "active", plan_id: planV2Id });
      const [history] = await q<{ reason_code: string; to_status: string }>(
        "SELECT reason_code, to_status FROM subscription_state_history WHERE subscription_id=$1",
        [sub?.id],
      );
      expect(history).toEqual({ reason_code: "platform_onboarding_contract", to_status: "active" });
      const events = await q<{ event_type: string }>(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1",
        [sub?.id],
      );
      expect(events.map((e) => e.event_type)).toContain("m35.subscription.created");
      const audit = await q<{ context: Record<string, string> }>(
        "SELECT context FROM audit_event WHERE event_type='m35.subscription.contract_signed' AND resource_id=$1",
        [sub?.id],
      );
      expect(audit[0]?.context).toMatchObject({
        organizationId: ORG_A,
        operatorUserId: OPERATOR_USER,
        reason: "order form signed by the customer's administrator",
        planSlug: planV2Slug,
      });
      // the M1 baseline row-audit trigger records the write itself (it never names an actor: that is what the structured event above is for)
      const rowAudit = await q<{ event_type: string }>(
        "SELECT event_type FROM audit_event WHERE resource_kind='subscription_contract' AND organization_id=$1",
        [ORG_A],
      );
      expect(rowAudit.map((r) => r.event_type)).toContain("subscription_contract.insert");

      // the wizard was asked to attest the plan_contract step, with the contract as evidence (never the subscription id)
      expect(wizardCalls.attests).toHaveLength(1);
      expect(wizardCalls.attests[0]).toMatchObject({
        slug: "pricing-a",
        taskId: "task-pricing-a",
        actor: { kind: "platform", userId: OPERATOR_USER, membershipId: OPERATOR_MEMBERSHIP },
        input: {
          evidenceRef: `plan:${planV2Slug}`,
          reason: "order form signed by the customer's administrator",
        },
      });
      expect(
        String((wizardCalls.attests[0]?.input as { evidenceNote: string }).evidenceNote),
      ).toContain("OF-2026-0042");
    });

    it("a second sign of the same tenant, plan and mode RESUMES (no duplicate); a different plan or mode is refused", async () => {
      const again = await contracts.createForTenant(operator, "pricing-a", body(planV2Slug));
      expect(again.resumed).toBe(true);
      expect(again.planContractStep).toEqual({ status: "already_settled" });
      expect(await q("SELECT 1 FROM subscription WHERE organization_id=$1", [ORG_A])).toHaveLength(
        1,
      );
      await expect(
        contracts.createForTenant(operator, "pricing-a", body(planV2Slug, "managed_billing")),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_EXISTS" });
    });

    it("if settling fails AFTER the commit the subscription stays, the answer says pending, and the retry resumes and settles", async () => {
      wizardCalls.failAttest = true;
      const first = await contracts.createForTenant(
        operator,
        "pricing-b",
        body(planV2Slug, "none"),
      );
      expect(first.planContractStep).toEqual({
        status: "pending",
        reason: "ONBOARDING_TASK_CHANGED",
      });
      expect(
        await q("SELECT 1 FROM subscription WHERE organization_id=$1 AND status<>'canceled'", [
          ORG_B,
        ]),
      ).toHaveLength(1);
      wizardCalls.failAttest = false;
      const retry = await contracts.createForTenant(
        operator,
        "pricing-b",
        body(planV2Slug, "none"),
      );
      expect(retry).toMatchObject({ resumed: true, planContractStep: { status: "settled" } });
      expect(
        await q("SELECT 1 FROM subscription WHERE organization_id=$1 AND status<>'canceled'", [
          ORG_B,
        ]),
      ).toHaveLength(1);
    });

    it("a tenant still provisioning can be signed, but its step stays pending (the wizard acts only in onboarding)", async () => {
      const result = await contracts.createForTenant(operator, "pricing-f", body(planV2Slug));
      expect(result.planContractStep).toEqual({
        status: "pending",
        reason: "tenant_not_onboarding",
      });
      await admin.query(
        "UPDATE subscription SET status='canceled', canceled_at=now() WHERE organization_id=$1",
        [ORG_F],
      );
    });

    it("the database refuses a contract on a draft plan, or on a plan that is not the subscription's own", async () => {
      const [draft] = await q<{ id: string }>(
        `INSERT INTO plan (slug,family_slug,version,name,tier,cadence,base_price_cents,is_active,trial_period_days)
         VALUES ('guard-probe-v1','guard-probe',1,'Probe','census_banded','monthly',0,false,0) RETURNING id`,
      );
      const [sub] = await q<{ id: string }>(
        "SELECT id FROM subscription WHERE organization_id=$1",
        [ORG_A],
      );
      await expect(
        admin.query(
          `INSERT INTO subscription_contract (organization_id,subscription_id,plan_id,contract_start_on,signed_by_membership_id,signed_reason)
           VALUES ($1,$2,$3,'2026-11-05',$4,'a contract on a draft plan')`,
          [ORG_C, sub?.id, draft?.id, OPERATOR_MEMBERSHIP],
        ),
      ).rejects.toThrow(/published census_banded|subscription_contract/);
      // an existing contract cannot be re-pointed at another plan or organisation
      await expect(
        admin.query("UPDATE subscription_contract SET plan_id=$1 WHERE organization_id=$2", [
          planV1,
          ORG_A,
        ]),
      ).rejects.toThrow(/subscription_contract/);
      await admin.query("DELETE FROM plan WHERE id=$1", [draft?.id]);
    });

    it("changes the billing service mode on its own audited route (reason required, same mode is a no-op)", async () => {
      const changed = await contracts.setBillingServiceMode(
        operator,
        "pricing-a",
        "managed_billing",
        "the tenant moved to managed billing",
      );
      expect(changed).toMatchObject({ billingServiceMode: "managed_billing", billingBps: 400 });
      expect(
        (
          await contracts.setBillingServiceMode(
            operator,
            "pricing-a",
            "managed_billing",
            "idempotent repeat of the change",
          )
        ).billingServiceMode,
      ).toBe("managed_billing");
      const audit = await q<{ context: Record<string, string> }>(
        "SELECT context FROM audit_event WHERE event_type='m35.subscription.billing_service_mode_changed'",
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.context).toMatchObject({ from: "billing_software", to: "managed_billing" });
      await expect(
        contracts.setBillingServiceMode(operator, "pricing-a", "none", "no"),
      ).rejects.toThrow(/reason/);
      await contracts.setBillingServiceMode(
        operator,
        "pricing-a",
        "billing_software",
        "back to billing software",
      );
    });

    it("exposes the mode to another module: the BillingServiceModeReader body reads the tenant's own contract", async () => {
      expect(await readBillingServiceMode(app.db, ORG_A)).toBe("billing_software");
      expect(await readBillingServiceMode(app.db, ORG_B)).toBe("none");
      expect(await readBillingServiceMode(app.db, ORG_C)).toBeNull(); // no contract: never read as `none`
    });
  });

  // ── 3. the meters on seeded synthetic data ─────────────────────────────────────────────────────────
  describe("the meters", () => {
    it("the daily census rides M5's PatientCensusReader: contracted orgs only, latest observation of the day wins", async () => {
      const addPatient = async (org: string, mrn: string, status: string) =>
        admin.query(
          `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
           VALUES ($1,$2,'Test','Patient','1950-01-01','F',$3)`,
          [org, mrn, status],
        );
      for (let i = 1; i <= 6; i++) await addPatient(ORG_A, `A-${i}`, "active");
      await addPatient(ORG_A, "A-9", "discharged");
      await addPatient(ORG_C, "C-1", "active"); // C has no contract yet

      const reader = buildPatientCensusReader(app.db);
      const deps = (when: string) => ({ platformRunner, census: reader, now: at(when) });
      expect(await recordDailyCensusForOrg(deps("2026-11-01T18:00:00Z"), ORG_A)).toEqual({
        recorded: true,
        censusDate: "2026-11-01",
        count: 6,
      });
      expect(await recordDailyCensusForOrg(deps("2026-11-01T18:00:00Z"), ORG_C)).toEqual({
        recorded: false,
      }); // not contracted

      await addPatient(ORG_A, "A-7", "active");
      await addPatient(ORG_A, "A-8", "active");
      expect(await recordDailyCensusForOrg(deps("2026-11-02T06:00:00Z"), ORG_A)).toMatchObject({
        count: 8,
      });
      // a later reading the same day replaces the earlier one; a late retry of an OLDER one changes nothing
      await admin.query("UPDATE patient SET status='discharged' WHERE mrn='A-8'");
      await recordDailyCensusForOrg(deps("2026-11-02T18:00:00Z"), ORG_A);
      await recordDailyCensusForOrg(deps("2026-11-02T06:00:00Z"), ORG_A);
      const rows = await q<{ census_date: string; active_patient_count: number }>(
        "SELECT census_date::text, active_patient_count FROM patient_census_daily WHERE organization_id=$1 ORDER BY census_date",
        [ORG_A],
      );
      expect(rows).toEqual([
        { census_date: "2026-11-01", active_patient_count: 6 },
        { census_date: "2026-11-02", active_patient_count: 7 },
      ]);
      expect(
        await q("SELECT 1 FROM patient_census_daily WHERE organization_id=$1", [ORG_C]),
      ).toHaveLength(0);
      // set Nov 2 back to the figure the statement test hand-computes from
      await admin.query(
        "UPDATE patient_census_daily SET active_patient_count=8 WHERE organization_id=$1 AND census_date='2026-11-02'",
        [ORG_A],
      );
    });

    it("counts active staff: signed in, a live membership, and neither an auditor nor a ChartWarden operator; a user counts once", async () => {
      const u = async (n: string) => seedUser(`a-${n}`);
      const nurse1 = await seedMembership(ORG_A, await u("nurse1"));
      const admin2 = await seedMembership(ORG_A, await u("admin2"));
      const nurse3 = await seedMembership(ORG_A, await u("nurse3"));
      const auditor = await seedMembership(ORG_A, await u("auditor"));
      const operatorM = await seedMembership(ORG_A, await u("operator"));
      const neverIn = await seedMembership(ORG_A, await u("never"));
      const revokedBefore = await seedMembership(ORG_A, await u("revoked-before"), {
        revoked: "2026-10-15T00:00:00Z",
      });
      const pending = await seedMembership(ORG_A, await u("pending"), {
        accepted: null,
        status: "pending",
      });
      const dupUser = await u("two-memberships");
      const oldM = await seedMembership(ORG_A, dupUser, { revoked: "2026-11-05T00:00:00Z" });
      const newM = await seedMembership(ORG_A, dupUser, { accepted: "2026-11-06T00:00:00Z" });
      for (const m of [nurse1, nurse3, neverIn])
        await grantOrgRole(ORG_A, m, "registered_nurse", "clinical_staff");
      await grantOrgRole(ORG_A, admin2, "org_admin", "admin_executive");
      await grantOrgRole(ORG_A, auditor, "external_auditor", "external_auditor");
      await grantPlatformRole(ORG_A, operatorM);

      // sign-ins through the real consumer (membership resolved from the user, pseudonymized, tenant pool)
      const users = await q<{ id: string; email: string }>(
        `SELECT id, email FROM "user" WHERE email LIKE 'a-%@pricing.example'`,
      );
      const idOf = (n: string) => users.find((x) => x.email === `a-${n}@pricing.example`)?.id ?? "";
      await signIn(ORG_A, idOf("nurse1"), "2026-11-03T09:00:00Z");
      await signIn(ORG_A, idOf("admin2"), "2026-11-03T09:00:00Z");
      await signIn(ORG_A, idOf("admin2"), "2026-11-12T09:00:00Z"); // twice: still one account
      await signIn(ORG_A, idOf("nurse3"), "2026-11-20T09:00:00Z");
      await signIn(ORG_A, idOf("auditor"), "2026-11-04T09:00:00Z");
      await signIn(ORG_A, idOf("operator"), "2026-11-04T09:00:00Z");
      await signIn(ORG_A, idOf("revoked-before"), "2026-11-04T09:00:00Z"); // stale delivery for a membership revoked before the month
      await signIn(ORG_A, idOf("pending"), "2026-11-04T09:00:00Z"); // never accepted
      await signIn(ORG_A, dupUser, "2026-11-07T09:00:00Z"); // resolves to the live membership
      await ledgerRow(ORG_A, oldM, "2026-11"); // the replaced membership also signed in earlier in the month
      // October sign-ins never count for November
      await signIn(ORG_A, idOf("never"), "2026-10-20T09:00:00Z");

      const staff = await platformRunner((tx) =>
        countActiveStaffForMonth(tx, keyProvider, ORG_A, NOV),
      );
      // nurse1, admin2 (twice), nurse3, and the two-membership user once = 4. Not: auditor, operator, never signed in (Nov),
      // revoked before the month, pending.
      expect(staff).toEqual({ count: 4, basis: "identity_filtered" });
      expect(auditor && operatorM && revokedBefore && pending).toBeTruthy();

      // a key rotated since the month: roles cannot be applied, so the count falls back to the UNFILTERED ledger and says so
      const rotated = {
        activeKey: async () => ({
          keyEpoch: "epoch-20270101T0000Z-rotated",
          keyMaterial: "another",
        }),
      };
      const fallback = await platformRunner((tx) =>
        countActiveStaffForMonth(tx, rotated, ORG_A, NOV),
      );
      expect(fallback.basis).toBe("ledger_unfiltered");
      expect(fallback.count).toBeGreaterThan(4);
      // nobody signed in during December
      expect(
        await platformRunner((tx) => countActiveStaffForMonth(tx, keyProvider, ORG_A, DEC)),
      ).toEqual({ count: 0, basis: "identity_filtered" });
    });

    it("net collections: posted remittances by payment date, every payer kind, never another org's, pending counted not dropped", async () => {
      await remittance(ORG_A, { dollars: "10000.00", productionDate: "2026-11-02T00:00:00Z" });
      await remittance(ORG_A, {
        dollars: "5000.50",
        productionDate: "2026-11-30T00:00:00Z",
        kind: "commercial",
        status: "partial_posted",
      });
      await remittance(ORG_A, {
        dollars: "0.00",
        productionDate: "2026-11-10T00:00:00Z",
        method: "non_payment_remit",
      });
      await remittance(ORG_A, {
        dollars: "2000.00",
        productionDate: "2026-11-12T00:00:00Z",
        status: "queued",
      });
      await remittance(ORG_A, {
        dollars: "300.00",
        productionDate: "2026-11-13T00:00:00Z",
        status: "failed",
      });
      await remittance(ORG_A, { dollars: "9999.00", productionDate: "2026-10-31T23:59:59Z" }); // October
      await remittance(ORG_A, { dollars: "7777.00", productionDate: "2026-12-01T00:00:00Z" }); // December
      await remittance(ORG_B, { dollars: "123456.00", productionDate: "2026-11-05T00:00:00Z" }); // another tenant
      const reader = buildNetCollectionsReader(app.db);
      expect(
        await reader.netCollectionsForPeriod(ORG_A as never, {
          periodStart: NOV.start,
          periodEnd: NOV.end,
        }),
      ).toEqual({
        netCents: 1_500_050,
        remittanceCount: 3,
        pendingCount: 2,
      });
      expect(
        (
          await reader.netCollectionsForPeriod(ORG_B as never, {
            periodStart: NOV.start,
            periodEnd: NOV.end,
          })
        ).netCents,
      ).toBe(12_345_600);
      expect(
        await reader.netCollectionsForPeriod(ORG_D as never, {
          periodStart: NOV.start,
          periodEnd: NOV.end,
        }),
      ).toEqual({ netCents: 0, remittanceCount: 0, pendingCount: 0 });
      await expect(
        reader.netCollectionsForPeriod(ORG_A as never, {
          periodStart: NOV.end,
          periodEnd: NOV.start,
        }),
      ).rejects.toThrow(/before/);
    });
  });

  // ── 4. the statement ───────────────────────────────────────────────────────────────────────────────
  describe("the monthly statement", () => {
    const stripePushes: string[] = [];
    const stripe: StatementStripePort = {
      pushFinalStatement: async (s) => {
        stripePushes.push(s.id);
        return { usageRecordId: `ur_${stripePushes.length}` };
      },
    };
    const deps = (when: string, withStripe = false) => ({
      platformRunner,
      keyProvider,
      netCollections: buildNetCollectionsReader(app.db),
      now: at(when),
      ...(withStripe ? { stripe } : {}),
    });

    it("computes the draft from the three meters: the band beats staff x per-user, and the first statement carries the implementation fee", async () => {
      await censusDays(ORG_A, 3, 19, 12); // with Nov 1 (6) and Nov 2 (8): 19 days observed, mean 11.47
      const out = await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_A);
      expect(
        out.map((o) => [
          o.outcome,
          o.outcome === "skipped" ? o.reason : o.statement.periodYearMonth,
        ]),
      ).toEqual([
        ["skipped", "no_census"], // October: the org was not live and swept
        ["written", "2026-11"],
      ]);
      const [row] = await q<Record<string, string>>(
        "SELECT * FROM subscription_statement WHERE organization_id=$1 AND period_year_month='2026-11'",
        [ORG_A],
      );
      expect(row).toMatchObject({
        status: "draft",
        staff_count: 4,
        staff_count_basis: "identity_filtered",
        adc_hundredths: 1147,
        adc_days_observed: 19,
        adc_days_in_period: 30,
        billing_service_mode: "billing_software",
        net_collections_cents: "1500050",
        net_collections_remittance_count: 3,
        net_collections_pending_count: 2,
        per_user_price_cents: "15000",
        band_min_adc: 10,
        band_fee_cents: "200000",
        per_user_subtotal_cents: "60000",
        platform_fee_cents: "200000",
        platform_fee_basis: "census_band",
        billing_bps: 100,
        billing_fee_cents: "15001", // 1,500,050 x 1% = 15,000.50 -> half up
        one_time_fee_cents: "250000",
        minimum_adjustment_cents: "0",
        total_cents: "465001",
      });
      expect(row?.finalized_at).toBeNull();
    });

    it("is idempotent: a rerun is the same single draft, and it follows the data while the month is open", async () => {
      const before = await q(
        "SELECT id, total_cents FROM subscription_statement WHERE organization_id=$1",
        [ORG_A],
      );
      await runStatementsForOrg(deps("2026-11-20T13:00:00Z"), ORG_A);
      expect(
        await q("SELECT id, total_cents FROM subscription_statement WHERE organization_id=$1", [
          ORG_A,
        ]),
      ).toEqual(before);
      await remittance(ORG_A, { dollars: "1000.00", productionDate: "2026-11-15T00:00:00Z" });
      await runStatementsForOrg(deps("2026-11-21T00:00:00Z"), ORG_A);
      const [row] = await q<{
        net_collections_cents: string;
        billing_fee_cents: string;
        total_cents: string;
      }>(
        "SELECT net_collections_cents, billing_fee_cents, total_cents FROM subscription_statement WHERE organization_id=$1",
        [ORG_A],
      );
      expect(row).toEqual({
        net_collections_cents: "1600050",
        billing_fee_cents: "16001",
        total_cents: "466001",
      });
      expect(
        await q("SELECT 1 FROM subscription_statement WHERE organization_id=$1", [ORG_A]),
      ).toHaveLength(1);
    });

    it("stays a draft through the grace window (a late 835 dated inside the month still counts), then FINALIZES, and a final month never moves", async () => {
      await remittance(ORG_A, { dollars: "500.00", productionDate: "2026-11-30T00:00:00Z" });
      await runStatementsForOrg(deps("2026-12-03T00:00:00Z"), ORG_A); // December has no census yet; November is still inside its grace
      let [row] = await q<{ status: string; net_collections_cents: string }>(
        "SELECT status, net_collections_cents FROM subscription_statement WHERE organization_id=$1 AND period_year_month='2026-11'",
        [ORG_A],
      );
      expect(row).toEqual({ status: "draft", net_collections_cents: "1650050" });

      await censusDays(ORG_A, 1, 6, 20, "2026-12");
      const out = await runStatementsForOrg(deps("2026-12-07T00:00:00Z", true), ORG_A);
      expect(
        out.map((o) => [o.outcome, o.outcome === "written" ? o.statement.status : "-"]),
      ).toEqual([
        ["written", "final"],
        ["written", "draft"],
      ]);
      [row] = await q(
        "SELECT status, net_collections_cents FROM subscription_statement WHERE organization_id=$1 AND period_year_month='2026-11'",
        [ORG_A],
      );
      expect(row).toEqual({ status: "final", net_collections_cents: "1650050" });
      // the Stripe seam: the FINAL statement was pushed once through the port and its usage record stored; the draft was not
      expect(stripePushes).toHaveLength(1);
      expect(
        await q<{
          period_year_month: string;
          stripe_usage_record_id: string | null;
          posted: boolean;
        }>(
          "SELECT period_year_month, stripe_usage_record_id, stripe_posted_at IS NOT NULL AS posted FROM subscription_statement WHERE organization_id=$1 ORDER BY period_year_month",
          [ORG_A],
        ),
      ).toEqual([
        { period_year_month: "2026-11", stripe_usage_record_id: "ur_1", posted: true },
        { period_year_month: "2026-12", stripe_usage_record_id: null, posted: false },
      ]);

      // money that posts AFTER the grace is not re-billed into the closed month
      await remittance(ORG_A, { dollars: "40000.00", productionDate: "2026-11-29T00:00:00Z" });
      const again = await runStatementsForOrg(deps("2026-12-08T00:00:00Z", true), ORG_A);
      expect(again[0]).toMatchObject({ outcome: "skipped", reason: "final" });
      [row] = await q(
        "SELECT status, net_collections_cents FROM subscription_statement WHERE organization_id=$1 AND period_year_month='2026-11'",
        [ORG_A],
      );
      expect(row?.net_collections_cents).toBe("1650050");

      // December is the second statement: no implementation fee again; 20 patients falls in the 17 band
      const [dec] = await q<Record<string, string>>(
        "SELECT * FROM subscription_statement WHERE organization_id=$1 AND period_year_month='2026-12'",
        [ORG_A],
      );
      expect(dec).toMatchObject({
        one_time_fee_cents: "0",
        band_min_adc: 17,
        band_fee_cents: "300000",
        adc_hundredths: 2000,
        staff_count: 0,
      });
    });

    it("a final statement is frozen by its trigger, even against the platform carrier; only the Stripe columns may be written", async () => {
      const platformUrl = new URL(DB_URL as string);
      platformUrl.username = "chartwarden_platform_login";
      platformUrl.password = PLATFORM_PASSWORD;
      const carrier = new Client({ connectionString: platformUrl.toString() });
      await carrier.connect();
      try {
        await expect(
          carrier.query(
            "UPDATE subscription_statement SET total_cents = 1 WHERE organization_id=$1 AND status='final'",
            [ORG_A],
          ),
        ).rejects.toThrow(/final statement cannot change/);
        await expect(
          admin.query(
            "UPDATE subscription_statement SET staff_count = 99 WHERE organization_id=$1 AND status='final'",
            [ORG_A],
          ),
        ).rejects.toThrow(/final statement cannot change/);
        await expect(
          carrier.query(
            "UPDATE subscription_statement SET stripe_usage_record_id='ur_manual' WHERE organization_id=$1 AND status='final'",
            [ORG_A],
          ),
        ).resolves.toBeDefined();
      } finally {
        await carrier.end();
      }
    });

    it("the database refuses a statement whose platform fee is not the GREATER of its two sides, or whose total does not add up", async () => {
      const [src] = await q<Record<string, unknown>>(
        "SELECT * FROM subscription_statement WHERE organization_id=$1 AND period_year_month='2026-12'",
        [ORG_A],
      );
      const clone = async (set: string) =>
        admin.query(
          `INSERT INTO subscription_statement (organization_id,subscription_id,plan_id,period_year_month,period_start,period_end,status,staff_count,
             staff_count_basis,adc_hundredths,adc_days_observed,adc_days_in_period,billing_service_mode,net_collections_cents,net_collections_remittance_count,
             net_collections_pending_count,per_user_price_cents,band_min_adc,band_fee_cents,billing_bps,per_user_subtotal_cents,platform_fee_cents,
             platform_fee_basis,billing_fee_cents,one_time_fee_cents,minimum_adjustment_cents,total_cents,computed_at)
           SELECT organization_id,subscription_id,plan_id,'2027-01','2027-01-01','2027-02-01','draft',staff_count,staff_count_basis,adc_hundredths,1,31,
             billing_service_mode,net_collections_cents,0,0,per_user_price_cents,band_min_adc,band_fee_cents,billing_bps,per_user_subtotal_cents,
             ${set}, platform_fee_basis,billing_fee_cents,one_time_fee_cents,minimum_adjustment_cents,total_cents,computed_at
           FROM subscription_statement WHERE id=$1`,
          [src?.id],
        );
      await expect(clone("1")).rejects.toThrow(/platform_fee_ck/);
    });

    it("the per-user side wins when staff x price beats the band, and a tenant that bills outside ChartWarden pays no percentage", async () => {
      const [perUser] = await q<{ id: string }>("SELECT id FROM plan WHERE slug=$1", [planV2Slug]);
      expect(perUser?.id).toBe(planV2Id);
      // a plan whose per-user price is high: 3 staff x $1,000 = $3,000 beats the $1,000 first band
      const p = await plans.create(
        operator,
        plan({ familySlug: "per-user-heavy", perUserPriceCents: 100_000 }),
        "a plan priced per seat",
      );
      await plans.publish(operator, p.id, "approved by the owner");
      perUserPlanSlug = p.slug;
      await contracts.createForTenant(operator, "pricing-c", {
        planSlug: perUserPlanSlug,
        billingServiceMode: "managed_billing",
        reason: "order form signed by the customer's administrator",
      });
      for (const [i, n] of ["c1", "c2", "c3"].entries()) {
        const uid = await seedUser(`c-${n}`);
        const m = await seedMembership(ORG_C, uid);
        await grantOrgRole(ORG_C, m, "registered_nurse", "clinical_staff");
        await signIn(ORG_C, uid, `2026-11-0${i + 2}T09:00:00Z`);
      }
      await censusDays(ORG_C, 1, 19, 5);
      await remittance(ORG_C, { dollars: "10000.00", productionDate: "2026-11-09T00:00:00Z" });
      await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_C);
      const [c] = await q<Record<string, string>>(
        "SELECT * FROM subscription_statement WHERE organization_id=$1",
        [ORG_C],
      );
      expect(c).toMatchObject({
        staff_count: 3,
        per_user_subtotal_cents: "300000",
        band_fee_cents: "100000",
        platform_fee_cents: "300000",
        platform_fee_basis: "per_user",
        billing_bps: 400,
        billing_fee_cents: "40000",
        total_cents: String(300_000 + 40_000 + 250_000),
      });

      // ORG_D: bills outside ChartWarden (none) although it collected $50,000
      await contracts.createForTenant(operator, "pricing-d", {
        planSlug: planV2Slug,
        billingServiceMode: "none",
        reason: "order form signed by the customer's administrator",
      });
      const uidD = await seedUser("d-1");
      const mD = await seedMembership(ORG_D, uidD);
      await grantOrgRole(ORG_D, mD, "registered_nurse", "clinical_staff");
      await signIn(ORG_D, uidD, "2026-11-05T09:00:00Z");
      await censusDays(ORG_D, 1, 19, 0);
      await remittance(ORG_D, { dollars: "50000.00", productionDate: "2026-11-09T00:00:00Z" });
      await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_D);
      const [d] = await q<Record<string, string>>(
        "SELECT * FROM subscription_statement WHERE organization_id=$1",
        [ORG_D],
      );
      expect(d).toMatchObject({
        billing_service_mode: "none",
        net_collections_cents: "5000000",
        billing_bps: 0,
        billing_fee_cents: "0",
        adc_hundredths: 0, // a month of zeros is a real zero
        band_min_adc: 0,
        platform_fee_cents: "100000",
      });
    });

    it("never bills an org with no contract or a canceled subscription, and an org with a contract but no observed census gets no statement", async () => {
      expect(await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_E)).toEqual([]); // no contract
      expect(await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_F)).toEqual([]); // canceled above
      expect(
        await q("SELECT 1 FROM subscription_statement WHERE organization_id IN ($1,$2)", [
          ORG_E,
          ORG_F,
        ]),
      ).toHaveLength(0);
      // B has a contract but was never swept
      const unswept = await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_B);
      expect(unswept.every((o) => o.outcome === "skipped" && o.reason === "no_census")).toBe(true);
      expect(
        await q("SELECT 1 FROM subscription_statement WHERE organization_id=$1", [ORG_B]),
      ).toHaveLength(0);
      // once swept it is billed, so the isolation checks below have data on BOTH sides
      await censusDays(ORG_B, 1, 19, 3);
      await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_B);
      expect(
        await q("SELECT 1 FROM subscription_statement WHERE organization_id=$1", [ORG_B]),
      ).toHaveLength(1);
    });
  });

  // ── 5. tenant isolation and what the tenant is shown ───────────────────────────────────────────────
  describe("the tenant surface", () => {
    it("a tenant reads ITS OWN plan terms and latest statement, and the operator behind the contract is not in it", async () => {
      const a = await contracts.tenantView(ORG_A, "tenant-a-user");
      expect(a.contract).toMatchObject({
        plan: { slug: planV2Slug },
        billingServiceMode: "billing_software",
        billingBps: 100,
        perUserPriceCents: 15_000,
        contractTermMonths: 12,
      });
      expect(a.contract?.bands.map((b) => [b.minAdc, b.maxAdc, b.monthlyFeeCents])).toEqual([
        [0, 9, 100_000],
        [10, 16, 200_000],
        [17, 25, 300_000],
        [26, null, 400_000],
      ]);
      for (const hidden of ["signedByMembershipId", "signedReason", "orderFormRef"]) {
        expect(a.contract).not.toHaveProperty(hidden);
      }
      expect(a.latestStatement).toMatchObject({ periodYearMonth: "2026-12", status: "draft" });
    });

    it("tenants never see each other: contracts, census and statements are isolated by RLS", async () => {
      const b = await contracts.tenantView(ORG_B, "tenant-b-user");
      expect(b.contract?.billingServiceMode).toBe("none");
      expect(b.latestStatement).toMatchObject({ periodYearMonth: "2026-11", status: "draft" });
      expect(b.latestStatement?.inputs.averageDailyCensus).toBe(3); // B's own census, not A's
      const none = await contracts.tenantView(ORG_E, "tenant-e-user");
      expect(none).toEqual({ contract: null, latestStatement: null });

      const tenantClient = new Client({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await tenantClient.connect();
      try {
        for (const table of [
          "subscription_contract",
          "patient_census_daily",
          "subscription_statement",
        ]) {
          await tenant(tenantClient, ORG_B, async () => {
            const rows = (await tenantClient.query(`SELECT DISTINCT organization_id FROM ${table}`))
              .rows;
            expect(
              rows.every((r) => r.organization_id === ORG_B),
              table,
            ).toBe(true);
          });
          await tenant(tenantClient, ORG_A, async () => {
            const rows = (await tenantClient.query(`SELECT DISTINCT organization_id FROM ${table}`))
              .rows;
            expect(
              rows.map((r) => r.organization_id),
              table,
            ).toEqual([ORG_A]);
          });
        }
        // no org context at all reads nothing
        await tenantClient.query("BEGIN");
        expect(
          (await tenantClient.query("SELECT 1 FROM subscription_statement")).rows,
        ).toHaveLength(0);
        await tenantClient.query("ROLLBACK");
      } finally {
        await tenantClient.end();
      }
    });

    it("the platform view carries who signed and why; its statements are the same rows", async () => {
      const view = await contracts.platformView("pricing-a");
      expect(view.contract).toMatchObject({ signedByMembershipId: OPERATOR_MEMBERSHIP });
      expect(view.statements.map((s) => s.periodYearMonth)).toEqual(["2026-12", "2026-11"]);
      await expect(contracts.platformView("no-such-tenant")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });
});
