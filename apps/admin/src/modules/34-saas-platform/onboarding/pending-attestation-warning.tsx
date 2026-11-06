// apps/admin/src/modules/34-saas-platform/onboarding — a data change while the compliance officer's go-live attestation is waiting
// for approval voids that attestation (the server does it in the same transaction): say so BEFORE the operator saves.
import { InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";
import type { WizardView } from "./wizard-model";

export function PendingAttestationWarning({ view }: { view: WizardView }): JSX.Element | null {
  if (view.goLive.state !== "awaiting_approval") return null;
  return (
    <InlineAlert tone="warning">
      The compliance officer has attested go-live readiness. Saving a change here voids that
      attestation, and they will need to attest again.
    </InlineAlert>
  );
}
