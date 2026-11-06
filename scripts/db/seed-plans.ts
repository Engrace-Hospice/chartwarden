/**
 * ChartWarden — M35 plan catalog fixture (local dev / demo only). NOT a pricing source of truth.
 *
 * `plan` / `plan_meter` are platform-owned (no organization_id) and no migration inserts rows, so a fresh
 * `db:reset` leaves `GET /api/v1/plans` empty and the billing plan screen shows "No plans are available".
 * The flat starter / professional / enterprise tiers are RETIRED (slice 2, migration 1341): they are still seeded, as archived rows with
 * their usage meters, so a dev database shows what production holds (old rows stay readable) but no new tenant is offered one. What a
 * tenant signs now is a census-banded plan: one DEMO version is seeded and published below, with the owner's default bands
 * (0-9, 10-16, 17-25, 26+ patients) and DEMO prices that are not the price list; real plans are made in the pricing plan editor.
 *
 * Idempotent: flat plans upsert on `slug`, meters on `(plan_id, event_type)`; the published demo plan is frozen by the database, so a
 * re-run leaves it exactly as it is. Prereq: DB migrated. Run: bun run db:seed:plans
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

interface MeterSeed {
  readonly eventType: string;
  readonly inclusiveQuantity: number;
  readonly overageUnitPriceCents: number;
  readonly billingAggregation: "sum" | "last" | "count";
}

interface PlanSeed {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tier: "starter" | "professional" | "enterprise";
  readonly basePriceCents: number;
  readonly meters: readonly MeterSeed[];
}

const meter = (
  eventType: string,
  inclusiveQuantity: number,
  overageUnitPriceCents: number,
  billingAggregation: MeterSeed["billingAggregation"],
): MeterSeed => ({ eventType, inclusiveQuantity, overageUnitPriceCents, billingAggregation });

export const PLANS: readonly PlanSeed[] = [
  {
    slug: "starter-monthly",
    name: "Starter",
    description: "Small hospices getting started: core charting and billing.",
    tier: "starter",
    basePriceCents: 49_900,
    meters: [meter("active_patient", 50, 1_000, "last"), meter("active_user", 10, 2_500, "last")],
  },
  {
    slug: "professional-monthly",
    name: "Professional",
    description: "Growing hospices: higher volumes plus claims and interoperability allowances.",
    tier: "professional",
    basePriceCents: 149_900,
    meters: [
      meter("active_patient", 250, 800, "last"),
      meter("active_user", 50, 2_000, "last"),
      meter("claim_submitted_medicare", 500, 150, "count"),
      meter("fhir_egress_request", 50_000, 1, "count"),
    ],
  },
  {
    slug: "enterprise-monthly",
    name: "Enterprise",
    description: "Multi-site organizations: large allowances including AI and HL7 messaging.",
    tier: "enterprise",
    basePriceCents: 499_900,
    meters: [
      meter("active_patient", 1_000, 600, "last"),
      meter("active_user", 250, 1_500, "last"),
      meter("claim_submitted_medicare", 2_500, 100, "count"),
      meter("claim_submitted_medicaid", 1_000, 100, "count"),
      meter("ai_tokens_consumed", 5_000_000, 1, "sum"),
      meter("fhir_egress_request", 500_000, 1, "count"),
      meter("hl7_message_inbound", 100_000, 1, "count"),
      meter("hl7_message_outbound", 100_000, 1, "count"),
    ],
  },
];

/** The demo census-banded plan: DEMO prices, the owner's default band thresholds. Created as a draft, banded, then published. */
const DEMO_FAMILY = "demo-census-banded";
const DEMO_BANDS: readonly { readonly minAdc: number; readonly monthlyFeeCents: number }[] = [
  { minAdc: 0, monthlyFeeCents: 150_000 },
  { minAdc: 10, monthlyFeeCents: 275_000 },
  { minAdc: 17, monthlyFeeCents: 400_000 },
  { minAdc: 26, monthlyFeeCents: 550_000 },
];

async function seedDemoCensusBandedPlan(db: Client): Promise<string> {
  const slug = `${DEMO_FAMILY}-v1`;
  const existing = await db.query<{ published_at: Date | null }>(
    "SELECT published_at FROM plan WHERE slug = $1",
    [slug],
  );
  if (existing.rows[0])
    return existing.rows[0].published_at ? "already published, left as is" : "left as a draft";
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO plan (slug, family_slug, version, name, description, tier, cadence, base_price_cents, is_active, trial_period_days,
                       per_user_price_cents, billing_software_bps, managed_billing_bps, contract_term_months,
                       implementation_fee_cents, minimum_monthly_cents)
     VALUES ($1, $2, 1, 'Demo census-banded', 'DEMO prices for local development. Not the price list.', 'census_banded', 'monthly',
             $3, false, 0, 9900, 100, 400, 12, 250000, NULL)
     RETURNING id`,
    [slug, DEMO_FAMILY, DEMO_BANDS[0]?.monthlyFeeCents],
  );
  const planId = rows[0]?.id;
  if (!planId) throw new Error("demo plan insert returned no id");
  for (const band of DEMO_BANDS) {
    await db.query(
      "INSERT INTO plan_census_band (plan_id, min_adc, monthly_fee_cents) VALUES ($1, $2, $3)",
      [planId, band.minAdc, band.monthlyFeeCents],
    );
  }
  await db.query("UPDATE plan SET published_at = now(), is_active = true WHERE id = $1", [planId]);
  return "published";
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is not set");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    let meters = 0;
    for (const p of PLANS) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO plan (slug, name, description, tier, cadence, base_price_cents, is_active)
         VALUES ($1, $2, $3, $4, 'monthly', $5, false)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
           tier = EXCLUDED.tier, base_price_cents = EXCLUDED.base_price_cents, is_active = false,
           deprecated_at = COALESCE(plan.deprecated_at, now()), updated_at = now()
         RETURNING id`,
        [p.slug, p.name, p.description, p.tier, p.basePriceCents],
      );
      const planId = rows[0]?.id;
      if (!planId) throw new Error(`plan upsert returned no id for ${p.slug}`);
      for (const m of p.meters) {
        await db.query(
          `INSERT INTO plan_meter (plan_id, event_type, inclusive_quantity, overage_unit_price_cents, billing_aggregation)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (plan_id, event_type) DO UPDATE SET inclusive_quantity = EXCLUDED.inclusive_quantity,
             overage_unit_price_cents = EXCLUDED.overage_unit_price_cents,
             billing_aggregation = EXCLUDED.billing_aggregation, updated_at = now()`,
          [planId, m.eventType, m.inclusiveQuantity, m.overageUnitPriceCents, m.billingAggregation],
        );
        meters++;
      }
    }
    const demo = await seedDemoCensusBandedPlan(db);
    await db.query("COMMIT");
    console.log(
      `✓ plan seed: ${PLANS.length} retired flat plans, ${meters} meters upserted; demo census-banded plan ${demo}.`,
    );
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    await db.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
