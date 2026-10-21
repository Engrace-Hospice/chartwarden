// @chartwarden/terminology-loader — validation helpers shared by every per-system parser. A parser is strict by
// design: a row it cannot read FAILS the load (with a line number or code, never the row's text), because a
// silently-skipped row in a code system is a code that validates as "unknown" for every tenant.
import { LoaderDataError } from "../errors";
import type { ConceptStatus, LoadableSystemId, ParsedConcept, ParsedSource } from "../types";

const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validIso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Normalise a source date (`YYYYMMDD`, `M/D/YYYY` or `YYYY-MM-DD`) to ISO; blank → null; anything else —
 * including an impossible calendar date — throws, naming the field.
 */
export function parseDate(raw: string | undefined, field: string): string | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  let iso: string | null = null;
  const c = COMPACT_DATE.exec(s);
  const u = US_DATE.exec(s);
  if (c) iso = validIso(Number(c[1]), Number(c[2]), Number(c[3]));
  else if (u) iso = validIso(Number(u[3]), Number(u[1]), Number(u[2]));
  else if (ISO_DATE.test(s))
    iso = validIso(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)));
  if (iso === null) throw new LoaderDataError("DATE_INVALID", `${field} is not a valid date`);
  return iso;
}

/** Throw unless `code` matches the system's code grammar. */
export function assertCodeShape(
  system: LoadableSystemId,
  code: string,
  pattern: RegExp,
  where: string,
): void {
  if (!pattern.test(code)) {
    throw new LoaderDataError("CODE_INVALID", `${system} ${where}: code does not match ${pattern}`);
  }
}

/** Reject a display that is empty (a concept with no label is unusable in every picker). */
export function assertDisplay(system: LoadableSystemId, display: string, where: string): void {
  if (display.trim() === "") {
    throw new LoaderDataError("DISPLAY_EMPTY", `${system} ${where}: empty display`);
  }
}

/** Build the result, enforcing non-empty + unique codes (the staging PK would reject a duplicate anyway). */
export function finish(
  system: LoadableSystemId,
  concepts: readonly ParsedConcept[],
  warnings: readonly string[] = [],
): ParsedSource {
  if (concepts.length === 0) {
    throw new LoaderDataError("SOURCE_EMPTY", `${system}: the source produced no concepts`);
  }
  const seen = new Set<string>();
  for (const c of concepts) {
    if (seen.has(c.code)) {
      throw new LoaderDataError(
        "DUPLICATE_CODE",
        `${system}: code '${c.code}' appears twice in the source`,
      );
    }
    seen.add(c.code);
  }
  return { system, concepts, warnings };
}

/** Convenience constructor for a parsed concept. */
export function concept(
  code: string,
  display: string,
  status: ConceptStatus,
  fields: {
    readonly effectiveDate?: string | null;
    readonly endDate?: string | null;
    readonly properties?: Readonly<Record<string, unknown>>;
  } = {},
): ParsedConcept {
  return {
    code,
    display,
    status,
    effectiveDate: fields.effectiveDate ?? null,
    endDate: fields.endDate ?? null,
    properties: fields.properties ?? {},
  };
}

/** A CPT-shaped code (5 digits, or 4 digits + F/M/T/U) belongs to AMA's licensed set — never loadable (D4). */
const CPT_SHAPE = /^\d{4}[0-9FMTU]$/;

/** Throw if a code looks like CPT. Level II HCPCS never starts with a digit, so this cannot reject real HCPCS. */
export function rejectCptShaped(code: string, system: LoadableSystemId): void {
  if (CPT_SHAPE.test(code)) {
    throw new LoaderDataError(
      "CPT_NOT_LOADABLE",
      `${system}: a CPT-shaped code is present; CPT is AMA-licensed and deferred (D4)`,
    );
  }
}
