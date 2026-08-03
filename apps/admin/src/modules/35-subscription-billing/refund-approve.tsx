import { DetailPageLayout, EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Refund approval (`/admin/refunds/:id/approve`,
// refund.approve). THE sensitive path: approval carries a step-up AND the §4.8 four-eyes rule (the approver
// MUST differ from the requester). The server enforces both; this screen surfaces each denial as a
// first-class outcome — REFUND_FOUR_EYES (403 approver == requester) and a stale step-up are distinct, named
// messages, not a generic error. Hydrates the refund from GET /api/admin/refunds/:id (M35A-T03 detail GET).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { actionButtonStyle, Field, inputStyle, Kv, OutcomeBanner } from "./ui";
import { cap, formatCents, formatDate, orgLabel, refundTone } from "./status";

interface Refund {
  id: string;
  organizationId: string;
  organizationName: string;
  invoiceId: string;
  amountCents: number;
  kind: string;
  reasonCode: string;
  status: string;
  requestedByMembershipId: string;
  requestedAt: string;
}

function denialMessage(error: unknown, fallback: string): string {
  const code = (error as { code?: string })?.code;
  if (code === "REFUND_FOUR_EYES") return "Four-eyes: you cannot approve a refund you requested. A different approver is required.";
  if (code === "STEP_UP_REQUIRED") return "Step-up re-authentication required — re-verify and retry.";
  return fallback;
}

export function RefundApprove(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [refund, setRefund] = useState<Refund | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError("No refund selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/admin/refunds/{id}", { params: { path: { id } } });
    if (res.error) {
      setError("Refund unavailable.");
      setLoading(false);
      return;
    }
    setRefund(res.data as unknown as Refund);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = useCallback(async () => {
    if (!id) return;
    setBusy(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/refunds/{id}/approve", { params: { path: { id } }, headers: { "Idempotency-Key": crypto.randomUUID() } });
    if (res.error) {
      setOutcome({ ok: false, message: denialMessage(res.error, "Could not approve the refund.") });
      setBusy(false);
      return;
    }
    setOutcome({ ok: true, message: "Refund approved — queued for execution." });
    setBusy(false);
    setTimeout(() => navigate("/admin/refunds"), 1000);
  }, [client, id, navigate]);

  const deny = useCallback(async () => {
    if (!id || denyReason.trim().length === 0) return;
    setBusy(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/refunds/{id}/deny", { params: { path: { id } }, body: { reason: denyReason.trim() }, headers: { "Idempotency-Key": crypto.randomUUID() } });
    if (res.error) {
      setOutcome({ ok: false, message: denialMessage(res.error, "Could not deny the refund.") });
      setBusy(false);
      return;
    }
    setOutcome({ ok: true, message: "Refund denied." });
    setBusy(false);
    setTimeout(() => navigate("/admin/refunds"), 1000);
  }, [client, id, denyReason, navigate]);

  if (loading) return <LoadingSpinner />;
  if (error || !refund) return <EmptyState title="Unavailable" description={error ?? "Refund not found."} />;

  const decided = refund.status !== "requested";

  return (
    <DetailPageLayout
      header={<PageHeader title="Review refund" breadcrumb="Platform Ops / Refunds" />}
      aside={
        <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <Kv label="Organization">{orgLabel(refund.organizationName, refund.organizationId)}</Kv>
          <Kv label="Amount"><span className="tabular-nums">{formatCents(refund.amountCents)}</span></Kv>
          <Kv label="Kind">{cap(refund.kind)}</Kv>
          <Kv label="Reason">{cap(refund.reasonCode)}</Kv>
          <Kv label="Requested"><span className="tabular-nums">{formatDate(refund.requestedAt)}</span></Kv>
          <Kv label="Requested by"><span style={{ fontSize: "0.75rem" }}>{refund.requestedByMembershipId}</span></Kv>
          <Kv label="Status"><StatusPill label={cap(refund.status)} tone={refundTone(refund.status)} /></Kv>
        </div>
      }
    >
      <section style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "34rem" }}>
        <div role="note" style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)", border: "1px solid var(--color-outline-variant)", borderRadius: "var(--radius-md, 0.5rem)", padding: "0.75rem 0.9rem" }}>
          Approval is step-up-gated and enforces four-eyes: you may not approve a refund you requested. A
          denied step-up or a self-approval attempt is reported below.
        </div>
        {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
        {decided ? (
          <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>This refund is already {cap(refund.status)} — no action available.</p>
        ) : (
          <>
            <button type="button" onClick={() => void approve()} disabled={busy} style={actionButtonStyle(true, busy)}>{busy ? "Working…" : "Approve refund"}</button>
            <Field label="Deny reason" htmlFor="deny-reason">
              <textarea id="deny-reason" value={denyReason} onChange={(e) => setDenyReason(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical" }} placeholder="Why is this refund being denied?" />
            </Field>
            <button type="button" onClick={() => void deny()} disabled={busy || denyReason.trim().length === 0} style={actionButtonStyle(false, busy || denyReason.trim().length === 0)}>Deny refund</button>
          </>
        )}
      </section>
    </DetailPageLayout>
  );
}
