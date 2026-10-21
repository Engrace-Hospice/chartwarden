import type { JSX } from "react";
// apps/web/src/modules/02-identity — the ChartWarden brand lockup for the auth-flow cards (Sign in, MFA,
// org-select, invitations, …): the brand mark (/chartwarden-mark.svg, same asset as the sidebar) beside the
// `wx-brand` wordmark from the shared app-shell chrome. One lockup so every auth card is identical.
export function BrandLockup(): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2.5">
      <img src="/chartwarden-mark.svg" width="32" height="32" alt="" />
      <span className="wx-brand" style={{ fontSize: "1.375rem" }}>
        ChartWarden
      </span>
    </div>
  );
}
