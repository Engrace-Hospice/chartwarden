import { CenteredCardLayout, PageHeader, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Pause subscription (`/admin/subscriptions/:id/pause`,
// subscription.admin.write). A gated action: an optional until-date over POST /api/admin/subscriptions/:id/pause
// (step-up + Idempotency-Key, enforced server-side). A stale step-up surfaces as a first-class error outcome.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { actionButtonStyle, Field, inputStyle, OutcomeBanner } from "./ui";
import { idempotencyKey } from "./status";

export function SubscriptionPause(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

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
      const code = (res.error as { code?: string })?.code;
      setOutcome({ ok: false, message: code === "STEP_UP_REQUIRED" ? "Step-up re-authentication required — re-verify and retry." : "Could not pause the subscription." });
      setBusy(false);
      return;
    }
    setOutcome({ ok: true, message: "Subscription paused." });
    setBusy(false);
    setTimeout(() => navigate(`/admin/subscriptions/${id}`), 800);
  }, [client, id, until, navigate]);

  return (
    <CenteredCardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1.5rem", maxWidth: "30rem" }}>
        <PageHeader title="Pause subscription" breadcrumb="Platform Ops / Subscriptions" />
        <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)", margin: 0 }}>
          Pausing halts billing until resumed (or the until-date). This is a step-up-gated platform action.
        </p>
        <Field label="Paused until (optional)" htmlFor="paused-until">
          <input id="paused-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Reason (for your ops record)" htmlFor="pause-reason">
          <textarea id="pause-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical" }} placeholder="Why is this subscription being paused?" />
        </Field>
        {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="button" onClick={() => navigate(`/admin/subscriptions/${id}`)} style={actionButtonStyle(false)}>Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={busy} style={actionButtonStyle(true, busy)}>{busy ? "Pausing…" : "Pause subscription"}</button>
        </div>
      </div>
    </CenteredCardLayout>
  );
}
