import {
  Button,
  type FieldErrors,
  Panel,
  SelectField,
  TextAreaField,
  TextField,
  focusFirstInvalid,
  isValid,
  stashStepUpDraft,
  useApiClient,
  useStepUpDraft,
} from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 New refund request (`/admin/refunds/new`,
// refund.request). POST /api/admin/refunds (step-up + Idempotency-Key). The §4.8 four-eyes rule keeps
// the REQUESTER distinct from the approver, so this screen only REQUESTS — approval is a separate surface.
// The reason detail carries a 40-char minimum (mirrors the server contract) enforced before submit.
import { useCallback, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { idempotencyKey } from "./status";
import { type Outcome, OutcomeBanner, failureOutcome } from "./ui";

const REASONS = ["duplicate", "fraudulent", "requested_by_customer", "other"] as const;
const KINDS = ["full", "partial", "credit_only"] as const;
const MIN_REASON = 40;
const KIND_OPTIONS = KINDS.map((k) => ({ value: k, label: k.replace(/_/g, " ") }));
const REASON_OPTIONS = REASONS.map((r) => ({ value: r, label: r.replace(/_/g, " ") }));

const REFUND_DRAFT_KEY = "refund-new";
const INVOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RefundForm = {
  invoiceId: string;
  amount: string;
  kind: string;
  reasonCode: string;
  detail: string;
};

/** Per-field messages for the refund request; empty when it can be submitted (#597, F-042). */
export function refundFormErrors(form: RefundForm): FieldErrors<keyof RefundForm> {
  const errors: FieldErrors<keyof RefundForm> = {};
  const invoice = form.invoiceId.trim();
  if (invoice === "") errors.invoiceId = "Enter the invoice id.";
  else if (!INVOICE_UUID.test(invoice)) errors.invoiceId = "The invoice id is a UUID, e.g. 3f2b…";
  const amount = Number(form.amount);
  if (form.amount.trim() === "") errors.amount = "Enter the refund amount in dollars.";
  else if (!Number.isFinite(amount) || amount <= 0)
    errors.amount = "Enter a dollar amount greater than 0, e.g. 25.00.";
  const length = form.detail.trim().length;
  if (length < MIN_REASON)
    errors.detail = `Describe the reason in at least ${MIN_REASON} characters (${length} so far).`;
  return errors;
}

export function RefundNew(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  // A step-up refusal sends the operator to /step-up and back; the typed request is restored.
  const restored = useStepUpDraft<RefundForm>(REFUND_DRAFT_KEY);
  const [form, setForm] = useState<RefundForm>(
    () =>
      restored ?? {
        invoiceId: "",
        amount: "",
        kind: "partial",
        reasonCode: "requested_by_customer",
        detail: "",
      },
  );
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const detailShort = useMemo(() => form.detail.trim().length < MIN_REASON, [form.detail]);
  const errors = attempted ? refundFormErrors(form) : {};

  const submit = useCallback(async () => {
    if (!isValid(refundFormErrors(form))) {
      setAttempted(true);
      focusFirstInvalid(formRef.current);
      return;
    }
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
  }, [client, form, navigate]);

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
            <div className="grid gap-4" ref={formRef}>
              <TextField
                id="invoice-id"
                label="Invoice id"
                required
                error={errors.invoiceId}
                value={form.invoiceId}
                onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}
                placeholder="Invoice UUID"
              />
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  id="amount"
                  label="Amount (USD)"
                  required
                  error={errors.amount}
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
                  label="Reason detail"
                  hint="Do not include patient information."
                  required
                  error={errors.detail}
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
              {outcome ? (
                <OutcomeBanner
                  {...outcome}
                  onReverify={() => stashStepUpDraft(REFUND_DRAFT_KEY, form)}
                />
              ) : null}
              <div className="wx-action-row is-end">
                <Button tone="tertiary" onClick={() => navigate("/admin/refunds")}>
                  Cancel
                </Button>
                <Button loading={busy} onClick={() => void submit()}>
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
