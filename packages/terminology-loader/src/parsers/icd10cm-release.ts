// packages/terminology-loader/src/parsers/icd10cm-release.ts (moved from scripts/db/lib, which re-exports it) — pure parsers for the CDC/NCHS ICD-10-CM release files (F-238).
//
// The M38 `concept_icd10cm` table is platform reference data whose production loader was never in this
// repository, so every stack ran with an EMPTY ICD-10-CM and nothing could answer "is this code valid on
// the date it was written?". `scripts/db/load-icd10cm.ts` loads the real release; this module is the IO-free
// half it is built from, so the parsing rules are unit-tested against fixtures, not trusted.
//
// THE FILES (one fiscal-year release, effective October 1; NCHS publishes them, CMS re-hosts them):
//   icd10cm-order-YYYY.txt          every code, headers included, fixed-width:
//                                   cols 1-5 order no · 7-13 code (no dot) · 15 billable flag (1 = valid for
//                                   HIPAA-covered transactions, 0 = header) · 17-76 short title · 78- long title
//   icd10cm-order-addenda-YYYY.txt  what changed vs the prior October: `Add:` / `Delete:` / `Revise from:` /
//                                   `Revise to:` + billable flag + code + titles
//   icd10cm-tabular-YYYY.xml        the Tabular List: chapters → sections → nested <diag>, each carrying its
//                                   instructional notes (codeFirst, useAdditionalCode, codeAlso, excludes1/2)
//
// WHAT IS DERIVED, AND HOW (each a documented convention, not a guess):
//   • parent       the longest proper prefix of the code that is itself a code in the same release
//                  (placeholder `X`s stripped first: T81.4XXA → T81.4).
//   • chapter      from the Tabular chapter the code (or its nearest listed ancestor) sits in.
//   • instructional notes INHERIT downward (ICD-10-CM Official Guidelines I.A.12–13: a note at a category
//                  applies to every subcategory and code under it), so each code's `hasCodeFirstNote` /
//                  `useAdditionalCode` flags are the union over its ancestors; the note TEXT is kept only at
//                  the code that states it (`noteSource` points there) to keep 98k rows small.
//   • manifestation  a code whose title (or an ancestor's) reads "in (other) diseases classified elsewhere" —
//                  ICD-10-CM's own marker for manifestation codes, which may never be sequenced first
//                  (Guidelines I.A.13 "Etiology/manifestation convention").

/** Dotted display form: `I5022` → `I50.22`; three-character categories stay bare (`I10`). */
export function dotted(code: string): string {
  const c = code.trim().toUpperCase().replace(".", "");
  return c.length > 3 ? `${c.slice(0, 3)}.${c.slice(3)}` : c;
}

/** Undotted, upper-case key form (`i50.22` → `I5022`). */
export function bare(code: string): string {
  return code.trim().toUpperCase().replace(".", "");
}

export interface OrderEntry {
  /** Undotted code, as in the file. */
  readonly code: string;
  readonly billable: boolean;
  readonly shortTitle: string;
  readonly longTitle: string;
}

const ICD10CM_CODE = /^[A-Z][0-9A-Z]{2,6}$/;

/**
 * Parse `icd10cm-order-YYYY.txt`. Throws on a malformed line rather than skipping it silently.
 * `codePattern` lets the ICD-10-PCS order file (same layout, codes may start with a digit) reuse this reader.
 */
export function parseOrderFile(text: string, codePattern: RegExp = ICD10CM_CODE): OrderEntry[] {
  const out: OrderEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    const code = line.slice(6, 13).trim();
    const flag = line.slice(14, 15);
    if (!/^\d{5}$/.test(line.slice(0, 5)) || !codePattern.test(code) || !/^[01]$/.test(flag)) {
      throw new Error(
        `order file line ${i + 1} is not in the NCHS fixed-width layout: ${JSON.stringify(line.slice(0, 40))}`,
      );
    }
    out.push({
      code,
      billable: flag === "1",
      shortTitle: line.slice(16, 76).trim(),
      longTitle: line.slice(77).trim(),
    });
  }
  return out;
}

export type AddendaAction = "add" | "delete" | "revise_from" | "revise_to";
export interface AddendaEntry {
  readonly action: AddendaAction;
  readonly code: string;
  readonly billable: boolean;
  readonly title: string;
}

/** Parse `icd10cm-order-addenda-YYYY.txt`. */
export function parseOrderAddenda(text: string): AddendaEntry[] {
  const out: AddendaEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(Add|Delete|Revise from|Revise to):\s+([01])\s+([A-Z][0-9A-Z]{2,6})\s+(.*)$/.exec(
      line,
    );
    if (!m) continue;
    const action = (
      {
        Add: "add",
        Delete: "delete",
        "Revise from": "revise_from",
        "Revise to": "revise_to",
      } as const
    )[m[1] as "Add" | "Delete" | "Revise from" | "Revise to"];
    // The line carries the short title (60 cols) then the long title; keep the long one.
    const rest = m[4] as string;
    out.push({
      action,
      billable: m[2] === "1",
      code: m[3] as string,
      title: (rest.length > 61 ? rest.slice(61) : rest).trim(),
    });
  }
  return out;
}

export interface TabularNotes {
  readonly codeFirst: readonly string[];
  readonly useAdditionalCode: readonly string[];
  readonly codeAlso: readonly string[];
  readonly excludes1: readonly string[];
  readonly excludes2: readonly string[];
}

export interface TabularDiag {
  /** Undotted. */
  readonly code: string;
  readonly title: string;
  /** Chapter number as printed ("9"). */
  readonly chapter: string;
  readonly chapterTitle: string;
  readonly notes: TabularNotes;
}

const NOTE_KINDS = [
  "codeFirst",
  "useAdditionalCode",
  "codeAlso",
  "excludes1",
  "excludes2",
] as const;
type NoteKind = (typeof NOTE_KINDS)[number];

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

/**
 * Parse the Tabular List XML into one entry per <diag>. A small tag walker, not a general XML parser: the
 * NCHS tabular file is machine-generated, attribute-free on the elements read here, and has no CDATA or
 * comments inside <diag> — the fixture test pins that shape.
 */
export function parseTabular(xml: string): TabularDiag[] {
  const out: TabularDiag[] = [];
  const tokens = /<(\/?)([A-Za-z0-9]+)[^>]*?(\/?)>|([^<]+)/g;
  const stack: string[] = [];
  let chapter = "";
  let chapterTitle = "";
  interface Open {
    code: string;
    title: string;
    notes: Record<NoteKind, string[]>;
  }
  const diags: Open[] = [];
  let text = "";
  let noteKind: NoteKind | null = null;
  for (const m of xml.matchAll(tokens)) {
    const [, close, name, selfClose, chars] = m;
    if (chars !== undefined) {
      text += chars;
      continue;
    }
    const tag = name as string;
    if (selfClose) continue;
    if (!close) {
      stack.push(tag);
      text = "";
      if (tag === "diag") diags.push({ code: "", title: "", notes: emptyNotes() });
      if ((NOTE_KINDS as readonly string[]).includes(tag)) noteKind = tag as NoteKind;
      continue;
    }
    // closing tag
    stack.pop();
    const parent = stack[stack.length - 1];
    const value = decode(text);
    text = "";
    if (tag === "name" && parent === "chapter") chapter = value;
    else if (tag === "desc" && parent === "chapter") chapterTitle = value;
    else if (tag === "name" && parent === "diag")
      (diags[diags.length - 1] as Open).code = value.replace(".", "");
    else if (tag === "desc" && parent === "diag") (diags[diags.length - 1] as Open).title = value;
    else if (tag === "note" && noteKind && parent === noteKind)
      (diags[diags.length - 1] as Open | undefined)?.notes[noteKind].push(value);
    else if ((NOTE_KINDS as readonly string[]).includes(tag)) noteKind = null;
    else if (tag === "diag") {
      const d = diags.pop() as Open;
      out.push({ code: d.code, title: d.title, chapter, chapterTitle, notes: d.notes });
    }
  }
  return out;
}

function emptyNotes(): Record<NoteKind, string[]> {
  return { codeFirst: [], useAdditionalCode: [], codeAlso: [], excludes1: [], excludes2: [] };
}

/** The M38 `properties` jsonb for one ICD-10-CM concept (see the header for each derivation). */
export interface Icd10cmConceptProperties {
  readonly shortTitle: string;
  /** Inherited: this code or an ancestor carries a "Code first" note. Often conditional ("code first, if applicable, …") — advisory; only `manifestation` is a hard sequencing rule. */
  readonly hasCodeFirstNote: boolean;
  /** Inherited: this code or an ancestor carries a "Use additional code" note. */
  readonly useAdditionalCode: boolean;
  /** "in (other) diseases classified elsewhere" — never sequenced first. */
  readonly manifestation: boolean;
  /** Notes stated AT this code (not inherited), verbatim. Omitted when empty. */
  readonly notes?: Partial<Record<NoteKind, readonly string[]>>;
  /** Undotted codes of the ancestors whose notes this code inherits (nearest first). */
  readonly noteSources?: readonly string[];
}

export interface Icd10cmConceptRow {
  /** Dotted. */
  readonly code: string;
  readonly display: string;
  readonly isBillableLeaf: boolean;
  readonly chapter: string | null;
  /** Dotted, or null for a three-character category. */
  readonly parentCode: string | null;
  readonly properties: Icd10cmConceptProperties;
}

const MANIFESTATION = /\bin (?:other )?diseases classified elsewhere\b/i;

/** Nearest existing ancestor by prefix (placeholder X's stripped first), or null. */
export function parentOf(code: string, known: ReadonlySet<string>): string | null {
  let c = bare(code);
  for (let n = c.length - 1; n >= 3; n--) {
    c = c.slice(0, n);
    const stripped = c.replace(/X+$/, "");
    if (stripped.length >= 3 && stripped !== c && known.has(stripped)) return stripped;
    if (known.has(c)) return c;
  }
  return null;
}

/** Combine an order file (the code list) with the tabular (chapters + notes) into concept rows. */
export function buildConceptRows(
  order: readonly OrderEntry[],
  tabular: readonly TabularDiag[],
): Icd10cmConceptRow[] {
  const known = new Set(order.map((e) => e.code));
  const tab = new Map(tabular.map((d) => [d.code, d]));
  const titles = new Map(order.map((e) => [e.code, e.longTitle]));
  const parents = new Map<string, string | null>();
  for (const e of order) parents.set(e.code, parentOf(e.code, known));

  const ancestors = (code: string): string[] => {
    const chain: string[] = [];
    let p = parents.get(code) ?? null;
    while (p) {
      chain.push(p);
      p = parents.get(p) ?? null;
    }
    return chain;
  };

  return order.map((e) => {
    const chain = ancestors(e.code);
    const lineage = [e.code, ...chain];
    const own = tab.get(e.code);
    const nearestTab = lineage.map((c) => tab.get(c)).find(Boolean);
    const withNotes = (kind: NoteKind) =>
      lineage.filter((c) => (tab.get(c)?.notes[kind].length ?? 0) > 0);
    const codeFirstFrom = withNotes("codeFirst");
    const useAddlFrom = withNotes("useAdditionalCode");
    const ownNotes: Partial<Record<NoteKind, readonly string[]>> = {};
    if (own) for (const k of NOTE_KINDS) if (own.notes[k].length) ownNotes[k] = own.notes[k];
    const sources = [...new Set([...codeFirstFrom, ...useAddlFrom].filter((c) => c !== e.code))];
    const properties: Icd10cmConceptProperties = {
      shortTitle: e.shortTitle,
      hasCodeFirstNote: codeFirstFrom.length > 0,
      useAdditionalCode: useAddlFrom.length > 0,
      manifestation: lineage.some((c) => MANIFESTATION.test(titles.get(c) ?? "")),
      ...(Object.keys(ownNotes).length ? { notes: ownNotes } : {}),
      ...(sources.length ? { noteSources: sources } : {}),
    };
    const parent = parents.get(e.code) ?? null;
    return {
      code: dotted(e.code),
      display: e.longTitle,
      isBillableLeaf: e.billable,
      chapter: nearestTab?.chapter ?? null,
      parentCode: parent ? dotted(parent) : null,
      properties,
    };
  });
}

export interface Deprecation {
  /** Dotted. */
  readonly code: string;
  /** Dotted billable successors in the new release (children of a code that became a header). */
  readonly successors: readonly string[];
  readonly kind: "narrower" | "none";
  readonly guidance: string;
}

/**
 * Billable codes of the PRIOR release that are no longer billable in the NEW one. A code that became a
 * header maps to its new billable children ("narrower" — pick the specific one); a code that vanished maps
 * to none (the coder must re-code from the documentation).
 */
export function deprecationsBetween(
  prior: readonly OrderEntry[],
  next: readonly OrderEntry[],
): Deprecation[] {
  const nextBillable = new Set(next.filter((e) => e.billable).map((e) => e.code));
  const nextAll = new Map(next.map((e) => [e.code, e]));
  const out: Deprecation[] = [];
  for (const e of prior) {
    if (!e.billable || nextBillable.has(e.code)) continue;
    const successors = next
      .filter((n) => n.billable && n.code.startsWith(e.code) && n.code !== e.code)
      .map((n) => dotted(n.code));
    out.push({
      code: dotted(e.code),
      successors,
      kind: successors.length ? "narrower" : "none",
      guidance: nextAll.has(e.code)
        ? `${dotted(e.code)} is a header from this release on; code to one of its ${successors.length} subcodes.`
        : `${dotted(e.code)} was deleted; re-code from the documentation.`,
    });
  }
  return out;
}

/**
 * Codes present in `next` that are neither in `prior` nor on `next`'s own October `Add:` list were added
 * by a mid-year (April 1) update to the prior fiscal year. NCHS ships the April update as PDFs only, so
 * this difference is how the loader dates them correctly instead of treating them as new on October 1.
 */
export function midYearAdditions(
  prior: readonly OrderEntry[],
  next: readonly OrderEntry[],
  nextAddenda: readonly AddendaEntry[],
): Set<string> {
  const had = new Set(prior.map((e) => e.code));
  const octoberAdds = new Set(nextAddenda.filter((a) => a.action === "add").map((a) => a.code));
  return new Set(
    next.filter((e) => !had.has(e.code) && !octoberAdds.has(e.code)).map((e) => e.code),
  );
}
