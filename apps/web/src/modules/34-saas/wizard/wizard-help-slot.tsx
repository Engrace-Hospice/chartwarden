// apps/web/src/modules/34-saas/wizard — the extension points for "Get help" (slice 7D fills them: the help request dialog and the banner
// that says a request is open). Empty on purpose until then; nothing else renders in their place.
import type { JSX } from "react";

/** The header's Get help entry. */
export function WizardHelpSlot(): JSX.Element | null {
  return null;
}

/**
 * Where a sentence that says "ask ChartWarden" gets its link: 7D renders a link that opens a help request about `topic`. Until then the
 * sentence stands alone as text.
 */
export function AskChartWardenSlot(_props: { readonly topic: string }): JSX.Element | null {
  return null;
}
