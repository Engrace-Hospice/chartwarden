import { Button, Modal, SelectField, TextAreaField, TextField, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/11-orders — the five §2.2/§2.3/§2.5/§2.6 write ceremonies (#91).
//
// M11's web surface issued no mutation at all. Four of its seven screens are QUEUES whose whole reason to
// exist is an action they did not offer — a physician could open "orders awaiting your signature" and have
// no way to sign one. This modal is the action, shared by the queues and the detail pane so a signature
// taken from an inbox row and one taken from the order itself are the same ceremony committing to the same
// route.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//
//   • WHETHER the caller may sign. `signer_eligible` (§4.7) resolves the caller's disciplines from their
//     M3 role grants and matches them against the ORDER KIND's signer matrix. This modal never consults
//     that matrix: it offers the ceremony, and a 403 is rendered as the refusal it is.
//   • WHETHER the order is in a signable state. §2.2 is the server's; a 409 means the row moved under the
//     caller, which on a shared queue is ordinary rather than exceptional.
//   • The §2.5 cosignature requirement, resolved at request-signature time and rendered from the read.
//
// `signerDiscipline` IS sent from the client, and is provenance rather than authorization: it records
// which of the caller's roles they signed as. The values of `OrderSignerDiscipline` are M3 ROLE KEYS
// (`rn_case_manager`, `medical_director`, `np`, …), so the options are the caller's OWN
// `session.roles` filtered to that vocabulary — an intersection, not a derivation. The repo has one
// authority-derivation input (M3's role keys) and three modules already answer this question identically;
// inventing a fourth mapping here is exactly the drift `discipline-derivation.test.ts` pins against.
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import {
  type CosignerRole,
  type DiscontinueReason,
  type OrderView,
  type WriteResult,
  completeOrder,
  cosignOrder,
  discontinueOrder,
  nowIso,
  recordVerbalOrder,
  signOrder,
} from "./orders-api";

/** The five ceremonies this modal performs. One component, because they share every control but the body. */
export type OrderAction = "sign" | "cosign" | "discontinue" | "complete" | "verbal";

/** The §2.1 signer vocabulary, as role keys. Mirrors `OrderSignerDiscipline` in `@wardenx/orders`. */
const SIGNER_ROLE_KEYS = [
  "rn_case_manager",
  "medical_director",
  "hospice_physician",
  "np",
  "pa",
  "msw",
  "clinical_supervisor",
] as const;

const COSIGNER_ROLES = [
  "rn_case_manager",
  "clinical_supervisor",
  "medical_director",
] as const satisfies readonly CosignerRole[];

const DISCONTINUE_REASONS = [
  "clinical_judgement",
  "patient_request",
  "adverse_event",
  "level_of_care_change",
] as const satisfies readonly DiscontinueReason[];

const LABEL: Record<OrderAction, string> = {
  sign: "Sign order",
  cosign: "Cosign order",
  discontinue: "Discontinue order",
  complete: "Mark reviewed",
  verbal: "Record verbal order",
};

const SUBMIT: Record<OrderAction, string> = {
  sign: "Sign",
  cosign: "Cosign",
  discontinue: "Discontinue",
  complete: "Mark reviewed",
  verbal: "Record",
};

/** Server minimum lengths, mirrored so the button can say WHY it is disabled instead of a 422 after the fact. */
const ATTESTATION_MIN = 50;
const VERBAL_ATTESTATION_MIN = 100;

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export interface OrderActionModalProps {
  readonly open: boolean;
  readonly action: OrderAction;
  readonly orderId: string;
  readonly onClose: () => void;
  /** Called with the row the server returned, so the caller can re-render without a refetch. */
  readonly onDone: (order: OrderView) => void;
}

export function OrderActionModal({
  open,
  action,
  orderId,
  onClose,
  onDone,
}: OrderActionModalProps): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The caller's own roles, narrowed to the signer vocabulary. NOT a check that they may sign.
  const signerRoles = useMemo(() => {
    const held = new Set(session?.roles ?? []);
    return SIGNER_ROLE_KEYS.filter((r) => held.has(r));
  }, [session]);

  const [signerDiscipline, setSignerDiscipline] = useState("");
  const [cosignerRole, setCosignerRole] = useState<CosignerRole>(COSIGNER_ROLES[0]);
  const [attestation, setAttestation] = useState("");
  const [reason, setReason] = useState<DiscontinueReason>(DISCONTINUE_REASONS[0]);
  const [notes, setNotes] = useState("");
  const [orderingPhysicianMdmId, setOrderingPhysicianMdmId] = useState("");
  const [readBackVerified, setReadBackVerified] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setSignerDiscipline(signerRoles.length === 1 ? (signerRoles[0] as string) : "");
    setAttestation("");
    setNotes("");
    setOrderingPhysicianMdmId("");
    setReadBackVerified(false);
  }, [open, signerRoles]);

  if (!open) return null;

  const needsSigner = action === "sign";
  const needsAttestation = action === "cosign" || action === "verbal";
  const min = action === "verbal" ? VERBAL_ATTESTATION_MIN : ATTESTATION_MIN;

  const blocked =
    (needsSigner && signerDiscipline === "") ||
    (action === "verbal" &&
      (signerDiscipline === "" || orderingPhysicianMdmId.trim() === "" || !readBackVerified)) ||
    (needsAttestation && attestation.trim().length < min);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    let res: WriteResult;
    switch (action) {
      case "sign":
        res = await signOrder(client, orderId, { signerDiscipline, signedAtClient: nowIso() });
        break;
      case "cosign":
        res = await cosignOrder(client, orderId, { cosignerRole, attestationText: attestation });
        break;
      case "discontinue":
        res = await discontinueOrder(client, orderId, {
          reason,
          effectiveAt: nowIso(),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
        break;
      case "complete":
        res = await completeOrder(client, orderId, notes.trim() ? { reason: notes.trim() } : {});
        break;
      case "verbal": {
        const receivedAt = nowIso();
        res = await recordVerbalOrder(client, orderId, {
          recorderDiscipline: signerDiscipline,
          verbalAttestation: attestation,
          readBackVerified,
          effectiveAt: receivedAt,
          receivedAt,
          orderingPhysicianMdmId: orderingPhysicianMdmId.trim(),
        });
        break;
      }
    }
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone(res.order);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={LABEL[action]}
      width="30rem"
      accent={action === "discontinue" ? t.alert : t.primary}
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={title}>{LABEL[action]}</h2>

        {needsSigner || action === "verbal" ? (
          signerRoles.length === 0 ? (
            // Not a permission verdict — the server still owns that. This says the SIGNATURE cannot be
            // labelled, because none of the caller's roles is in the signer vocabulary at all.
            <p style={meta}>
              None of your roles can be recorded as a signing discipline, so this signature cannot
              be attributed. Ask an administrator to review your role grants.
            </p>
          ) : (
            <SelectField
              label={action === "verbal" ? "Recording as" : "Signing as"}
              value={signerDiscipline}
              onChange={(e) => setSignerDiscipline(e.target.value)}
              options={[
                ...(signerRoles.length > 1 ? [{ value: "", label: "Select a role…" }] : []),
                ...signerRoles.map((r) => ({ value: r, label: humanize(r) })),
              ]}
            />
          )
        ) : null}

        {action === "cosign" ? (
          <SelectField
            label="Cosigning as"
            value={cosignerRole}
            onChange={(e) => setCosignerRole(e.target.value as CosignerRole)}
            options={COSIGNER_ROLES.map((r) => ({ value: r, label: humanize(r) }))}
          />
        ) : null}

        {action === "discontinue" ? (
          <SelectField
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as DiscontinueReason)}
            options={DISCONTINUE_REASONS.map((r) => ({ value: r, label: humanize(r) }))}
          />
        ) : null}

        {action === "verbal" ? (
          <TextField
            label="Ordering physician (MDM id)"
            value={orderingPhysicianMdmId}
            onChange={(e) => setOrderingPhysicianMdmId(e.target.value)}
          />
        ) : null}

        {needsAttestation ? (
          <>
            <TextAreaField
              label={action === "verbal" ? "Read-back attestation" : "Attestation"}
              value={attestation}
              onChange={(e) => setAttestation(e.target.value)}
              rows={4}
            />
            <p style={meta}>
              {attestation.trim().length}/{min} characters minimum — the server enforces this floor.
            </p>
          </>
        ) : null}

        {action === "verbal" ? (
          <label style={checkRow}>
            <input
              type="checkbox"
              checked={readBackVerified}
              onChange={(e) => setReadBackVerified(e.target.checked)}
            />
            <span>I read this order back to the ordering physician and they confirmed it.</span>
          </label>
        ) : null}

        {action === "discontinue" || action === "complete" ? (
          <TextAreaField
            label={action === "complete" ? "Note (optional)" : "Notes (optional)"}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || blocked}>
            {busy ? "Working…" : SUBMIT[action]}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const title = { margin: 0, fontSize: "1.05rem", fontWeight: 600 } as const;
const meta = { margin: 0, fontSize: "0.75rem", color: "var(--color-on-surface-variant)" } as const;
const errorText = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" } as const;
const checkRow = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.8125rem",
} as const;
