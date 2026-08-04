import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/35-subscription — M35 plan picker (§5.1 `/billing/plan`).
// The plan comparison grid over GET /api/v1/plans (the public catalog: tier, cadence, base price, and
// per-meter included quantities + overage rates) with the org's current plan highlighted (from
// GET /api/v1/subscription). "Change plan" is a forward CTA — the mutating POST is a step-up action the
// server gates (subscription.update); this surface presents the choice. Lantern: No-Line cards,
// tabular-nums, CSS-var tokens.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { cap, formatCents } from "./billing-status";

interface Meter {
  eventType: string;
  label: string;
  inclusiveQuantity: number;
  overageUnitPriceCents: number;
  billingAggregation: string;
}
interface Plan {
  slug: string;
  name: string;
  description: string | null;
  tier: string;
  cadence: string;
  basePriceCents: number;
  currencyCode: string;
  trialPeriodDays: number;
  meters: Meter[];
}

export function BillingPlan(): JSX.Element {
  const client = useApiClient();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [currentSlug, setCurrentSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [plansRes, subRes] = await Promise.all([
      client.GET("/api/v1/plans"),
      client.GET("/api/v1/subscription"),
    ]);
    if (plansRes.error) {
      setError("Plan catalog unavailable.");
      setLoading(false);
      return;
    }
    setPlans((plansRes.data as unknown as Plan[]) ?? []);
    setCurrentSlug(
      subRes.error ? null : ((subRes.data as unknown as { planSlug: string }).planSlug ?? null),
    );
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Plans" breadcrumb="Billing / Change plan" />}
      table={
        plans.length === 0 ? (
          <EmptyState title="No plans" description="No plans are available for your account." />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))",
              gap: "1.25rem",
              padding: "0 1.5rem 1.5rem",
            }}
          >
            {plans.map((p) => (
              <PlanCard key={p.slug} plan={p} isCurrent={p.slug === currentSlug} />
            ))}
          </div>
        )
      }
    />
  );
}

function PlanCard({ plan, isCurrent }: { plan: Plan; isCurrent: boolean }): JSX.Element {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-xl, 1rem)",
        boxShadow: "var(--shadow-soft)",
        padding: "1.25rem",
        outline: isCurrent ? "2px solid var(--color-primary)" : "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <span style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", fontWeight: 600 }}>
          {plan.name}
        </span>
        {isCurrent ? (
          <StatusPill label="Current" tone="success" />
        ) : (
          <StatusPill label={cap(plan.tier)} tone="neutral" />
        )}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.35rem" }}>
        <span className="tabular-nums" style={{ fontSize: "1.6rem", fontWeight: 700 }}>
          {formatCents(plan.basePriceCents, plan.currencyCode)}
        </span>
        <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
          / {plan.cadence === "annual" ? "year" : "month"}
        </span>
      </div>
      {plan.description ? (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
          {plan.description}
        </p>
      ) : null}
      {plan.trialPeriodDays > 0 ? (
        <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
          {plan.trialPeriodDays}-day trial
        </span>
      ) : null}

      {plan.meters.length > 0 ? (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.25rem" }}
        >
          <span
            style={{
              fontSize: "0.65rem",
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--color-on-surface-variant)",
            }}
          >
            Included + overage
          </span>
          {plan.meters.map((m) => (
            <div
              key={m.eventType}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "0.8rem",
                gap: "0.5rem",
              }}
            >
              <span>{m.label}</span>
              <span className="tabular-nums" style={{ color: "var(--color-on-surface-variant)" }}>
                {m.inclusiveQuantity.toLocaleString()} incl ·{" "}
                {formatCents(m.overageUnitPriceCents, plan.currencyCode)}/ea
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        disabled={isCurrent}
        style={{
          marginTop: "auto",
          padding: "0.55rem 1rem",
          borderRadius: "var(--radius-md, 0.5rem)",
          border: "none",
          background: isCurrent ? "var(--color-surface-container)" : "var(--color-primary)",
          color: isCurrent ? "var(--color-on-surface-variant)" : "var(--color-on-primary)",
          fontSize: "0.875rem",
          fontWeight: 600,
          cursor: isCurrent ? "default" : "pointer",
        }}
      >
        {isCurrent ? "Current plan" : "Change plan"}
      </button>
    </section>
  );
}
