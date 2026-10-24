// M36 WP 6.7 (ADR-0099 D14) - the frame EVERY state of the family contact's page sits in: a calm single column, the heading, the not-an-emergency notice
// and the agency's 24-hour number. The notice and the number are rendered here, not in the states, so no state can leave them out.
import { t } from "@chartwarden/ui";
import type { CSSProperties, JSX, ReactNode, Ref } from "react";
import { ft } from "./family-text";

const TAP_TARGET = "2.75rem";
const digitsOf = (phone: string): string => phone.replace(/[^0-9+]/g, "");

export function PhoneLine({
  label,
  phone,
}: { readonly label: string; readonly phone: string }): JSX.Element {
  return (
    <p style={phoneStyle}>
      {label}{" "}
      <a href={`tel:${digitsOf(phone)}`} style={phoneLink} translate="no">
        {phone}
      </a>
    </p>
  );
}

export interface FamilyContactFrameProps {
  readonly heading: string;
  readonly headingRef: Ref<HTMLHeadingElement>;
  /** The agency's 24-hour number: from the state once known, else from the link fragment; null when neither is available. */
  readonly agencyPhone: string | null;
  readonly bereavementPhone?: string | null;
  readonly children: ReactNode;
}

export function FamilyContactFrame({
  heading,
  headingRef,
  agencyPhone,
  bereavementPhone = null,
  children,
}: FamilyContactFrameProps): JSX.Element {
  return (
    <main lang="en" style={pageStyle}>
      <h1 ref={headingRef} tabIndex={-1} style={titleStyle}>
        {heading}
      </h1>
      <div role="note" style={noticeStyle}>
        <p style={noticeText}>{ft("family.notEmergency")}</p>
        {agencyPhone ? (
          <PhoneLine label={ft("family.contact.agencyPhone")} phone={agencyPhone} />
        ) : null}
        {bereavementPhone ? (
          <PhoneLine label={ft("family.bereavement.phone")} phone={bereavementPhone} />
        ) : null}
      </div>
      {children}
    </main>
  );
}

export const pageStyle: CSSProperties = {
  maxWidth: "40rem",
  margin: "0 auto",
  padding: "1rem",
  boxSizing: "border-box",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  overflowWrap: "anywhere",
};
export const titleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.375rem",
  color: t.onSurface,
};
const noticeStyle: CSSProperties = {
  background: t.surfaceLow,
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusMd,
  padding: t.space4,
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
};
const noticeText: CSSProperties = { margin: 0, color: t.onSurface, fontWeight: 600 };
const phoneStyle: CSSProperties = { margin: 0, color: t.onSurface };
const phoneLink: CSSProperties = {
  display: "inline-block",
  minHeight: TAP_TARGET,
  lineHeight: TAP_TARGET,
  color: t.primary,
  fontWeight: 600,
};
export const mutedStyle: CSSProperties = {
  margin: 0,
  color: t.onSurfaceVariant,
  fontSize: "0.9375rem",
};
export const tapStyle: CSSProperties = { minHeight: TAP_TARGET, width: "100%" };
