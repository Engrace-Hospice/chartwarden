// @chartwarden/intake-extraction — the ICD-10-CM CODE SCANNER (F-238).
//
// WHY CODES ARE NOT TAKEN FROM THE MODEL. AI Governance §2.1.1 hard-blocks AI-introduced changes to codes.
// A diagnosis code DocLens shows a reviewer must be the code PRINTED on the page, so this scanner — not the
// extraction model — finds them, in the Docling text, with the page and block they sit in. The model reads
// the diagnosis wording; it never supplies a code.
//
// OCR REPAIR, AND ITS GUARD. Fax OCR systematically misreads code characters: Tesseract reads the letter I
// as 1 ("150.23" for I50.23, "110" for I10) and Z as 2 ("299.81"); EasyOCR reads 0 as o/O ("I5o.23",
// "F02. BO") and splits codes with spaces ("N18 . 4"). A repair is accepted only when BOTH hold:
//   1. the repaired string is a real ICD-10-CM code (in the loaded releases), and
//   2. that code's official title shares meaningful words with the text written next to it on the page
//      ("Hypertension (110)" → I10 "Essential (primary) hypertension") — so "BP 110/70" never becomes I10.
// A repaired code is always marked `repaired` (the reviewer is told), and when two repairs both pass, the
// scanner refuses to choose (`ambiguous`) rather than guess.

import type { CodingTerminology } from "./terminology-port";

export interface ScanBlock {
  readonly text: string;
  readonly bbox?: readonly [number, number, number, number];
}

export interface ScanPage {
  readonly page: number;
  readonly blocks: readonly ScanBlock[];
}

export interface CodeToken {
  readonly page: number;
  readonly blockIndex: number;
  /** The characters as OCR read them ("150.23"). */
  readonly raw: string;
  /** The words written next to the code on the page (its diagnosis wording), for the title check. */
  readonly context: string;
  /** Inside parentheses or after an ICD/Dx label — the only places a first-character repair is allowed. */
  readonly codeContext: boolean;
  /** "principal" when the block (or the one before) is labelled principal/primary diagnosis. */
  readonly labelledRole: "principal" | null;
  /** Dotted candidate readings, the as-read normalisation first. */
  readonly readings: readonly string[];
}

export interface ScannedCode extends Omit<CodeToken, "readings"> {
  /**
   * False for a token that only LOOKED like a code (no reading is a code, and it carries neither a letter
   * nor a decimal point — "(503)" in a phone number). Callers drop these silently instead of flagging them.
   */
  readonly codeShaped: boolean;
  /** The accepted dotted code, or null when no reading passed (unreadable / ambiguous). */
  readonly code: string | null;
  /** True when `code` differs from the characters as read. */
  readonly repaired: boolean;
  readonly ambiguous: readonly string[];
  /** Title-to-context agreement of the accepted code (shared meaningful word stems). */
  readonly agreement: number;
}

// ── tokenising ──────────────────────────────────────────────────────────────────────────────────────

const FIRST: Record<string, readonly string[]> = {
  "1": ["I"],
  l: ["I"],
  "|": ["I"],
  i: ["I"],
  "0": ["O"],
  "2": ["Z"],
  "5": ["S"],
  "8": ["B"],
  "6": ["G"],
};
const DIGIT: Record<string, readonly string[]> = {
  o: ["0"],
  O: ["0"],
  D: ["0"],
  Q: ["0"],
  I: ["1"],
  l: ["1"],
  "|": ["1"],
  i: ["1"],
  S: ["5"],
  s: ["5"],
  B: ["8"],
  Z: ["2"],
  z: ["2"],
};
const AMBIG: Record<string, readonly string[]> = {
  "0": ["O"],
  O: ["0"],
  o: ["0"],
  "1": ["I"],
  I: ["1"],
  l: ["1", "I"],
  "|": ["1", "I"],
  "8": ["B"],
  B: ["8"],
  "5": ["S"],
  S: ["5"],
  "2": ["Z"],
  Z: ["2"],
};

const TOKEN =
  /(?<![A-Za-z0-9])([A-Za-z0-9|])\s?([0-9OoIlDQSsBZz|])\s?([0-9A-Za-z|])(?:\s*[.,]\s*([0-9A-Za-z|](?:\s?[0-9A-Za-z|]){0,3}))?(?![A-Za-z0-9])/g;

/** Every way a token can read, capped; the as-read reading first. */
function readings(first: string, d2: string, d3: string, tail: string): string[] {
  const opts = (
    c: string,
    map: Record<string, readonly string[]>,
    keep: (c: string) => boolean,
  ) => [
    ...new Set([
      ...(keep(c) ? [c.toUpperCase()] : []),
      ...(map[c] ?? []),
      ...(map[c.toUpperCase()] ?? []),
    ]),
  ];
  const a = opts(first, FIRST, (c) => /[A-Za-z]/.test(c));
  const b = opts(d2, DIGIT, (c) => /\d/.test(c));
  const c = opts(d3, DIGIT, (x) => /[0-9A]/.test(x)); // 3rd char: digit, or A (C4A, D3A, M1A, Z3A…)
  const t = tail.replace(/\s/g, "");
  const tails: string[][] = [...t].map((ch) => [
    ...new Set([ch.toUpperCase(), ...(AMBIG[ch] ?? [])]),
  ]);
  let combos = [""];
  for (const set of tails) combos = combos.flatMap((p) => set.map((ch) => p + ch)).slice(0, 64);
  const out: string[] = [];
  for (const x of a)
    for (const y of b)
      for (const z of c)
        for (const tl of combos) out.push(tl ? `${x}${y}${z}.${tl}` : `${x}${y}${z}`);
  return [...new Set(out)].slice(0, 256);
}

const ROLE_LABEL = /\b(?:principal|primary)\s+(?:diagnosis|dx)\b/i;
const SECONDARY_LABEL = /\b(?:secondary|other)\s+(?:diagnos[ie]s|dx)\b/i;
const CODE_LABEL = /\b(?:icd(?:-?10)?(?:-?cm)?|dx|diagnosis code|code)\s*[:#]?\s*$/i;

/** Find code-shaped tokens and their candidate readings. Pure. */
export function findCodeTokens(pages: readonly ScanPage[]): CodeToken[] {
  const out: CodeToken[] = [];
  for (const page of pages) {
    page.blocks.forEach((block, blockIndex) => {
      const text = block.text;
      const prevText = page.blocks[blockIndex - 1]?.text ?? "";
      for (const m of text.matchAll(TOKEN)) {
        const [whole, first, d2, d3, tail = ""] = m as unknown as [
          string,
          string,
          string,
          string,
          string?,
        ];
        const at = m.index ?? 0;
        // Never part of a date, a ratio, a phone number or a measurement: "110/70", "1.5 L", "97301".
        const after = text.slice(at + whole.length, at + whole.length + 2);
        const before = text.slice(Math.max(0, at - 1), at);
        if (/^\s?[/:]\d/.test(after) || /[/:\-$]/.test(before)) continue;
        if (
          /^\s?(?:mg|mcg|ml|l|kg|g|%|cm|mm|units?)\b/i.test(
            text.slice(at + whole.length, at + whole.length + 6),
          )
        )
          continue;
        const inParens = isInParens(text, at, whole.length);
        const labelled = CODE_LABEL.test(text.slice(Math.max(0, at - 24), at));
        const lead = text.slice(0, at);
        const context = cleanContext(contextFor(text, at));
        if (!context && !inParens && !labelled) continue;
        const r = readings(first, d2, d3, tail);
        if (r.length === 0) continue; // "SBP", "1 of": a character no code can have in that position
        // A phone number's area code: "(503) 555-0161".
        if (
          /^\)\s*\d{3}[-.\s]\d{4}/.test(
            text
              .slice(at + whole.length)
              .trimStart()
              .replace(/^/, ")")
              .replace(/^\)\)/, ")"),
          )
        )
          continue;
        const asRead =
          `${first}${d2}${d3}${tail ? `.${tail.replace(/\s/g, "")}` : ""}`.toUpperCase();
        // A token that needs its FIRST character repaired is only credible where codes are written.
        const firstIsLetter = /[A-Za-z]/.test(first);
        if (!firstIsLetter && !inParens && !labelled) continue;
        if (!tail && !inParens && !labelled) continue; // a bare 3-character category only in a code context
        const roleText = `${prevText} ${lead}`;
        const lastPrincipal = roleText.search(ROLE_LABEL);
        const lastSecondary = roleText.search(SECONDARY_LABEL);
        out.push({
          page: page.page,
          blockIndex,
          raw: whole.trim(),
          context,
          codeContext: inParens || labelled,
          labelledRole:
            lastPrincipal >= 0 && lastPrincipal > lastSecondary && !SECONDARY_LABEL.test(lead)
              ? "principal"
              : null,
          readings: [asRead, ...r.filter((x) => x !== asRead)],
        });
      }
    });
  }
  return out;
}

function isInParens(text: string, at: number, len: number): boolean {
  const open = text.lastIndexOf("(", at);
  const close = text.indexOf(")", at + len);
  return open >= 0 && close >= 0 && text.lastIndexOf(")", at) < open;
}

/** The diagnosis wording a code belongs to: the text before it back to the previous code group / list mark. */
function contextFor(text: string, at: number): string {
  const head = text.slice(0, at);
  const cut = Math.max(head.lastIndexOf(")"), head.search(/\d+\s*[._)]\s+[^\d]*$/));
  return head.slice(cut >= 0 ? cut + 1 : Math.max(0, at - 100)).slice(-100);
}

function cleanContext(s: string): string {
  return s
    .replace(/[()]/g, " ")
    .replace(/^\W*\d+\s*[._)-]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── title agreement ─────────────────────────────────────────────────────────────────────────────────

const STOP = new Set([
  "with",
  "without",
  "and",
  "the",
  "of",
  "in",
  "for",
  "due",
  "to",
  "other",
  "unspecified",
  "type",
  "stage",
  "diagnosis",
  "primary",
  "principal",
  "secondary",
  "history",
  "chronic",
  "acute",
  "disease",
  "disorder",
  "dx",
  "status",
  "classified",
  "elsewhere",
  "specified",
  "not",
  "nos",
  "on",
  "or",
]);
const ABBREV: Record<string, string> = {
  chf: "congestive heart failure",
  hf: "heart failure",
  hfref: "heart failure reduced systolic",
  hfpef: "heart failure preserved diastolic",
  copd: "chronic obstructive pulmonary",
  ckd: "chronic kidney",
  esrd: "end stage renal",
  afib: "atrial fibrillation",
  af: "atrial fibrillation",
  htn: "hypertension",
  dm: "diabetes mellitus",
  t2dm: "type 2 diabetes mellitus",
  cad: "coronary artery",
  mi: "myocardial infarction",
  aud: "alcohol use",
  oud: "opioid use",
  ftt: "failure to thrive",
  uti: "urinary tract infection",
  tobacco: "tobacco nicotine",
  smoker: "tobacco nicotine",
  smoking: "tobacco nicotine",
  nicotine: "tobacco nicotine",
  oxygen: "oxygen",
  o2: "oxygen",
  pna: "pneumonia",
  cva: "cerebral infarction stroke",
  als: "amyotrophic lateral sclerosis",
};
const stems = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .flatMap((w) => (ABBREV[w] ? ABBREV[w].split(" ") : [w]))
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.slice(0, 5)),
  );

/** Shared meaningful word stems between the page wording and a code's official title. */
export function titleAgreement(context: string, display: string): number {
  const a = stems(context);
  let n = 0;
  for (const s of stems(display)) if (a.has(s)) n++;
  return n;
}

// ── resolving readings against the code set ─────────────────────────────────────────────────────────

/** Pick each token's code: the as-read reading if real, else exactly one title-agreeing repair. */
export async function resolveCodeTokens(
  tokens: readonly CodeToken[],
  terminology: CodingTerminology,
): Promise<ScannedCode[]> {
  const titles = await terminology.titles([...new Set(tokens.flatMap((t) => t.readings))]);
  const known = { has: (c: string) => titles.has(c) };
  return tokens.map((t) => {
    const { readings: rs, ...rest } = t;
    const asRead = rs[0] as string;
    const codeShaped = /^[A-Z]/.test(asRead) || asRead.includes(".");
    if (known.has(asRead)) {
      const agreement = titleAgreement(t.context, titles.get(asRead) ?? "");
      // Outside a code context, a code-shaped token must also MEAN the words around it: "T 37.2 C" is a
      // temperature, not T37.2.
      if (t.codeContext || agreement > 0)
        return {
          ...rest,
          codeShaped: true,
          code: asRead,
          repaired: false,
          ambiguous: [],
          agreement,
        };
    }
    const passing = rs
      .slice(1)
      .filter((r) => known.has(r))
      .map((r) => ({ r, score: titleAgreement(t.context, titles.get(r) ?? "") }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = passing[0];
    if (!best || (passing[1] && passing[1].score === best.score)) {
      return {
        ...rest,
        codeShaped: codeShaped && t.codeContext,
        code: null,
        repaired: false,
        ambiguous: passing.map((x) => x.r),
        agreement: 0,
      };
    }
    return {
      ...rest,
      codeShaped: true,
      code: best.r,
      repaired: true,
      ambiguous: [],
      agreement: best.score,
    };
  });
}
