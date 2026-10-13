// apps/admin/src/modules/34-saas-platform — the lifecycle "Transition status" dialog (spec §5.1
// `/tenants/:orgSlug/status`): onboarding → active, active ⇄ suspended / at_risk. Backed by
// POST /api/v1/platform/tenants/{orgSlug}/status; the server runs the §2.2 machine and its guards (canonical
// onboarding tasks settled, BAA executed and >90d from expiry for activation), so a refusal carries the reason.
import {
  Button,
  InlineAlert,
  Modal,
  SelectField,
  TextAreaField,
  useApiClient,
} from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";
import { statusLabel } from "./saas-status";

/** `transitionReason` carries a minLength of 8 in the published contract. */
const MIN_REASON = 8;

/** Targets the platform status route can reach from a status (the machine's source of truth is server-side). */
const TARGETS: Readonly<Record<string, readonly string[]>> = {
  onboarding: ["active"],
  active: ["suspended", "at_risk"],
  suspended: ["active"],
  at_risk: ["active", "suspended"],
};

export function transitionTargets(fromStatus: string): readonly string[] {
  return TARGETS[fromStatus] ?? [];
}

export interface TenantTransitionDialogProps {
  open: boolean;
  orgSlug: string;
  tenantName: string;
  fromStatus: string;
  onDone: () => void;
  onClose: () => void;
}

function serverMessage(err: unknown): string | null {
  const message = (err as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

export function TenantTransitionDialog({
  open,
  orgSlug,
  tenantName,
  fromStatus,
  onDone,
  onClose,
}: TenantTransitionDialogProps): JSX.Element | null {
  const client = useApiClient();
  const targets = transitionTargets(fromStatus);
  const [target, setTarget] = useState<string>(targets[0] ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The dialog stays mounted while the tenant's status changes, so a remembered pick may no longer be reachable.
  const chosen = targets.includes(target) ? target : (targets[0] ?? "");
  const activating = fromStatus === "onboarding" && chosen === "active";
  const commitLabel = activating ? "Activate tenant" : "Apply";

  async function submit(): Promise<void> {
    if (busy) return;
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON) {
      setError(`Enter a transition reason of at least ${MIN_REASON} characters.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { error: err } = await client.POST("/api/v1/platform/tenants/{orgSlug}/status", {
        params: { path: { orgSlug } },
        body: { toStatus: chosen as "active", transitionReason: trimmed },
      });
      if (err) {
        setError(serverMessage(err) ?? "The transition was refused. The tenant is unchanged.");
        return;
      }
      setReason("");
      onDone();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Transition status">
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Transition status</h2>
        <p style={{ margin: 0, fontSize: "0.85rem" }}>
          <strong>{tenantName}</strong> is currently <strong>{statusLabel(fromStatus)}</strong>.
        </p>
        {targets.length === 0 ? (
          <>
            <p style={{ margin: 0 }}>No status changes are available from this state.</p>
            <Button tone="secondary" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            {targets.length > 1 ? (
              <SelectField
                label="New status"
                value={chosen}
                onChange={(e) => setTarget(e.target.value)}
                options={targets.map((value) => ({ value, label: statusLabel(value) }))}
              />
            ) : null}
            <TextAreaField
              label="Transition reason"
              hint="Recorded on the tenant's status ledger and audit trail."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
            {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <Button tone="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={busy}>
                {busy ? "Applying…" : commitLabel}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
