// apps/web/src/modules/34-saas/wizard — what the clearinghouse panel hands each of its cards (choice, BAA, connection, activation): who the
// drafts belong to, the persistent status line, and how a card says it is busy so the others hold still. Two writes in flight at once, or
// a write under an open editor, would bump the version the editor is pinned to and cost the member what they typed.
import type { DraftScope } from "./billing-drafts";
import type { TenantWizardView } from "./panel-props";
import type { PanelStatusControl } from "./panel-status";

export type CardId = "choice" | "baa" | "verify" | "activate";

export interface CardContext {
  readonly scope: DraftScope;
  readonly stepKey: string;
  /** The whole onboarding view: a card warns about a pending go-live attestation from it. */
  readonly wizard: TenantWizardView;
  readonly announce: PanelStatusControl["announce"];
  /** A write landed: read this step's data and the wizard again. Never rejects. */
  readonly onSettled: () => Promise<void>;
  /** A refusal showed the view had moved (a stale pin, a verification that was voided): the same reload, run for a refusal. */
  readonly onMoved: () => Promise<void>;
  /** The card has an open editor or a write in flight (`busy`), or no longer has. */
  readonly onBusy: (card: CardId, busy: boolean) => void;
  /** Another card is busy (an editor is open, a write is running): this card's controls wait. */
  readonly lockedFor: (card: CardId) => boolean;
}
