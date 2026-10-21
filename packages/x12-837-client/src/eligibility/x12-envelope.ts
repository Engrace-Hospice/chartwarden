// @chartwarden/x12-837-client — the minimal X12 interchange tokenizer + date helpers the HETS 270/271 codec
// shares. Pure (no IO). ADR-0037: X12 parsing is TypeScript in this M23-owned package, not a sidecar.
//
// The delimiters are read from the ISA header itself (X12.5 / TR3 005010X279A1): the element separator is
// the character right after "ISA", the component separator is ISA16 and the segment terminator is the
// character that follows ISA16. HETS answers with `*`, `|` and `~` (Companion Guide Appendix B), but a
// clearinghouse may re-envelope, so nothing here assumes those values.

/** The three delimiters an interchange declares in its ISA segment. */
export interface X12Delimiters {
  readonly element: string;
  readonly component: string;
  readonly repetition: string;
  readonly segment: string;
}

/** A tokenized interchange: delimiters + every segment split into its elements (`[id, e01, e02, …]`). */
export interface X12Interchange {
  readonly delimiters: X12Delimiters;
  readonly segments: readonly (readonly string[])[];
}

/** Thrown when a payload is not a parseable X12 interchange. Never carries payload content (PHI). */
export class X12FormatError extends Error {
  public override readonly name = "X12FormatError";
}

const ISA_ELEMENT_COUNT = 16;

/** Tokenize a raw X12 interchange. Throws {@link X12FormatError} (content-free message) when malformed. */
export function tokenizeInterchange(raw: string): X12Interchange {
  const text = raw.replace(/^﻿/, "").trimStart();
  if (!text.startsWith("ISA") || text.length < 4) {
    throw new X12FormatError("payload does not start with an ISA segment");
  }
  const element = text.charAt(3);
  // The separator at index 3 is the first of the 16; walk to the 16th (the one before ISA16).
  let cursor = 3;
  for (let seen = 1; seen < ISA_ELEMENT_COUNT; seen += 1) {
    cursor = text.indexOf(element, cursor + 1);
    if (cursor === -1) throw new X12FormatError("ISA segment is truncated");
  }
  // After the 16th separator: ISA16 (component separator), then the segment terminator.
  const component = text.charAt(cursor + 1);
  const segment = text.charAt(cursor + 2);
  if (!component || !segment) throw new X12FormatError("ISA segment is truncated");
  const isaElements = text.slice(0, cursor + 2).split(element);
  const repetition = isaElements[11] && isaElements[11].length === 1 ? isaElements[11] : "^";

  const segments = text
    .split(segment)
    .map((s) => s.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, ""))
    .filter((s) => s.length > 0)
    .map((s) => s.split(element));
  return { delimiters: { element, component, repetition, segment }, segments };
}

/** `CCYYMMDD` → ISO `CCYY-MM-DD`, or null when the value is not a valid 8-digit date. */
export function x12DateToIso(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** ISO `CCYY-MM-DD` → `CCYYMMDD`. Throws on a malformed date (caller-side programming error). */
export function isoToX12Date(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || x12DateToIso(iso.replaceAll("-", "")) === null) {
    throw new X12FormatError("date must be an ISO yyyy-mm-dd calendar date");
  }
  return iso.replaceAll("-", "");
}

/**
 * Parse a DTP03 value by its DTP02 format qualifier: `D8` is one date, `RD8` a `CCYYMMDD-CCYYMMDD` range.
 * Returns null for an unknown qualifier or a malformed value.
 */
export function parseDtpValue(
  format: string | undefined,
  value: string | undefined,
): { readonly start: string; readonly end: string | null } | null {
  if (format === "D8") {
    const start = x12DateToIso(value);
    return start ? { start, end: null } : null;
  }
  if (format === "RD8" && value) {
    const [from, to] = value.split("-");
    const start = x12DateToIso(from);
    if (!start) return null;
    return { start, end: x12DateToIso(to) };
  }
  return null;
}
