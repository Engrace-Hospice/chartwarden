// apps/backend/src/modules/22-documents/extraction/writeback-plan-dx.ts — the PURE commit planner for the
// DocLens → M7 DIAGNOSIS writeback (F-238 dx-writeback). A sibling of `writeback-plan.ts` (the F-235 M5
// contact planner), composed next to it at completion; no IO. The caller loads the review's server-side
// decisions + candidates (values already DEK-decrypted) and executes the plan in the completion transaction.
//
// Candidates `diagnoses[n].description | .icd10 | .role` with the same `n` WITHIN ONE EXTRACTION JOB form
// one diagnosis (two documents in one batch each number their own list from 0). Each diagnosis either
// becomes one commit item or is EXCLUDED with a named reason; nothing is dropped silently. Rules, in order:
//
//   rejected                  a rejected candidate is no intent (not reported). A rejected/absent CODE does
//                             not sink the diagnosis — it goes without a code; a rejected/absent ROLE is
//                             `unspecified`; a rejected/absent DESCRIPTION sinks it (`description_not_approved`).
//   sud_detected              any approved candidate of the diagnosis sits on a SUD-flagged page and the batch's
//                             W4 detection was not rejected as a false positive (the F-235 rule).
//   patient_unresolved        no resolved patient — never a headless create.
//   edited_value_missing /    the description has no attested value (the F-235 rules).
//   value_missing
//   conflicting_values        two approved, different descriptions (or codes) for one diagnosis.
//   sud_confirmed_batch       the diagnosis is itself SUD (F10–F19 except F17, or SUD wording) and the batch's
//   sud_unresolved            SUD detection was CONFIRMED (or is still unresolved): nothing Part 2 goes out.
//                             Otherwise a SUD diagnosis goes out flagged `sudRelated`, so M7's Part 2 gates hold.
//   icd10_malformed           (the CODE candidate only) the attested code is not ICD-10-CM shaped. The diagnosis
//                             still goes, without a code — the clinician codes it; nothing is invented.
//   icd10_edit_missing        (the CODE candidate only) `approve_with_edit` with no stored edit.
//
// GOVERNANCE (AI Governance v0.2 §2.1.1): the code is ONLY the as-printed extraction (every stored candidate
// value is grounded verbatim in the source text) or the reviewer's typed edit. `extraction_candidate.value_code`
// — a model-assigned code — is never an input here. The document's `role` is carried as a label; it never
// becomes `problem.kind`.
import { detectSudIndicators } from "@wardenx/intake-extraction";
import {
  type DocLensDiagnosisItem,
  type DocLensIcd10Source,
  isSudIcd10Code,
  normalizeDiagnosisRole,
  normalizeIcd10CmShape,
  parseDiagnosisFieldPath,
} from "@wardenx/types";

export type DiagnosisWritebackExclusionReason =
  | "description_not_approved"
  | "sud_detected"
  | "patient_unresolved"
  | "edited_value_missing"
  | "value_missing"
  | "conflicting_values"
  | "sud_confirmed_batch"
  | "sud_unresolved"
  | "icd10_malformed"
  | "icd10_edit_missing";

/** One decided diagnosis candidate, as loaded server-side. */
export interface DiagnosisCandidateFact {
  readonly candidateId: string;
  readonly decisionId: string;
  readonly extractionJobId: string;
  readonly fieldPath: string;
  readonly sudDetected: boolean;
  /** The decrypted extracted value, or null when none was loaded/stored. */
  readonly extractedValue: string | null;
  readonly decision: "approve" | "approve_with_edit" | "reject";
  readonly editedValue: string | null;
  readonly editedCode: string | null;
  readonly sourceDocumentId: string;
}

/** A decision that is committed: one `extraction_provenance` row each. */
export interface PlannedDiagnosisCommitField {
  readonly itemKey: string;
  readonly candidateId: string;
  readonly decisionId: string;
  readonly fieldPath: string;
  readonly sourceDocumentId: string;
}

export interface DiagnosisWritebackExclusion {
  readonly candidateId: string;
  readonly fieldPath: string;
  readonly reason: DiagnosisWritebackExclusionReason;
}

export interface DiagnosisWritebackPlan {
  readonly targetPatientId: string | null;
  readonly items: readonly DocLensDiagnosisItem[];
  readonly committed: readonly PlannedDiagnosisCommitField[];
  readonly excluded: readonly DiagnosisWritebackExclusion[];
}

/** Is this field path one this planner owns? (The M5 planner reports it as `not_a_writeback_target`.) */
export function isDiagnosisFieldPath(fieldPath: string): boolean {
  return parseDiagnosisFieldPath(fieldPath) !== null;
}

/** SUD wording in a diagnosis description — the same v1 rules the W4 page detector runs (negation-aware). */
export function descriptionHasSudWording(description: string): boolean {
  return (
    detectSudIndicators([{ page: 1, blocks: [{ text: description, bbox: [0, 0, 0, 0] }] }]).length >
    0
  );
}

type BatchSudStatus = "not_detected" | "detected" | "confirmed" | "rejected";

interface Group {
  readonly jobId: string;
  readonly index: number;
  readonly description: DiagnosisCandidateFact[];
  readonly icd10: DiagnosisCandidateFact[];
  readonly role: DiagnosisCandidateFact[];
}

const attested = (f: DiagnosisCandidateFact): string | null => {
  const v = f.decision === "approve_with_edit" ? f.editedValue : f.extractedValue;
  return v === null || v.trim() === "" ? null : v.trim();
};

export function planDiagnosisWriteback(input: {
  readonly batchPatientId: string | null;
  readonly batchSudStatus?: BatchSudStatus;
  readonly facts: readonly DiagnosisCandidateFact[];
}): DiagnosisWritebackPlan {
  const excluded: DiagnosisWritebackExclusion[] = [];
  const exclude = (f: DiagnosisCandidateFact, reason: DiagnosisWritebackExclusionReason): void => {
    excluded.push({ candidateId: f.candidateId, fieldPath: f.fieldPath, reason });
  };

  // Group the APPROVED diagnosis candidates per (job, n).
  const groups = new Map<string, Group>();
  for (const f of input.facts) {
    const parsed = parseDiagnosisFieldPath(f.fieldPath);
    if (parsed === null || f.decision === "reject") continue;
    const key = `${f.extractionJobId}#${parsed.index}`;
    let g = groups.get(key);
    if (!g) {
      g = { jobId: f.extractionJobId, index: parsed.index, description: [], icd10: [], role: [] };
      groups.set(key, g);
    }
    g[parsed.slot].push(f);
  }

  const items: DocLensDiagnosisItem[] = [];
  const committed: PlannedDiagnosisCommitField[] = [];
  const ordered = [...groups.entries()].sort(([, a], [, b]) =>
    a.jobId === b.jobId ? a.index - b.index : a.jobId < b.jobId ? -1 : 1,
  );

  for (const [itemKey, g] of ordered) {
    const all = [...g.description, ...g.icd10, ...g.role];
    const excludeAll = (reason: DiagnosisWritebackExclusionReason): void => {
      for (const f of all) exclude(f, reason);
    };

    if (g.description.length === 0) {
      excludeAll("description_not_approved");
      continue;
    }
    if (all.some((f) => f.sudDetected) && input.batchSudStatus !== "rejected") {
      excludeAll("sud_detected");
      continue;
    }
    if (input.batchPatientId === null) {
      excludeAll("patient_unresolved");
      continue;
    }

    // Description: exactly one attested value.
    const descValues = new Set<string>();
    let descMissing: DiagnosisWritebackExclusionReason | null = null;
    for (const f of g.description) {
      const v = attested(f);
      if (v === null) {
        descMissing = f.decision === "approve_with_edit" ? "edited_value_missing" : "value_missing";
      } else {
        descValues.add(v);
      }
    }
    if (descMissing !== null) {
      excludeAll(descMissing);
      continue;
    }
    if (descValues.size > 1) {
      excludeAll("conflicting_values");
      continue;
    }
    const description = [...descValues][0] as string;

    // Code: as printed, or as typed by the reviewer. Never `value_code`.
    const codeCandidates: Array<{
      f: DiagnosisCandidateFact;
      code: string;
      src: DocLensIcd10Source;
    }> = [];
    for (const f of g.icd10) {
      const raw =
        f.decision === "approve_with_edit"
          ? f.editedCode?.trim() || f.editedValue?.trim() || null
          : (f.extractedValue?.trim() ?? null);
      if (raw === null || raw === "") {
        exclude(f, f.decision === "approve_with_edit" ? "icd10_edit_missing" : "icd10_malformed");
        continue;
      }
      const code = normalizeIcd10CmShape(raw);
      if (code === null) {
        exclude(f, "icd10_malformed");
        continue;
      }
      codeCandidates.push({
        f,
        code,
        src: f.decision === "approve_with_edit" ? "reviewer_edit" : "document",
      });
    }
    if (new Set(codeCandidates.map((c) => c.code)).size > 1) {
      excludeAll("conflicting_values");
      continue;
    }
    const chosenCode = codeCandidates[0] ?? null;

    // Role: the document's label (a suggestion only).
    const roleValues = new Set(g.role.map((f) => normalizeDiagnosisRole(attested(f))));
    const documentRole = roleValues.size === 1 ? [...roleValues][0]! : "unspecified";

    // 42 CFR Part 2 — the diagnosis itself.
    const sudRelated =
      isSudIcd10Code(chosenCode?.code ?? null) || descriptionHasSudWording(description);
    if (sudRelated && input.batchSudStatus === "confirmed") {
      excludeAll("sud_confirmed_batch");
      continue;
    }
    if (sudRelated && input.batchSudStatus === "detected") {
      excludeAll("sud_unresolved");
      continue;
    }

    const used: DiagnosisCandidateFact[] = [
      ...g.description,
      ...codeCandidates.map((c) => c.f),
      ...g.role,
    ];
    for (const f of used) {
      committed.push({
        itemKey,
        candidateId: f.candidateId,
        decisionId: f.decisionId,
        fieldPath: f.fieldPath,
        sourceDocumentId: f.sourceDocumentId,
      });
    }
    items.push({
      itemKey,
      description,
      icd10Code: chosenCode?.code ?? null,
      icd10Source: chosenCode?.src ?? null,
      documentRole,
      sudRelated,
    });
  }

  return {
    targetPatientId: items.length > 0 ? input.batchPatientId : null,
    items,
    committed,
    excluded,
  };
}
