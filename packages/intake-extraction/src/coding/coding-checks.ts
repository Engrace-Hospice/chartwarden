// @chartwarden/intake-extraction — DETERMINISTIC ICD-10-CM coding checks on a referral packet (F-238).
//
// These are rules, not AI: every flag cites the code set (M38, loaded from the CDC/NCHS release) or an
// ICD-10-CM Official Guideline / CMS hospice rule, and each one only POINTS OUT — it never changes a code,
// picks a principal diagnosis, or decides related/unrelated (AI Governance §2.1.1; the physician decides).
//
//   code_not_valid_on_date        the code was not a billable code on the date of the document it is in
//                                 (deleted, or a category/header that needs a subcode) → successors
//   code_retired_since_written    valid when written, not valid on the packet's reference date (hospice
//                                 admission / today) — re-code before any claim → successors
//   unknown_code                  not an ICD-10-CM code in any loaded release (an OCR or typing error)
//   ocr_repaired                  the code was read with OCR damage and repaired; the reviewer must confirm it
//   unreadable_code               a code-shaped token no repair could vet (or two repairs tie)
//   manifestation_code            "in diseases classified elsewhere" — never first (Guidelines I.A.13)
//   unacceptable_hospice_principal R53.81 debility / R62.7 adult failure to thrive / R54 age-related debility —
//                                 CMS does not accept them as the hospice principal diagnosis
//   symptom_code_as_principal     an R-chapter (symptoms/signs) code labelled principal (Guidelines II.A)
//   unspecified_code              the title says "unspecified" and the packet documents a more specific code
//                                 in the same category → those codes
//   combination_code_expected     hypertension coded I10 with heart failure and/or CKD documented: ICD-10-CM
//                                 presumes the link (Guidelines I.C.9.a.2–3) → I11.0 / I12.x / I13.x
//   more_specific_code_supported  E11.9 ("without complications") while CKD is documented — the "with"
//                                 convention (I.A.15) presumes diabetic CKD → E11.22
//   conflicting_codes             one condition coded differently across the packet's documents
//   resolved_condition            the document calls the condition resolved — not an active diagnosis
//   part2_sud                     F10–F19 (F17 tobacco excluded, 42 CFR §2.11) — consent gating applies

import type { ScannedCode } from "./icd-scanner";
import type { CodingTerminology, IcdCodeFacts } from "./terminology-port";

export type CodingFlagKind =
  | "code_not_valid_on_date"
  | "code_retired_since_written"
  | "unknown_code"
  | "ocr_repaired"
  | "unreadable_code"
  | "manifestation_code"
  | "unacceptable_hospice_principal"
  | "symptom_code_as_principal"
  | "unspecified_code"
  | "combination_code_expected"
  | "more_specific_code_supported"
  | "conflicting_codes"
  | "resolved_condition"
  | "part2_sud";

export interface CodingFlag {
  readonly kind: CodingFlagKind;
  /** The code the flag is about (dotted), or the raw token for an unreadable one. */
  readonly code: string;
  readonly page: number;
  readonly blockIndex: number;
  /** Codes the reviewer could consider instead — never applied automatically. */
  readonly suggest: readonly string[];
  /** Reviewer-facing explanation, citing the rule. */
  readonly detail: string;
}

/** A code found on a page, placed in its document (the splitter's segment). */
export interface CodeInDocument extends ScannedCode {
  /** ISO date of the document the code was written in (the date it is judged by), or null. */
  readonly documentDate: string | null;
  /** Splitter segment id (first page number) — conflicts are only across different documents. */
  readonly documentKey: number;
}

export interface CodingCheckInput {
  readonly codes: readonly CodeInDocument[];
  /** The packet's reference date (hospice admission / receipt): "is it valid now?" is judged on this. */
  readonly referenceDate: string;
  /** All page text, for wording-level evidence (heart failure / CKD documented without a code). */
  readonly pageText: ReadonlyMap<number, string>;
}

export const UNACCEPTABLE_HOSPICE_PRINCIPAL: Readonly<Record<string, string>> = {
  "R53.81": "debility",
  "R62.7": "adult failure to thrive",
  R54: "age-related physical debility",
};

const SUD = /^F1[0-689]\./;
const HF = /\b(?:heart failure|hfref|hfpef|chf)\b/i;
const CKD = /\b(?:chronic kidney disease|ckd)\b/i;
const RESOLVED = /\bresolved\b/i;

export async function runCodingChecks(
  input: CodingCheckInput,
  terminology: CodingTerminology,
): Promise<CodingFlag[]> {
  const flags: CodingFlag[] = [];
  const add = (
    c: Pick<ScannedCode, "page" | "blockIndex">,
    kind: CodingFlagKind,
    code: string,
    detail: string,
    suggest: readonly string[] = [],
  ) => flags.push({ kind, code, page: c.page, blockIndex: c.blockIndex, suggest, detail });

  const readable = input.codes.filter(
    (c): c is CodeInDocument & { code: string } => c.code !== null,
  );
  for (const c of input.codes.filter((x) => x.code === null && x.codeShaped)) {
    add(
      c,
      "unreadable_code",
      c.raw,
      c.ambiguous.length
        ? `"${c.raw}" could be ${c.ambiguous.join(" or ")} — check the page; WardenLens will not choose.`
        : `"${c.raw}" looks like a code but is not a valid ICD-10-CM code under any reading — check the page.`,
    );
  }

  const distinct = [...new Set(readable.map((c) => c.code))];
  const nowFacts = await terminology.lookup(distinct, input.referenceDate);
  const deprecations = await terminology.deprecations(distinct);
  const titles = await terminology.titles(distinct);
  // A document older than the earliest loaded release cannot be judged by the code set of ITS date; it is
  // judged by the earliest one loaded (and the detail says so) rather than failed for a release we lack.
  const coverageFrom = await terminology.coverageFrom();
  const judgedOn = (c: CodeInDocument) => {
    const d = c.documentDate ?? input.referenceDate;
    return coverageFrom && d < coverageFrom ? coverageFrom : d;
  };
  const byDate = new Map<string, ReadonlyMap<string, IcdCodeFacts>>();
  for (const d of new Set(readable.map(judgedOn))) {
    byDate.set(d, await terminology.lookup(distinct, d));
  }

  const allCodes = new Set(distinct);
  const allText = [...input.pageText.values()].join("\n");
  const hfDocumented = HF.test(allText) || distinct.some((c) => c.startsWith("I50."));
  const ckdCodes = distinct.filter((c) => c.startsWith("N18."));
  const ckdDocumented = CKD.test(allText) || ckdCodes.length > 0;

  for (const c of readable) {
    const code = c.code;
    const written = judgedOn(c);
    const then = byDate.get(written)?.get(code);
    const now = nowFacts.get(code);
    const dep = deprecations.get(code);
    const title = titles.get(code) ?? now?.display ?? then?.display ?? "";

    if (c.repaired)
      add(
        c,
        "ocr_repaired",
        code,
        `Read as "${c.raw}" and repaired to ${code} (${title}) — confirm against the page.`,
      );
    if (!titles.has(code)) {
      add(c, "unknown_code", code, `${code} is not an ICD-10-CM code in any loaded release.`);
      continue;
    }
    if (!then?.billable) {
      add(
        c,
        "code_not_valid_on_date",
        code,
        then
          ? `${code} is a category, not a billable code, on ${written} — it needs a more specific subcode.`
          : `${code} was not a valid ICD-10-CM code on ${written}, the date of this document.`,
        dep?.successors ?? [],
      );
    } else if (!now?.billable) {
      add(
        c,
        "code_retired_since_written",
        code,
        `${code} was valid when written (${written}) but not on ${input.referenceDate}${dep ? ` (retired ${dep.effective})` : ""} — re-code before any claim.`,
        dep?.successors ?? [],
      );
    }
    if ((now ?? then)?.manifestation) {
      add(
        c,
        "manifestation_code",
        code,
        `${code} is a manifestation code ("in diseases classified elsewhere") — it is never sequenced first; code the underlying condition first.`,
      );
    }
    if (UNACCEPTABLE_HOSPICE_PRINCIPAL[code]) {
      add(
        c,
        "unacceptable_hospice_principal",
        code,
        `${code} (${UNACCEPTABLE_HOSPICE_PRINCIPAL[code]}) is not accepted by CMS as the hospice principal diagnosis${c.labelledRole === "principal" ? " — and this document lists it as primary" : ""}.`,
      );
    } else if (code.startsWith("R") && c.labelledRole === "principal") {
      add(
        c,
        "symptom_code_as_principal",
        code,
        `${code} is a symptom code labelled principal; a symptom code is not principal when a related definitive diagnosis is documented.`,
      );
    }
    if (/\bunspecified\b/i.test(title)) {
      const category = code.slice(0, 3);
      const specific = distinct.filter(
        (o) =>
          o !== code && o.slice(0, 3) === category && !/\bunspecified\b/i.test(titles.get(o) ?? ""),
      );
      if (specific.length) {
        add(
          c,
          "unspecified_code",
          code,
          `${code} (${title}) — the packet documents more specific ${category} codes.`,
          specific,
        );
      }
    }
    if (code === "I10" && (hfDocumented || ckdDocumented)) {
      const late = ckdCodes.some((k) => k === "N18.5" || k === "N18.6");
      const suggest =
        hfDocumented && ckdDocumented
          ? [late ? "I13.2" : "I13.0"]
          : hfDocumented
            ? ["I11.0"]
            : [late ? "I12.0" : "I12.9"];
      add(
        c,
        "combination_code_expected",
        code,
        `Hypertension with ${[hfDocumented && "heart failure", ckdDocumented && "chronic kidney disease"].filter(Boolean).join(" and ")} documented — ICD-10-CM presumes the link (Guidelines I.C.9.a.2–3): ${suggest[0]}, not I10.`,
        suggest,
      );
    }
    if (code === "E11.9" && ckdDocumented) {
      add(
        c,
        "more_specific_code_supported",
        code,
        `Type 2 diabetes "without complications" while CKD is documented — the "with" convention (Guidelines I.A.15) presumes diabetic CKD: E11.22.`,
        ["E11.22"],
      );
    }
    if (RESOLVED.test(c.context)) {
      add(
        c,
        "resolved_condition",
        code,
        `The document calls this condition resolved — not an active diagnosis.`,
      );
    }
    if (SUD.test(code)) {
      add(
        c,
        "part2_sud",
        code,
        `${code} is a substance use disorder code — 42 CFR Part 2 consent gating applies.`,
      );
    }
  }

  // Conflicts: one condition coded differently across documents (same category, or the dementia family).
  const families: { name: string; match: (code: string) => boolean }[] = [
    { name: "dementia", match: (x) => /^(F0[1-3]|G30|G31\.0|G31\.8)/.test(x) },
  ];
  const groups = new Map<string, CodeInDocument[]>();
  for (const c of readable) {
    const fam = families.find((f) => f.match(c.code as string))?.name;
    const key = fam ?? (c.code as string).slice(0, 3);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const [key, members] of groups) {
    const codes = [...new Set(members.map((m) => m.code as string))].filter(
      (x) => !(key === "dementia" && x.startsWith("F02")),
    );
    const docs = new Set(members.map((m) => m.documentKey));
    if (codes.length > 1 && docs.size > 1) {
      const first = members[0] as CodeInDocument;
      flags.push({
        kind: "conflicting_codes",
        code: codes.join(", "),
        page: first.page,
        blockIndex: first.blockIndex,
        suggest: [],
        detail: `The packet codes this ${key === "dementia" ? "dementia" : `${key} condition`} differently across documents: ${codes.join(", ")}. The documentation decides which is right.`,
      });
    }
  }
  void allCodes;
  return flags;
}
