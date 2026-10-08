import { Button, Panel, TextField, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Apply promo to a subscription
// (`/admin/subscriptions/:id/apply_promo`, promo.admin.apply). POST /api/admin/subscriptions/:id/apply_promo
// (step-up + Idempotency-Key + the §4.8 `promo_applicable_to_subscription` ABAC gate, enforced server-side).
// The server's 4xx (inapplicable promo / stale step-up) surfaces as a first-class outcome — no client authz.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { idempotencyKey } from "./status";
import { type Outcome, OutcomeBanner, failureOutcome } from "./ui";

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
        <div className="max-w-xl">
          <Panel title="Promo" icon="receipt">
            <div className="grid gap-4">
              <TextField
                id="promo-code"
                label="Promo code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. LAUNCH25"
              />
              {outcome ? <OutcomeBanner {...outcome} /> : null}
              <div className="wx-action-row is-end">
                <Button tone="tertiary" onClick={() => navigate(`/admin/subscriptions/${id}`)}>
                  Cancel
                </Button>
                <Button loading={busy} disabled={!code.trim()} onClick={() => void submit()}>
                  Apply promo
                </Button>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
