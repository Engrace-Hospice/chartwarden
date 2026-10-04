import {
  Button,
  EmptyState,
  Glyph,
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
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
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
      header={
        <PageHeader
          title="Plans"
          breadcrumb="Billing / Change plan"
          actions={
            <Link to="/subscription" style={headerActionStyle}>
              Back to billing
            </Link>
          }
        >
          <div style={headerDescriptionStyle}>
            Compare available plans and review included usage before changing subscription tier.
          </div>
        </PageHeader>
      }
      filters={
        <div style={toolbarStyle}>
          <div style={toolbarCopyStyle}>
            <Glyph name="sparkle" size={16} />
            <span>Plan changes are submitted through the guarded subscription update flow.</span>
          </div>
          {currentSlug ? (
            <div style={currentPlanChipStyle}>
              <span style={chipLabelStyle}>Current</span>
              <code className="wx-data-md" style={currentSlugStyle}>
                {currentSlug}
              </code>
            </div>
          ) : null}
        </div>
      }
      table={
        plans.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="No plans" description="No plans are available for your account." />
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(21rem, 1fr))",
              gap: "1.25rem",
              padding: "0 1.5rem 1.5rem",
              alignItems: "stretch",
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
  const cadenceLabel = plan.cadence === "annual" ? "year" : "month";

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-soft)",
        padding: "1.25rem",
        outline: isCurrent
          ? "2px solid color-mix(in srgb, var(--color-primary) 75%, transparent)"
          : "1px solid color-mix(in srgb, var(--color-outline-variant) 20%, transparent)",
        outlineOffset: isCurrent ? "-2px" : "-1px",
        minWidth: 0,
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
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", minWidth: 0 }}>
          <span style={planNameStyle}>{plan.name}</span>
          <span style={planMetaStyle}>{cap(plan.tier)} tier</span>
        </div>
        {isCurrent ? (
          <StatusPill label="Current" tone="success" />
        ) : (
          <StatusPill label={cap(plan.cadence)} tone="neutral" />
        )}
      </div>

      <div style={priceBlockStyle}>
        <span className="tabular-nums" style={priceStyle}>
          {formatCents(plan.basePriceCents, plan.currencyCode)}
        </span>
        <span style={priceCadenceStyle}>/ {cadenceLabel}</span>
      </div>

      {plan.description ? <p style={descriptionStyle}>{plan.description}</p> : null}

      <div style={planFactsStyle}>
        <PlanFact label="Billing cadence" value={cap(plan.cadence)} />
        <PlanFact
          label="Trial"
          value={plan.trialPeriodDays > 0 ? `${plan.trialPeriodDays} days` : "None"}
        />
      </div>

      {plan.meters.length > 0 ? (
        <div style={meterBlockStyle}>
          <span style={sectionEyebrowStyle}>Included + overage</span>
          <div style={{ width: "100%", overflowX: "auto" }}>
            <table style={meterTableStyle}>
              <thead>
                <tr style={tableHeadRowStyle}>
                  <th style={{ ...thStyle, width: "44%" }}>Meter</th>
                  <th style={{ ...thStyle, width: "28%", textAlign: "right" }}>Included</th>
                  <th style={{ ...thStyle, width: "28%", textAlign: "right" }}>Overage</th>
                </tr>
              </thead>
              <tbody>
                {plan.meters.map((m) => (
                  <tr
                    key={m.eventType}
                    style={{
                      borderBottom:
                        "1px solid color-mix(in srgb, var(--color-outline-variant) 25%, transparent)",
                    }}
                  >
                    <td style={tdStyle}>
                      <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                        {m.label}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <span className="tabular-nums">{m.inclusiveQuantity.toLocaleString()}</span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <span className="tabular-nums">
                        {formatCents(m.overageUnitPriceCents, plan.currencyCode)}/ea
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <Button
        type="button"
        tone={isCurrent ? "secondary" : "primary"}
        disabled={isCurrent}
        style={{ marginTop: "auto", width: "100%", borderRadius: "var(--radius-md)" }}
      >
        {isCurrent ? "Current plan" : "Change plan"}
      </Button>
    </section>
  );
}

function PlanFact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={planFactStyle}>
      <span style={factLabelStyle}>{label}</span>
      <span className="tabular-nums" style={factValueStyle}>
        {value}
      </span>
    </div>
  );
}

const headerDescriptionStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};

const headerActionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "2.5rem",
  padding: "0.5rem 1rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  textDecoration: "none",
  fontSize: "0.8125rem",
  fontWeight: 650,
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0 1.5rem 1rem",
  flexWrap: "wrap",
};

const toolbarCopyStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};

const currentPlanChipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.35rem 0.625rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
};

const chipLabelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  fontWeight: 600,
};

const currentSlugStyle: CSSProperties = {
  color: "var(--color-primary)",
  fontSize: "0.75rem",
};

const planNameStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-display)",
  fontSize: "1.15rem",
  fontWeight: 650,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const planMetaStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.78rem",
};

const priceBlockStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "0.35rem",
};

const priceStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "1.7rem",
  fontWeight: 750,
};

const priceCadenceStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};

const descriptionStyle: CSSProperties = {
  margin: 0,
  minHeight: "2.5rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
  lineHeight: 1.45,
};

const planFactsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "0.75rem",
};

const planFactStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};

const factLabelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.74rem",
};

const factValueStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
  fontWeight: 650,
};

const meterBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  marginTop: "0.15rem",
};

const sectionEyebrowStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
  fontWeight: 600,
};

const meterTableStyle: CSSProperties = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.8rem",
};

const tableHeadRowStyle: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
  background: "var(--color-surface-low)",
};

const thStyle: CSSProperties = {
  padding: "0.5rem 0.625rem",
  fontWeight: 600,
  fontSize: "0.68rem",
};

const tdStyle: CSSProperties = {
  padding: "0.6rem 0.625rem",
  color: "var(--color-on-surface-variant)",
  verticalAlign: "middle",
};
