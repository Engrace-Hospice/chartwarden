// apps/admin/src/modules/34-saas-platform — the lifecycle "Transition status" dialog (spec §5.1
// `/tenants/:orgSlug/status` + `/offboard`): onboarding → active, active ⇄ suspended / at_risk, and the offboarding
// chain offboarding_initiated → final_export_pending → retained → destruction_pending (which is what makes the shred
// ceremony reachable). Backed by POST .../status and POST .../offboard; the server runs the §2.2 machine and its
// guards (canonical tasks + BAA for activation; retention elapsed and no legal hold for destruction), so a refusal
// carries the reason.
import { Button, InlineAlert, Modal, SelectField, TextAreaField, useApiClient } from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";
import { statusLabel } from "./saas-status";

/** `transitionReason` carries a minLength of 8 in the published contract. */
const MIN_REASON = 8;

/** Targets the platform status route can reach from a status (the machine's source of truth is server-side). */
const TARGETS: Readonly<Record<string, readonly string[]>> = {
  onboarding: ["active"],
  active: ["suspended", "at_risk", "offboarding_initiated"],
  suspended: ["active", "offboarding_initiated"],
  at_risk: ["active", "suspended", "offboarding_initiated"],
  offboarding_initiated: ["final_export_pending"],
  final_export_pending: ["retained"],
  retained: ["destruction_pending"],
};

/** The button wording for a transition whose generic "Apply" would hide how consequential it is. */
const COMMIT_LABEL: Readonly<Record<string, string>> = {
  active_from_onboarding: "Activate tenant",
  offboarding_initiated: "Begin offboarding",
  final_export_pending: "Start final export",
  retained: "Mark export complete",
  destruction_pending: "Schedule destruction",
};

type ExportPurpose = "migration" | "baa_termination";
const EXPORT_PURPOSES: readonly { value: ExportPurpose; label: string }[] = [
  { value: "migration", label: "Migration to another system" },
  { value: "baa_termination", label: "BAA termination" },
];

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
  const [purpose, setPurpose] = useState<ExportPurpose>("migration");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The dialog stays mounted while the tenant's status changes, so a remembered pick may no longer be reachable.
  const chosen = targets.includes(target) ? target : (targets[0] ?? "");
  const offboarding = chosen === "offboarding_initiated";
  const commitLabel =
    COMMIT_LABEL[
      fromStatus === "onboarding" && chosen === "active" ? "active_from_onboarding" : chosen
    ] ?? "Apply";

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
      const { error: err } = offboarding
        ? await client.POST("/api/v1/platform/tenants/{orgSlug}/offboard", {
            params: { path: { orgSlug } },
            body: { transitionReason: trimmed, exportPurpose: purpose },
          })
        : await client.POST("/api/v1/platform/tenants/{orgSlug}/status", {
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
            {offboarding ? (
              <SelectField
                label="Export purpose"
                hint="What the tenant's final export is for."
                value={purpose}
                onChange={(e) => setPurpose(e.target.value as ExportPurpose)}
                options={EXPORT_PURPOSES}
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
