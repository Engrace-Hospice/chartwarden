// apps/web/src/modules/41-billing-commercial — the AUTHORIZATION DRAWER (M41). The right-hand drawer of the authorizations list: one
// pre-authorization's plan, payer policy, level of care, period and status, plus (for write holders) Deny and Void on an approved
// one. The authorization NUMBER is never displayed: the view does not carry it and the drawer says so.
//   POST /api/v1/billing/commercial/authorizations/{id}/status  { status: "denied" | "voided" }   (Idempotency-Key per attempt)
// Denied and voided are final (a second change is a 409). A change can demote dependent READY claims to draft; the confirm says so.
import {
  Button,
  Glyph,
  InlineAlert,
  StatusPill,
  useApiClient,
  useDrawerA11y,
} from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { authFailureRedirect } from "../23-billing-medicare/write-workflow";
import {
  type AuthorizationPlan,
  type AuthorizationView,
  authorizationPeriod,
  authorizationRequirementLabel,
  authorizationStatusLabel,
  authorizationStatusTone,
  authorizationWindowNote,
  levelOfCareLabel,
  shortId,
} from "./commercial-model";

type NextStatus = "denied" | "voided";
const ACTION_LABEL: Record<NextStatus, string> = { denied: "Deny", voided: "Void" };

/** The drawer frame shared by the detail view and the record form. */
export function AuthorizationDrawerShell({
  label,
  title,
  subtitle,
  closeLabel,
  onClose,
  children,
}: {
  label: string;
  title: string;
  subtitle?: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={label}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="clipboard-list" size={20} />
        </span>
        <div>
          <h2>{title}</h2>
          {subtitle ? <div className="wx-row-sub">{subtitle}</div> : null}
        </div>
        <Button tone="tertiary" size="sm" aria-label={closeLabel} onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">{children}</div>
    </aside>
  );
}

export function AuthorizationDrawer({
  authorization,
  plan,
  today,
  canWrite,
  onClose,
  onChanged,
  onReload,
}: {
  authorization: AuthorizationView;
  plan: AuthorizationPlan | undefined;
  today: string;
  canWrite: boolean;
  onClose: () => void;
  onChanged: (status: NextStatus) => void;
  onReload: () => void;
}): JSX.Element {
  const planName = plan?.planName ?? `Plan ${shortId(authorization.planId)}`;
  const note = authorizationWindowNote(authorization, today);
  const leadDays = plan?.authorizationLeadDays ?? null;
  return (
    <AuthorizationDrawerShell
      label={`Authorization for ${planName}`}
      title={planName}
      subtitle={`Authorization ${shortId(authorization.id)}`}
      closeLabel="Close authorization preview"
      onClose={onClose}
    >
      <section className="wx-drawer-card">
        <div className="wx-drawer-card-head">
          <h3>Authorization</h3>
          <StatusPill
            label={authorizationStatusLabel(authorization.status)}
            tone={authorizationStatusTone(authorization.status)}
          />
        </div>
        <dl className="wx-kv">
          <dt>Plan</dt>
          <dd>{planName}</dd>
          {plan ? (
            <>
              <dt>Payer policy</dt>
              <dd>{authorizationRequirementLabel(plan.authorizationRequirement)}</dd>
            </>
          ) : null}
          {leadDays !== null ? (
            <>
              <dt>Lead time</dt>
              <dd className="wx-nums">{`${leadDays} ${leadDays === 1 ? "day" : "days"}`}</dd>
            </>
          ) : null}
          <dt>Level of care</dt>
          <dd>{levelOfCareLabel(authorization.levelOfCare)}</dd>
          <dt>Period</dt>
          <dd className="wx-nums">
            {authorizationPeriod(authorization.effectiveFrom, authorization.effectiveTo)}
            {note ? <div className="wx-row-sub">{note}</div> : null}
          </dd>
          <dt>Obtained on</dt>
          <dd className="wx-nums">{authorization.obtainedOn}</dd>
          <dt>Reference</dt>
          <dd className="wx-nums">{shortId(authorization.id)}</dd>
        </dl>
        <p className="wx-row-sub">The authorization number is stored but never shown.</p>
      </section>
      {authorization.status !== "approved" ? (
        <p className="wx-row-sub">Final. Record a new authorization instead.</p>
      ) : canWrite ? (
        <StatusActions
          authorizationId={authorization.id}
          onChanged={onChanged}
          onReload={onReload}
        />
      ) : null}
    </AuthorizationDrawerShell>
  );
}

function StatusActions({
  authorizationId,
  onChanged,
  onReload,
}: {
  authorizationId: string;
  onChanged: (status: NextStatus) => void;
  onReload: () => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState<NextStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  const lastOpened = useRef<NextStatus | null>(null);
  const attemptKey = useRef<string | null>(null);
  const inFlight = useRef(false);

  // Deny / Void swap for Confirm / Keep: move focus into the pair, and back to the button that opened it when it closes.
  useEffect(() => {
    if (confirming) controls.current?.querySelector("button")?.focus();
    else if (lastOpened.current) {
      controls.current
        ?.querySelector<HTMLElement>(`[data-action="${lastOpened.current}"]`)
        ?.focus();
    }
  }, [confirming]);

  const open = (status: NextStatus): void => {
    lastOpened.current = status;
    attemptKey.current = null;
    setError(null);
    setConfirming(status);
  };

  const confirm = async (status: NextStatus): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    attemptKey.current ??= crypto.randomUUID();
    try {
      const { error: err, response } = await client.POST(
        "/api/v1/billing/commercial/authorizations/{id}/status",
        {
          params: {
            path: { id: authorizationId },
            header: { "Idempotency-Key": attemptKey.current },
          },
          body: { status },
        },
      );
      if (!err) {
        attemptKey.current = null;
        onChanged(status);
        return;
      }
      const code = (err as { error?: { code?: string } }).error?.code;
      const redirect = authFailureRedirect(
        response.status,
        code,
        window.location.pathname + window.location.search,
      );
      if (redirect) {
        navigate(redirect);
        return;
      }
      if (response.status === 409) {
        attemptKey.current = null;
        setConfirming(null);
        setError(
          "This authorization is no longer approved, so its status cannot change. The list has been reloaded.",
        );
        onReload();
        return;
      }
      setError(
        response.status === 403
          ? "You are not allowed to change this authorization."
          : response.status === 404
            ? "This authorization is not in your scope. Reload the list."
            : "That did not go through. Try again.",
      );
    } catch {
      setError("That did not go through. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="wx-drawer-actions" ref={controls}>
      {confirming ? (
        <>
          <p className="wx-row-sub">
            {`${ACTION_LABEL[confirming]} this authorization? It is final. Ready claims that relied on it may fall back to draft until another authorization covers them.`}
          </p>
          <Button
            tone="secondary"
            disabled={busy}
            onClick={() => void confirm(confirming)}
            data-action={confirming}
          >
            {busy ? "Saving…" : `Confirm ${ACTION_LABEL[confirming].toLowerCase()}`}
          </Button>
          <Button
            tone="tertiary"
            disabled={busy}
            onClick={() => {
              attemptKey.current = null;
              setConfirming(null);
            }}
          >
            Keep
          </Button>
        </>
      ) : (
        <>
          <Button tone="secondary" data-action="denied" onClick={() => open("denied")}>
            Deny
          </Button>
          <Button tone="secondary" data-action="voided" onClick={() => open("voided")}>
            Void
          </Button>
        </>
      )}
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    </div>
  );
}
