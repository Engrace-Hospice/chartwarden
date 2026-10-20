// apps/web/src/shell — shared presentation + search for names resolved by usePatientNames / usePhysicianNames.
// A resolved-name value is tri-state: `undefined` = lookup still pending, `null` = settled with nothing readable,
// string = the name. The two non-name states must read differently on screen (still loading vs. unavailable).
import type { JSX } from "react";
import type { PatientNames } from "./patient-names";

export const NAME_LOADING_LABEL = "Loading…";
export const NAME_UNAVAILABLE_LABEL = "Name unavailable";

/** The patient's resolved name in the tri-state form `NameLabel` / `nameText` take. */
export function patientNameOf(names: PatientNames, id: string): string | null | undefined {
  const entry = names[id];
  return entry === undefined ? undefined : (entry?.name ?? null);
}

export function nameText(value: string | null | undefined): string {
  if (value === undefined) return NAME_LOADING_LABEL;
  return value ?? NAME_UNAVAILABLE_LABEL;
}

const MUTED = { color: "var(--color-on-surface-variant)", fontStyle: "italic" } as const;

export function NameLabel({ value }: { value: string | null | undefined }): JSX.Element {
  if (value === undefined)
    return (
      <span style={MUTED} aria-busy="true">
        {NAME_LOADING_LABEL}
      </span>
    );
  if (value === null) return <span style={MUTED}>{NAME_UNAVAILABLE_LABEL}</span>;
  return <>{value}</>;
}

/**
 * Worklist search: every whitespace/comma separated token of `query` must appear somewhere in the fields, so
 * "ada lovelace" finds a patient stored as "Lovelace, Ada". Empty fields are skipped; an empty query matches.
 */
export function matchesAllTokens(
  fields: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const tokens = query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = fields.filter(Boolean).join("\n").toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}
