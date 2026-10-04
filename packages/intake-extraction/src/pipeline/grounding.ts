// @wardenx/intake-extraction — DocLens quote GROUNDING (F-236, ADR-0048). Pure.
//
// The extractor model is never trusted for coordinates. It returns, per field, a value plus a VERBATIM
// quote and the page it claims the quote is on. This module finds that quote in the text Docling actually
// read (`DoclingPage.blocks`) and takes the bounding box from the block(s) it matched. Two checks, both
// fail-closed:
//
//   1. the QUOTE must occur in the parsed text (on the claimed page first, then any page — the page the
//      text is really on wins over the page the model named). A quote found nowhere ⇒ `quote_not_found`;
//      the model invented or paraphrased it, and the field is dropped.
//   2. the VALUE must occur inside the quote. A real quote with a value that is not in it (the model
//      "normalised" 503-555-0142 into a different number, or answered from elsewhere) ⇒
//      `value_not_in_quote`. The reviewer's edit is the place to normalise, not the model.
//
// Matching ignores case, whitespace runs and punctuation/quote-mark variants (OCR noise), and may span up
// to four CONSECUTIVE blocks on one page (a value split across lines). The returned box is the union of
// the matched blocks — block-level, not character-level, which is exactly as precise as Docling's
// layout is and no more.

/** Top-left origin, page points: [left, top, right, bottom]. */
export type GroundingBBox = readonly [number, number, number, number];

export interface GroundingPage {
  readonly page: number;
  readonly blocks: ReadonlyArray<{ readonly text: string; readonly bbox: GroundingBBox }>;
}

export type GroundingResult =
  | {
      readonly grounded: true;
      readonly page: number;
      readonly bbox: GroundingBBox;
      /** Whether the quote was on the page the model named. False ⇒ the true page was used. */
      readonly onClaimedPage: boolean;
    }
  | {
      readonly grounded: false;
      readonly reason: "quote_too_short" | "quote_not_found" | "value_not_in_quote";
    };

const MAX_SPAN_BLOCKS = 4;
const MIN_QUOTE_CHARS = 3;

/** Lower-case, unify quote marks/dashes, collapse whitespace. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Alphanumerics only — the comparison basis for "is this value in this quote". */
const alnum = (s: string): string => s.toLowerCase().replace(/[^0-9a-z]/g, "");

function union(boxes: readonly GroundingBBox[]): GroundingBBox {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

function findOnPage(page: GroundingPage, quote: string): GroundingBBox | null {
  const blocks = page.blocks;
  // Smallest span first: a quote inside ONE block must get that block's box, never the union with the
  // blocks before it that a first-start-wins scan would also "contain" it in.
  for (let size = 1; size <= MAX_SPAN_BLOCKS; size += 1) {
    for (let i = 0; i + size <= blocks.length; i += 1) {
      const span = blocks.slice(i, i + size);
      if (normalizeForMatch(span.map((b) => b.text).join(" ")).includes(quote)) {
        return union(span.map((b) => b.bbox));
      }
    }
  }
  return null;
}

export function groundQuote(
  pages: readonly GroundingPage[],
  claim: { readonly page: number; readonly quote: string; readonly value: string },
): GroundingResult {
  const quote = normalizeForMatch(claim.quote);
  if (alnum(quote).length < MIN_QUOTE_CHARS) return { grounded: false, reason: "quote_too_short" };
  const valueKey = alnum(claim.value);
  if (valueKey.length === 0 || !alnum(quote).includes(valueKey)) {
    return { grounded: false, reason: "value_not_in_quote" };
  }
  const claimed = pages.find((p) => p.page === claim.page);
  if (claimed) {
    const box = findOnPage(claimed, quote);
    if (box) return { grounded: true, page: claimed.page, bbox: box, onClaimedPage: true };
  }
  for (const page of pages) {
    if (page.page === claim.page) continue;
    const box = findOnPage(page, quote);
    if (box) return { grounded: true, page: page.page, bbox: box, onClaimedPage: false };
  }
  return { grounded: false, reason: "quote_not_found" };
}
