// M36 WP 5.6 (ADR-0086, PROPOSED) - the "Legal hold" chip. The server sends `legalHold: true` only to a viewer who holds
// `messaging.retention.manage` (that a hold exists is not for ordinary readers to learn), so this renders nothing for anyone else.
// A shared-kit pill with a lock glyph and the words "Legal hold": the meaning is never carried by colour alone. It is a display marker; it
// says the message is covered by an active hold, not who placed it or why.
import { StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import * as W from "./retention-wording";
import "./legal-hold-chip.css";

export function LegalHoldChip({
  scope = "message",
}: {
  /** `message`: this message is held. `thread`: at least one message in this thread is held. */
  readonly scope?: "message" | "thread";
}): JSX.Element {
  return (
    <span
      className="wx-legal-hold-chip"
      role="note"
      aria-label={scope === "thread" ? W.LEGAL_HOLD_THREAD_ARIA : W.LEGAL_HOLD_MESSAGE_ARIA}
    >
      <StatusPill tone="warning" glyph="lock" label={W.LEGAL_HOLD_CHIP_TEXT} />
    </span>
  );
}
