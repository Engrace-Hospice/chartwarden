// apps/web/src/modules/34-saas/wizard — the one extension point in the wizard header for "Get help" (slice 7D fills it: the help request
// dialog and the banner that says a request is open). Empty on purpose until then; nothing else renders in its place.
import type { JSX } from "react";

export function WizardHelpSlot(): JSX.Element | null {
  return null;
}
