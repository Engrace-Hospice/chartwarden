import { Button, Modal, SelectField, TextAreaField, TextField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — the §2.2/§2.3/§2.5/§2.7 write ceremonies the M12 queues are for (#91).
//
// Four of this module's nine screens are QUEUES whose entire reason to exist is an action they did not
// offer: the prescriber Sign Inbox (`pending_signature`), the Verbal-Orders queue (`verbal_pending`), and
// the Refill Inbox + its detail. A physician could open "medication orders awaiting your signature" and
// have no way to sign one.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030).
//
//   • §2.2 the lifecycle. `transitionMedicationOrder` decides whether the order is in a state that
//     permits the transition — including that `complete` and `discontinue` are legal only from `active`,
//     which is reachable at all only since #136.
//   • §2.4 the EPCS gate. A controlled order refuses this `sign` path by design (`SIGN_REQUIRES_EPCS`),
//     and `requestSignature` refuses one outright while the agency is not DEA EPCS-certified (D18). Both
//     are rendered as the refusals they are, not as generic errors.
//   • §4.7 prescriber eligibility, resolved from the caller's own M3 grants. A 403 is the answer.
//
// `signerDiscipline` IS sent, and is PROVENANCE rather than authorization: it records which of the
// caller's roles they signed as. The options are the caller's OWN session roles intersected with the
// prescribing vocabulary — the same rule `11-orders/order-action-modal.tsx` follows, and for the same
// reason: the repo has one authority-derivation input (M3 role keys) and `discipline-derivation.test.ts`
// pins that no module invents a second.
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import {
  type CosignerRole,
  type DiscontinueReason,
  type MedicationOrderView,
  type WriteResult,
  completeOrder,
  cosignOrder,
  discontinueOrder,
  nowIso,
  recordVerbalOrder,
  requestSignature,
  signOrder,
} from "./medications-api";

/** The six ceremonies this modal performs. One component, because they share every control but the body. */
export type MedicationAction =
  | "request-signature"
  | "sign"
  | "cosign"
  | "verbal"
  | "discontinue"
  | "complete";

/** The §2.1 prescribing/recording vocabulary, as M3 role keys. */
const PRESCRIBER_ROLE_KEYS = [
  "hospice_physician",
  "medical_director",
  "np",
  "pa",
  "rn_case_manager",
  "clinical_supervisor",
] as const;

const COSIGNER_ROLES = [
  "rn_case_manager",
  "clinical_supervisor",
  "medical_director",
] as const satisfies readonly CosignerRole[];

// Three, not four: M12's discontinuation vocabulary is NARROWER than M11's (which also carries
// `level_of_care_change`). Derived from the contract, so the difference is a compile error rather than
// a 422 nobody predicted.
const DISCONTINUE_REASONS = [
  "clinical_judgement",
  "patient_request",
  "adverse_event",
] as const satisfies readonly DiscontinueReason[];

const LABEL: Record<MedicationAction, string> = {
  "request-signature": "Send for signature",
  sign: "Sign medication order",
  cosign: "Cosign medication order",
  verbal: "Record verbal order",
  discontinue: "Discontinue medication",
  complete: "Complete course",
};

const SUBMIT: Record<MedicationAction, string> = {
  "request-signature": "Send",
  sign: "Sign",
  cosign: "Cosign",
  verbal: "Record",
  discontinue: "Discontinue",
  complete: "Complete",
};

/** Server minimum lengths, mirrored so the button can say WHY it is disabled instead of a 422 after. */
const ATTESTATION_MIN = 50;
const VERBAL_ATTESTATION_MIN = 100;

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export interface MedicationActionModalProps {
  readonly open: boolean;
  readonly action: MedicationAction;
  readonly orderId: string;
  readonly onClose: () => void;
  readonly onDone: (order: MedicationOrderView) => void;
}

export function MedicationActionModal({
  open,
  action,
  orderId,
  onClose,
  onDone,
}: MedicationActionModalProps): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The caller's own roles, narrowed to the prescribing vocabulary. NOT a check that they may sign.
  const prescriberRoles = useMemo(() => {
    const held = new Set(session?.roles ?? []);
    return PRESCRIBER_ROLE_KEYS.filter((r) => held.has(r));
  }, [session]);

  const [discipline, setDiscipline] = useState("");
  const [cosignerRole, setCosignerRole] = useState<CosignerRole>(COSIGNER_ROLES[0]);
  const [attestation, setAttestation] = useState("");
  const [reason, setReason] = useState<DiscontinueReason>(DISCONTINUE_REASONS[0]);
  const [notes, setNotes] = useState("");
  const [namedPrescriberMdmId, setNamedPrescriberMdmId] = useState("");
  // GAP-036: shown only after the server answers 422 ALLERGY_CHECK_NOT_PASSED (a drug-allergy conflict).
  const [allergyConflict, setAllergyConflict] = useState(false);
  const [allergyOverrideReason, setAllergyOverrideReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setDiscipline(prescriberRoles.length === 1 ? (prescriberRoles[0] as string) : "");
    setAttestation("");
    setNotes("");
    setNamedPrescriberMdmId("");
    setAllergyConflict(false);
    setAllergyOverrideReason("");
  }, [open, prescriberRoles]);

  if (!open) return null;

  // GAP-035: sign no longer takes a discipline or an "ordering physician" claim; the server derives both.
  const needsDiscipline = action === "request-signature" || action === "verbal";
  const needsAttestation = action === "cosign" || action === "verbal";
  const min = action === "verbal" ? VERBAL_ATTESTATION_MIN : ATTESTATION_MIN;

  const blocked =
    (needsDiscipline && discipline === "") ||
    (action === "verbal" && namedPrescriberMdmId.trim() === "") ||
    (needsAttestation && attestation.trim().length < min) ||
    (allergyConflict && allergyOverrideReason.trim() === "");

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    let res: WriteResult<MedicationOrderView>;
    switch (action) {
      case "request-signature":
        res = await requestSignature(
          client,
          orderId,
          discipline,
          allergyConflict ? allergyOverrideReason.trim() : undefined,
        );
        break;
      case "sign":
        // GAP-035: the server derives the signer's discipline and standing from the session and the order.
        res = await signOrder(client, orderId, { signedAtClient: nowIso() });
        break;
      case "cosign":
        res = await cosignOrder(client, orderId, { cosignerRole, attestationText: attestation });
        break;
      case "verbal":
        res = await recordVerbalOrder(client, orderId, {
          recorderDiscipline: discipline,
          verbalAttestation: attestation,
          receivedAt: nowIso(),
          namedPrescriberMdmId: namedPrescriberMdmId.trim(),
        });
        break;
      case "discontinue":
        res = await discontinueOrder(client, orderId, {
          reason,
          effectiveAt: nowIso(),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
        break;
      case "complete":
        res = await completeOrder(client, orderId, notes.trim() || undefined);
        break;
    }
    setBusy(false);
    if (!res.ok) {
      if (action === "request-signature" && res.code === "ALLERGY_CHECK_NOT_PASSED") {
        setAllergyConflict(true);
      }
      setError(res.message);
      return;
    }
    onDone(res.value);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={LABEL[action]}
      width="30rem"
      accent={action === "discontinue" ? "alert" : "primary"}
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={title}>{LABEL[action]}</h2>

        {needsDiscipline ? (
          prescriberRoles.length === 0 ? (
            // Not a permission verdict — the server still owns that. This says the SIGNATURE cannot be
            // labelled, because none of the caller's roles is in the prescribing vocabulary at all.
            <p style={meta}>
              None of your roles can be recorded as a prescribing discipline, so this cannot be
              attributed. Ask an administrator to review your role grants.
            </p>
          ) : (
            <SelectField
              label={action === "verbal" ? "Recording as" : "Send to discipline"}
              value={discipline}
              onChange={(e) => setDiscipline(e.target.value)}
              options={[
                ...(prescriberRoles.length > 1 ? [{ value: "", label: "Select a role…" }] : []),
                ...prescriberRoles.map((r) => ({ value: r, label: humanize(r) })),
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

        {allergyConflict ? (
          <TextAreaField
            label="Allergy override reason"
            value={allergyOverrideReason}
            onChange={(e) => setAllergyOverrideReason(e.target.value)}
            rows={3}
          />
        ) : null}

        {action === "verbal" ? (
          <TextField
            label="Named prescriber (MDM id)"
            value={namedPrescriberMdmId}
            onChange={(e) => setNamedPrescriberMdmId(e.target.value)}
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

        {action === "discontinue" || action === "complete" ? (
          <TextAreaField
            label={action === "complete" ? "Note (optional)" : "Notes (optional)"}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        ) : null}

        {action === "verbal" ? (
          <p style={meta}>
            A verbal order is a valid order pending signature (CMS), and the eMAR may administer
            against it during the §2.3 window. A controlled substance cannot be ordered verbally in
            Phase 1.
          </p>
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
          <Button
            tone={action === "discontinue" ? "danger" : "primary"}
            onClick={() => void submit()}
            disabled={busy || blocked}
          >
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
