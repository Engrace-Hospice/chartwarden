// @chartwarden/ui web — FactList: "what settles this step", as facts that hold or do not yet. Each row pairs an icon with its state in
// words (Met / Not yet / Blocked), so the list reads the same in grayscale and to a screen reader. `info` is a plain note (no verdict).
// Rules live in styles/list-chrome.css (`wx-fact-list*`).
import type { JSX, ReactNode } from "react";
import { Glyph, type GlyphName } from "../system/glyphs";

export type FactState = "ok" | "pending" | "blocked" | "info";

export interface Fact {
  readonly key: string;
  readonly label: ReactNode;
  readonly state: FactState;
  readonly detail?: ReactNode;
}

export interface FactListProps {
  readonly facts: readonly Fact[];
  readonly ariaLabel?: string;
}

const GLYPH: Record<FactState, GlyphName> = {
  ok: "check-circle",
  pending: "clock",
  blocked: "block",
  info: "info",
};
const WORDS: Record<FactState, string | null> = {
  ok: "Met",
  pending: "Not yet",
  blocked: "Blocked",
  info: null,
};

export function FactList({ facts, ariaLabel = "Facts" }: FactListProps): JSX.Element | null {
  if (facts.length === 0) return null;
  return (
    <ul className="wx-fact-list" aria-label={ariaLabel}>
      {facts.map((fact) => (
        <li key={fact.key} className={`wx-fact is-${fact.state}`}>
          <Glyph name={GLYPH[fact.state]} size={16} strokeWidth={2} />
          <span className="wx-fact-body">
            <span className="wx-fact-label">
              {WORDS[fact.state] ? <span className="wx-sr-only">{WORDS[fact.state]}: </span> : null}
              {fact.label}
            </span>
            {fact.detail ? <span className="wx-fact-detail">{fact.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
