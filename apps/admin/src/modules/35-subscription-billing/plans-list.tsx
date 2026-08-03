import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Plans list + create (`/admin/plans`, plan.admin.read).
// Cross-tenant plan catalog over GET /api/admin/plans; a draft plan is created via POST /api/admin/plans
// (plan.admin.write — step-up + Idempotency-Key, enforced server-side). Each row links to the meter/pricing
// editor. Amounts are integer cents formatted once. Lantern: work-queue-ish list + inline create.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { actionButtonStyle, bodyRow, cell, cellRight, Field, inputStyle, OutcomeBanner, tableStyle, theadRow } from "./ui";
import { cap, formatCents, idempotencyKey } from "./status";

type PlanRow =
  operations["getApiAdminPlans"]["responses"][200]["content"]["application/json"][number];

export function PlansList(): JSX.Element {
  const client = useApiClient();
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [form, setForm] = useState({ slug: "", name: "", tier: "starter", cadence: "monthly", basePrice: "", trialDays: "0" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/admin/plans");
    if (res.error) {
      setError("Plans unavailable.");
      setLoading(false);
      return;
    }
    setPlans(res.data);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    setSaving(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/plans", {
      body: {
        slug: form.slug.trim(),
        name: form.name.trim(),
        tier: form.tier as "starter" | "professional" | "enterprise",
        cadence: form.cadence as "monthly" | "annual",
        basePriceCents: Math.round(Number(form.basePrice) * 100) || 0,
        currencyCode: "USD",
        trialPeriodDays: Number(form.trialDays) || 0,
      },
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (res.error) {
      setOutcome({ ok: false, message: "Could not create the plan (check step-up + fields)." });
    } else {
      setOutcome({ ok: true, message: `Draft plan "${form.name}" created.` });
      setShowCreate(false);
      setForm({ slug: "", name: "", tier: "starter", cadence: "monthly", basePrice: "", trialDays: "0" });
      await load();
    }
    setSaving(false);
  }, [client, form, load]);

  if (loading) return <LoadingSpinner />;

  return (
    <div style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <PageHeader
        title="Plans"
        breadcrumb="Platform Ops"
        actions={
          <button type="button" onClick={() => setShowCreate((s) => !s)} style={actionButtonStyle(true)}>
            {showCreate ? "Cancel" : "New plan"}
          </button>
        }
      />
      {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
      {showCreate ? (
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "0.75rem", maxWidth: "48rem" }}>
          <Field label="Slug"><input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} style={inputStyle} /></Field>
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} /></Field>
          <Field label="Tier">
            <select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })} style={inputStyle}>
              <option value="starter">Starter</option>
              <option value="professional">Professional</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </Field>
          <Field label="Cadence">
            <select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })} style={inputStyle}>
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
          </Field>
          <Field label="Base price (USD)"><input value={form.basePrice} inputMode="decimal" onChange={(e) => setForm({ ...form, basePrice: e.target.value })} style={inputStyle} /></Field>
          <Field label="Trial days"><input value={form.trialDays} inputMode="numeric" onChange={(e) => setForm({ ...form, trialDays: e.target.value })} style={inputStyle} /></Field>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button type="button" onClick={() => void create()} disabled={saving || !form.slug || !form.name} style={actionButtonStyle(true, saving || !form.slug || !form.name)}>
              {saving ? "Creating…" : "Create draft"}
            </button>
          </div>
        </section>
      ) : null}
      {error || plans.length === 0 ? (
        <EmptyState title={error ?? "No plans"} description={error ? "Retry shortly." : "Create the first plan to begin."} />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={theadRow}>
              <th style={cell}>Plan</th>
              <th style={cell}>Tier</th>
              <th style={cell}>Cadence</th>
              <th style={cellRight}>Base price</th>
              <th style={cellRight}>Trial</th>
              <th style={cell}>Status</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} style={bodyRow}>
                <td style={cell}>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>{p.slug}</div>
                </td>
                <td style={cell}>{cap(p.tier)}</td>
                <td style={cell}>{cap(p.cadence)}</td>
                <td style={cellRight} className="tabular-nums">{formatCents(p.basePriceCents, p.currencyCode)}</td>
                <td style={cellRight} className="tabular-nums">{p.trialPeriodDays}d</td>
                <td style={cell}>
                  <StatusPill label={p.isActive ? "Active" : "Draft"} tone={p.isActive ? "success" : "neutral"} />
                </td>
                <td style={cell}>
                  <Link to={`/admin/plans/${p.id}/edit`} style={actionButtonStyle(false)}>Edit</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
