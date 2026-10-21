import { t } from "@chartwarden/ui";
// apps/web/src/modules/39-consent — shared capture-evidence sub-form (WX-PR-010). Every signature
// ceremony (initial sign, supersede, renew) collects the SAME per-`captureMethod` evidence and is
// gated by the SAME floor the backend enforces (`validateCaptureEvidence`,
// packages/consent/src/validation/rules.ts) — one place so the three ceremonies cannot drift.
//
// `electronic_portal_signature` is deliberately absent from the staff-selectable method list: per
// the M39 spec §5.3, that method is the PORTAL's own signing path (M31), populated server-side with
// `capture_evidence_jsonb.portal_session_id` from the patient's own session — a staff screen has no
// legitimate portal session to attest on the patient's behalf.
import type { CSSProperties, JSX } from "react";

export const STAFF_CAPTURE_METHODS = [
  { value: "typed_signature_in_app", label: "Typed signature (in app)" },
  { value: "uploaded_signed_pdf", label: "Uploaded signed PDF" },
  { value: "witnessed_verbal_documented", label: "Witnessed verbal (documented)" },
  { value: "notarized", label: "Notarized" },
] as const;
export type StaffCaptureMethod = (typeof STAFF_CAPTURE_METHODS)[number]["value"];

export interface CaptureEvidenceState {
  typedSignatureName: string;
  typedSignatureRole: string;
  uploadedPdfDocumentId: string;
  witnessName: string;
  witnessAttestationText: string;
  witnessSignatureEvidenceDocumentId: string;
  notaryCertificateDocumentId: string;
}

export function emptyEvidence(): CaptureEvidenceState {
  return {
    typedSignatureName: "",
    typedSignatureRole: "",
    uploadedPdfDocumentId: "",
    witnessName: "",
    witnessAttestationText: "",
    witnessSignatureEvidenceDocumentId: "",
    notaryCertificateDocumentId: "",
  };
}

/** Mirrors the backend floor in `validateCaptureEvidence` — gates the ceremony's commit button
 *  client-side so a doomed sign never round-trips just to learn it was incomplete. */
export function isEvidenceComplete(method: StaffCaptureMethod, e: CaptureEvidenceState): boolean {
  if (method === "typed_signature_in_app") return e.typedSignatureName.trim().length >= 2;
  if (method === "uploaded_signed_pdf") return e.uploadedPdfDocumentId.trim().length > 0;
  if (method === "witnessed_verbal_documented")
    return (
      e.witnessName.trim().length >= 2 &&
      e.witnessAttestationText.trim().length >= 20 &&
      e.witnessSignatureEvidenceDocumentId.trim().length > 0
    );
  if (method === "notarized") return e.notaryCertificateDocumentId.trim().length > 0;
  return false;
}

/** Only the fields the selected method requires — sent as `SignConsentBodySchema.captureEvidence`. */
export function evidencePayload(
  method: StaffCaptureMethod,
  e: CaptureEvidenceState,
): Record<string, string> {
  if (method === "typed_signature_in_app")
    return {
      typedSignatureName: e.typedSignatureName.trim(),
      ...(e.typedSignatureRole.trim() ? { typedSignatureRole: e.typedSignatureRole.trim() } : {}),
    };
  if (method === "uploaded_signed_pdf")
    return { uploadedPdfDocumentId: e.uploadedPdfDocumentId.trim() };
  if (method === "witnessed_verbal_documented")
    return {
      witnessName: e.witnessName.trim(),
      witnessAttestationText: e.witnessAttestationText.trim(),
      witnessSignatureEvidenceDocumentId: e.witnessSignatureEvidenceDocumentId.trim(),
    };
  return { notaryCertificateDocumentId: e.notaryCertificateDocumentId.trim() };
}

export function CaptureEvidenceFields({
  method,
  value,
  onChange,
}: {
  method: StaffCaptureMethod;
  value: CaptureEvidenceState;
  onChange: (next: CaptureEvidenceState) => void;
}): JSX.Element {
  const set = (patch: Partial<CaptureEvidenceState>) => onChange({ ...value, ...patch });
  if (method === "typed_signature_in_app")
    return (
      <div style={group}>
        <label style={label} htmlFor="evidence-typed-name">
          Signer's typed name *
        </label>
        <input
          id="evidence-typed-name"
          style={input}
          value={value.typedSignatureName}
          onChange={(ev) => set({ typedSignatureName: ev.target.value })}
        />
        <label style={label} htmlFor="evidence-typed-role">
          Signer's role (optional)
        </label>
        <input
          id="evidence-typed-role"
          style={input}
          value={value.typedSignatureRole}
          onChange={(ev) => set({ typedSignatureRole: ev.target.value })}
        />
      </div>
    );
  if (method === "uploaded_signed_pdf")
    return (
      <div style={group}>
        <label style={label} htmlFor="evidence-pdf-doc">
          Uploaded signed-PDF document id *
        </label>
        <input
          id="evidence-pdf-doc"
          style={input}
          value={value.uploadedPdfDocumentId}
          onChange={(ev) => set({ uploadedPdfDocumentId: ev.target.value })}
          placeholder="M22 document id"
        />
      </div>
    );
  if (method === "witnessed_verbal_documented")
    return (
      <div style={group}>
        <label style={label} htmlFor="evidence-witness-name">
          Witness name *
        </label>
        <input
          id="evidence-witness-name"
          style={input}
          value={value.witnessName}
          onChange={(ev) => set({ witnessName: ev.target.value })}
        />
        <label style={label} htmlFor="evidence-witness-attestation">
          Witness attestation (≥20 characters) *
        </label>
        <textarea
          id="evidence-witness-attestation"
          style={{ ...input, minHeight: "4.5rem" }}
          value={value.witnessAttestationText}
          onChange={(ev) => set({ witnessAttestationText: ev.target.value })}
        />
        <label style={label} htmlFor="evidence-witness-doc">
          Witness signature evidence document id *
        </label>
        <input
          id="evidence-witness-doc"
          style={input}
          value={value.witnessSignatureEvidenceDocumentId}
          onChange={(ev) => set({ witnessSignatureEvidenceDocumentId: ev.target.value })}
          placeholder="M22 document id"
        />
      </div>
    );
  return (
    <div style={group}>
      <label style={label} htmlFor="evidence-notary-doc">
        Notary certificate document id *
      </label>
      <input
        id="evidence-notary-doc"
        style={input}
        value={value.notaryCertificateDocumentId}
        onChange={(ev) => set({ notaryCertificateDocumentId: ev.target.value })}
        placeholder="M22 document id"
      />
    </div>
  );
}

const group: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.4rem" };
const label: CSSProperties = { fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant };
const input: CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
};
