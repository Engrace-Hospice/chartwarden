// @wardenx/intake-extraction — the fax-packet SPLITTER (F-238): one inbound fax → the documents inside it.
//
// A hospice referral fax is a stack of separate documents (discharge summary, H&P, consults, labs, a
// transfer form, a POLST…). DocLens used to treat every run of consecutive same-type pages as ONE
// document (`groupContiguousRuns`), so two consults back to back — a pulmonology note from 2025 and a
// memory-clinic letter — became one "document", and its dates, authors and diagnoses were blended.
// Diagnosis review needs the real boundaries: a code is judged by the date of the document it was written
// in, and conflicting codes are only a conflict when they come from different documents.
//
// SIGNALS, strongest first (all read from the Docling blocks, so they survive OCR noise):
//   1. duplicate     the page's WORD SET is ≥ DUPLICATE_THRESHOLD similar to an earlier page's AND its
//                    numbers match (faxes resend pages; two days of the same flowsheet share words but not
//                    numbers). On the fixture a re-sent page scores 0.88–1.00 against its original and no
//                    other page pair exceeds 0.30. It becomes its own segment pointing at the original, and
//                    is never extracted twice.
//   2. continuation  "Page 2 of 3" (OCR often drops the digit: "Page of 3") in the page's top blocks, or the
//                    previous page ended with a short "(continued…)" line — not any sentence containing the
//                    word ("I have continued donepezil" is not a page break). A continuation never starts a
//                    document.
//   3. new header    a `section_header` among the page's first blocks → a new document starts here.
//   4. type change   the per-page classifier says a different document type.
//   Otherwise the page continues the current document.
// Pure: no IO, deterministic, so it is scored against the complex-packet fixture's answer key.

import type { ClassifiedPage } from "./pipeline";

export interface SplitterBlock {
  readonly text: string;
  readonly label: string;
}

export interface SplitterPage {
  readonly page: number;
  readonly blocks: readonly SplitterBlock[];
}

export type SegmentBoundary = "first_page" | "new_header" | "type_change" | "duplicate";

export interface PacketSegment {
  readonly pageNumbers: readonly number[];
  readonly documentType: ClassifiedPage["documentType"];
  /** Lowest classifier confidence across the segment's pages. */
  readonly confidence: number;
  /** True when any page needs human classification (unknown / below the floor): no extraction job. */
  readonly needsHumanClassification: boolean;
  /** The document's title as printed (its first section header), or null. */
  readonly title: string | null;
  /** The document's own date (ISO yyyy-mm-dd) from its header area, or null. */
  readonly documentDate: string | null;
  /** For a re-sent page: the earlier page it duplicates. Duplicates are shown, never extracted. */
  readonly duplicateOfPage: number | null;
  readonly boundary: SegmentBoundary;
}

export const DUPLICATE_THRESHOLD = 0.85;
/** Pages with fewer distinct words than this are never called duplicates (blank / near-empty pages). */
const DUPLICATE_MIN_WORDS = 25;
const HEADER_BLOCKS = 3;

const CONTINUATION_TOP = /\bpage\s*(\d{0,2})\s*(?:of|\/)\s*\d{1,2}\b/i;
const CONTINUED_BOTTOM = /^\W*\(\s*continued\b/i;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1);
}

interface Fingerprint {
  readonly words: ReadonlySet<string>;
  readonly numbers: ReadonlySet<string>;
}

function fingerprint(text: string): Fingerprint {
  const w = words(text);
  return { words: new Set(w), numbers: new Set(w.filter((x) => /\d/.test(x))) };
}

function isDuplicate(a: Fingerprint, b: Fingerprint): boolean {
  if (a.words.size < DUPLICATE_MIN_WORDS || b.words.size < DUPLICATE_MIN_WORDS) return false;
  if (jaccard(a.words, b.words) < DUPLICATE_THRESHOLD) return false;
  // Same numbers (or neither page has any): a different day's copy of the same form has different ones.
  return (
    a.numbers.size + b.numbers.size === 0 || jaccard(a.numbers, b.numbers) >= DUPLICATE_THRESHOLD
  );
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function isContinuation(page: SplitterPage, previous: SplitterPage | undefined): boolean {
  const top = page.blocks.slice(0, HEADER_BLOCKS);
  for (const b of top) {
    const m = CONTINUATION_TOP.exec(b.text);
    // "Page 1 of 3" is a first page; "Page 2 of 3" and the OCR-mangled "Page of 3" are continuations.
    if (m && m[1] !== "1") return true;
  }
  const tail = previous?.blocks.slice(-2) ?? [];
  return tail.some((b) => b.text.length <= 80 && CONTINUED_BOTTOM.test(b.text));
}

function headerTitle(page: SplitterPage): string | null {
  const h = page.blocks.slice(0, HEADER_BLOCKS).find((b) => b.label === "section_header");
  return h ? h.text.replace(/\s+/g, " ").trim() : null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** A date labelled as the patient's birth date is never the document's date. */
const BIRTH_LABEL = /\b(?:dob|d\.o\.b|date\s+of\s+birth|birth\s*date|born)\W*$/i;

/**
 * Labels that name THE document's date, in priority order: a discharge summary is dated by its discharge,
 * not its admission; a report by its exam/study/visit/service date. Unlabelled dates come after these.
 */
const DATE_LABELS: readonly RegExp[] = [
  /\bdischarged?\s*(?:date)?\W*$/i,
  /\b(?:date\s+of\s+service|service\s+date|exam\s+date|study\s+date|visit|transfer\s+date|referral\s+date)\W*$/i,
  /\bdate\W*$/i,
];

const iso = (y: string | number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The document's date from its header area: a labelled date by {@link DATE_LABELS} priority, else the first
 * unlabelled one; never a date labelled as a birth date. mm/dd/yyyy (OCR-tolerant spacing) or a spelled
 * date ("March 10, 2025" — OCR may split the day, "March 1 0 ,", and float the year before the month).
 */
export function headerDate(page: SplitterPage, blocks = 6): string | null {
  const text = page.blocks
    .slice(0, blocks)
    .map((b) => b.text)
    .join(" ");
  const found: { date: string; rank: number; at: number }[] = [];
  for (const n of text.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})\b/g)) {
    const before = text.slice(Math.max(0, (n.index ?? 0) - 32), n.index);
    if (BIRTH_LABEL.test(before)) continue;
    const m = Number(n[1]);
    const d = Number(n[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) continue;
    const rank = DATE_LABELS.findIndex((re) => re.test(before));
    found.push({
      date: iso(n[3] as string, m, d),
      rank: rank < 0 ? DATE_LABELS.length : rank,
      at: n.index ?? 0,
    });
  }
  if (found.length)
    return (found.sort((a, b) => a.rank - b.rank || a.at - b.at)[0] as { date: string }).date;

  const spelled = new RegExp(
    `\\b(${MONTHS.join("|")})\\s+(\\d)\\s?(\\d)?\\b(?:\\s*,?\\s*((?:19|20)\\d{2})\\b)?`,
    "i",
  ).exec(text);
  if (spelled) {
    const m = MONTHS.indexOf((spelled[1] as string).toLowerCase()) + 1;
    const d = Number(`${spelled[2]}${spelled[3] ?? ""}`);
    // The year follows the day, or OCR read it just before the month line.
    const year =
      spelled[4] ??
      /\b((?:19|20)\d{2})\b\W*$/.exec(
        text.slice(Math.max(0, spelled.index - 16), spelled.index),
      )?.[1];
    if (year && d >= 1 && d <= 31) return iso(year, m, d);
  }
  // Layout OCR can also emit the day AFTER the year, from the next text line: "March 2025" · "10,".
  const split = new RegExp(
    `\\b(${MONTHS.join("|")})\\s+((?:19|20)\\d{2})\\s+(\\d{1,2})\\s*,`,
    "i",
  ).exec(text);
  if (split) {
    const d = Number(split[3]);
    if (d >= 1 && d <= 31)
      return iso(split[2] as string, MONTHS.indexOf((split[1] as string).toLowerCase()) + 1, d);
  }
  return null;
}

/** Split a parsed fax into its documents. `classified` carries the per-page classifier verdicts. */
export function splitPacket(
  pages: readonly SplitterPage[],
  classified: readonly ClassifiedPage[],
): PacketSegment[] {
  const ordered = [...pages].sort((a, b) => a.page - b.page);
  const verdict = new Map(classified.map((c) => [c.pageNumber, c]));
  const fingerprints = new Map<number, Fingerprint>();
  const segments: {
    pages: SplitterPage[];
    type: ClassifiedPage["documentType"];
    duplicateOf: number | null;
    boundary: SegmentBoundary;
  }[] = [];

  ordered.forEach((page, i) => {
    const prev = ordered[i - 1];
    const type = verdict.get(page.page)?.documentType ?? "unknown";
    const print = fingerprint(page.blocks.map((b) => b.text).join(" "));
    let duplicateOf: number | null = null;
    for (const [earlier, fp] of fingerprints) {
      if (isDuplicate(print, fp)) {
        duplicateOf = earlier;
        break;
      }
    }
    fingerprints.set(page.page, print);
    const current = segments[segments.length - 1];

    let boundary: SegmentBoundary | null = null;
    if (!current) boundary = "first_page";
    else if (duplicateOf !== null) boundary = "duplicate";
    else if (current.duplicateOf !== null)
      boundary = "new_header"; // a page after a re-sent page starts fresh
    else if (isContinuation(page, prev)) boundary = null;
    else if (headerTitle(page)) boundary = "new_header";
    else if (type !== current.type) boundary = "type_change";

    if (boundary === null && current) {
      current.pages.push(page);
    } else {
      segments.push({ pages: [page], type, duplicateOf, boundary: boundary ?? "first_page" });
    }
  });

  return segments.map((s) => {
    const nums = s.pages.map((p) => p.page);
    const verdicts = nums.map((n) => verdict.get(n));
    const first = s.pages[0] as SplitterPage;
    // A document's type is its first page's verdict; continuation pages often classify weakly.
    const firstVerdict = verdicts[0];
    return {
      pageNumbers: nums,
      documentType: firstVerdict?.documentType ?? "unknown",
      confidence: Math.min(...verdicts.map((v) => v?.confidence ?? 0)),
      needsHumanClassification:
        !firstVerdict ||
        firstVerdict.needsHumanClassification ||
        firstVerdict.documentType === "unknown",
      title: headerTitle(first),
      documentDate: headerDate(first),
      duplicateOfPage: s.duplicateOf,
      boundary: s.boundary,
    };
  });
}
