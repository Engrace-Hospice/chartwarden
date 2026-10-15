// M36 WP 4.1 - the marker on an urgent clinical message: an icon AND words (never colour alone), readable by a screen
// reader as a labelled note. A display marker only: it says the message was sent as urgent, not that anyone was paged,
// reached or answered it.
import { Glyph } from "@wardenx/ui";
import type { JSX } from "react";
import { URGENT_BADGE_ARIA, URGENT_BADGE_TEXT } from "./urgent-wording";
import "./urgent.css";

export function UrgentBadge(): JSX.Element {
  return (
    <p className="wx-urgent-badge" role="note" aria-label={URGENT_BADGE_ARIA}>
      <Glyph name="alert" size={14} />
      <span>{URGENT_BADGE_TEXT}</span>
    </p>
  );
}
