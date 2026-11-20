// apps/web/src/modules/08-encounters — the three dialogs of the cosigner's ceremony (acknowledge, sign, supervisor release), for a note's
// cosignature request and for an amendment's (ADR-0114 VN-D30, S1 PR E4). Moved out of encounter-read.tsx with its words unchanged for the
// note; the amendment says "amendment" where the note says "encounter" or "documentation". State and writes are `use-cosign-ceremony.ts`.
import { CeremonyModal, Glyph, t } from "@chartwarden/ui";
import { useId } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { CosignSubjectKind } from "./cosign-model";
import { type CosignCeremony, RELEASE_REASON_MIN } from "./use-cosign-ceremony";

export interface CosignFact {
  readonly label: string;
  readonly value: ReactNode;
  readonly mono?: boolean;
}

export interface CosignCeremonyModalsProps {
  readonly ceremony: CosignCeremony;
  readonly subject: CosignSubjectKind;
  /** What the signature dialog opens with, e.g. "Cosign Routine Visit" or "Cosign amendment". */
  readonly heading: string;
  /** The few facts that say what is being cosigned (the service date, the amendment's reason and sections). */
  readonly facts: readonly CosignFact[];
}

const COPY: Readonly<
  Record<CosignSubjectKind, { acknowledge: string; release: string; legal: string }>
> = {
  note: {
    acknowledge:
      "Confirms you have opened this encounter for cosignature review. This does not sign it.",
    release: "Releases this encounter from the 48-hour cosignature hard cap.",
    legal: "I attest I have reviewed this documentation and concur as the qualifying cosigner.",
  },
  addendum: {
    acknowledge:
      "Confirms you have opened this amendment for cosignature review. This does not sign it.",
    release:
      "Releases this amendment from the 48-hour cosignature hard cap. An RN still has to sign it.",
    legal:
      "I attest I have reviewed this amendment to the signed documentation and concur as the qualifying cosigner.",
  },
};

function Fact({ label, value, mono }: CosignFact): JSX.Element {
  return (
    <div style={factRow}>
      <span style={factLabel}>{label}</span>
      <span style={{ ...factValue, fontFamily: mono ? t.fontMono : undefined }}>{value}</span>
    </div>
  );
}

/** The refusal in words (announced assertively), with the way to re-authenticate beside it when that is the fix. */
function CeremonyError({ ceremony }: { readonly ceremony: CosignCeremony }): JSX.Element | null {
  if (ceremony.error === null) return null;
  return (
    <p role="alert" aria-live="assertive" style={alertStyle}>
      {ceremony.error}
      {ceremony.reauthenticateHref ? (
        <>
          {" "}
          <Link to={ceremony.reauthenticateHref} style={alertLink}>
            Re-authenticate
          </Link>
        </>
      ) : null}
    </p>
  );
}

export function CosignCeremonyModals({
  ceremony,
  subject,
  heading,
  facts,
}: CosignCeremonyModalsProps): JSX.Element {
  const reasonId = useId();
  const countId = useId();
  const copy = COPY[subject];
  const reasonLength = ceremony.reason.trim().length;
  return (
    <>
      <CeremonyModal
        open={ceremony.step === "acknowledge"}
        title="Acknowledge cosignature request"
        attestation={
          <div style={stack}>
            <span style={hint}>{copy.acknowledge}</span>
            <CeremonyError ceremony={ceremony} />
          </div>
        }
        signer={{ name: "Cosigner", role: "This session" }}
        commitLabel={ceremony.busy ? "Acknowledging…" : "Acknowledge"}
        commitBlocked={ceremony.busy}
        onCommit={() => void ceremony.commit()}
        onCancel={ceremony.close}
      />

      <CeremonyModal
        open={ceremony.step === "sign"}
        title="Sign cosignature"
        attestation={
          <div style={stack}>
            <div style={headingRow}>
              <Glyph name="shield" size={16} />
              <strong>{heading}</strong>
            </div>
            {facts.map((fact) => (
              <Fact key={fact.label} {...fact} />
            ))}
            <CeremonyError ceremony={ceremony} />
          </div>
        }
        legalText={copy.legal}
        signer={{ name: "Cosigning RN", role: "This session" }}
        commitLabel={ceremony.busy ? "Signing…" : "Sign & commit"}
        commitBlocked={ceremony.busy}
        onCommit={() => void ceremony.commit()}
        onCancel={ceremony.close}
      />

      <CeremonyModal
        open={ceremony.step === "release"}
        title="Supervisor release"
        attestation={
          <div style={{ ...stack, gap: "0.6rem" }}>
            <span style={hint}>{copy.release}</span>
            <label htmlFor={reasonId} style={reasonLabel}>
              Reason (≥ {RELEASE_REASON_MIN} characters)
            </label>
            <textarea
              id={reasonId}
              aria-describedby={countId}
              value={ceremony.reason}
              onChange={(event) => ceremony.setReason(event.target.value)}
              rows={3}
              style={{ ...textareaStyle, ...(ceremony.reasonError ? textareaErrorStyle : null) }}
              aria-invalid={ceremony.reasonError !== null}
            />
            {ceremony.reasonError ? (
              <span role="alert" style={fieldError}>
                {ceremony.reasonError}
              </span>
            ) : null}
            <span
              id={countId}
              style={{
                fontSize: "0.7rem",
                color: reasonLength >= RELEASE_REASON_MIN ? t.onSurfaceVariant : t.warning,
              }}
            >
              {reasonLength}/{RELEASE_REASON_MIN}
            </span>
            <CeremonyError ceremony={ceremony} />
          </div>
        }
        signer={{ name: "Supervisor", role: "This session" }}
        commitLabel={ceremony.busy ? "Releasing…" : "Release"}
        commitBlocked={ceremony.busy}
        onCommit={() => void ceremony.commit()}
        onCancel={ceremony.close}
      />
    </>
  );
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.5rem" };
const headingRow: CSSProperties = { display: "flex", alignItems: "center", gap: "0.4rem" };
const hint: CSSProperties = { fontSize: "0.8125rem", color: t.onSurfaceVariant };
const factRow: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.1rem" };
const factLabel: CSSProperties = { fontSize: "0.7rem", color: t.onSurfaceVariant };
const factValue: CSSProperties = { fontSize: "0.85rem", color: t.onSurface };
const reasonLabel: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: t.onSurfaceVariant,
};
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.8rem", color: t.error };
const alertLink: CSSProperties = { color: t.primary, fontWeight: 650 };
const fieldError: CSSProperties = { fontSize: "0.7rem", lineHeight: 1.35, color: t.error };
const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.65rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontFamily: t.fontSans,
  fontSize: "0.85rem",
  resize: "vertical",
};
const textareaErrorStyle: CSSProperties = {
  borderColor: t.error,
  boxShadow: "0 0 0 1px color-mix(in srgb, var(--color-error) 25%, transparent)",
};
