import { Button, Panel, SelectField, TextAreaField, TextField, useApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 New refund request (`/admin/refunds/new`,
// refund.request). POST /api/admin/refunds (step-up + Idempotency-Key). The §4.8 four-eyes rule keeps
// the REQUESTER distinct from the approver, so this screen only REQUESTS — approval is a separate surface.
// The reason detail carries a 40-char minimum (mirrors the server contract) enforced before submit.
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { idempotencyKey } from "./status";
import { type Outcome, OutcomeBanner, failureOutcome } from "./ui";

const REASONS = ["duplicate", "fraudulent", "requested_by_customer", "other"] as const;
const KINDS = ["full", "partial", "credit_only"] as const;
const MIN_REASON = 40;
const KIND_OPTIONS = KINDS.map((k) => ({ value: k, label: k.replace(/_/g, " ") }));
const REASON_OPTIONS = REASONS.map((r) => ({ value: r, label: r.replace(/_/g, " ") }));

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
  const [outcome, setOutcome] = useState<Outcome | null>(null);

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
      setOutcome(
        failureOutcome(
          res.error,
          "Could not create the refund request (check the invoice id + fields).",
        ),
      );
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
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Request a refund</h1>
            <p>A request only — a different operator approves it (four-eyes).</p>
          </div>
        </header>
        <div className="max-w-2xl">
          <Panel title="Refund request" icon="rotate-ccw">
            <div className="grid gap-4">
              <TextField
                id="invoice-id"
                label="Invoice id"
                value={form.invoiceId}
                onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}
                placeholder="Invoice UUID"
              />
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  id="amount"
                  label="Amount (USD)"
                  value={form.amount}
                  inputMode="decimal"
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
                <SelectField
                  id="kind"
                  label="Kind"
                  value={form.kind}
                  options={KIND_OPTIONS}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                />
              </div>
              <SelectField
                id="reason-code"
                label="Reason code"
                value={form.reasonCode}
                options={REASON_OPTIONS}
                onChange={(e) => setForm({ ...form, reasonCode: e.target.value })}
              />
              <div className="grid gap-1">
                <TextAreaField
                  id="detail"
                  label={`Reason detail (min ${MIN_REASON} chars)`}
                  value={form.detail}
                  onChange={(e) => setForm({ ...form, detail: e.target.value })}
                  rows={4}
                />
                <span
                  className={`wx-nums text-xs ${
                    detailShort
                      ? "text-[var(--color-error)]"
                      : "text-[var(--color-on-surface-variant)]"
                  }`}
                >
                  {form.detail.trim().length}/{MIN_REASON} characters
                </span>
              </div>
              {outcome ? <OutcomeBanner {...outcome} /> : null}
              <div className="wx-action-row is-end">
                <Button tone="tertiary" onClick={() => navigate("/admin/refunds")}>
                  Cancel
                </Button>
                <Button loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
                  Submit request
                </Button>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
