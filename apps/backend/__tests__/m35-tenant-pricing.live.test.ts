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
import {
  buildPricingOnboardingPort,
  readTenantGoLive,
} from "../src/modules/34-saas-tenant-platform/onboarding/pricing-port";
import { M35_OUTBOX_EVENTS } from "../src/modules/35-subscription/events-by-m35";
import { buildM35SessionCreatedConsumer } from "../src/modules/35-subscription/outbox-consumers/m2-session-created";
import { recordDailyCensusForOrg } from "../src/modules/35-subscription/pricing/census-daily";
import {
  listContractedOrgIds,
  selectNewestContract,
} from "../src/modules/35-subscription/pricing/contract-select";
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
import { buildPlatformAuditPort } from "../src/modules/35-subscription/pricing/ports";
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
const ORG_G = "a7000000-0000-4000-8000-0000000000a7"; // goes live MID-month (Nov 20): first month prorated by days
const ORG_H = "a8000000-0000-4000-8000-0000000000a8"; // the billing service mode flips on Nov 28 (effective Dec 1)
const ORG_I = "a9000000-0000-4000-8000-0000000000a9"; // goes live on the LAST day of the month
const ORG_J = "aa000000-0000-4000-8000-0000000000aa"; // a plan minimum, whole first month
const ORG_K = "ab000000-0000-4000-8000-0000000000ab"; // a plan minimum, prorated first month
const ORG_L = "ac000000-0000-4000-8000-0000000000ac"; // canceled mid-month, inside the grace window
const ORG_M = "ad000000-0000-4000-8000-0000000000ad"; // suspended (paused) mid-month: its last month must still finalize
const ORG_N = "ae000000-0000-4000-8000-0000000000ae"; // re-signed: two contracts, the first canceled
const OPERATOR_USER = "0a000000-0000-4000-8000-000000000001";
const OPERATOR_MEMBERSHIP = "0b000000-0000-4000-8000-000000000001";
const KEY = {
  keyEpoch: "epoch-20261101T0000Z-pricing",
  keyMaterial: "pricing-live-suite-key-material",
};
const keyProvider = { activeKey: async () => KEY };

/** Contracts are signed while onboarding, before the tenant goes live (go-live is set per org by `goLive`). */
const SIGNED_AT = "2026-10-20T12:00:00Z";
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
    { minAdc: 30, monthlyFeeCents: 500_000 },
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
  /** The contract service on another clock: the mode-change and re-sign stories happen on specific days. */
  let contractsAt: (iso: string) => ContractService;
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

  /** A connection as the REAL platform carrier (BYPASSRLS, bound by its enumerated grants), never the superuser. */
  async function asCarrier<T>(fn: (carrier: Client) => Promise<T>): Promise<T> {
    const url = new URL(DB_URL as string);
    url.username = "chartwarden_platform_login";
    url.password = PLATFORM_PASSWORD;
    const carrier = new Client({ connectionString: url.toString() });
    await carrier.connect();
    try {
      return await fn(carrier);
    } finally {
      await carrier.end();
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

  /** The tenant goes live (M34 stamps `activated_at` on the `onboarding -> active` approval); statements are charged from that day. */
  async function goLive(org: string, whenIso: string): Promise<void> {
    await admin.query(
      "UPDATE tenant_account SET status='active', activated_at=$2 WHERE organization_id=$1",
      [org, whenIso],
    );
  }

  /** The audit rows (any kind) a statement write left, so a rerun that writes nothing can be proven to leave none. */
  const statementAuditRows = async (): Promise<number> =>
    Number(
      (
        await q<{ n: string }>(
          "SELECT count(*) AS n FROM audit_event WHERE resource_kind='subscription_statement'",
        )
      )[0]?.n ?? 0,
    );

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
    systemDefault = false,
  ): Promise<void> {
    const found = await q<{ id: string }>(
      "SELECT id FROM role WHERE organization_id=$1 AND key=$2",
      [org, key],
    );
    const roleId =
      found[0]?.id ??
      (
        await q<{ id: string }>(
          "INSERT INTO role (organization_id,key,name,category,enabled,system_default) VALUES ($1,$2,$2,$3::role_category,true,$4) RETURNING id",
          [org, key, category, systemDefault],
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
    for (const [org, slug] of [
      [ORG_G, "pricing-g"],
      [ORG_H, "pricing-h"],
      [ORG_I, "pricing-i"],
      [ORG_J, "pricing-j"],
      [ORG_K, "pricing-k"],
      [ORG_L, "pricing-l"],
      [ORG_M, "pricing-m"],
      [ORG_N, "pricing-n"],
    ] as const) {
      await seedOrg(org, slug, "onboarding");
    }

    // A wizard double: the port is the real one, the wizard behind it records what it is asked.
    wizardCalls = { attests: [], failAttest: false, locked: null };
    const slugs = new Map([
      ["pricing-a", ORG_A],
      ["pricing-b", ORG_B],
      ["pricing-c", ORG_C],
      ["pricing-d", ORG_D],
      ["pricing-e", ORG_E],
      ["pricing-f", ORG_F],
      ["pricing-g", ORG_G],
      ["pricing-h", ORG_H],
      ["pricing-i", ORG_I],
      ["pricing-j", ORG_J],
      ["pricing-k", ORG_K],
      ["pricing-l", ORG_L],
      ["pricing-m", ORG_M],
      ["pricing-n", ORG_N],
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
    // THE shipped audit mapping (M35 buildPlatformAuditPort), fed M4's real writer: the same code path production runs.
    const audit = buildPlatformAuditPort((tx, row) => auditPlatformEvent(tx as never, row));
    plans = buildPricingPlanService({ platformRunner, audit });
    contracts = buildContractService({
      db: app.db,
      platformRunner,
      outbox,
      audit,
      onboarding: buildPricingOnboardingPort({ wizard }),
      now: at(SIGNED_AT),
    });
    contractsAt = (iso: string) =>
      buildContractService({
        db: app.db,
        platformRunner,
        outbox,
        audit,
        onboarding: buildPricingOnboardingPort({ wizard }),
        now: at(iso),
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
        [26, 29],
        [30, null],
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
      expect(v2.bands).toHaveLength(5);
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
        await denied("UPDATE subscription_contract SET signed_reason = 'rewritten by the tenant'");
        await denied("UPDATE subscription_contract_mode SET billing_service_mode = 'none'");
        await denied("DELETE FROM subscription_contract_mode");
        await denied(
          "INSERT INTO subscription_contract_mode (organization_id,contract_id,billing_service_mode,effective_from) VALUES ($1,$1,'none','2026-11-01')",
          [ORG_A],
        );
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
          [
            "UPDATE subscription_contract_mode SET billing_service_mode = 'none'",
            "mode history: INSERT only, append-only",
          ],
          ["DELETE FROM subscription_contract_mode", "mode history: never deleted"],
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
      // a RETIRED flat plan cannot be repriced or offered again through the legacy editor
      const [retired] = await q<{ id: string }>("SELECT id FROM plan WHERE slug='starter-monthly'");
      await expect(
        route.adminUpdatePlan(operator, retired?.id ?? "", { basePriceCents: 1 } as never),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(route.adminActivatePlan(operator, retired?.id ?? "")).rejects.toMatchObject({
        code: "CONFLICT",
      });
      const [stillRetired] = await q<{ is_active: boolean; base_price_cents: string }>(
        "SELECT is_active, base_price_cents FROM plan WHERE slug='starter-monthly'",
      );
      expect(stillRetired).toEqual({ is_active: false, base_price_cents: "29900" });
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
      // a tenant cannot select a contracted plan, and asking for one answers exactly what asking for a plan that does not exist
      // answers (404): a probe cannot tell the census slugs from nothing
      const unknown = await route
        .createSubscription(tenantActor, { planSlug: "no-such-plan-v1" })
        .catch((e) => e);
      const contracted = await route
        .createSubscription(tenantActor, { planSlug: planV2Slug })
        .catch((e) => e);
      expect(contracted).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
      expect({ code: contracted.code, message: contracted.message }).toEqual({
        code: unknown.code,
        message: unknown.message,
      });
      // the legacy admin editor cannot activate, archive or meter one (publishing and archiving have their own audited routes)
      await expect(route.adminActivatePlan(operator, planV2Id)).rejects.toMatchObject({
        code: "PLAN_ASSIGNED_BY_OPERATIONS",
      });
      await expect(route.adminDeprecatePlan(operator, planV2Id)).rejects.toMatchObject({
        code: "PLAN_ASSIGNED_BY_OPERATIONS",
      });
      await expect(
        route.adminAddMeter(operator, planV2Id, {
          eventType: "api_call",
          inclusiveQuantity: 1,
          overageUnitPriceCents: 1,
          billingAggregation: "sum",
        } as never),
      ).rejects.toMatchObject({ code: "PLAN_ASSIGNED_BY_OPERATIONS" });
      expect((await plans.get(planV2Id)).status).toBe("published"); // none of those touched it
      // a flat plan still works exactly as before
      const flat = await route.createSubscription(tenantActor, { planSlug: "starter-monthly" });
      expect(flat).toMatchObject({ planSlug: "starter-monthly" });
      // ... and that tenant cannot move onto a contracted plan (404, like a plan that does not exist)
      await expect(
        route.changePlan(tenantActor, { newPlanSlug: planV2Slug, prorationBehavior: "none" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await admin.query(
        "UPDATE subscription SET status='canceled', canceled_at=now() WHERE organization_id=$1",
        [ORG_B],
      );
      await admin.query("UPDATE plan SET is_active=false WHERE slug='starter-monthly'");
    });
  });

  // ── 1b. the freeze cannot be walked around ─────────────────────────────────────────────────────────
  describe("the published-plan freeze cannot be bypassed", () => {
    let frozenId = "";
    let draftId = "";

    it("leaving census_banded and coming back as a draft (the two-step re-price) is refused to the REAL carrier by its column grants, and to a superuser by the trigger", async () => {
      const probe = await plans.create(
        operator,
        plan({ familySlug: "freeze-probe" }),
        "a plan the freeze probes attack",
      );
      frozenId = probe.id;
      await plans.publish(operator, frozenId, "publish the freeze probe");
      // Step 1: ONE statement leaves census_banded, nulls every contracted column and un-publishes the row; the old
      // guard checked only OLD.tier = census_banded rows, so this passed and the row was an editable flat plan.
      const leave = `UPDATE plan SET tier='starter', family_slug=NULL, per_user_price_cents=NULL, billing_software_bps=NULL,
        managed_billing_bps=NULL, contract_term_months=NULL, implementation_fee_cents=NULL, minimum_monthly_cents=NULL,
        published_at=NULL WHERE id=$1`;
      await asCarrier(async (carrier) => {
        await expect(carrier.query(leave, [frozenId])).rejects.toMatchObject({ code: "42501" });
        // tier, slug, family, version, cadence and lineage are not columns the carrier may write at all
        for (const column of ["tier", "slug", "family_slug", "version", "cadence"]) {
          await expect(
            carrier.query(`UPDATE plan SET ${column} = ${column} WHERE id=$1`, [frozenId]),
            column,
          ).rejects.toMatchObject({ code: "42501" });
        }
      });
      await expect(admin.query(leave, [frozenId])).rejects.toThrow(/cannot change tier/);
      const [row] = await q<{
        tier: string;
        published_at: Date | null;
        per_user_price_cents: string;
      }>("SELECT tier, published_at, per_user_price_cents FROM plan WHERE id=$1", [frozenId]);
      expect(row).toMatchObject({ tier: "census_banded", per_user_price_cents: "10000" });
      expect(row?.published_at).not.toBeNull();
    });

    it("a published version cannot be sent back to a draft, even by the carrier (the column is writable; the trigger holds)", async () => {
      await asCarrier(async (carrier) => {
        await expect(
          carrier.query("UPDATE plan SET published_at = NULL WHERE id=$1", [frozenId]),
        ).rejects.toThrow(/go back to a draft/);
        await expect(
          carrier.query("UPDATE plan SET per_user_price_cents = 1 WHERE id=$1", [frozenId]),
        ).rejects.toThrow(/frozen/);
      });
    });

    it("a flat plan that subscriptions already use cannot be flipped to census_banded", async () => {
      await admin.query(
        `INSERT INTO plan (slug,name,tier,cadence,base_price_cents,is_active,trial_period_days)
         VALUES ('flat-probe','Flat probe','starter','monthly',100,true,0)`,
      );
      const [flat] = await q<{ id: string }>("SELECT id FROM plan WHERE slug='flat-probe'");
      await admin.query(
        "INSERT INTO subscription (organization_id, plan_id, status) VALUES ($1,$2,'active')",
        [ORG_E, flat?.id],
      );
      try {
        await expect(
          admin.query(
            "UPDATE plan SET tier='census_banded', family_slug='flat-probe', slug='flat-probe-v1' WHERE id=$1",
            [flat?.id],
          ),
        ).rejects.toThrow(/subscriptions use/);
      } finally {
        await admin.query("DELETE FROM subscription WHERE organization_id=$1", [ORG_E]);
        await admin.query("DELETE FROM plan WHERE id=$1", [flat?.id]);
      }
    });

    it("a band cannot be re-pointed from a draft to a published plan (or back), and the carrier cannot UPDATE a band at all", async () => {
      const draft = await plans.create(
        operator,
        plan({ familySlug: "freeze-probe-draft" }),
        "a draft whose bands the probe moves",
      );
      draftId = draft.id;
      const move = "UPDATE plan_census_band SET plan_id=$1 WHERE plan_id=$2";
      await asCarrier(async (carrier) => {
        await expect(carrier.query(move, [frozenId, draftId])).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          carrier.query("UPDATE plan_census_band SET monthly_fee_cents = 1 WHERE plan_id=$1", [
            draftId,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await expect(admin.query(move, [frozenId, draftId])).rejects.toThrow(/another plan/);
      await expect(admin.query(move, [draftId, frozenId])).rejects.toThrow(/another plan/);
      // the published plan's bands are untouched
      expect(await q("SELECT 1 FROM plan_census_band WHERE plan_id=$1", [frozenId])).toHaveLength(
        5,
      );
      // a draft's bands are still replaced the way the editor does it: delete and insert
      await expect(
        plans.replaceDraft(
          operator,
          draftId,
          plan({ familySlug: "freeze-probe-draft" }),
          "edit the draft",
        ),
      ).resolves.toBeDefined();
    });

    it("the carrier holds no UPDATE on plan_census_band and only the editable columns of plan", async () => {
      const grants = await q<{ privilege_type: string; column_name: string | null }>(
        `SELECT 'table' AS scope, privilege_type, NULL AS column_name FROM information_schema.role_table_grants
          WHERE grantee='chartwarden_platform' AND table_name='plan_census_band'
         UNION ALL
         SELECT 'column', privilege_type, column_name FROM information_schema.role_column_grants
          WHERE grantee='chartwarden_platform' AND table_name='plan' AND privilege_type='UPDATE'`,
      );
      const bandPrivileges = grants
        .filter((g) => g.column_name === null)
        .map((g) => g.privilege_type);
      expect(bandPrivileges.sort()).toEqual(["DELETE", "INSERT", "SELECT"]);
      const updatable = grants.filter((g) => g.column_name !== null).map((g) => g.column_name);
      for (const never of [
        "id",
        "slug",
        "tier",
        "cadence",
        "family_slug",
        "version",
        "supersedes_plan_id",
        "created_at",
      ]) {
        expect(updatable, never).not.toContain(never);
      }
      expect(updatable).toEqual(
        expect.arrayContaining(["published_at", "per_user_price_cents", "is_active"]),
      );
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
        pendingBillingServiceMode: null,
        contractStartOn: "2026-10-20",
        contractEndsOn: "2027-10-20",
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
      // the signing also wrote the contract's FIRST billing service mode, dated the signing day
      expect(
        await q(
          "SELECT billing_service_mode, effective_from::text FROM subscription_contract_mode m JOIN subscription_contract c ON c.id=m.contract_id WHERE c.subscription_id=$1",
          [sub?.id],
        ),
      ).toEqual([{ billing_service_mode: "billing_software", effective_from: "2026-10-20" }]);
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

    it("the contract's row audit never copies who signed, why, or the order form into the tenant-readable audit trail", async () => {
      const secrets = [
        OPERATOR_MEMBERSHIP,
        "order form signed by the customer's administrator",
        "OF-2026-0042",
      ];
      const tenantClient = new Client({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await tenantClient.connect();
      try {
        await tenant(tenantClient, ORG_A, async () => {
          // what GET /api/v1/audit/events serves: audit_event under the tenant's own RLS
          const rows = (
            await tenantClient.query(
              "SELECT event_type, before, after, context FROM audit_event WHERE resource_kind='subscription_contract'",
            )
          ).rows;
          expect(rows.map((r) => r.event_type)).toContain("subscription_contract.insert");
          const everything = JSON.stringify(rows);
          for (const secret of secrets) expect(everything).not.toContain(secret);
          const insert = rows.find((r) => r.event_type === "subscription_contract.insert");
          expect(insert?.after).toMatchObject({
            signed_by_membership_id: "<changed>",
            signed_reason: "<changed>",
            order_form_ref: "<changed>",
          });
        });
        // and no audit row of the org at all (any resource) carries them
        const all = await q(
          "SELECT before, after, context FROM audit_event WHERE organization_id=$1",
          [ORG_A],
        );
        for (const secret of secrets) expect(JSON.stringify(all)).not.toContain(secret);
      } finally {
        await tenantClient.end();
      }
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
      // ORG_A is still onboarding and has no statement yet: nothing has been billed and nothing is running, so the change is IMMEDIATE
      expect(changed).toMatchObject({
        billingServiceMode: "managed_billing",
        billingBps: 400,
        pendingBillingServiceMode: null,
      });
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
      expect(audit[0]?.context).toMatchObject({
        from: "billing_software",
        to: "managed_billing",
        effectiveOn: "2026-10-20",
      });
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
      const onNov5 = new Date("2026-11-05T12:00:00Z");
      expect(await readBillingServiceMode(app.db, ORG_A, onNov5)).toBe("billing_software");
      expect(await readBillingServiceMode(app.db, ORG_B, onNov5)).toBe("none");
      expect(await readBillingServiceMode(app.db, ORG_C, onNov5)).toBeNull(); // no contract: never read as `none`
    });

    it("a tenant that is still onboarding with NO statement yet changes mode immediately (D6): nothing was billed, so there is no month to protect", async () => {
      const day = "2026-10-21T09:00:00Z";
      const changed = await contractsAt(day).setBillingServiceMode(
        operator,
        "pricing-b",
        "billing_software",
        "the tenant will bill in ChartWarden after all",
      );
      expect(changed).toMatchObject({
        billingServiceMode: "billing_software",
        billingBps: 100,
        pendingBillingServiceMode: null,
      });
      expect(await readBillingServiceMode(app.db, ORG_B, new Date(day))).toBe("billing_software");
      // back to `none`, also immediate: later stories read B as a tenant that bills outside
      await contractsAt(day).setBillingServiceMode(
        operator,
        "pricing-b",
        "none",
        "the tenant keeps its own billing after all",
      );
      expect(await readBillingServiceMode(app.db, ORG_B, new Date(day))).toBe("none");
    });

    it("a tenant cannot cancel a contracted subscription (403 PLAN_ASSIGNED_BY_OPERATIONS); the subscription is untouched", async () => {
      const route = buildDrizzleM35RouteService(app.db, { platformRunner, outbox });
      await expect(
        route.cancelSubscription({
          organizationId: ORG_A,
          userId: await seedUser("tenant-a-admin"),
          roles: ["org_admin"],
          membershipId: OPERATOR_MEMBERSHIP,
          stepUpRecent: true,
        }),
      ).rejects.toMatchObject({ code: "PLAN_ASSIGNED_BY_OPERATIONS", statusCode: 403 });
      expect(
        await q(
          "SELECT cancel_at_period_end, canceled_at FROM subscription WHERE organization_id=$1",
          [ORG_A],
        ),
      ).toEqual([{ cancel_at_period_end: false, canceled_at: null }]);
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
      // the SYSTEM auditor role, the row M3's auditor grant creates (system_default)
      await grantOrgRole(ORG_A, auditor, "external_auditor", "external_auditor", true);
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

    it("an auditor who ALSO holds a staff role is staff (counted); a tenant's look-alike external_auditor role hides nobody", async () => {
      const win = NOV;
      const count = () =>
        platformRunner((tx) => countActiveStaffForMonth(tx, keyProvider, ORG_E, win));
      expect(await count()).toEqual({ count: 0, basis: "identity_filtered" });

      // the system auditor alone: excluded
      const auditorUser = await seedUser("e-auditor");
      const auditorM = await seedMembership(ORG_E, auditorUser);
      await grantOrgRole(ORG_E, auditorM, "external_auditor", "external_auditor", true);
      await signIn(ORG_E, auditorUser, "2026-11-04T09:00:00Z");
      expect(await count()).toEqual({ count: 0, basis: "identity_filtered" });

      // the DUAL-ROLE case: the same membership also holds a staff role -> it is staff
      await grantOrgRole(ORG_E, auditorM, "registered_nurse", "clinical_staff");
      expect(await count()).toEqual({ count: 1, basis: "identity_filtered" });

      // the FAKE-KEY case: a tenant admin creates its own `external_auditor`-keyed role (never system_default) and attaches it
      // to a nurse to shrink the bill. Another org, because a key is unique per org.
      await admin.query("DELETE FROM membership_role WHERE membership_id=$1", [auditorM]);
      await admin.query("DELETE FROM role WHERE organization_id=$1 AND key='external_auditor'", [
        ORG_E,
      ]);
      const fakeUser = await seedUser("e-fake");
      const fakeM = await seedMembership(ORG_E, fakeUser);
      await grantOrgRole(ORG_E, fakeM, "external_auditor", "external_auditor", false);
      await signIn(ORG_E, fakeUser, "2026-11-04T09:00:00Z");
      // auditorM now holds no grant at all (still signed in, still live): counted too
      expect(await count()).toEqual({ count: 2, basis: "identity_filtered" });
      await admin.query("DELETE FROM membership_role WHERE organization_id=$1", [ORG_E]);
      await admin.query(
        "DELETE FROM role WHERE organization_id=$1 AND key IN ('external_auditor','registered_nurse')",
        [ORG_E],
      );
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

    it("net collections BY MONTH (one call for the whole range): grouped by the UTC month of the payment date, the same meter as by period", async () => {
      const reader = buildNetCollectionsReader(app.db);
      const range = {
        periodStart: new Date("2026-10-01T00:00:00Z"),
        periodEnd: new Date("2027-01-01T00:00:00Z"),
      };
      expect(await reader.netCollectionsByMonth(ORG_A as never, range)).toEqual([
        { yearMonth: "2026-10", netCents: 999_900, remittanceCount: 1, pendingCount: 0 },
        { yearMonth: "2026-11", netCents: 1_500_050, remittanceCount: 3, pendingCount: 2 },
        { yearMonth: "2026-12", netCents: 777_700, remittanceCount: 1, pendingCount: 0 },
      ]);
      // a payment is dated in UTC: 23:30 on Nov 30 at UTC-5 is Dec 1 04:30Z, and the last second of Nov 30Z is still November
      await remittance(ORG_E, { dollars: "100.00", productionDate: "2026-11-30T23:30:00-05:00" });
      await remittance(ORG_E, { dollars: "200.00", productionDate: "2026-11-30T23:59:59Z" });
      await remittance(ORG_E, { dollars: "300.00", productionDate: "2026-12-01T00:00:00Z" });
      expect(await reader.netCollectionsByMonth(ORG_E as never, range)).toEqual([
        { yearMonth: "2026-11", netCents: 20_000, remittanceCount: 1, pendingCount: 0 },
        { yearMonth: "2026-12", netCents: 40_000, remittanceCount: 2, pendingCount: 0 },
      ]);
      // another tenant's money never appears
      expect(await reader.netCollectionsByMonth(ORG_F as never, range)).toEqual([]);
      await admin.query("DELETE FROM remittance_advice WHERE organization_id=$1", [ORG_E]);
    });

    it("a month whose ledger spans MORE THAN ONE key epoch (a rotation mid-month) cannot be role-filtered: the busiest single epoch is counted, flagged unfiltered", async () => {
      const OCT = calendarMonthOf(new Date("2026-10-15T00:00:00Z"));
      const ledger = async (epoch: string, n: number, tag: string) => {
        for (let i = 0; i < n; i++) {
          await admin.query(
            `INSERT INTO user_active_period (organization_id, membership_pseudonym, pseudonym_key_epoch, period_year_month, was_active,
               first_session_at, last_session_at) VALUES ($1,$2,$3,'2026-10',true,now(),now())`,
            [ORG_E, computeBillingPseudonym(`${epoch}-material`, `${tag}-${i}`), epoch],
          );
        }
      };
      // three members signed in under the old key, two under the new (active) one: the same person has a different pseudonym under
      // each key, so the epochs cannot be added (a rotated member would count twice) and the roles cannot be applied
      await ledger("epoch-20260901T0000Z-old", 3, "old");
      await ledger(KEY.keyEpoch, 2, "new");
      const staff = await platformRunner((tx) =>
        countActiveStaffForMonth(tx, keyProvider, ORG_E, OCT),
      );
      expect(staff).toEqual({ count: 3, basis: "ledger_unfiltered" });
      // one epoch that is no longer the active key: also unfiltered, the same way
      await admin.query(
        "DELETE FROM user_active_period WHERE organization_id=$1 AND pseudonym_key_epoch=$2",
        [ORG_E, KEY.keyEpoch],
      );
      expect(
        await platformRunner((tx) => countActiveStaffForMonth(tx, keyProvider, ORG_E, OCT)),
      ).toEqual({ count: 3, basis: "ledger_unfiltered" });
      await admin.query("DELETE FROM user_active_period WHERE organization_id=$1", [ORG_E]);
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
    // the REAL go-live reader (M34's tenant_account.activated_at), the real M25 reader, on the real carrier
    const deps = (when: string, withStripe = false) => ({
      platformRunner,
      keyProvider,
      netCollections: buildNetCollectionsReader(app.db),
      goLive: { goLiveAt: readTenantGoLive },
      now: at(when),
      ...(withStripe ? { stripe } : {}),
    });
    const statementOf = async (org: string, month: string) =>
      (
        await q<Record<string, string>>(
          "SELECT * FROM subscription_statement WHERE organization_id=$1 AND period_year_month=$2",
          [org, month],
        )
      )[0];
    const outcomesOf = (out: Awaited<ReturnType<typeof runStatementsForOrg>>) =>
      out.map((o) => [
        o.outcome,
        o.outcome === "written" ? o.statement.periodYearMonth : o.periodYearMonth,
      ]);

    it("computes the draft from the three meters: the band beats staff x per-user, and the first statement carries the implementation fee", async () => {
      await goLive(ORG_A, "2026-11-01T00:00:00Z"); // go-live on the 1st: a WHOLE first month
      await censusDays(ORG_A, 3, 19, 12); // with Nov 1 (6) and Nov 2 (8): 19 days observed, mean 11.47
      const out = await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_A);
      // statements start at go-live: October (signed, not live) has none
      expect(outcomesOf(out)).toEqual([["written", "2026-11"]]);
      const row = await statementOf(ORG_A, "2026-11");
      expect(row).toMatchObject({
        status: "draft",
        staff_count: 4,
        staff_count_basis: "identity_filtered",
        adc_hundredths: 1147,
        adc_days_observed: 19,
        adc_days_in_period: 30,
        days_live: 30,
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
        prior_period_fee_cents: "0",
        total_cents: "465001",
        needs_review: false, // a draft with pending remittances is routine
      });
      expect(row?.finalized_at).toBeNull();
    });

    it("is idempotent: a rerun that changes no figure WRITES NOTHING (no update, no audit row); it follows the data while the month is open", async () => {
      const before = await q(
        "SELECT id, total_cents, computed_at, updated_at FROM subscription_statement WHERE organization_id=$1",
        [ORG_A],
      );
      const auditBefore = await statementAuditRows();
      const rerun = await runStatementsForOrg(deps("2026-11-20T13:00:00Z"), ORG_A);
      expect(outcomesOf(rerun)).toEqual([["unchanged", "2026-11"]]);
      expect(
        await q(
          "SELECT id, total_cents, computed_at, updated_at FROM subscription_statement WHERE organization_id=$1",
          [ORG_A],
        ),
      ).toEqual(before); // not even computed_at moved
      expect(await statementAuditRows()).toBe(auditBefore); // an hourly sweep does not fill the audit trail with identical rewrites

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
      expect(await statementAuditRows()).toBeGreaterThan(auditBefore); // a real change is audited
      expect(
        await q("SELECT 1 FROM subscription_statement WHERE organization_id=$1", [ORG_A]),
      ).toHaveLength(1);
    });

    it("stays a draft through the grace window (a late 835 dated inside the month still counts), then FINALIZES, and a final month never moves", async () => {
      await remittance(ORG_A, { dollars: "500.00", productionDate: "2026-11-30T00:00:00Z" });
      await runStatementsForOrg(deps("2026-12-03T00:00:00Z"), ORG_A); // December has no census yet; November is still inside its grace
      let row = await statementOf(ORG_A, "2026-11");
      expect(row).toMatchObject({ status: "draft", net_collections_cents: "1650050" });

      await censusDays(ORG_A, 1, 6, 20, "2026-12");
      const out = await runStatementsForOrg(deps("2026-12-07T00:00:00Z", true), ORG_A);
      expect(
        out.map((o) => [o.outcome, o.outcome === "written" ? o.statement.status : "-"]),
      ).toEqual([
        ["written", "final"],
        ["written", "draft"],
      ]);
      row = await statementOf(ORG_A, "2026-11");
      expect(row).toMatchObject({ status: "final", net_collections_cents: "1650050" });
      // two remittances of the month had not posted when it closed: an operator should look (final + pending => needs_review)
      expect(row).toMatchObject({ net_collections_pending_count: 2, needs_review: true });
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
    });

    it("LATE MONEY (D4): $40,000 dated Nov 29 that posts Dec 8, after November finalized, is NEVER lost and never re-bills November: it is a $400 prior-period line on the December statement", async () => {
      await remittance(ORG_A, { dollars: "40000.00", productionDate: "2026-11-29T00:00:00Z" });
      const again = await runStatementsForOrg(deps("2026-12-08T00:00:00Z", true), ORG_A);
      expect(outcomesOf(again)).toEqual([["written", "2026-12"]]); // November is final: not planned again
      // November is exactly as it was finalized
      expect(await statementOf(ORG_A, "2026-11")).toMatchObject({
        status: "final",
        net_collections_cents: "1650050",
        billing_fee_cents: "16501", // 1,650,050 x 1% = 16,500.50 -> half up
        prior_period_fee_cents: "0",
      });
      // December carries it, stored with its source month and November's own rate
      const dec = await statementOf(ORG_A, "2026-12");
      expect(dec?.prior_period_lines).toEqual([
        {
          sourceYearMonth: "2026-11",
          netCollectionsCents: 4_000_000,
          remittanceCount: 1,
          billingServiceMode: "billing_software",
          billingBps: 100,
          feeCents: 40_000,
        },
      ]);
      // December: 20 patients is the 17 band ($3,000); the implementation fee already rode November; December's OWN December-dated 835
      // ($7,777.00 dated Dec 1) is billed at 1% = $77.77; plus the $400.00 prior-period line
      expect(dec).toMatchObject({
        one_time_fee_cents: "0",
        band_min_adc: 17,
        band_fee_cents: "300000",
        adc_hundredths: 2000,
        staff_count: 0,
        days_live: 31,
        platform_fee_cents: "300000",
        net_collections_cents: "777700",
        billing_fee_cents: "7777",
        prior_period_fee_cents: "40000",
        total_cents: String(300_000 + 7_777 + 40_000),
      });
      // the same run again: nothing new to carry (the draft recomputes the same line, so nothing is written)
      expect(
        outcomesOf(await runStatementsForOrg(deps("2026-12-08T01:00:00Z", true), ORG_A)),
      ).toEqual([["unchanged", "2026-12"]]);
      // when December closes, the line freezes with it, and January does NOT carry the same $40,000 a second time
      await censusDays(ORG_A, 7, 31, 20, "2026-12");
      await runStatementsForOrg(deps("2027-01-07T00:00:00Z", true), ORG_A);
      const decFinal = await statementOf(ORG_A, "2026-12");
      expect(decFinal).toMatchObject({ status: "final", prior_period_fee_cents: "40000" });
      await censusDays(ORG_A, 1, 5, 20, "2027-01");
      const jan = await runStatementsForOrg(deps("2027-01-08T00:00:00Z", true), ORG_A);
      expect(outcomesOf(jan)).toEqual([["written", "2027-01"]]);
      expect(await statementOf(ORG_A, "2027-01")).toMatchObject({
        prior_period_fee_cents: "0",
        prior_period_lines: [],
      });
      // and a further $100.00 that posts for November later is carried alone
      await remittance(ORG_A, { dollars: "100.00", productionDate: "2026-11-02T00:00:00Z" });
      await runStatementsForOrg(deps("2027-01-08T02:00:00Z", true), ORG_A);
      expect((await statementOf(ORG_A, "2027-01"))?.prior_period_lines).toEqual([
        expect.objectContaining({
          sourceYearMonth: "2026-11",
          netCollectionsCents: 10_000,
          feeCents: 100,
        }),
      ]);
    });

    it("a final statement is frozen by its trigger, even against the platform carrier; only the Stripe columns may be written", async () => {
      await asCarrier(async (carrier) => {
        for (const assignment of [
          "total_cents = 1",
          "prior_period_fee_cents = 1",
          "prior_period_lines = '[]'::jsonb",
          "days_live = 1",
          "needs_review = false",
        ]) {
          await expect(
            carrier.query(
              `UPDATE subscription_statement SET ${assignment} WHERE organization_id=$1 AND status='final'`,
              [ORG_A],
            ),
            assignment,
          ).rejects.toThrow(/final statement cannot change/);
        }
        await expect(
          carrier.query(
            "UPDATE subscription_statement SET stripe_usage_record_id='ur_manual' WHERE organization_id=$1 AND status='final'",
            [ORG_A],
          ),
        ).resolves.toBeDefined();
      });
      await expect(
        admin.query(
          "UPDATE subscription_statement SET staff_count = 99 WHERE organization_id=$1 AND status='final'",
          [ORG_A],
        ),
      ).rejects.toThrow(/final statement cannot change/);
    });

    it("the database refuses a statement whose figures do not add up: the greater-of platform fee, the proration, the minimum floor, the half-up billing fee, the prior-period lines, the total", async () => {
      const columns = await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='subscription_statement' AND column_name NOT IN ('id') ORDER BY ordinal_position`,
      );
      const [src] = await q<Record<string, unknown>>(
        "SELECT id FROM subscription_statement WHERE organization_id=$1 AND period_year_month='2027-01'",
        [ORG_A],
      );
      // a clone of a real row as a NEW month, with some columns overridden
      const clone = async (overrides: Record<string, string>) => {
        const select = columns.map(({ column_name: c }) => {
          if (c === "period_year_month") return "'2027-09'";
          if (c === "period_start") return "'2027-09-01'::timestamptz";
          if (c === "period_end") return "'2027-10-01'::timestamptz";
          if (c === "adc_days_in_period") return "30";
          if (c === "status") return "'draft'";
          if (c === "finalized_at") return "NULL";
          if (c === "stripe_usage_record_id" || c === "stripe_posted_at") return "NULL";
          return overrides[c] ?? c;
        });
        return admin.query(
          `INSERT INTO subscription_statement (${columns.map((c) => c.column_name).join(",")})
           SELECT ${select.join(",")} FROM subscription_statement WHERE id=$1`,
          [src?.id],
        );
      };
      // a baseline clone that keeps every figure consistent must itself be refused or accepted deterministically: build one that is valid
      const valid = {
        adc_days_observed: "1",
        days_live: "30",
        per_user_subtotal_cents: "0",
        band_fee_cents: "300000",
        platform_fee_cents: "300000",
        billing_bps: "100",
        net_collections_cents: "1000000",
        billing_fee_cents: "10000",
        minimum_monthly_cents: "NULL",
        minimum_adjustment_cents: "0",
        one_time_fee_cents: "0",
        prior_period_lines: "'[]'::jsonb",
        prior_period_fee_cents: "0",
        total_cents: "310000",
      };
      await expect(clone(valid)).resolves.toBeDefined();
      await admin.query("DELETE FROM subscription_statement WHERE period_year_month='2027-09'");
      const refused = async (change: Record<string, string>, constraint: RegExp) => {
        await expect(clone({ ...valid, ...change })).rejects.toThrow(constraint);
      };
      await refused({ platform_fee_cents: "1", total_cents: "10001" }, /platform_fee_ck/);
      await refused({ billing_fee_cents: "9999", total_cents: "309999" }, /billing_fee_ck/);
      await refused({ days_live: "31" }, /counts_ck/);
      // 15 live days of a 30-day month: the platform fee must be 150,000, not the whole 300,000
      await refused({ days_live: "15" }, /platform_fee_ck/);
      await refused(
        { minimum_monthly_cents: "400000", minimum_adjustment_cents: "0" },
        /minimum_ck/,
      );
      await refused({ total_cents: "310001" }, /total_ck/);
      const lines = (fee: number, source = "2027-08", net = 100_000, bps = 100) =>
        `'[{"sourceYearMonth":"${source}","netCollectionsCents":${net},"remittanceCount":1,"billingServiceMode":"billing_software","billingBps":${bps},"feeCents":${fee}}]'::jsonb`;
      // a line whose fee is not the half-up percentage of its own net collections
      await refused(
        { prior_period_lines: lines(999), prior_period_fee_cents: "999", total_cents: "310999" },
        /prior_lines_ck/,
      );
      // a source month that is not EARLIER than the statement's
      await refused(
        {
          prior_period_lines: lines(1000, "2027-09"),
          prior_period_fee_cents: "1000",
          total_cents: "311000",
        },
        /prior_lines_ck/,
      );
      // a fee column that is not the sum of its lines
      await refused(
        { prior_period_lines: lines(1000), prior_period_fee_cents: "5", total_cents: "310005" },
        /prior_lines_ck/,
      );
      // ... and the valid line is accepted
      await expect(
        clone({
          ...valid,
          prior_period_lines: lines(1000),
          prior_period_fee_cents: "1000",
          total_cents: "311000",
        }),
      ).resolves.toBeDefined();
      await admin.query("DELETE FROM subscription_statement WHERE period_year_month='2027-09'");
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
      await goLive(ORG_C, "2026-11-01T00:00:00Z");
      for (const [i, n] of ["c1", "c2", "c3"].entries()) {
        const uid = await seedUser(`c-${n}`);
        const m = await seedMembership(ORG_C, uid);
        await grantOrgRole(ORG_C, m, "registered_nurse", "clinical_staff");
        await signIn(ORG_C, uid, `2026-11-0${i + 2}T09:00:00Z`);
      }
      await censusDays(ORG_C, 1, 19, 5);
      await remittance(ORG_C, { dollars: "10000.00", productionDate: "2026-11-09T00:00:00Z" });
      await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_C);
      const c = await statementOf(ORG_C, "2026-11");
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
      await goLive(ORG_D, "2026-11-01T00:00:00Z");
      const uidD = await seedUser("d-1");
      const mD = await seedMembership(ORG_D, uidD);
      await grantOrgRole(ORG_D, mD, "registered_nurse", "clinical_staff");
      await signIn(ORG_D, uidD, "2026-11-05T09:00:00Z");
      await censusDays(ORG_D, 1, 19, 0);
      await remittance(ORG_D, { dollars: "50000.00", productionDate: "2026-11-09T00:00:00Z" });
      await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_D);
      expect(await statementOf(ORG_D, "2026-11")).toMatchObject({
        billing_service_mode: "none",
        net_collections_cents: "5000000",
        billing_bps: 0,
        billing_fee_cents: "0",
        adc_hundredths: 0, // a month of zeros is a real zero
        band_min_adc: 0,
        platform_fee_cents: "100000",
      });
    });

    it("never bills an org with no contract or one that is not live, and an org that is live but whose census was never swept gets no statement", async () => {
      expect(await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_E)).toEqual([]); // no contract
      expect(await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_F)).toEqual([]); // canceled before it ever went live
      expect(
        await q("SELECT 1 FROM subscription_statement WHERE organization_id IN ($1,$2)", [
          ORG_E,
          ORG_F,
        ]),
      ).toHaveLength(0);
      // B has a contract and is live but was never swept: no census day, no statement (a missing census is not a census of zero)
      await goLive(ORG_B, "2026-11-01T00:00:00Z");
      const unswept = await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_B);
      expect(outcomesOf(unswept)).toEqual([["skipped", "2026-11"]]);
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
        [26, 29, 400_000],
        [30, null, 500_000],
      ]);
      for (const hidden of ["signedByMembershipId", "signedReason", "orderFormRef"]) {
        expect(a.contract).not.toHaveProperty(hidden);
      }
      expect(a.latestStatement).toMatchObject({ periodYearMonth: "2027-01", status: "draft" });
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
      const view = await contracts.platformView(operator, "pricing-a");
      expect(view.contract).toMatchObject({ signedByMembershipId: OPERATOR_MEMBERSHIP });
      expect(view.statements.map((s) => s.periodYearMonth)).toEqual([
        "2027-01",
        "2026-12",
        "2026-11",
      ]);
      await expect(contracts.platformView(operator, "no-such-tenant")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("an operator's read of a tenant's contract and bills leaves a structured read-audit row naming the operator and the tenant (fail-closed, in the read's own transaction)", async () => {
      const before = await q(
        "SELECT 1 FROM audit_event WHERE event_type='m35.subscription.platform_viewed'",
      );
      await contracts.platformView(operator, "pricing-b");
      const rows = await q<{ organization_id: string | null; context: Record<string, unknown> }>(
        "SELECT organization_id, context FROM audit_event WHERE event_type='m35.subscription.platform_viewed' ORDER BY created_at DESC",
      );
      expect(rows).toHaveLength(before.length + 1);
      expect(rows[0]?.context).toMatchObject({
        organizationId: ORG_B,
        operatorUserId: OPERATOR_USER,
        operatorMembershipId: OPERATOR_MEMBERSHIP,
        hasContract: true,
      });
      // platform-scoped (no organisation column): the tenant cannot read it back in its own audit trail, and it carries no figure
      expect(rows[0]?.organization_id).toBeNull();
      expect(JSON.stringify(rows[0]?.context)).not.toMatch(/total|cents/i);
      // a read that cannot be audited is not served
      const unaudited = buildContractService({
        db: app.db,
        platformRunner,
        onboarding: buildPricingOnboardingPort({
          wizard: {
            getPlatform: async () => ({ steps: [] }) as never,
            attestPlatform: async () => ({}) as never,
          },
        }),
      });
      await expect(unaudited.platformView(operator, "pricing-b")).rejects.toMatchObject({
        code: "AUDIT_UNBOUND",
      });
    });
  });

  // ── 6. the pricing rules on real months ────────────────────────────────────────────────────────────
  describe("the pricing rules on real months", () => {
    const deps = (when: string) => ({
      platformRunner,
      keyProvider,
      netCollections: buildNetCollectionsReader(app.db),
      goLive: { goLiveAt: readTenantGoLive },
      now: at(when),
    });
    const reason = "order form signed by the customer's administrator";
    const sign = (
      slug: string,
      planSlug: string,
      billingServiceMode: "none" | "billing_software" | "managed_billing" = "none",
    ) => contracts.createForTenant(operator, slug, { planSlug, billingServiceMode, reason });
    const statementOf = async (org: string, month: string) =>
      (
        await q<Record<string, string>>(
          "SELECT * FROM subscription_statement WHERE organization_id=$1 AND period_year_month=$2",
          [org, month],
        )
      )[0];
    const outcomesOf = (out: Awaited<ReturnType<typeof runStatementsForOrg>>) =>
      out.map((o) => [
        o.outcome,
        o.outcome === "written" ? o.statement.periodYearMonth : o.periodYearMonth,
      ]);
    let minPlanSlug = "";

    it("D2: a MID-MONTH go-live is prorated by the days live, the go-live day counting: Nov 20 is 11 of 30 days, $2,000 band -> $733.33, the implementation fee whole", async () => {
      await sign("pricing-g", planV2Slug);
      await goLive(ORG_G, "2026-11-20T08:00:00Z");
      await censusDays(ORG_G, 20, 25, 12);
      const out = await runStatementsForOrg(deps("2026-11-25T12:00:00Z"), ORG_G);
      expect(outcomesOf(out)).toEqual([["written", "2026-11"]]);
      expect(await statementOf(ORG_G, "2026-11")).toMatchObject({
        days_live: 11,
        adc_days_in_period: 30,
        adc_hundredths: 1200,
        band_fee_cents: "200000", // the full-month side is shown whole
        platform_fee_cents: "73333", // 200,000 x 11 / 30 = 73,333.33
        one_time_fee_cents: "250000", // not prorated
        billing_fee_cents: "0",
        total_cents: String(73_333 + 250_000),
        status: "draft",
      });
    });

    it("D2: a go-live on the 1st is a WHOLE first month (30 of 30)", async () => {
      // ORG_H goes live on Nov 1: the whole-month case, and the story of the Nov-28 mode flip below
      await sign("pricing-h", planV2Slug, "billing_software");
      await goLive(ORG_H, "2026-11-01T00:00:00Z");
      await censusDays(ORG_H, 1, 25, 12);
      await remittance(ORG_H, { dollars: "10000.00", productionDate: "2026-11-09T00:00:00Z" });
      await runStatementsForOrg(deps("2026-11-25T12:00:00Z"), ORG_H);
      expect(await statementOf(ORG_H, "2026-11")).toMatchObject({
        days_live: 30,
        platform_fee_cents: "200000",
        billing_service_mode: "billing_software",
        billing_bps: 100,
        billing_fee_cents: "10000",
        one_time_fee_cents: "250000",
        total_cents: String(200_000 + 10_000 + 250_000),
      });
    });

    it("D2: a go-live on the LAST day of the month is one day: $1,000 band / 30 = $33.33, plus the implementation fee", async () => {
      await sign("pricing-i", planV2Slug);
      await goLive(ORG_I, "2026-11-30T20:00:00Z");
      await censusDays(ORG_I, 30, 30, 5);
      await runStatementsForOrg(deps("2026-11-30T22:00:00Z"), ORG_I);
      expect(await statementOf(ORG_I, "2026-11")).toMatchObject({
        days_live: 1,
        band_fee_cents: "100000",
        platform_fee_cents: "3333", // 100,000 / 30 = 3,333.33
        total_cents: String(3_333 + 250_000),
      });
    });

    it("D3: the plan minimum floors the PLATFORM FEE only, the billing percentage is added on top: $1,500 minimum, $1,000 band, $1,000 billing fee -> $500 top-up (the old rule let the billing fee clear the minimum and billed $4,500, not $5,000)", async () => {
      const minPlan = await plans.create(
        operator,
        plan({ familySlug: "min-floor", minimumMonthlyCents: 150_000 }),
        "a plan with a monthly minimum",
      );
      await plans.publish(operator, minPlan.id, "approved by the owner");
      minPlanSlug = minPlan.slug;
      await sign("pricing-j", minPlanSlug, "billing_software");
      await goLive(ORG_J, "2026-11-01T00:00:00Z");
      await censusDays(ORG_J, 1, 19, 5);
      await remittance(ORG_J, { dollars: "100000.00", productionDate: "2026-11-09T00:00:00Z" });
      await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_J);
      expect(await statementOf(ORG_J, "2026-11")).toMatchObject({
        platform_fee_cents: "100000",
        minimum_monthly_cents: "150000",
        minimum_adjustment_cents: "50000",
        billing_fee_cents: "100000",
        one_time_fee_cents: "250000",
        total_cents: String(100_000 + 50_000 + 100_000 + 250_000),
      });
    });

    it("D3: the minimum is prorated the same way in a first month: $1,500 x 11/30 = $550 floors a $366.67 platform fee", async () => {
      await sign("pricing-k", minPlanSlug);
      await goLive(ORG_K, "2026-11-20T08:00:00Z");
      await censusDays(ORG_K, 20, 25, 5);
      await runStatementsForOrg(deps("2026-11-25T12:00:00Z"), ORG_K);
      expect(await statementOf(ORG_K, "2026-11")).toMatchObject({
        days_live: 11,
        platform_fee_cents: "36667", // 100,000 x 11 / 30 = 36,666.67
        minimum_adjustment_cents: "18333", // 150,000 x 11 / 30 = 55,000, less the platform fee
        total_cents: String(55_000 + 250_000),
      });
    });

    it("D6: a mode change takes effect from the 1st of the NEXT month: flipped on Nov 28, November keeps billing software, December is managed billing", async () => {
      const nov28 = contractsAt("2026-11-28T10:00:00Z");
      const flipped = await nov28.setBillingServiceMode(
        operator,
        "pricing-h",
        "managed_billing",
        "the tenant moved to managed billing",
      );
      expect(flipped).toMatchObject({
        billingServiceMode: "billing_software", // still in force today
        billingBps: 100,
        pendingBillingServiceMode: {
          billingServiceMode: "managed_billing",
          effectiveOn: "2026-12-01",
        },
      });
      const audit = await q<{ context: Record<string, unknown> }>(
        "SELECT context FROM audit_event WHERE event_type='m35.subscription.billing_service_mode_changed' AND context->>'organizationId'=$1",
        [ORG_H],
      );
      expect(audit[0]?.context).toMatchObject({
        from: "billing_software",
        to: "managed_billing",
        effectiveOn: "2026-12-01",
      });
      // the seam answers by date
      expect(await readBillingServiceMode(app.db, ORG_H, new Date("2026-11-30T23:59:59Z"))).toBe(
        "billing_software",
      );
      expect(await readBillingServiceMode(app.db, ORG_H, new Date("2026-12-01T00:00:00Z"))).toBe(
        "managed_billing",
      );

      // the operator changes their mind the same day: setting the mode in force again withdraws the pending change
      const withdrawn = await contractsAt("2026-11-28T11:00:00Z").setBillingServiceMode(
        operator,
        "pricing-h",
        "billing_software",
        "the tenant stays on billing software",
      );
      expect(withdrawn).toMatchObject({
        billingServiceMode: "billing_software",
        pendingBillingServiceMode: null,
      });
      await contractsAt("2026-11-28T12:00:00Z").setBillingServiceMode(
        operator,
        "pricing-h",
        "managed_billing",
        "the tenant confirmed managed billing",
      );

      // recomputing November AFTER the flip still prices it with the mode it started with
      await censusDays(ORG_H, 26, 29, 12);
      await runStatementsForOrg(deps("2026-11-29T12:00:00Z"), ORG_H);
      expect(await statementOf(ORG_H, "2026-11")).toMatchObject({
        billing_service_mode: "billing_software",
        billing_bps: 100,
        billing_fee_cents: "10000",
      });

      // December bills with the new mode: 4% of the $5,000 collected
      await censusDays(ORG_H, 1, 6, 12, "2026-12");
      await remittance(ORG_H, { dollars: "5000.00", productionDate: "2026-12-02T00:00:00Z" });
      const out = await runStatementsForOrg(deps("2026-12-07T00:00:00Z"), ORG_H);
      expect(outcomesOf(out)).toEqual([
        ["written", "2026-11"],
        ["written", "2026-12"],
      ]);
      expect(await statementOf(ORG_H, "2026-11")).toMatchObject({
        status: "final",
        billing_service_mode: "billing_software",
        billing_fee_cents: "10000",
      });
      expect(await statementOf(ORG_H, "2026-12")).toMatchObject({
        status: "draft",
        billing_service_mode: "managed_billing",
        billing_bps: 400,
        billing_fee_cents: "20000",
        platform_fee_cents: "200000",
        one_time_fee_cents: "0",
        total_cents: String(200_000 + 20_000),
      });
    });

    it("D6 in the database: the history is append-only, a signed contract never changes, and no change can reach into a month that is already final", async () => {
      const [contract] = await q<{ id: string }>(
        "SELECT id FROM subscription_contract WHERE organization_id=$1",
        [ORG_H],
      );
      const insert = (from: string) =>
        admin.query(
          "INSERT INTO subscription_contract_mode (organization_id, contract_id, billing_service_mode, effective_from) VALUES ($1,$2,'none',$3)",
          [ORG_H, contract?.id, from],
        );
      await expect(insert("2026-11-30")).rejects.toThrow(
        /already final|before one already recorded/,
      );
      await expect(insert("2026-10-01")).rejects.toThrow(/before one already recorded/);
      await expect(
        admin.query(
          "UPDATE subscription_contract_mode SET billing_service_mode='none' WHERE contract_id=$1",
          [contract?.id],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        admin.query("DELETE FROM subscription_contract_mode WHERE contract_id=$1", [contract?.id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        admin.query(
          "UPDATE subscription_contract SET signed_reason='rewritten after the fact' WHERE id=$1",
          [contract?.id],
        ),
      ).rejects.toThrow(/cannot change/);
      // a mode row must belong to its contract's own organisation
      await expect(
        admin.query(
          "INSERT INTO subscription_contract_mode (organization_id, contract_id, billing_service_mode, effective_from) VALUES ($1,$2,'none','2027-02-01')",
          [ORG_G, contract?.id],
        ),
      ).rejects.toThrow(/own organization/);
    });

    it("CANCEL inside the grace window: the month it was canceled in is billed for the days used (the cancel day counts), finalizes on schedule, and a late 835 is carried on a settlement statement; the canceled contract is not 'live'", async () => {
      await sign("pricing-l", planV2Slug, "billing_software");
      await goLive(ORG_L, "2026-11-01T00:00:00Z");
      await censusDays(ORG_L, 1, 19, 5);
      await remittance(ORG_L, { dollars: "1000.00", productionDate: "2026-11-09T00:00:00Z" });
      // the platform cancels the subscription on Nov 20 at 14:00
      await admin.query(
        "UPDATE subscription SET status='canceled', canceled_at='2026-11-20T14:00:00Z' WHERE organization_id=$1",
        [ORG_L],
      );
      const inGrace = await runStatementsForOrg(deps("2026-11-25T12:00:00Z"), ORG_L);
      expect(outcomesOf(inGrace)).toEqual([["written", "2026-11"]]);
      expect(await statementOf(ORG_L, "2026-11")).toMatchObject({
        days_live: 20, // Nov 1..20 (the old code billed a canceled subscription for nothing at all)
        platform_fee_cents: "66667", // 100,000 x 20 / 30 = 66,666.67
        billing_fee_cents: "1000",
        one_time_fee_cents: "250000",
        total_cents: String(66_667 + 1_000 + 250_000),
        status: "draft",
      });
      // after the grace the month finalizes whatever the subscription has become; no December statement (nothing live, nothing late yet)
      const closed = await runStatementsForOrg(deps("2026-12-10T00:00:00Z"), ORG_L);
      expect(outcomesOf(closed)).toEqual([
        ["written", "2026-11"],
        ["skipped", "2026-12"],
      ]);
      expect(await statementOf(ORG_L, "2026-11")).toMatchObject({ status: "final" });
      expect(await statementOf(ORG_L, "2026-12")).toBeUndefined();
      // a $2,000 835 dated Nov 12 posts after the close: a SETTLEMENT statement for December carries it (never lost, even after a cancel)
      await remittance(ORG_L, { dollars: "2000.00", productionDate: "2026-11-12T00:00:00Z" });
      const settled = await runStatementsForOrg(deps("2026-12-12T00:00:00Z"), ORG_L);
      expect(outcomesOf(settled)).toEqual([["written", "2026-12"]]);
      expect(await statementOf(ORG_L, "2026-12")).toMatchObject({
        days_live: 0,
        staff_count: 0,
        platform_fee_cents: "0",
        one_time_fee_cents: "0",
        net_collections_cents: "0",
        prior_period_fee_cents: "2000",
        total_cents: "2000",
      });
      // which orgs are asked: L is still scanned for late money, but it is no longer live (the census does not record it)
      const dec12 = new Date("2026-12-12T00:00:00Z");
      expect((await listContractedOrgIds(platformRunner, "statements", dec12)).has(ORG_L)).toBe(
        true,
      );
      expect((await listContractedOrgIds(platformRunner, "live", dec12)).has(ORG_L)).toBe(false);
      expect(
        await recordDailyCensusForOrg(
          {
            platformRunner,
            census: { activePatientCount: async () => 4 },
            now: at("2026-12-12T18:00:00Z"),
          },
          ORG_L,
        ),
      ).toEqual({ recorded: false });
      // ... until the settlement window (12 months after it ended) has passed
      const jan2028 = new Date("2028-01-15T00:00:00Z");
      expect((await listContractedOrgIds(platformRunner, "statements", jan2028)).has(ORG_L)).toBe(
        false,
      );
    });

    it("a SUSPENDED (paused) organisation's last month still finalizes, billed for the days before the pause; the statement run is not the active-org sweep", async () => {
      await sign("pricing-m", planV2Slug);
      await goLive(ORG_M, "2026-11-01T00:00:00Z");
      await censusDays(ORG_M, 1, 14, 12);
      // the org is suspended on Nov 15 at 09:00 (M2 pauses its subscription): the tenant is no longer active
      await admin.query(
        "UPDATE subscription SET status='paused', paused_at='2026-11-15T09:00:00Z' WHERE organization_id=$1",
        [ORG_M],
      );
      await admin.query(
        `INSERT INTO subscription_state_history (subscription_id, organization_id, from_status, to_status, transitioned_at, reason_code)
         SELECT id, organization_id, 'active', 'paused', '2026-11-15T09:00:00Z', 'org_suspended_by_platform_admin' FROM subscription WHERE organization_id=$1`,
        [ORG_M],
      );
      await admin.query("UPDATE tenant_account SET status='suspended' WHERE organization_id=$1", [
        ORG_M,
      ]);
      // the selector (what the sweep fans out over) names it although no active-org list would
      const dec10 = new Date("2026-12-10T00:00:00Z");
      expect((await listContractedOrgIds(platformRunner, "statements", dec10)).has(ORG_M)).toBe(
        true,
      );
      expect((await listContractedOrgIds(platformRunner, "live", dec10)).has(ORG_M)).toBe(false);
      const out = await runStatementsForOrg(deps("2026-12-10T00:00:00Z"), ORG_M);
      expect(outcomesOf(out)).toEqual([
        ["written", "2026-11"],
        ["skipped", "2026-12"],
      ]);
      expect(await statementOf(ORG_M, "2026-11")).toMatchObject({
        status: "final",
        days_live: 15, // Nov 1..15: the pause began at 09:00 on the 15th, so that day was used
        platform_fee_cents: "100000", // 200,000 x 15 / 30
        total_cents: String(100_000 + 250_000),
      });
    });

    it("RE-SIGN: an org with two contracts (the first canceled) is billed on the NEW one, with the new one's mode; every consumer picks the same contract", async () => {
      await sign("pricing-n", planV2Slug, "none");
      await goLive(ORG_N, "2026-11-01T00:00:00Z");
      await admin.query(
        "UPDATE subscription SET status='canceled', canceled_at='2026-11-10T10:00:00Z' WHERE organization_id=$1",
        [ORG_N],
      );
      // the tenant is back in onboarding and a new contract is signed on Nov 12 (billing software this time)
      await admin.query("UPDATE tenant_account SET status='onboarding' WHERE organization_id=$1", [
        ORG_N,
      ]);
      await contractsAt("2026-11-12T10:00:00Z").createForTenant(operator, "pricing-n", {
        planSlug: planV2Slug,
        billingServiceMode: "billing_software",
        reason,
      });
      await goLive(ORG_N, "2026-11-01T00:00:00Z");
      expect(
        await q("SELECT 1 FROM subscription_contract WHERE organization_id=$1", [ORG_N]),
      ).toHaveLength(2);

      const nov20 = new Date("2026-11-20T12:00:00Z");
      // the ONE selector: the newest LIVE contract is the second; the canceled first is not "the contract"
      const newest = await platformRunner((tx) => selectNewestContract(tx, "live", nov20, ORG_N));
      expect(newest?.sub.status).toBe("active");
      expect(await readBillingServiceMode(app.db, ORG_N, nov20)).toBe("billing_software");
      expect(
        await recordDailyCensusForOrg(
          {
            platformRunner,
            census: { activePatientCount: async () => 5 },
            now: at("2026-11-20T18:00:00Z"),
          },
          ORG_N,
        ),
      ).toMatchObject({ recorded: true });

      await censusDays(ORG_N, 1, 19, 5);
      const out = await runStatementsForOrg(deps("2026-11-20T12:00:00Z"), ORG_N);
      // one statement per subscription for its own lifetime: the first for Nov 1..10, the second from its signing day Nov 12
      expect(outcomesOf(out)).toEqual([
        ["written", "2026-11"],
        ["written", "2026-11"],
      ]);
      const rows = await q<Record<string, string>>(
        `SELECT s.*, sub.status AS sub_status FROM subscription_statement s JOIN subscription sub ON sub.id = s.subscription_id
          WHERE s.organization_id=$1 ORDER BY s.days_live`,
        [ORG_N],
      );
      expect(
        rows.map((r) => [
          r.sub_status,
          r.days_live,
          r.platform_fee_cents,
          r.billing_service_mode,
          r.one_time_fee_cents,
        ]),
      ).toEqual([
        ["canceled", 10, "33333", "none", "250000"], // 100,000 x 10 / 30
        ["active", 19, "63333", "billing_software", "250000"], // 100,000 x 19 / 30, the new subscription's own first statement
      ]);
    });

    it("CONCURRENT runs for one org are serialized: one row per month, the implementation fee once, a rotated-key month flagged for review", async () => {
      // three staff signed in under the old key and two under the new one, in November: cannot be role-filtered
      for (const [epoch, n, tag] of [
        ["epoch-20260901T0000Z-old", 3, "old"],
        [KEY.keyEpoch, 2, "new"],
      ] as const) {
        for (let i = 0; i < n; i++) {
          await admin.query(
            `INSERT INTO user_active_period (organization_id, membership_pseudonym, pseudonym_key_epoch, period_year_month, was_active,
               first_session_at, last_session_at) VALUES ($1,$2,$3,'2026-11',true,now(),now())`,
            [ORG_G, computeBillingPseudonym(`${epoch}-material`, `g-${tag}-${i}`), epoch],
          );
        }
      }
      await censusDays(ORG_G, 26, 26, 12);
      const results = await Promise.all([
        runStatementsForOrg(deps("2026-11-26T12:00:00Z"), ORG_G),
        runStatementsForOrg(deps("2026-11-26T12:00:00Z"), ORG_G),
      ]);
      const kinds = results.flatMap((r) => outcomesOf(r).map((o) => o[0]));
      expect(kinds.filter((k) => k === "written")).toHaveLength(1); // the second run, under the lock, found the same figures and wrote nothing
      expect(kinds).toContain("unchanged");
      const rows = await q<Record<string, string>>(
        "SELECT * FROM subscription_statement WHERE organization_id=$1",
        [ORG_G],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        one_time_fee_cents: "250000",
        staff_count: 3, // the busiest single epoch
        staff_count_basis: "ledger_unfiltered",
        needs_review: true,
      });
    });
  });

  // ── 7. the dev seed ────────────────────────────────────────────────────────────────────────────────
  describe("the dev plan seed", () => {
    const seed = () =>
      spawnSync("bun", ["run", "scripts/db/seed-plans.ts"], {
        cwd: join(__dirname, "../../.."),
        env: { ...process.env, DATABASE_ADMIN_URL: DB_URL },
        encoding: "utf8",
      });

    it("seeds the demo census plan as a DRAFT with the owner's five bands, so nothing offers it until an operator publishes it", async () => {
      const first = seed();
      expect(first.status, first.stderr).toBe(0);
      const [demo] = await q<{
        id: string;
        is_active: boolean;
        published_at: Date | null;
        tier: string;
      }>("SELECT id, is_active, published_at, tier FROM plan WHERE slug='demo-census-banded-v1'");
      expect(demo).toMatchObject({ is_active: false, published_at: null, tier: "census_banded" });
      expect(
        (
          await q<{ min_adc: number }>(
            "SELECT min_adc FROM plan_census_band WHERE plan_id=$1 ORDER BY min_adc",
            [demo?.id],
          )
        ).map((b) => b.min_adc),
      ).toEqual([0, 10, 17, 26, 30]);
      // not offered, and not signable (a draft is never an offered version)
      expect((await plans.listOffered()).map((p) => p.slug)).not.toContain("demo-census-banded-v1");
      await expect(
        contracts.createForTenant(operator, "pricing-f", {
          planSlug: "demo-census-banded-v1",
          billingServiceMode: "none",
          reason: "an attempt to sign the seeded demo plan",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      // idempotent: a second run leaves it exactly as it is (an operator may have edited the draft)
      await admin.query("UPDATE plan SET name='Demo edited by an operator' WHERE id=$1", [
        demo?.id,
      ]);
      const second = seed();
      expect(second.status, second.stderr).toBe(0);
      expect(
        (await q<{ name: string }>("SELECT name FROM plan WHERE id=$1", [demo?.id]))[0]?.name,
      ).toBe("Demo edited by an operator");
      // the flat tiers it also seeds are retired rows
      expect(
        await q(
          "SELECT 1 FROM plan WHERE tier IN ('starter','professional','enterprise') AND is_active",
        ),
      ).toHaveLength(0);
    });
  });
});
