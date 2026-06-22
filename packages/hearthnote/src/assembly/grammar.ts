// packages/hearthnote/src/assembly/grammar.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The deterministic grammar primitives Layer-1 assembly applies: `${slot}` interpolation against a merged
// param/context map, and sentence finishing (capitalize the first letter, terminate with a period). Every
// function is a total, pure string transform — no locale, no randomness — so assembly stays byte-identical.
import type { SlotValue } from "./types";

/** Matches `${slot}` placeholders; `slot` is a dot/underscore/alnum identifier. */
const SLOT = /\$\{([A-Za-z0-9_.]+)\}/g;

/**
 * Replace every `${slot}` in `phrase` from `values`. An unresolved slot is left verbatim (so a missing
 * value is visible in review rather than silently dropped) — this keeps assembly total and deterministic.
 */
export function interpolate(phrase: string, values: Readonly<Record<string, SlotValue>>): string {
  return phrase.replace(SLOT, (whole, slot: string) => {
    const v = values[slot];
    return v === undefined ? whole : String(v);
  });
}

/** Capitalize the first character of a clinical sentence and ensure it ends in a single period. */
export function finishSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** Join assembled sentences within a section with a single space (deterministic separator). */
export function joinSentences(sentences: readonly string[]): string {
  return sentences.filter((s) => s.length > 0).join(" ");
}
