import { StatusPill, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the PLAN VERSION SIGN CEREMONY (§5.1 #4, Track B).
//
// One slot of the D11 quorum that was SEALED when the version was finalized. Two server contracts the
// modal makes visible rather than hiding:
//   • the quorum is frozen on the version (route 5's `requiredSignerSet`) — the modal shows collected vs
//     required per role, so a signer knows whether theirs is the signature that flips the version `signed`;
//   • signing is a §4.1 STEP-UP route — a session that is not recently re-authenticated is refused by the
//     server (M2 SESSION_POLICY) and the refusal is surfaced verbatim, never retried silently.
//
// CHHA acknowledgment vs signature is the aide-POC distinction (§3.5): an acknowledgment slot is sent with
// `isAcknowledgment: true` and attests receipt/understanding, not clinical authorship.
import { useState } from "react";
import type { JSX } from "react";
import {
  type RequiredSignerSlot,
  type SignatureView,
  type VersionDetail,
  errorMessage,
  writeHeaders,
} from "./discipline-api";
import { humanize } from "./discipline-status";
import {
  Modal,
  TextAreaField,
  TextField,
  alertStyle,
  mutedStyle,
  primaryButtonStyle,
} from "./discipline-ui";

/** How many of a role's required slots are already filled (an acknowledgment fills only an ack slot). */
function collectedFor(slot: RequiredSignerSlot, signatures: readonly SignatureView[]): number {
  return signatures.filter(
    (s) => s.signerRole === slot.role && s.isAcknowledgment === slot.isAcknowledgment,
  ).length;
}

export function SignVersionModal({
  planId,
  version,
  requiredSignerSet,
  onClose,
  onSigned,
}: {
  planId: string;
  version: VersionDetail;
  requiredSignerSet: RequiredSignerSlot[];
  onClose: () => void;
  onSigned: () => void;
}): JSX.Element {
  const client = useApiClient();
  const openSlot = requiredSignerSet.find(
    (slot) => collectedFor(slot, version.signatures) < slot.count,
  );
  const [signerRole, setSignerRole] = useState(openSlot?.role ?? "");
  const [isAcknowledgment, setIsAcknowledgment] = useState(openSlot?.isAcknowledgment ?? false);
  const [attestationText, setAttestationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = signerRole.trim().length > 0 && attestationText.trim().length >= 10 && !busy;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await client.POST("/api/v1/discipline-plans/{planId}/versions/{versionId}/sign", {
      params: {
        path: { planId, versionId: version.versionId },
        header: writeHeaders(version.version),
      },
      body: { signerRole, attestationText, isAcknowledgment },
    } as never);
    setBusy(false);
    if (res.error) {
      setError(
        errorMessage(
          res.error,
          "The signature was not recorded. Signing requires a recently re-authenticated session.",
        ),
      );
      return;
    }
    onSigned();
  }

  return (
    <Modal
      title={`Sign version ${version.sequence}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          style={{ ...primaryButtonStyle, opacity: canSubmit ? 1 : 0.5 }}
        >
          {busy ? "Signing…" : isAcknowledgment ? "Acknowledge" : "Sign"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
        <span style={mutedStyle}>
          The required signer set was sealed when this version was finalized; it cannot be widened
          here.
        </span>
        {requiredSignerSet.length === 0 ? (
          <span style={mutedStyle}>
            This version carries no readable signer quorum. Record your role below — the server
            validates it against the sealed set.
          </span>
        ) : (
          <ul
            style={{
              margin: 0,
              paddingLeft: "1.1rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.25rem",
            }}
          >
            {requiredSignerSet.map((slot) => {
              const done = collectedFor(slot, version.signatures);
              return (
                <li
                  key={`${slot.role}-${slot.isAcknowledgment}`}
                  style={{ fontSize: "0.82rem", color: t.onSurface }}
                >
                  {humanize(slot.role)}
                  {slot.isAcknowledgment ? " (acknowledgment)" : ""} —{" "}
                  <StatusPill
                    label={`${done} of ${slot.count}`}
                    tone={done >= slot.count ? "success" : "progress"}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <TextField label="Signing role" value={signerRole} onChange={setSignerRole} />
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: t.space2,
          fontSize: "0.82rem",
          color: t.onSurface,
        }}
      >
        <input
          type="checkbox"
          checked={isAcknowledgment}
          onChange={(e) => setIsAcknowledgment(e.target.checked)}
        />
        Record as an acknowledgment (receipt and understanding), not a clinical signature
      </label>
      <TextAreaField
        label="Attestation"
        value={attestationText}
        onChange={setAttestationText}
        rows={4}
        hint="At least 10 characters. The attestation text is stored verbatim on the signature row."
      />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
