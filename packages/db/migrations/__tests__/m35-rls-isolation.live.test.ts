/**
 * M35 Subscription Billing — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * The pure unit suites for M35 exercise the domain but never touch a database, so they cannot catch a
 * wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants. This test
 * applies the actual migrations to a real Postgres and exercises the policies as the unprivileged
 * `chartwarden_app` role (no BYPASSRLS), proving cross-tenant denial for real across ALL 21 of M35's owned
 * tables — which carry THREE distinct RLS shapes (0143's own §1 commentary is the source of truth):
 *
 *   1. TENANT-SCOPED (twelve): subscription, subscription_state_history, payment_method, invoice,
 *      invoice_line, usage_event (partitioned — the policy lives on the parent and propagates to every
 *      partition, PG11+), usage_period_aggregate, patient_active_period, user_active_period,
 *      dunning_state, promo_code_application, refund. Canonical `app.org_id` predicate, chartwarden_app keeps
 *      DELETE (the §3.7 tenant-offboarding copy-then-delete eraser needs it).
 *   2. PLATFORM CATALOG (three): plan, plan_meter, promo_code — `FOR SELECT USING (true)` to chartwarden_app
 *      (every tenant must read the pricing/coupon catalog to subscribe); writes only via chartwarden_admin.
 *   3. PLATFORM-ONLY (six): revenue_recognition_snapshot, patient_pseudonym_key, stripe_webhook_event,
 *      stripe_api_call_audit, platform_retained_invoice, platform_retained_invoice_line. RLS enabled with
 *      NO chartwarden_app grant at all (table-level GRANT, not just a policy) — a chartwarden_app SELECT fails
 *      with a permission error regardless of `app.org_id`, not merely a zero-row result (there is no
 *      GRANT to bypass, so Postgres never gets as far as evaluating a policy). Migration 0159 (already
 *      applied) closed the "RLS enabled + zero policy = grant is dead" gap on these six by adding a
 *      `USING (true)` policy for chartwarden_admin, so chartwarden_admin can now read them for real.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m35` (SUPERUSER to a THROWAWAY
 *     db; for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type CatalogIds = { planId: string; planMeterId: string; promoCodeId: string };

type SeedIds = {
  subscriptionId: string;
  subStateHistoryId: string;
  paymentMethodId: string;
  invoiceId: string;
  invoiceLineId: string;
  usagePeriodAggregateId: string;
  patientActivePeriodId: string;
  userActivePeriodId: string;
  dunningStateId: string;
  promoCodeApplicationId: string;
  refundId: string;
  usageEventId: string;
};

// 1. TENANT-SCOPED — twelve tables, canonical app.org_id cross-tenant denial.
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "subscription", key: "subscriptionId" },
  { table: "subscription_state_history", key: "subStateHistoryId" },
  { table: "payment_method", key: "paymentMethodId" },
  { table: "invoice", key: "invoiceId" },
  { table: "invoice_line", key: "invoiceLineId" },
  { table: "usage_event", key: "usageEventId" },
  { table: "usage_period_aggregate", key: "usagePeriodAggregateId" },
  { table: "patient_active_period", key: "patientActivePeriodId" },
  { table: "user_active_period", key: "userActivePeriodId" },
  { table: "dunning_state", key: "dunningStateId" },
  { table: "promo_code_application", key: "promoCodeApplicationId" },
  { table: "refund", key: "refundId" },
];

// 2. PLATFORM CATALOG — three tables, read-all to every tenant.
const CATALOG_READALL: { table: string; key: keyof CatalogIds }[] = [
  { table: "plan", key: "planId" },
  { table: "plan_meter", key: "planMeterId" },
  { table: "promo_code", key: "promoCodeId" },
];

// 3. PLATFORM-ONLY — six tables, no chartwarden_app grant at all (0159 gave chartwarden_admin a real policy).
const PLATFORM_ONLY = [
  "revenue_recognition_snapshot",
  "patient_pseudonym_key",
  "stripe_webhook_event",
  "stripe_api_call_audit",
  "platform_retained_invoice",
  "platform_retained_invoice_line",
];

describe.skipIf(!DB_URL)(
  "M35 Subscription Billing — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
    let db: Client;
    let catalog: CatalogIds;
    let a: SeedIds;

    async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
      await db.query("SET ROLE chartwarden_app");
      await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
      try {
        return await fn();
      } finally {
        await db.query("RESET ROLE");
      }
    }

    async function withAdmin<T>(fn: () => Promise<T>): Promise<T> {
      await db.query("SET ROLE chartwarden_admin");
      try {
        return await fn();
      } finally {
        await db.query("RESET ROLE");
      }
    }

    async function resetSchema() {
      await db.query("DROP SCHEMA IF EXISTS public CASCADE");
      await db.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await db.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
    }

    async function applyMigrations() {
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        }
        await db.query(sql);
      }
    }

    /** Seed the shared platform catalog (plan/plan_meter/promo_code) once, as superuser. */
    async function seedCatalog(): Promise<CatalogIds> {
      const planId = (
        await db.query(
          `INSERT INTO plan (slug, name, tier, cadence, base_price_cents, is_active)
         VALUES ('starter-monthly','Starter','starter','monthly',29900,true) RETURNING id`,
        )
      ).rows[0].id as string;
      const planMeterId = (
        await db.query(
          `INSERT INTO plan_meter (plan_id, event_type, inclusive_quantity, overage_unit_price_cents, billing_aggregation)
         VALUES ($1,'active_patient',500,150,'sum') RETURNING id`,
          [planId],
        )
      ).rows[0].id as string;
      const promoCodeId = (
        await db.query(
          `INSERT INTO promo_code (stripe_coupon_id, stripe_promotion_code_id, code, kind, percent_off, duration)
         VALUES ('coupon_launch20','promo_launch20','LAUNCH20','percent_off',20,'once') RETURNING id`,
        )
      ).rows[0].id as string;
      return { planId, planMeterId, promoCodeId };
    }

    /** Seed one full linked M35 tenant chain for `org` as superuser (RLS + grants bypassed). */
    async function seedOrg(org: string, n: number, cat: CatalogIds): Promise<SeedIds> {
      const subscriptionId = (
        await db.query(
          `INSERT INTO subscription (organization_id, plan_id, stripe_customer_id, stripe_subscription_id, status)
         VALUES ($1,$2,$3,$4,'active') RETURNING id`,
          [org, cat.planId, `cus_org${n}`, `sub_org${n}`],
        )
      ).rows[0].id as string;

      const subStateHistoryId = (
        await db.query(
          `INSERT INTO subscription_state_history (organization_id, subscription_id, from_status, to_status, reason_code)
         VALUES ($1,$2,'trialing','active','trial_converted') RETURNING id`,
          [org, subscriptionId],
        )
      ).rows[0].id as string;

      const paymentMethodId = (
        await db.query(
          `INSERT INTO payment_method (organization_id, stripe_payment_method_id, kind, card_brand, card_last4, is_default)
         VALUES ($1,$2,'card','visa','4242',true) RETURNING id`,
          [org, `pm_org${n}`],
        )
      ).rows[0].id as string;

      const invoiceId = (
        await db.query(
          `INSERT INTO invoice (organization_id, subscription_id, stripe_invoice_id, status, subtotal_cents, total_cents, amount_due_cents)
         VALUES ($1,$2,$3,'open',29900,29900,29900) RETURNING id`,
          [org, subscriptionId, `in_org${n}`],
        )
      ).rows[0].id as string;

      const invoiceLineId = (
        await db.query(
          `INSERT INTO invoice_line (organization_id, invoice_id, stripe_line_id, kind, description, quantity, unit_amount_cents, total_cents, plan_meter_id)
         VALUES ($1,$2,$3,'subscription','Starter plan',1,29900,29900,$4) RETURNING id`,
          [org, invoiceId, `il_org${n}`, cat.planMeterId],
        )
      ).rows[0].id as string;

      const usagePeriodAggregateId = (
        await db.query(
          `INSERT INTO usage_period_aggregate (organization_id, subscription_id, event_type, period_start, period_end, total_quantity)
         VALUES ($1,$2,'active_patient','2026-07-01T00:00:00Z','2026-07-31T23:59:59Z',42) RETURNING id`,
          [org, subscriptionId],
        )
      ).rows[0].id as string;

      const patientActivePeriodId = (
        await db.query(
          `INSERT INTO patient_active_period (organization_id, patient_pseudonym, pseudonym_key_epoch, period_year_month, was_active)
         VALUES ($1,$2,'epoch-1','2026-07',true) RETURNING id`,
          [org, "a".repeat(32)],
        )
      ).rows[0].id as string;

      const userActivePeriodId = (
        await db.query(
          `INSERT INTO user_active_period (organization_id, membership_pseudonym, pseudonym_key_epoch, period_year_month, was_active)
         VALUES ($1,$2,'epoch-1','2026-07',true) RETURNING id`,
          [org, "b".repeat(32)],
        )
      ).rows[0].id as string;

      const dunningStateId = (
        await db.query(
          `INSERT INTO dunning_state (organization_id, subscription_id, stage, attempt_count)
         VALUES ($1,$2,'day_1',1) RETURNING id`,
          [org, subscriptionId],
        )
      ).rows[0].id as string;

      const promoCodeApplicationId = (
        await db.query(
          `INSERT INTO promo_code_application (organization_id, subscription_id, promo_code_id, applied_by_membership_id)
         VALUES ($1,$2,$3,gen_random_uuid()) RETURNING id`,
          [org, subscriptionId, cat.promoCodeId],
        )
      ).rows[0].id as string;

      const refundId = (
        await db.query(
          `INSERT INTO refund (organization_id, invoice_id, amount_cents, kind, reason_code, reason_detail, requested_by_membership_id)
         VALUES ($1,$2,5000,'partial','customer_request',$3,gen_random_uuid()) RETURNING id`,
          [
            org,
            invoiceId,
            "Customer requested a partial refund after downgrading mid-cycle billing period.",
          ],
        )
      ).rows[0].id as string;

      const usageEventId = (
        await db.query(
          `INSERT INTO usage_event (organization_id, subscription_id, event_type, quantity, source_module)
         VALUES ($1,$2,'active_patient',1,'m1') RETURNING id`,
          [org, subscriptionId],
        )
      ).rows[0].id as string;

      return {
        subscriptionId,
        subStateHistoryId,
        paymentMethodId,
        invoiceId,
        invoiceLineId,
        usagePeriodAggregateId,
        patientActivePeriodId,
        userActivePeriodId,
        dunningStateId,
        promoCodeApplicationId,
        refundId,
        usageEventId,
      };
    }

    /** Seed one row per PLATFORM-ONLY table (no chartwarden_app grant at all), as superuser, once. */
    async function seedPlatformOnly(): Promise<void> {
      await db.query(
        `INSERT INTO revenue_recognition_snapshot (
         snapshot_month, mrr_cents, arr_cents, new_mrr_cents, expansion_mrr_cents, contraction_mrr_cents,
         churn_mrr_cents, active_subscriptions, trialing_subscriptions, past_due_subscriptions)
       VALUES ('2026-07',598000,7176000,29900,0,0,0,2,0,0)`,
      );
      await db.query(
        `INSERT INTO patient_pseudonym_key (key_epoch, key_material_ciphertext, key_kms_ref, is_active)
       VALUES ('epoch-1','ciphertext-blob','kms://key/1',true)`,
      );
      await db.query(
        `INSERT INTO stripe_webhook_event (id, event_type, payload_ciphertext, payload_dek_ref, signature_verified_at)
       VALUES ('evt_1','invoice.paid','ciphertext','dek-ref',now())`,
      );
      await db.query(
        `INSERT INTO stripe_api_call_audit (stripe_idempotency_key, operation, request_envelope_redacted)
       VALUES ('idem-1','invoices.create','{}'::jsonb)`,
      );
      const retainedInvoiceId = (
        await db.query(
          `INSERT INTO platform_retained_invoice (
           original_invoice_id, original_organization_id, retain_until, stripe_invoice_id, status,
           subtotal_cents, tax_cents, total_cents, amount_paid_cents, currency_code)
         VALUES (gen_random_uuid(),$1,now() + interval '7 years','in_retained_1','paid',29900,0,29900,29900,'USD')
         RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      await db.query(
        `INSERT INTO platform_retained_invoice_line (
         original_invoice_line_id, retained_invoice_id, original_invoice_id, original_organization_id,
         retain_until, stripe_line_id, kind, description)
       VALUES (gen_random_uuid(),$1,gen_random_uuid(),$2,now() + interval '7 years','il_retained_1','subscription','Starter plan')`,
        [retainedInvoiceId, ORG_A],
      );
    }

    beforeAll(async () => {
      db = new Client({ connectionString: DB_URL });
      await db.connect();
      await resetSchema();
      await applyMigrations();
      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      catalog = await seedCatalog();
      a = await seedOrg(ORG_A, 1, catalog);
      await seedOrg(ORG_B, 2, catalog);
      await seedPlatformOnly();
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable,
    // not theoretical.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M35 tenant-scoped RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(
        join(MIGRATIONS_DIR, "0143_subscription_billing_m35_rls_audit_triggers.sql"),
        "utf8",
      );
      const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
      // The twelve TENANT-SCOPED policies carry a WITH CHECK; the three catalog `FOR SELECT` policies and
      // the six platform-only tables (which get no CREATE POLICY at all until 0159) do not match this regex.
      expect(policyBlocks.length).toBe(12);
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
      }
    });

    it.each(COVERED)(
      "$table: org A sees its row, org B cannot (cross-tenant denial)",
      async ({ table, key }) => {
        const id = a[key];
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
        );
        expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
        );
        expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
      },
    );

    it.each(CATALOG_READALL)(
      "$table: platform catalog is read-all (every tenant sees the row)",
      async ({ table, key }) => {
        const id = catalog[key];
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
        );
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
        );
        expect(seenByA.rows[0].n).toBe(1);
        expect(seenByB.rows[0].n).toBe(1);
      },
    );

    it.each(PLATFORM_ONLY)(
      "%s: chartwarden_admin can read (platform-only), chartwarden_app has no grant at all regardless of org",
      async (table) => {
        const seenByAdmin = await withAdmin(() =>
          db.query(`SELECT count(*)::int AS n FROM ${table}`),
        );
        expect(seenByAdmin.rows[0].n).toBeGreaterThanOrEqual(1);
        // chartwarden_app was never GRANTed on these six tables — a SELECT fails with a permission error, not
        // merely a zero-row result, and that holds regardless of which org's context is set.
        await expect(
          withOrg(ORG_A, () => db.query(`SELECT count(*) FROM ${table}`)),
        ).rejects.toThrow();
        await expect(
          withOrg(ORG_B, () => db.query(`SELECT count(*) FROM ${table}`)),
        ).rejects.toThrow();
      },
    );

    it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO subscription_state_history (organization_id, subscription_id, to_status, reason_code)
           VALUES ($1,$2,'active','cross_tenant_probe')`,
            [ORG_A, a.subscriptionId], // B tries to write a row scoped to A, against A's real subscription
          ),
        ),
      ).rejects.toThrow();
    });
  },
);
