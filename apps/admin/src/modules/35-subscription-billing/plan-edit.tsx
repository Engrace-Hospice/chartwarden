import { Button, StatusPill, TextField, useApiClient, useRequestGuard } from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Plan editor (`/admin/plans/:id/edit`, plan.admin.write).
// Hydrates from GET /api/admin/plans/:id (M35A-T03 detail GET), then manages the plan's usage meters
// (POST/PATCH .../meters) and drives the lifecycle: Activate (which the §4.13 outbox dispatcher syncs to a
// Stripe product/price — the "Sync to Stripe" path, vendor SDK OFF) and Deprecate. Every mutation carries a
// server-enforced step-up + Idempotency-Key; stale step-up surfaces as a first-class outcome. Redesign frame:
// the meters in the main column, the plan summary in the right drawer.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { cap, formatCents, idempotencyKey } from "./status";
import {
  DrawerHead,
  type Outcome,
  OutcomeBanner,
  StateError,
  StateLoading,
  failureOutcome,
  isNotFound,
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
  const [notFound, setNotFound] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [meter, setMeter] = useState({
    eventType: "",
    inclusive: "0",
    overage: "0",
    threshold: "80",
  });

  const guard = useRequestGuard();
  const load = useCallback(async () => {
    const isCurrent = guard();
    if (!id) {
      setError("No plan selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    const res = await client.GET("/api/admin/plans/{id}", { params: { path: { id } } });
    if (!isCurrent()) return;
    if (res.error) {
      // A 404 is final: retrying cannot bring the record back, so no "Try again" (#597, F-044).
      setNotFound(isNotFound(res));
      setError(isNotFound(res) ? "Plan not found." : "Plan unavailable.");
      setLoading(false);
      return;
    }
    setPlan(res.data);
    setLoading(false);
  }, [client, id, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<{ error?: unknown }>, okMsg: string, failMsg: string) => {
      setBusy(true);
      setOutcome(null);
      const res = await fn();
      setOutcome(res.error ? failureOutcome(res.error, failMsg) : { ok: true, message: okMsg });
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
      "Could not add the meter (check the fields).",
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
      "Could not activate this plan.",
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
      "Could not deprecate this plan.",
    );
  }, [client, id, run]);

  const frame = (content: JSX.Element): JSX.Element => (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Edit plan</h1>
            <p>Usage meters, pricing and the plan's lifecycle.</p>
          </div>
        </header>
        {content}
      </div>
    </div>
  );
  if (loading) return frame(<StateLoading label="Loading plan…" />);
  if (error || !plan)
    return frame(
      <StateError
        message={error ?? "Plan not found."}
        onRetry={notFound ? undefined : () => void load()}
      />,
    );

  return (
    <div className="wx-list-drawer has-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>{`Edit — ${plan.name}`}</h1>
            <p>Usage meters, pricing and the plan's lifecycle.</p>
          </div>
          <div className="wx-list-toolbar-end">
            {plan.isActive ? (
              <Button tone="secondary" onClick={deprecate} disabled={busy}>
                Deprecate
              </Button>
            ) : (
              <Button onClick={activate} disabled={busy}>
                Activate & sync to Stripe
              </Button>
            )}
          </div>
        </header>
        {outcome ? <OutcomeBanner {...outcome} /> : null}
        <h2 className="m-0 text-base font-semibold">Usage meters</h2>
        {plan.meters.length === 0 ? (
          <p className="m-0 text-sm">No meters yet — add one below.</p>
        ) : (
          <MetersTable meters={plan.meters} currencyCode={plan.currencyCode} />
        )}
        <div className="grid max-w-3xl items-end gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
          <TextField
            label="Event type"
            value={meter.eventType}
            onChange={(e) => setMeter({ ...meter, eventType: e.target.value })}
          />
          <TextField
            label="Included qty"
            value={meter.inclusive}
            inputMode="numeric"
            onChange={(e) => setMeter({ ...meter, inclusive: e.target.value })}
          />
          <TextField
            label="Overage $/unit"
            value={meter.overage}
            inputMode="decimal"
            onChange={(e) => setMeter({ ...meter, overage: e.target.value })}
          />
          <TextField
            label="Warn %"
            value={meter.threshold}
            inputMode="numeric"
            onChange={(e) => setMeter({ ...meter, threshold: e.target.value })}
          />
          <Button onClick={addMeter} disabled={busy || !meter.eventType.trim()}>
            Add meter
          </Button>
        </div>
      </div>
      <PlanSummary plan={plan} />
    </div>
  );
}

function MetersTable({
  meters,
  currencyCode,
}: { meters: readonly Meter[]; currencyCode: string }): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Usage meters</caption>
        <thead>
          <tr>
            <th scope="col">Meter</th>
            <th scope="col" className="wx-num-col">
              Included
            </th>
            <th scope="col" className="wx-num-col">
              Overage / unit
            </th>
          </tr>
        </thead>
        <tbody>
          {meters.map((m) => (
            <tr key={m.eventType}>
              <td>
                <span className="wx-row-title">{m.label}</span>
                <span className="wx-row-sub wx-data-md">{m.eventType}</span>
              </td>
              <td className="wx-num-col wx-nums">{m.inclusiveQuantity.toLocaleString()}</td>
              <td className="wx-num-col wx-nums">
                {formatCents(m.overageUnitPriceCents, currencyCode)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanSummary({ plan }: { plan: PlanDetail }): JSX.Element {
  return (
    <aside className="wx-admission-drawer" aria-label="Plan summary">
      <DrawerHead icon="layout-grid" title={plan.name} sub={plan.slug} />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Plan</h3>
            <StatusPill
              label={plan.isActive ? "Active" : "Draft"}
              tone={plan.isActive ? "success" : "neutral"}
            />
          </div>
          <dl className="wx-kv">
            <dt>Tier / cadence</dt>
            <dd>
              {cap(plan.tier)} · {cap(plan.cadence)}
            </dd>
            <dt>Base price</dt>
            <dd className="wx-nums">{formatCents(plan.basePriceCents, plan.currencyCode)}</dd>
            <dt>Trial</dt>
            <dd className="wx-nums">{plan.trialPeriodDays} days</dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>Stripe</h3>
          <dl className="wx-kv">
            <dt>Product</dt>
            <dd className="wx-data-md">{plan.stripeProductId ?? "— (pending sync)"}</dd>
            <dt>Price</dt>
            <dd className="wx-data-md">{plan.stripePriceId ?? "— (pending sync)"}</dd>
          </dl>
        </section>
      </div>
    </aside>
  );
}
