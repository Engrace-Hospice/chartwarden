import {
  Button,
  SelectField,
  TextAreaField,
  TextField,
  focusFirstInvalid,
  isValid,
  stashStepUpMemoryDraft,
  useApiClient,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 New refund request (`/admin/refunds/new`,
// refund.request). POST /api/admin/refunds (step-up + Idempotency-Key). The §4.8 four-eyes rule keeps
// the REQUESTER distinct from the approver, so this screen only REQUESTS — approval is a separate surface.
// The reason detail carries a 40-char minimum (mirrors the server contract) enforced before submit.
import { useCallback, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  MIN_REFUND_REASON,
  type RefundForm,
  checkRefundForm,
  refundFormErrors,
} from "./form-rules";
import { idempotencyKey } from "./status";
import {
  type Outcome,
  OutcomeBanner,
  UNREACHABLE_OUTCOME,
  failureOutcome,
  settleWrite,
} from "./ui";
import { useSuccessRedirect } from "./use-success-redirect";

const REASONS = ["duplicate", "fraudulent", "requested_by_customer", "other"] as const;
const KINDS = ["full", "partial", "credit_only"] as const;
const KIND_OPTIONS = KINDS.map((k) => ({ value: k, label: k.replace(/_/g, " ") }));
const REASON_OPTIONS = REASONS.map((r) => ({ value: r, label: r.replace(/_/g, " ") }));

const REFUND_DRAFT_KEY = "refund-new";

export function RefundNew(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  // A step-up refusal sends the operator to /step-up and back; the typed request is restored.
  const restored = useStepUpMemoryDraft<RefundForm>(REFUND_DRAFT_KEY);
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
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const { done, finish } = useSuccessRedirect();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const detailShort = useMemo(() => form.detail.trim().length < MIN_REFUND_REASON, [form.detail]);
  const errors = attempted ? refundFormErrors(form) : {};

  const submit = useCallback(async () => {
    if (busy || done) return;
    const { errors: problems, amountCents } = checkRefundForm(form);
    if (!isValid(problems) || amountCents === null) {
      setAttempted(true);
      focusFirstInvalid(formRef.current);
      return;
    }
    setBusy(true);
    setOutcome(null);
    const res = await settleWrite(
      client.POST("/api/admin/refunds", {
        body: {
          invoiceId: form.invoiceId.trim(),
          amountCents,
          kind: form.kind as "full" | "partial" | "credit_only",
          reasonCode: form.reasonCode as
            | "duplicate"
            | "fraudulent"
            | "requested_by_customer"
            | "other",
          reasonDetail: form.detail.trim(),
        },
        headers: { "Idempotency-Key": idempotencyKey() },
      }),
    );
    if (!res || res.error) {
      setOutcome(
        res
          ? failureOutcome(
              res.error,
              "Could not create the refund request (check the invoice id + fields).",
            )
          : UNREACHABLE_OUTCOME,
      );
      setBusy(false);
      return;
    }
    setBusy(false);
    finish("/admin/refunds", "Refund request created — awaiting a distinct approver (four-eyes).");
  }, [busy, done, client, form, finish]);

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Request a refund</h1>
            <p>A request only — a different operator approves it (four-eyes).</p>
          </div>
        </header>
        <form
          className="wx-drawer-card"
          ref={formRef}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="wx-drawer-card-head">
            <h2>Refund request</h2>
          </div>
          <div className="wx-form-stack">
            <TextField
              id="invoice-id"
              label="Invoice id"
              required
              error={errors.invoiceId}
              value={form.invoiceId}
              onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}
              placeholder="Invoice UUID"
            />
            <div className="wx-form-grid">
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
            <TextAreaField
              id="detail"
              label="Reason detail"
              hint={
                <>
                  Do not include patient information.{" "}
                  {/* Neutral until a submit is attempted: an untouched form isn't an error yet. */}
                  <span className={attempted && detailShort ? "wx-nums wx-text-error" : "wx-nums"}>
                    {form.detail.trim().length}/{MIN_REFUND_REASON} characters
                    {attempted && detailShort ? ` — too short, ${MIN_REFUND_REASON} needed` : ""}
                  </span>
                </>
              }
              required
              error={errors.detail}
              value={form.detail}
              onChange={(e) => setForm({ ...form, detail: e.target.value })}
              rows={4}
            />
            {outcome ? (
              <OutcomeBanner
                {...outcome}
                onReverify={() => stashStepUpMemoryDraft(REFUND_DRAFT_KEY, form)}
              />
            ) : null}
          </div>
          <div className="wx-drawer-actions">
            <Button type="submit" loading={busy || done}>
              Submit request
            </Button>
            <Button tone="tertiary" onClick={() => navigate("/admin/refunds")}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
