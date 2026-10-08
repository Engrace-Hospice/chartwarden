import { StepUpCard } from "@wardenx/ui";
// apps/web/src/modules/02-identity — Step-up Re-authentication (M2 Auth, AUTH polish).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "step-up" (/step-up). The ceremony itself (passkey +
// TOTP over /api/v1/sessions/step-up{/initiate}, the F-081 challenge decoding, the 423 lockout and the
// same-origin `?returnTo` guard) lives in the shared kit's StepUpCard (packages/ui), so the platform-ops
// console runs the same implementation; this route only supplies the tenant app's brand and footer.
import type { JSX } from "react";

export function StepUp(): JSX.Element {
  return (
    <StepUpCard
      brand={<strong>WardenX</strong>}
      footer={<a href="/login">Sign in as someone else</a>}
      signInPath="/login"
    />
  );
}
