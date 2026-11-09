import {
  Button,
  TextField,
  focusFirstInvalid,
  stashStepUpMemoryDraft,
  useApiClient,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Apply promo to a subscription
// (`/admin/subscriptions/:id/apply_promo`, promo.admin.apply). POST /api/admin/subscriptions/:id/apply_promo
// (step-up + Idempotency-Key + the §4.8 `promo_applicable_to_subscription` ABAC gate, enforced server-side).
// The server's 4xx (inapplicable promo / stale step-up) surfaces as a first-class outcome — no client authz.
import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { idempotencyKey } from "./status";
import { type Outcome, OutcomeBanner, StateError, StateLoading, failureOutcome } from "./ui";
import { useSubscriptionGate } from "./use-subscription-gate";
import { useSuccessRedirect } from "./use-success-redirect";

export function SubscriptionApplyPromo(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { gate, retry } = useSubscriptionGate(id);
  // A step-up refusal sends the operator to /step-up and back; the typed code is restored.
  const draftKey = `subscription-apply-promo:${id ?? ""}`;
  const restored = useStepUpMemoryDraft<string>(draftKey);
  const [code, setCode] = useState(restored ?? "");
  const [busy, setBusy] = useState(false);
  const { done, finish } = useSuccessRedirect();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempted, setAttempted] = useState(false);
  const panelRef = useRef<HTMLFormElement>(null);

  const submit = useCallback(async () => {
    if (busy || done) return;
    const promoCode = code.trim();
    setAttempted(true);
    if (!promoCode) {
      focusFirstInvalid(panelRef.current);
      return;
    }
    if (!id) return;
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
    // Cleared before the redirect so the locked form never flashes "Enter the promo code" under its own success.
    setCode("");
    setAttempted(false);
    setBusy(false);
    finish(`/admin/subscriptions/${id}`, `Promo "${promoCode}" applied.`);
  }, [busy, done, client, id, code, finish]);

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Apply promo code</h1>
            <p>
              Applies an active promo to this subscription. Applicability is verified server-side; a
              step-up is required.
            </p>
          </div>
        </header>
        {gate === "loading" ? (
          <StateLoading label="Loading subscription…" />
        ) : gate === "missing" ? (
          <StateError message="Subscription not found." />
        ) : gate === "error" ? (
          <StateError message="Subscription unavailable." onRetry={retry} />
        ) : (
          <form
            className="wx-drawer-card"
            ref={panelRef}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="wx-drawer-card-head">
              <h2>Promo</h2>
            </div>
            <div className="wx-form-stack">
              <TextField
                id="promo-code"
                label="Promo code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                error={attempted && !code.trim() ? "Enter the promo code to apply." : undefined}
                placeholder="e.g. LAUNCH25"
              />
              {outcome ? (
                <OutcomeBanner
                  {...outcome}
                  onReverify={() => stashStepUpMemoryDraft(draftKey, code)}
                />
              ) : null}
            </div>
            <div className="wx-drawer-actions">
              <Button type="submit" loading={busy || done}>
                Apply promo
              </Button>
              <Button tone="tertiary" onClick={() => navigate(`/admin/subscriptions/${id}`)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
