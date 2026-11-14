// @chartwarden/ui web — a data change while the compliance officer's go-live attestation is waiting for approval voids that attestation
// (the server does it in the same transaction): say so BEFORE anything is saved. Hoisted from the admin and the tenant onboarding wizards;
// the view is structural (`{ goLive: { state } }`), so either lane's wizard view fits, and `audience` picks the lane's wording.
import type { JSX } from "react";
import { InlineAlert } from "./inline-alert";

export type PendingAttestationAudience = "operator" | "tenant";

const MESSAGE: Readonly<Record<PendingAttestationAudience, string>> = {
  operator:
    "The compliance officer has attested go-live readiness. Saving a change here voids that attestation, and they will need to attest again.",
  tenant:
    "Your compliance officer has attested that you are ready to go live. Saving a change here voids that attestation, and they will need to attest again.",
};

export function PendingAttestationWarning({
  view,
  audience = "operator",
}: {
  view: { readonly goLive: { readonly state: string } };
  audience?: PendingAttestationAudience;
}): JSX.Element | null {
  if (view.goLive.state !== "awaiting_approval") return null;
  return <InlineAlert tone="warning">{MESSAGE[audience]}</InlineAlert>;
}
