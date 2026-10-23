// @chartwarden/x12-835-client — X12 segment tokenizer. PURE. Delimiters come from the fixed-width ISA
// header (ISA[3] element separator, ISA[104] component separator, ISA[105] segment terminator); nothing is
// hardcoded. Fails closed with {@link X12ParseError} (PHI-free messages) on garbled/truncated input.

/** A parse/validation failure. `message` is PHI-free (names the rule + counts, never claim/patient data). */
export class X12ParseError extends Error {
  public override readonly name: string = "X12ParseError";
  constructor(
    public readonly code: "X12_835_PARSE_FAILED" | "X12_835_UNBALANCED",
    message: string,
  ) {
    super(message);
  }
}

export interface X12Segment {
  /** `el[0]` is the segment id, so `CLP03` is `el[3]` (spec numbering). Use {@link elem} for safe reads. */
  readonly el: readonly string[];
}

export interface X12Document {
  readonly segments: readonly X12Segment[];
  readonly componentSeparator: string;
}

const ISA_LENGTH = 106;
const SEGMENT_ID = /^[A-Z][A-Z0-9]{1,2}$/;

/** Element `n` of a segment, trimmed; "" when absent. */
export function elem(seg: X12Segment, n: number): string {
  return (seg.el[n] ?? "").trim();
}

export function segId(seg: X12Segment): string {
  return seg.el[0] ?? "";
}

function isBadDelimiter(c: string | undefined, allowNewline: boolean): boolean {
  if (!c) return true;
  if (allowNewline && c === "\n") return false;
  return /[A-Za-z0-9\s]/.test(c);
}

function fail(message: string): never {
  throw new X12ParseError("X12_835_PARSE_FAILED", message);
}

export function tokenizeX12(raw: string): X12Document {
  const text = raw.replace(/^﻿/, "").replace(/^\s+/, "");
  if (text.length < ISA_LENGTH || !text.startsWith("ISA")) fail("not an X12 interchange (no ISA)");
  const elementSep = text.charAt(3);
  const componentSep = text.charAt(104);
  const terminator = text.charAt(105);
  if (
    isBadDelimiter(elementSep, false) ||
    isBadDelimiter(componentSep, false) ||
    isBadDelimiter(terminator, true)
  ) {
    fail("unusable ISA delimiters");
  }
  if (elementSep === componentSep || elementSep === terminator || componentSep === terminator) {
    fail("ISA delimiters are not distinct");
  }
  const isaParts = text.slice(0, 105).split(elementSep);
  if (isaParts.length !== 17 || (isaParts[16] ?? "").length !== 1) {
    fail("ISA is not the fixed 16-element header");
  }
  const pieces = text.split(terminator);
  const tail = pieces.pop() ?? "";
  if (tail.trim() !== "") fail("input is truncated (data after the last segment terminator)");
  const segments = pieces
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ el: p.split(elementSep) }));
  for (const s of segments) {
    if (!SEGMENT_ID.test(s.el[0] ?? "")) fail("garbled segment identifier");
  }
  return { segments, componentSeparator: componentSep };
}
