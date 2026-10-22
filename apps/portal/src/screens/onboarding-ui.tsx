import { Glyph } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import { PORTAL_BASE_PATH } from "../base-path";

/** Shared identity and accessible layout for pre-session onboarding. No patient information is shown here. */
export function PortalOnboardingBrand(): JSX.Element {
  return (
    <div className="wx-portal-auth-brand">
      <img className="wx-portal-auth-brand__mark" src={`${PORTAL_BASE_PATH}/chartwarden-mark.svg`} alt="" />
      <div><strong>ChartWarden</strong><span>Patient & Family Portal</span></div>
    </div>
  );
}

export function PortalOnboardingHeading({
  eyebrow,
  title,
  description,
}: { eyebrow: string; title: string; description?: ReactNode }): JSX.Element {
  return (
    <div className="wx-portal-auth-heading">
      <span className="wx-portal-auth-heading__eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

export function PortalOnboardingHelp(): JSX.Element {
  return (
    <p className="wx-portal-auth-help">
      <Glyph name="shield-check" size={18} />
      <span>Private, secure access. Need help? Contact your hospice care team. Never share your password or authenticator code.</span>
    </p>
  );
}
