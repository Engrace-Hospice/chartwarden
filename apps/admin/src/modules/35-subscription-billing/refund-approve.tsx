import {
  Button,
  InlineAlert,
  StatusPill,
  TextAreaField,
  focusFirstInvalid,
  useApiClient,
  useRequestGuard,
  useRestoreFocus,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Refund approval (`/admin/refunds/:id/approve`,
// refund.approve). THE sensitive path: approval carries a step-up AND the §4.8 four-eyes rule (the approver
// MUST differ from the requester). The server enforces both; this screen surfaces each denial as a
// first-class outcome — REFUND_FOUR_EYES (403 approver == requester) and a stale step-up are distinct, named
// messages, not a generic error. Hydrates the refund from GET /api/admin/refunds/:id (M35A-T03 detail GET).
// Redesign frame: the decision in the main column, the refund summary in the right drawer.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { DECIDED_REFUND_ICON, cap, formatCents, formatDate, orgLabel, refundTone } from "./status";
import {
  DrawerHead,
  type Outcome,
  OutcomeBanner,
  StateEmpty,
  StateError,
  StateLoading,
  UNREACHABLE_OUTCOME,
  failureOutcome,
  isNotFound,
  settleWrite,
} from "./ui";
import { useSuccessRedirect } from "./use-success-redirect";

type Refund = operations["getApiAdminRefundsById"]["responses"][200]["content"]["application/json"];

/** The parsed error body is the standard envelope `{ error: { code } }` (a flat `{ code }` is tolerated). */
function errorCode(error: unknown): string | undefined {
  const body = error as { code?: unknown; error?: { code?: unknown } } | null | undefined;
  const code = body?.error?.code ?? body?.code;
  return typeof code === "string" ? code : undefined;
}

function denial(error: unknown, fallback: string): Outcome {
  if (errorCode(error) === "REFUND_FOUR_EYES")
    return {
      ok: false,
      message:
        "Four-eyes: you cannot approve a refund you requested. A different approver is required.",
    };
  return failureOutcome(error, fallback);
}

export function RefundApprove(): JSX.Element {
  const client = useApiClient();
  const { done, finish } = useSuccessRedirect();
  const { id } = useParams<{ id: string }>();
  const [refund, setRefund] = useState<Refund | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Which decision is in flight (and stays set once it succeeded): both buttons lock, only that one shows the spinner.
  const [acting, setActing] = useState<"approve" | "deny" | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [denyAttempted, setDenyAttempted] = useState(false);
  const decisionRef = useRef<HTMLDivElement>(null);
  // A refused decision re-enables the buttons: focus returns to the one that was pressed (it was disabled while in flight).
  const captureFocus = useRestoreFocus(acting !== null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const guard = useRequestGuard();
  const load = useCallback(async () => {
    const isCurrent = guard();
    if (!id) {
      setError("No refund selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    const res = await client.GET("/api/admin/refunds/{id}", { params: { path: { id } } });
    if (!isCurrent()) return;
    if (res.error) {
      // A 404 is final: retrying cannot bring the record back, so no "Try again" (#597, F-044).
      setNotFound(isNotFound(res));
      setError(isNotFound(res) ? "Refund not found." : "Refund unavailable.");
      setLoading(false);
      return;
    }
    setRefund(res.data);
    setLoading(false);
  }, [client, id, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = useCallback(async () => {
    if (!id || acting || done) return;
    captureFocus();
    setActing("approve");
    setOutcome(null);
    const res = await settleWrite(
      client.POST("/api/admin/refunds/{id}/approve", {
        params: { path: { id } },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    );
    if (!res || res.error) {
      setOutcome(res ? denial(res.error, "Could not approve the refund.") : UNREACHABLE_OUTCOME);
      setActing(null);
      return;
    }
    finish("/admin/refunds", "Refund approved — queued for execution.");
  }, [acting, done, client, id, finish, captureFocus]);

  const deny = useCallback(async () => {
    if (!id || acting || done) return;
    setDenyAttempted(true);
    if (denyReason.trim().length === 0) {
      focusFirstInvalid(decisionRef.current);
      return;
    }
    captureFocus();
    setActing("deny");
    setOutcome(null);
    const res = await settleWrite(
      client.POST("/api/admin/refunds/{id}/deny", {
        params: { path: { id } },
        body: { reason: denyReason.trim() },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    );
    if (!res || res.error) {
      setOutcome(res ? denial(res.error, "Could not deny the refund.") : UNREACHABLE_OUTCOME);
      setActing(null);
      return;
    }
    finish("/admin/refunds", "Refund denied.");
  }, [acting, done, client, id, denyReason, finish, captureFocus]);

  const pageHead = (
    <header className="wx-page-head">
      <div>
        <h1>Review refund</h1>
        <p>Approve or deny a requested refund. You cannot decide a refund you requested.</p>
      </div>
    </header>
  );

  if (loading || error || !refund)
    return (
      <div className="wx-list-drawer">
        <div className="wx-list-drawer-main">
          {pageHead}
          {loading ? (
            <StateLoading label="Loading refund…" />
          ) : (
            <StateError
              message={error ?? "Refund not found."}
              onRetry={notFound ? undefined : () => void load()}
            />
          )}
        </div>
      </div>
    );

  const decided = refund.status !== "requested";

  return (
    <div className="wx-list-drawer has-drawer">
      <div className="wx-list-drawer-main">
        {pageHead}
        <InlineAlert tone="info">
          Approval is step-up-gated and enforces four-eyes: you may not approve a refund you
          requested. A denied step-up or a self-approval attempt is reported below.
        </InlineAlert>
        {outcome ? <OutcomeBanner {...outcome} /> : null}
        {decided ? (
          <StateEmpty icon={DECIDED_REFUND_ICON[refund.status]}>
            This refund is already {cap(refund.status)} — no action available.
          </StateEmpty>
        ) : (
          <section className="wx-drawer-card">
            <div className="wx-drawer-card-head">
              <h2>Decision</h2>
            </div>
            <div className="wx-form-stack" ref={decisionRef}>
              <div className="wx-drawer-actions">
                <Button
                  loading={acting === "approve"}
                  disabled={acting !== null || done}
                  onClick={() => void approve()}
                >
                  Approve refund
                </Button>
              </div>
              <TextAreaField
                id="deny-reason"
                label="Deny reason"
                hint="Required to deny a refund; leave it blank to approve."
                // Not `required` (and no `*`): Approve does not need it. It becomes required once a deny is attempted.
                aria-required={denyAttempted || undefined}
                // The reason is what the decision sends: it must not change while a decision is in flight or after it landed.
                readOnly={acting !== null || done}
                value={denyReason}
                onChange={(e) => setDenyReason(e.target.value)}
                error={
                  denyAttempted && denyReason.trim().length === 0
                    ? "Say why this refund is being denied."
                    : undefined
                }
                rows={3}
                placeholder="Why is this refund being denied?"
              />
              <div className="wx-drawer-actions">
                <Button
                  tone="secondary"
                  loading={acting === "deny"}
                  disabled={acting !== null || done}
                  onClick={() => void deny()}
                >
                  Deny refund
                </Button>
              </div>
            </div>
          </section>
        )}
      </div>
      <RefundSummary refund={refund} />
    </div>
  );
}

function RefundSummary({ refund }: { refund: Refund }): JSX.Element {
  return (
    <aside className="wx-admission-drawer" aria-label="Refund summary">
      <DrawerHead
        icon="rotate-ccw"
        title={formatCents(refund.amountCents)}
        sub={orgLabel(refund.organizationName, refund.organizationId)}
      />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Refund</h3>
            <StatusPill label={cap(refund.status)} tone={refundTone(refund.status)} />
          </div>
          <dl className="wx-kv">
            <dt>Organization</dt>
            <dd>{orgLabel(refund.organizationName, refund.organizationId)}</dd>
            <dt>Amount</dt>
            <dd className="wx-nums">{formatCents(refund.amountCents)}</dd>
            <dt>Kind</dt>
            <dd>{cap(refund.kind)}</dd>
            <dt>Reason</dt>
            <dd>{cap(refund.reasonCode)}</dd>
            <dt>Requested</dt>
            <dd className="wx-nums">{formatDate(refund.requestedAt)}</dd>
            <dt>Requested by</dt>
            <dd className="wx-data-md">{refund.requestedByMembershipId}</dd>
          </dl>
        </section>
      </div>
    </aside>
  );
}
