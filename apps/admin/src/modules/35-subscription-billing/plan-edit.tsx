import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Plan editor (`/admin/plans/:id/edit`, plan.admin.write).
// Hydrates from GET /api/admin/plans/:id (M35A-T03 detail GET), then manages the plan's usage meters
// (POST/PATCH .../meters) and drives the lifecycle: Activate (which the §4.13 outbox dispatcher syncs to a
// Stripe product/price — the "Sync to Stripe" path, vendor SDK OFF) and Deprecate. Every mutation carries a
// server-enforced step-up + Idempotency-Key; stale step-up surfaces as a first-class outcome. Lantern: Detail.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { cap, formatCents, idempotencyKey } from "./status";
import {
  Field,
  Kv,
  OutcomeBanner,
  actionButtonStyle,
  bodyRow,
  cell,
  cellRight,
  inputStyle,
  tableStyle,
  theadRow,
} from "./ui";

type PlanDetail =
  operations["getApiAdminPlansById"]["responses"][200]["content"]["application/json"];
type Meter = PlanDetail["meters"][number];

export function PlanEdit(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [meter, setMeter] = useState({
    eventType: "",
    inclusive: "0",
    overage: "0",
    threshold: "80",
  });

  const load = useCallback(async () => {
    if (!id) {
      setError("No plan selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/admin/plans/{id}", { params: { path: { id } } });
    if (res.error) {
      setError("Plan unavailable.");
      setLoading(false);
      return;
    }
    setPlan(res.data);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<{ error?: unknown }>, okMsg: string, failMsg: string) => {
      setBusy(true);
      setOutcome(null);
      const res = await fn();
      setOutcome(res.error ? { ok: false, message: failMsg } : { ok: true, message: okMsg });
      if (!res.error) await load();
      setBusy(false);
    },
    [load],
  );

  const addMeter = useCallback(() => {
    if (!id || !meter.eventType.trim()) return;
    void run(
      () =>
        client.POST("/api/admin/plans/{id}/meters", {
          params: { path: { id } },
          body: {
            eventType: meter.eventType.trim(),
            label: meter.eventType.trim(),
            inclusiveQuantity: Number(meter.inclusive) || 0,
            overageUnitPriceCents: Math.round(Number(meter.overage) * 100) || 0,
            billingAggregation: "sum",
            warningThresholdPercent: Number(meter.threshold) || 80,
          },
          headers: { "Idempotency-Key": idempotencyKey() },
        }),
      `Meter "${meter.eventType}" added.`,
      "Could not add the meter (check step-up + fields).",
    );
    setMeter({ eventType: "", inclusive: "0", overage: "0", threshold: "80" });
  }, [client, id, meter, run]);

  const activate = useCallback(() => {
    if (!id) return;
    void run(
      () =>
        client.POST("/api/admin/plans/{id}/activate", {
          params: { path: { id } },
          headers: { "Idempotency-Key": idempotencyKey() },
        }),
      "Plan activated — queued for Stripe sync (product/price).",
      "Could not activate (check step-up).",
    );
  }, [client, id, run]);

  const deprecate = useCallback(() => {
    if (!id) return;
    void run(
      () =>
        client.POST("/api/admin/plans/{id}/deprecate", {
          params: { path: { id } },
          headers: { "Idempotency-Key": idempotencyKey() },
        }),
      "Plan deprecated.",
      "Could not deprecate (check step-up).",
    );
  }, [client, id, run]);

  if (loading) return <LoadingSpinner />;
  if (error || !plan)
    return <EmptyState title="Unavailable" description={error ?? "Plan not found."} />;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={`Edit — ${plan.name}`}
          breadcrumb="Platform Ops / Plans"
          actions={
            <div style={{ display: "flex", gap: "0.75rem" }}>
              {plan.isActive ? (
                <button
                  type="button"
                  onClick={deprecate}
                  disabled={busy}
                  style={actionButtonStyle(false, busy)}
                >
                  Deprecate
                </button>
              ) : (
                <button
                  type="button"
                  onClick={activate}
                  disabled={busy}
                  style={actionButtonStyle(true, busy)}
                >
                  Activate & sync to Stripe
                </button>
              )}
            </div>
          }
        />
      }
      aside={
        <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <Kv label="Status">
            <StatusPill
              label={plan.isActive ? "Active" : "Draft"}
              tone={plan.isActive ? "success" : "neutral"}
            />
          </Kv>
          <Kv label="Tier / cadence">
            {cap(plan.tier)} · {cap(plan.cadence)}
          </Kv>
          <Kv label="Base price">
            <span className="tabular-nums">
              {formatCents(plan.basePriceCents, plan.currencyCode)}
            </span>
          </Kv>
          <Kv label="Trial">{plan.trialPeriodDays} days</Kv>
          <Kv label="Stripe product">{plan.stripeProductId ?? "— (pending sync)"}</Kv>
          <Kv label="Stripe price">{plan.stripePriceId ?? "— (pending sync)"}</Kv>
        </div>
      }
    >
      <section style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
        <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>Usage meters</h2>
        {plan.meters.length === 0 ? (
          <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
            No meters yet — add one below.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={cell}>Meter</th>
                <th style={cellRight}>Included</th>
                <th style={cellRight}>Overage / unit</th>
              </tr>
            </thead>
            <tbody>
              {plan.meters.map((m) => (
                <tr key={m.eventType} style={bodyRow}>
                  <td style={cell}>{m.label}</td>
                  <td style={cellRight} className="tabular-nums">
                    {m.inclusiveQuantity.toLocaleString()}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {formatCents(m.overageUnitPriceCents, plan.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
            gap: "0.75rem",
            maxWidth: "44rem",
            alignItems: "end",
          }}
        >
          <Field label="Event type">
            <input
              value={meter.eventType}
              onChange={(e) => setMeter({ ...meter, eventType: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Included qty">
            <input
              value={meter.inclusive}
              inputMode="numeric"
              onChange={(e) => setMeter({ ...meter, inclusive: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Overage $/unit">
            <input
              value={meter.overage}
              inputMode="decimal"
              onChange={(e) => setMeter({ ...meter, overage: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Warn %">
            <input
              value={meter.threshold}
              inputMode="numeric"
              onChange={(e) => setMeter({ ...meter, threshold: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <button
            type="button"
            onClick={addMeter}
            disabled={busy || !meter.eventType.trim()}
            style={actionButtonStyle(true, busy || !meter.eventType.trim())}
          >
            Add meter
          </button>
        </div>
      </section>
    </DetailPageLayout>
  );
}
