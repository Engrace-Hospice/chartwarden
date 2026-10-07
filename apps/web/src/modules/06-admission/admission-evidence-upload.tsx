// apps/web/src/modules/06-admission/admission-evidence-upload.tsx — the Notice of Rights / Election Statement / CTI
// "Upload document" ceremonies of the admission intake workspace, in the redesign's right-hand drawer
// (scanned-upload.tsx) instead of a centered modal. Presentation only: admission-detail.tsx owns the state and
// the request bodies (unchanged), this renders the fields with kit controls.
import { Glyph, SelectField, TextField } from "@wardenx/ui";
import type { JSX } from "react";
import { ScannedFileField, ScannedUploadDrawer, type ScannedUploadStage } from "./scanned-upload";

export type EvidenceUploadKind = "nor" | "election" | "election-signed" | "cti";
export type UploadedSignerRole = "patient" | "legal_representative" | "caregiver";

const TITLE: Record<EvidenceUploadKind, string> = {
  nor: "Upload Notice of Rights",
  election: "Upload Election Statement",
  "election-signed": "Upload signed Election Statement",
  cti: "Upload CTI",
};

const SUBTITLE: Record<EvidenceUploadKind, string> = {
  nor: "A scanned or completed Notice of Rights",
  election: "An existing Election Statement",
  "election-signed": "The signed paper Election Statement",
  cti: "An existing Certification of Terminal Illness",
};

export interface EvidenceUploadState {
  readonly file: File | null;
  readonly signedState: "unsigned" | "signed";
  readonly signerName: string;
  readonly signerRole: UploadedSignerRole;
  readonly signatureDate: string;
}

export interface EvidenceUploadHandlers {
  readonly onFile: (file: File | null) => void;
  readonly onSignedState: (state: "unsigned" | "signed") => void;
  readonly onSignerName: (value: string) => void;
  readonly onSignerRole: (value: UploadedSignerRole) => void;
  readonly onSignatureDate: (value: string) => void;
}

export function EvidenceUploadDrawer({
  kind,
  state,
  on,
  signedByLabel,
  stage,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  kind: EvidenceUploadKind;
  state: EvidenceUploadState;
  on: EvidenceUploadHandlers;
  /** CTI: the admission's hospice physician (read-only — the signed CTI must be theirs). */
  signedByLabel?: string;
  stage: ScannedUploadStage;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
}): JSX.Element {
  const hasSignature = kind !== "nor";
  const signedOnly = kind === "election-signed";
  const signed = signedOnly || state.signedState === "signed";
  const election = kind === "election" || kind === "election-signed";
  return (
    <ScannedUploadDrawer
      title={TITLE[kind]}
      subtitle={SUBTITLE[kind]}
      error={error}
      stage={stage}
      busy={busy}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <ScannedFileField label="Document" disabled={busy} onFile={on.onFile} />
      {hasSignature && !signedOnly ? (
        <SelectField
          label="Document signature status"
          value={state.signedState}
          disabled={busy}
          options={[
            { value: "unsigned", label: "Unsigned" },
            { value: "signed", label: "Signed" },
          ]}
          onChange={(e) => on.onSignedState(e.target.value as "unsigned" | "signed")}
        />
      ) : null}
      {hasSignature && signed ? (
        <>
          {signedByLabel ? (
            <div>
              <dl className="wx-kv">
                <dt>Signed by</dt>
                <dd>{signedByLabel}</dd>
              </dl>
              <p className="wx-pa-source">
                <Glyph name="lock" size={12} />
                <span>From admission details</span>
              </p>
            </div>
          ) : null}
          {election ? (
            <>
              <TextField
                label="Signer name"
                required
                disabled={busy}
                value={state.signerName}
                onChange={(e) => on.onSignerName(e.target.value)}
              />
              <SelectField
                label="Signer role"
                value={state.signerRole}
                disabled={busy}
                options={[
                  { value: "patient", label: "Patient" },
                  { value: "legal_representative", label: "Legal representative" },
                  { value: "caregiver", label: "Caregiver" },
                ]}
                onChange={(e) => on.onSignerRole(e.target.value as UploadedSignerRole)}
              />
            </>
          ) : null}
          <TextField
            type="date"
            label="Signature date"
            required
            disabled={busy}
            value={state.signatureDate}
            onChange={(e) => on.onSignatureDate(e.target.value)}
          />
        </>
      ) : null}
    </ScannedUploadDrawer>
  );
}
