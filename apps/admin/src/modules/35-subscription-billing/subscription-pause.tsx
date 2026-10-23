import {
  Button,
  Panel,
  TextAreaField,
  TextField,
  stashStepUpDraft,
  takeStepUpDraft,
  useApiClient,
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

export function SubscriptionPause(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { gate, retry } = useSubscriptionGate(id);
  // A step-up refusal sends the operator to /step-up and back; what they typed is restored.
  const draftKey = `subscription-pause:${id ?? ""}`;
  const [restored] = useState(() => takeStepUpDraft<{ until: string; reason: string }>(draftKey));
  const [until, setUntil] = useState(restored?.until ?? "");
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const submit = useCallback(async () => {
    if (!id) return;
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
    setTimeout(() => navigate(`/admin/subscriptions/${id}`), 800);
  }, [client, id, until, navigate]);

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
          <div className="max-w-xl">
            <Panel title="Pause" icon="clock">
              <div className="grid gap-4">
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
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="Why is this subscription being paused?"
                />
                {outcome ? (
                  <OutcomeBanner
                    {...outcome}
                    onReverify={() => stashStepUpDraft(draftKey, { until, reason })}
                  />
                ) : null}
                <div className="wx-action-row is-end">
                  <Button tone="tertiary" onClick={() => navigate(`/admin/subscriptions/${id}`)}>
                    Cancel
                  </Button>
                  <Button loading={busy} onClick={() => void submit()}>
                    Pause subscription
                  </Button>
                </div>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
