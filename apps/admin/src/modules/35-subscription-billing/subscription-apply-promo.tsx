import { CenteredCardLayout, PageHeader, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Apply promo to a subscription
// (`/admin/subscriptions/:id/apply_promo`, promo.admin.apply). POST /api/admin/subscriptions/:id/apply_promo
// (step-up + Idempotency-Key + the §4.8 `promo_applicable_to_subscription` ABAC gate, enforced server-side).
// The server's 4xx (inapplicable promo / stale step-up) surfaces as a first-class outcome — no client authz.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { idempotencyKey } from "./status";
import {
  Field,
  type Outcome,
  OutcomeBanner,
  actionButtonStyle,
  failureOutcome,
  inputStyle,
} from "./ui";

export function SubscriptionApplyPromo(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const submit = useCallback(async () => {
    const promoCode = code.trim();
    if (!id || !promoCode) return;
    setBusy(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/subscriptions/{id}/apply_promo", {
      params: { path: { id } },
      body: { promoCode },
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (res.error) {
      setOutcome(
        failureOutcome(res.error, "That promo could not be applied to this subscription."),
      );
      setBusy(false);
      return;
    }
    setOutcome({ ok: true, message: `Promo "${promoCode}" applied.` });
    setCode("");
    setBusy(false);
    setTimeout(() => navigate(`/admin/subscriptions/${id}`), 800);
  }, [client, id, code, navigate]);

  return (
    <CenteredCardLayout>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          padding: "1.5rem",
          maxWidth: "30rem",
        }}
      >
        <PageHeader title="Apply promo code" breadcrumb="Platform Ops / Subscriptions" />
        <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)", margin: 0 }}>
          Applies an active promo to this subscription. Applicability is verified server-side; a
          step-up is required.
        </p>
        <Field label="Promo code" htmlFor="promo-code">
          <input
            id="promo-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. LAUNCH25"
            style={inputStyle}
          />
        </Field>
        {outcome ? <OutcomeBanner {...outcome} /> : null}
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={() => navigate(`/admin/subscriptions/${id}`)}
            style={actionButtonStyle(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !code.trim()}
            style={actionButtonStyle(true, busy || !code.trim())}
          >
            {busy ? "Applying…" : "Apply promo"}
          </button>
        </div>
      </div>
    </CenteredCardLayout>
  );
}
