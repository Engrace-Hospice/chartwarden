// @wardenx/intake-extraction — pair page-scanned ICD-10-CM codes with the model's diagnosis WORDING (F-238).
//
// The model returns `diagnoses[n].description` (+ `.role`) grounded to a page block; the scanner returns the
// codes printed on the page. This joins them by position (same page, same Docling block) and wording (the
// words written before the code overlap the description), and emits `diagnoses[n].icd10` candidates whose
// value is ALWAYS a scanned code. Two more rules keep coded diagnoses from being lost or invented:
//   • a description printed with two codes ("Alzheimer's dementia (G30.9, F02.80)") becomes one diagnosis
//     per code — ICD-10-CM codes them separately and the reviewer decides each;
//   • a printed code the model did not describe still becomes a diagnosis, its description being the words
//     written before it on the page (the reviewer sees exactly what was printed).
// Pure.

import type { CodingFlag } from "./coding-checks";
import { type ScannedCode, titleAgreement } from "./icd-scanner";

export type Box = readonly [number, number, number, number];

export interface GroundedDiagnosis {
  /** The model's index n in `diagnoses[n]`. */
  readonly index: number;
  readonly description: string;
  readonly role: string | null;
  readonly page: number;
  readonly bbox: Box;
  readonly confidence: number;
}

export interface CodeOnPage extends ScannedCode {
  /** The Docling box of the block the code sits in. */
  readonly blockBox: Box;
}

export interface DiagnosisCandidate {
  readonly fieldPath: string;
  readonly value: string;
  readonly page: number;
  readonly bbox: Box;
  readonly confidence: number;
  /** Only on `.icd10` candidates. */
  readonly codingFlags?: readonly CodingFlag[];
  /** True when the value came from the page scan rather than the model. */
  readonly fromScan: boolean;
}

const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** The flags that belong to one scanned code mention (same page/block/code), plus packet-level conflicts. */
export function flagsFor(code: CodeOnPage, flags: readonly CodingFlag[]): CodingFlag[] {
  return flags.filter(
    (f) =>
      (f.page === code.page && f.blockIndex === code.blockIndex && f.code === code.code) ||
      (f.kind === "conflicting_codes" &&
        code.code !== null &&
        f.code.split(", ").includes(code.code)),
  );
}

export function attachCodesToDiagnoses(input: {
  readonly diagnoses: readonly GroundedDiagnosis[];
  /** Codes on this document's pages (readable ones; unreadable ones surface as flags only). */
  readonly codes: readonly CodeOnPage[];
  readonly flags: readonly CodingFlag[];
}): DiagnosisCandidate[] {
  const out: DiagnosisCandidate[] = [];
  const used = new Set<CodeOnPage>();
  let next = Math.max(-1, ...input.diagnoses.map((d) => d.index)) + 1;

  const emit = (
    index: number,
    d: Omit<GroundedDiagnosis, "index">,
    code: CodeOnPage | null,
    fromScan: boolean,
  ) => {
    const base = { page: d.page, bbox: d.bbox, confidence: d.confidence };
    out.push({
      ...base,
      fieldPath: `diagnoses[${index}].description`,
      value: d.description,
      fromScan,
    });
    if (d.role)
      out.push({ ...base, fieldPath: `diagnoses[${index}].role`, value: d.role, fromScan });
    if (code?.code) {
      out.push({
        ...base,
        fieldPath: `diagnoses[${index}].icd10`,
        value: code.code,
        codingFlags: flagsFor(code, input.flags),
        fromScan: true,
      });
    }
  };

  for (const d of input.diagnoses) {
    const mine = input.codes
      .filter((c) => !used.has(c) && c.code && c.page === d.page && overlaps(c.blockBox, d.bbox))
      .map((c) => ({ c, score: titleAgreement(d.description, c.context) }))
      .filter((x) => x.score > 0)
      .map((x) => x.c);
    // Codes printed together with this wording ("(I50.84, I50.22)") share its context.
    const group = mine.length
      ? mine.filter((c) => c.context === (mine[0] as CodeOnPage).context)
      : [];
    for (const c of group) used.add(c);
    emit(d.index, d, group[0] ?? null, false);
    for (const extra of group.slice(1)) emit(next++, d, extra, false);
  }

  for (const c of input.codes) {
    if (used.has(c) || !c.code || !c.context) continue;
    emit(
      next++,
      {
        description: c.context,
        role: c.labelledRole,
        page: c.page,
        bbox: c.blockBox,
        confidence: c.repaired ? 0.6 : 0.85,
      },
      c,
      true,
    );
  }
  return out;
}
