import {
  Button,
  TextAreaField,
  TextField,
  stashStepUpMemoryDraft,
  useApiClient,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Pause subscription (`/admin/subscriptions/:id/pause`,
// subscription.admin.write). A gated action: an optional until-date over POST /api/admin/subscriptions/:id/pause
// (step-up + Idempotency-Key, enforced server-side). A stale step-up surfaces as a first-class error outcome.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { idempotencyKey } from "./status";
import { type Outcome, OutcomeBanner, StateError, StateLoading, failureOutcome } from "./ui";
import { useSubscriptionGate } from "./use-subscription-gate";
import { SUBSCRIPTION_REDIRECT_DELAY_MS, useSuccessRedirect } from "./use-success-redirect";

export function SubscriptionPause(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { gate, retry } = useSubscriptionGate(id);
  // A step-up refusal sends the operator to /step-up and back; what they typed is restored.
  const draftKey = `subscription-pause:${id ?? ""}`;
  const restored = useStepUpMemoryDraft<{ until: string; reason: string }>(draftKey);
  const [until, setUntil] = useState(restored?.until ?? "");
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const { done, finish } = useSuccessRedirect();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const submit = useCallback(async () => {
    if (!id || busy || done) return;
    setBusy(true);
    setOutcome(null);
    const body = until ? { pausedUntil: new Date(until).toISOString() } : {};
    const res = await client.POST("/api/admin/subscriptions/{id}/pause", {
      params: { path: { id } },
      body,
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (res.error) {
      setOutcome(failureOutcome(res.error, "Could not pause the subscription."));
      setBusy(false);
      return;
    }
    setOutcome({ ok: true, message: "Subscription paused." });
    setBusy(false);
    finish(`/admin/subscriptions/${id}`, SUBSCRIPTION_REDIRECT_DELAY_MS);
  }, [busy, done, client, id, until, finish]);

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Pause subscription</h1>
            <p>
              Pausing halts billing until resumed (or the until-date). This is a step-up-gated
              platform action.
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
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="wx-drawer-card-head">
              <h2>Pause</h2>
            </div>
            <div className="wx-form-stack">
              <TextField
                id="paused-until"
                label="Paused until (optional)"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
              <TextAreaField
                id="pause-reason"
                label="Reason (for your ops record)"
                hint="Do not include patient information."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why is this subscription being paused?"
              />
              {outcome ? (
                <OutcomeBanner
                  {...outcome}
                  onReverify={() => stashStepUpMemoryDraft(draftKey, { until, reason })}
                />
              ) : null}
            </div>
            <div className="wx-drawer-actions">
              <Button type="submit" loading={busy || done}>
                Pause subscription
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
