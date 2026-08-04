import { CenteredCardLayout, PageHeader, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 New refund request (`/admin/refunds/new`,
// refund.request). POST /api/admin/refunds (step-up + Idempotency-Key). The §4.8 four-eyes rule keeps
// the REQUESTER distinct from the approver, so this screen only REQUESTS — approval is a separate surface.
// The reason detail carries a 40-char minimum (mirrors the server contract) enforced before submit.
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { idempotencyKey } from "./status";
import { Field, OutcomeBanner, actionButtonStyle, inputStyle } from "./ui";

const REASONS = ["duplicate", "fraudulent", "requested_by_customer", "other"] as const;
const KINDS = ["full", "partial", "credit_only"] as const;
const MIN_REASON = 40;

export function RefundNew(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    invoiceId: "",
    amount: "",
    kind: "partial",
    reasonCode: "requested_by_customer",
    detail: "",
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  const detailShort = useMemo(() => form.detail.trim().length < MIN_REASON, [form.detail]);
  const canSubmit = !detailShort && form.invoiceId.trim().length > 0 && Number(form.amount) > 0;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/refunds", {
      body: {
        invoiceId: form.invoiceId.trim(),
        amountCents: Math.round(Number(form.amount) * 100),
        kind: form.kind as "full" | "partial" | "credit_only",
        reasonCode: form.reasonCode as
          | "duplicate"
          | "fraudulent"
          | "requested_by_customer"
          | "other",
        reasonDetail: form.detail.trim(),
      },
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (res.error) {
      const c = (res.error as { code?: string })?.code;
      setOutcome({
        ok: false,
        message:
          c === "STEP_UP_REQUIRED"
            ? "Step-up re-authentication required — re-verify and retry."
            : "Could not create the refund request (check the invoice id + fields).",
      });
      setBusy(false);
      return;
    }
    setOutcome({
      ok: true,
      message: "Refund request created — awaiting a distinct approver (four-eyes).",
    });
    setBusy(false);
    setTimeout(() => navigate("/admin/refunds"), 1000);
  }, [client, form, canSubmit, navigate]);

  return (
    <CenteredCardLayout>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          padding: "1.5rem",
          maxWidth: "34rem",
        }}
      >
        <PageHeader title="Request a refund" breadcrumb="Platform Ops / Refunds" />
        <Field label="Invoice id" htmlFor="invoice-id">
          <input
            id="invoice-id"
            value={form.invoiceId}
            onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}
            placeholder="Invoice UUID"
            style={inputStyle}
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
          <Field label="Amount (USD)" htmlFor="amount">
            <input
              id="amount"
              value={form.amount}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Kind" htmlFor="kind">
            <select
              id="kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              style={inputStyle}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Reason code" htmlFor="reason-code">
          <select
            id="reason-code"
            value={form.reasonCode}
            onChange={(e) => setForm({ ...form, reasonCode: e.target.value })}
            style={inputStyle}
          >
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Reason detail (min ${MIN_REASON} chars)`} htmlFor="detail">
          <textarea
            id="detail"
            value={form.detail}
            onChange={(e) => setForm({ ...form, detail: e.target.value })}
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Field>
        <span
          style={{
            fontSize: "0.75rem",
            color: detailShort ? "var(--color-error)" : "var(--color-on-surface-variant)",
          }}
        >
          {form.detail.trim().length}/{MIN_REASON} characters
        </span>
        {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={() => navigate("/admin/refunds")}
            style={actionButtonStyle(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !canSubmit}
            style={actionButtonStyle(true, busy || !canSubmit)}
          >
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </CenteredCardLayout>
  );
}
