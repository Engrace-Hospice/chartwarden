import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Promos (`/admin/promos`, promo.admin.read/write).
// Cross-tenant promo catalog over GET /api/admin/promos with redemption counts; create via POST
// /api/admin/promos and deactivate via POST /api/admin/promos/:id/deactivate (promo.admin.write — step-up +
// Idempotency-Key). Percent/amount-off + duration are shown per §5.2. Lantern: list + inline create.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { cap, formatCents, idempotencyKey } from "./status";
import {
  Field,
  type Outcome,
  OutcomeBanner,
  actionButtonStyle,
  bodyRow,
  cell,
  cellRight,
  failureOutcome,
  inputStyle,
  tableStyle,
  theadRow,
} from "./ui";

type Promo =
  operations["getApiAdminPromos"]["responses"][200]["content"]["application/json"][number];

export function Promos(): JSX.Element {
  const client = useApiClient();
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    code: "",
    coupon: "",
    promotion: "",
    kind: "percent_off",
    percent: "",
    amount: "",
    duration: "once",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/admin/promos");
    if (res.error) {
      setError("Promos unavailable.");
      setLoading(false);
      return;
    }
    setPromos(res.data);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    setBusy(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/promos", {
      body: {
        code: form.code.trim(),
        stripeCouponId: form.coupon.trim() || form.code.trim(),
        stripePromotionCodeId: form.promotion.trim() || form.code.trim(),
        kind: form.kind as "percent_off" | "amount_off",
        percentOff: form.kind === "percent_off" ? Number(form.percent) || undefined : undefined,
        fixedOffCents:
          form.kind === "amount_off"
            ? Math.round(Number(form.amount) * 100) || undefined
            : undefined,
        duration: form.duration as "once" | "repeating" | "forever",
      },
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (res.error)
      setOutcome(failureOutcome(res.error, "Could not create the promo (check the fields)."));
    else {
      setOutcome({ ok: true, message: `Promo "${form.code}" created.` });
      setShowCreate(false);
      setForm({
        code: "",
        coupon: "",
        promotion: "",
        kind: "percent_off",
        percent: "",
        amount: "",
        duration: "once",
      });
      await load();
    }
    setBusy(false);
  }, [client, form, load]);

  const deactivate = useCallback(
    async (id: string, code: string) => {
      setBusy(true);
      setOutcome(null);
      const res = await client.POST("/api/admin/promos/{id}/deactivate", {
        params: { path: { id } },
        headers: { "Idempotency-Key": idempotencyKey() },
      });
      setOutcome(
        res.error
          ? failureOutcome(res.error, "Could not deactivate this promo.")
          : { ok: true, message: `Promo "${code}" deactivated.` },
      );
      if (!res.error) await load();
      setBusy(false);
    },
    [client, load],
  );

  if (loading) return <LoadingSpinner />;

  const discount = (p: Promo): string =>
    p.percentOff != null
      ? `${p.percentOff}%`
      : p.fixedOffCents != null
        ? formatCents(p.fixedOffCents)
        : "—";

  return (
    <div
      style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <PageHeader
        title="Promo codes"
        breadcrumb="Platform Ops"
        actions={
          <button
            type="button"
            onClick={() => setShowCreate((s) => !s)}
            style={actionButtonStyle(true)}
          >
            {showCreate ? "Cancel" : "New promo"}
          </button>
        }
      />
      {outcome ? <OutcomeBanner {...outcome} /> : null}
      {showCreate ? (
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
            gap: "0.75rem",
            maxWidth: "52rem",
            alignItems: "end",
          }}
        >
          <Field label="Code">
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Kind">
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              style={inputStyle}
            >
              <option value="percent_off">Percent off</option>
              <option value="amount_off">Amount off</option>
            </select>
          </Field>
          {form.kind === "percent_off" ? (
            <Field label="Percent">
              <input
                value={form.percent}
                inputMode="numeric"
                onChange={(e) => setForm({ ...form, percent: e.target.value })}
                style={inputStyle}
              />
            </Field>
          ) : (
            <Field label="Amount (USD)">
              <input
                value={form.amount}
                inputMode="decimal"
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                style={inputStyle}
              />
            </Field>
          )}
          <Field label="Duration">
            <select
              value={form.duration}
              onChange={(e) => setForm({ ...form, duration: e.target.value })}
              style={inputStyle}
            >
              <option value="once">Once</option>
              <option value="repeating">Repeating</option>
              <option value="forever">Forever</option>
            </select>
          </Field>
          <Field label="Stripe coupon id">
            <input
              value={form.coupon}
              onChange={(e) => setForm({ ...form, coupon: e.target.value })}
              style={inputStyle}
              placeholder="defaults to code"
            />
          </Field>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !form.code.trim()}
            style={actionButtonStyle(true, busy || !form.code.trim())}
          >
            Create promo
          </button>
        </section>
      ) : null}
      {error || promos.length === 0 ? (
        <EmptyState
          title={error ?? "No promos"}
          description={error ? "Retry shortly." : "Create the first promo code."}
        />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={theadRow}>
              <th style={cell}>Code</th>
              <th style={cell}>Discount</th>
              <th style={cell}>Duration</th>
              <th style={cellRight}>Redemptions</th>
              <th style={cell}>Status</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {promos.map((p) => (
              <tr key={p.id} style={bodyRow}>
                <td style={cell}>
                  <span style={{ fontWeight: 600 }}>{p.code}</span>
                </td>
                <td style={cell} className="tabular-nums">
                  {discount(p)}
                </td>
                <td style={cell}>
                  {cap(p.duration)}
                  {p.durationInMonths ? ` (${p.durationInMonths}m)` : ""}
                </td>
                <td style={cellRight} className="tabular-nums">
                  {p.redemptionCount.toLocaleString()}
                  {p.maxRedemptions ? ` / ${p.maxRedemptions}` : ""}
                </td>
                <td style={cell}>
                  <StatusPill
                    label={p.isActive ? "Active" : "Inactive"}
                    tone={p.isActive ? "success" : "neutral"}
                  />
                </td>
                <td style={cell}>
                  {p.isActive ? (
                    <button
                      type="button"
                      onClick={() => void deactivate(p.id, p.code)}
                      disabled={busy}
                      style={actionButtonStyle(false, busy)}
                    >
                      Deactivate
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
