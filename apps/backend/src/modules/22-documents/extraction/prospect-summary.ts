// apps/backend/src/modules/22-documents/extraction/prospect-summary.ts — the PURE "prospect summary" of a
// COMPLETED DocLens review (F-238): one clean picture of the person the intake fax describes — name, date of
// birth, address, contact, diagnoses, medications, allergies, and the records the packet held — each value with
// the document and page it came from, plus a copyable plain-text rendering of the same thing.
//
// DETERMINISTIC, NO MODEL (AI Governance v0.2 §2.1.1: no generated clinical text). Every value shown is a
// reviewer-attested candidate exactly as written on the page, or as the reviewer typed it — this file only
// selects, groups, de-duplicates, orders and formats. Nothing is paraphrased, coded, parsed or inferred:
// a medication line is shown as one line (the v1 field catalog extracts "name, strength, route and
// frequency" as ONE as-written line, so there is no dose/route column to fill without parsing it).
//
// WHAT IS INCLUDED — the same "approved value" rules the three commit paths use (writeback-commit-*.ts):
//   • decision `approve` → the extracted value; `approve_with_edit` → the reviewer's edit (for an ICD-10 code,
//     `editedCode` then `editedValue`); `reject` / undecided → omitted.
//   • a document a reviewer marked as ANOTHER patient's (`identity_resolution = 'other_patient'`) contributes
//     nothing, and its title is not shown (a title can name its patient).
//   • a re-sent copy of an earlier page (`duplicate_of_page`) contributes nothing (it is not extracted anyway).
//   • 42 CFR Part 2: the plain text exists to be COPIED, so anything SUD-adjacent is withheld unless a
//     reviewer rejected the batch's detection as a false positive — a value on a flagged page, a MAT
//     medication/allergy line (the W4 flagger's rules), and a substance-use diagnosis (F10–F19 except F17, or
//     SUD wording). Stricter than the M7 proposal path on purpose (that path keeps a Part 2 label and M7's
//     consent gates; a clipboard keeps neither). A flagged document's title is replaced by its type. Only a
//     COUNT of withheld values is reported.
// Values repeated across documents are shown once, with every citation; values that DIFFER across documents
// (two dates of birth) are all shown and marked, never reconciled.
import { lineNamesSudTreatmentMedication } from "@wardenx/intake-extraction";
import {
  type DocLensBatchSudStatus,
  type DocLensDiagnosisRole,
  type DocLensIcd10Source,
  diagnosisDedupeKey,
  doclensClinicalLineKey,
  doclensFieldPathIndex,
  isSudIcd10Code,
  normalizeDiagnosisRole,
  normalizeIcd10CmShape,
  parseDiagnosisFieldPath,
} from "@wardenx/types";
import { clinicalWritebackTargetOf } from "./writeback-plan-clinical";
import { descriptionHasSudWording } from "./writeback-plan-dx";

// ── input ────────────────────────────────────────────────────────────────────────────────────────────────

export type SummaryDecision = "approve" | "approve_with_edit" | "reject";

/** One document the fax splitter found (a `classified_page` row). */
export interface SummaryDocumentInput {
  readonly pageFrom: number;
  readonly pageTo: number;
  readonly documentType: string;
  readonly title: string | null;
  readonly date: string | null;
  readonly duplicateOfPage: number | null;
  readonly identityResolution: "same_patient" | "other_patient" | null;
}

export interface SummaryCodingFlagInput {
  readonly kind: string;
  readonly code: string;
  readonly detail: string;
}

/** One candidate of the batch, with the completed review's decision (values already DEK-decrypted). */
export interface SummaryFactInput {
  readonly candidateId: string;
  readonly extractionJobId: string;
  /** `pageFrom` of the document (classified_page) the candidate's extraction job ran over. */
  readonly documentPageFrom: number;
  readonly fieldPath: string;
  readonly page: number;
  /** Top of the candidate's box — reading order within a page. */
  readonly top: number;
  readonly sudDetected: boolean;
  readonly decision: SummaryDecision | null;
  /** The decrypted extracted value (only needed for `approve`). */
  readonly extractedValue: string | null;
  readonly editedValue: string | null;
  readonly editedCode: string | null;
  /** The deterministic coding checks stored on a `diagnoses[n].icd10` candidate. */
  readonly codingFlags: readonly SummaryCodingFlagInput[];
}

export interface ProspectSummaryInput {
  readonly batch: {
    readonly id: string;
    readonly uploadedAt: string;
    readonly sourceChannel: string;
    readonly patientId: string | null;
    readonly patientName: string | null;
    readonly referralId: string | null;
    readonly sudStatus: DocLensBatchSudStatus;
  };
  readonly review: { readonly id: string; readonly completedAt: string | null };
  readonly documents: readonly SummaryDocumentInput[];
  /** Pages the W4 detector flagged (decrypted SUD evidence). */
  readonly sudPages: readonly number[];
  readonly facts: readonly SummaryFactInput[];
}

// ── output ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SummaryCitation {
  /** The document's title, or its type label when it has none (or when its title is withheld). */
  readonly document: string;
  readonly documentType: string;
  readonly page: number;
}

export interface SummaryValue {
  readonly value: string;
  /** True when any contributing value is the reviewer's edit rather than the page's text. */
  readonly edited: boolean;
  readonly citations: readonly SummaryCitation[];
}

export type PatientFieldKey =
  | "legalName"
  | "preferredName"
  | "dateOfBirth"
  | "address"
  | "phoneHome"
  | "phoneMobile"
  | "email";

export interface SummaryPatientField {
  readonly key: PatientFieldKey;
  readonly label: string;
  /** More than one value ⇒ the documents disagree; every reading is shown, none is chosen. */
  readonly values: readonly SummaryValue[];
}

export interface SummaryDiagnosis {
  readonly description: string;
  readonly icd10Code: string | null;
  readonly icd10Source: DocLensIcd10Source | null;
  readonly role: DocLensDiagnosisRole;
  readonly edited: boolean;
  /** Most severe first. `label` / `severity` are the review screen's wording (doclens-model.ts). */
  readonly codingFlags: readonly SummaryCodingFlag[];
  readonly citations: readonly SummaryCitation[];
}

export type CodingFlagSeverity = "critical" | "warning" | "info";
export interface SummaryCodingFlag extends SummaryCodingFlagInput {
  readonly label: string;
  readonly severity: CodingFlagSeverity;
}

export interface SummaryLine {
  readonly text: string;
  readonly edited: boolean;
  readonly citations: readonly SummaryCitation[];
}

export interface SummaryDocument {
  readonly pageFrom: number;
  readonly pageTo: number;
  readonly documentType: string;
  readonly documentTypeLabel: string;
  /** Null when the document has none, or it is withheld (another patient's / a Part 2-flagged document). */
  readonly title: string | null;
  readonly date: string | null;
  readonly status: "included" | "other_patient" | "duplicate";
  readonly duplicateOfPage: number | null;
}

export interface ProspectSummary {
  readonly batchId: string;
  readonly reviewId: string;
  readonly completedAt: string | null;
  readonly receivedAt: string;
  readonly sourceChannel: string;
  readonly filedUnder: {
    readonly patientId: string | null;
    readonly patientName: string | null;
    readonly referralId: string | null;
  };
  readonly patient: readonly SummaryPatientField[];
  readonly diagnoses: readonly SummaryDiagnosis[];
  readonly medications: readonly SummaryLine[];
  readonly allergies: readonly SummaryLine[];
  /** Advance directive / DPOA DOCUMENTS present in the packet (their content is not extracted in v1). */
  readonly advanceDirectives: readonly SummaryDocument[];
  readonly documents: readonly SummaryDocument[];
  readonly withheld: { readonly part2Values: number };
  /** What the v1 DocLens field catalog does not extract — absence below is not "none". */
  readonly notCaptured: readonly string[];
  readonly plainText: string;
}

// ── constants ────────────────────────────────────────────────────────────────────────────────────────────

const DOC_TYPE_LABEL: Readonly<Record<string, string>> = {
  discharge_summary: "Discharge summary",
  med_recon: "Medication reconciliation",
  hp: "History & physical",
  lab: "Lab report",
  imaging: "Imaging report",
  consult: "Consult note",
  insurance_card: "Insurance card",
  photo_id: "Photo ID",
  advance_directive: "Advance directive",
  dpoa: "Durable power of attorney",
  transfer_record: "Transfer record",
  unknown: "Unclassified document",
};
export const summaryDocTypeLabel = (t: string): string =>
  DOC_TYPE_LABEL[t] ?? t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const PATIENT_FIELD_LABEL: Readonly<Record<PatientFieldKey, string>> = {
  legalName: "Legal name",
  preferredName: "Preferred name",
  dateOfBirth: "Date of birth",
  address: "Address",
  phoneHome: "Home phone",
  phoneMobile: "Mobile phone",
  email: "Email",
};
const PATIENT_FIELD_ORDER: readonly PatientFieldKey[] = [
  "legalName",
  "preferredName",
  "dateOfBirth",
  "address",
  "phoneHome",
  "phoneMobile",
  "email",
];
const SIMPLE_PATIENT_PATH: Readonly<Record<string, PatientFieldKey>> = {
  "patient.preferredName": "preferredName",
  "patient.dateOfBirth": "dateOfBirth",
  "patient.phoneHome": "phoneHome",
  "patient.phoneMobile": "phoneMobile",
  "patient.email": "email",
};
const NAME_PARTS = ["patient.legalFirstName", "patient.legalLastName"] as const;
const ADDRESS_PARTS = [
  "patient.address.line1",
  "patient.address.line2",
  "patient.address.city",
  "patient.address.state",
  "patient.address.postalCode",
] as const;

const ROLE_RANK: Readonly<Record<DocLensDiagnosisRole, number>> = {
  principal: 0,
  secondary: 1,
  unspecified: 2,
  history: 3,
};
const ROLE_LABEL: Readonly<Record<DocLensDiagnosisRole, string>> = {
  principal: "Principal",
  secondary: "Secondary",
  unspecified: "Listed",
  history: "History",
};

/** The v1 field catalog (`@wardenx/intake-extraction` registry) extracts none of these. */
export const PROSPECT_SUMMARY_NOT_CAPTURED: readonly string[] = [
  "Medical record number, Medicare / insurance IDs",
  "Emergency contact, caregiver and DPOA agent",
  "Referring physician and facility",
  "Code status and advance-directive content",
  "Recent hospitalizations and functional status",
];

/** The coding-check wording the review screen uses (mirrors apps/web …/doclens-model.ts `CODING_FLAG`), so a
 *  summary read outside the review module (the patient chart) says the same thing. */
const CODING_FLAG: Readonly<Record<string, { label: string; severity: CodingFlagSeverity }>> = {
  code_not_valid_on_date: {
    label: "Not a valid code on the document's date",
    severity: "critical",
  },
  code_retired_since_written: {
    label: "Code retired since — needs a current code",
    severity: "critical",
  },
  unknown_code: { label: "Not an ICD-10-CM code", severity: "critical" },
  icd10_malformed: { label: "Not an ICD-10-CM shaped code", severity: "critical" },
  unacceptable_hospice_principal: {
    label: "Not acceptable as hospice principal",
    severity: "critical",
  },
  manifestation_code: { label: "Manifestation code — cannot be principal", severity: "critical" },
  symptom_code_as_principal: { label: "Symptom code as principal", severity: "warning" },
  combination_code_expected: { label: "Combination code expected", severity: "warning" },
  more_specific_code_supported: {
    label: "Documentation supports a more specific code",
    severity: "warning",
  },
  conflicting_codes: { label: "Coded differently elsewhere in the packet", severity: "warning" },
  resolved_condition: { label: "Documented as resolved", severity: "warning" },
  unspecified_code: { label: "Unspecified code", severity: "info" },
  ocr_repaired: { label: "Code read through OCR repair — check the page", severity: "info" },
  unreadable_code: { label: "Code on the page could not be read", severity: "warning" },
  part2_sud: { label: "42 CFR Part 2 — substance use disorder code", severity: "critical" },
};
const SEVERITY_RANK: Readonly<Record<CodingFlagSeverity, number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};
function describeFlag(f: SummaryCodingFlagInput): SummaryCodingFlag {
  const known = CODING_FLAG[f.kind];
  const fallback = f.kind.replace(/_/g, " ");
  return {
    ...f,
    label: known?.label ?? fallback.charAt(0).toUpperCase() + fallback.slice(1),
    severity: known?.severity ?? "warning",
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────

const clean = (v: string | null): string | null => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};

/** The reviewer-attested text of a decided candidate, or null when it has none / was rejected. */
function attested(f: SummaryFactInput): { text: string; edited: boolean } | null {
  if (f.decision === "approve") {
    const t = clean(f.extractedValue);
    return t === null ? null : { text: t, edited: false };
  }
  if (f.decision === "approve_with_edit") {
    const t = clean(f.editedValue) ?? clean(f.editedCode);
    return t === null ? null : { text: t, edited: true };
  }
  return null;
}

class CitationSet {
  private readonly seen = new Set<string>();
  readonly list: SummaryCitation[] = [];
  add(c: SummaryCitation): void {
    const k = `${c.document}\u0000${c.page}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.list.push(c);
  }
  addAll(cs: readonly SummaryCitation[]): void {
    for (const c of cs) this.add(c);
  }
}

/** Merges equal values (by the deterministic line key), keeping first-seen order and every citation. */
class ValueSet {
  private readonly byKey = new Map<
    string,
    { value: string; edited: boolean; cites: CitationSet }
  >();
  add(value: string, edited: boolean, cites: readonly SummaryCitation[]): void {
    const k = doclensClinicalLineKey(value);
    let e = this.byKey.get(k);
    if (!e) {
      e = { value, edited: false, cites: new CitationSet() };
      this.byKey.set(k, e);
    }
    e.edited ||= edited;
    e.cites.addAll(cites);
  }
  values(): SummaryValue[] {
    return [...this.byKey.values()].map((e) => ({
      value: e.value,
      edited: e.edited,
      citations: e.cites.list,
    }));
  }
}

// ── the builder ──────────────────────────────────────────────────────────────────────────────────────────

export function buildProspectSummary(input: ProspectSummaryInput): ProspectSummary {
  const sudCleared = input.batch.sudStatus === "rejected";
  const sudPages = new Set(sudCleared ? [] : input.sudPages);

  const docs = [...input.documents].sort((a, b) => a.pageFrom - b.pageFrom);
  const docByFrom = new Map(docs.map((d) => [d.pageFrom, d]));
  const docSudFlagged = (d: SummaryDocumentInput): boolean =>
    !sudCleared &&
    ([...sudPages].some((p) => p >= d.pageFrom && p <= d.pageTo) ||
      input.facts.some((f) => f.documentPageFrom === d.pageFrom && f.sudDetected));
  const displayTitle = (d: SummaryDocumentInput): string | null =>
    d.identityResolution === "other_patient" || docSudFlagged(d) ? null : clean(d.title);
  const citeOf = (f: SummaryFactInput): SummaryCitation => {
    const d = docByFrom.get(f.documentPageFrom);
    const type = d?.documentType ?? "unknown";
    return {
      document: (d ? displayTitle(d) : null) ?? summaryDocTypeLabel(type),
      documentType: type,
      page: f.page,
    };
  };

  let withheld = 0;
  // Usable facts: decided-in, on an included document, in reading order.
  const usable: Array<SummaryFactInput & { att: { text: string; edited: boolean } }> = [];
  const ordered = [...input.facts].sort(
    (a, b) =>
      a.documentPageFrom - b.documentPageFrom ||
      a.page - b.page ||
      doclensFieldPathIndex(a.fieldPath) - doclensFieldPathIndex(b.fieldPath) ||
      a.top - b.top ||
      a.fieldPath.localeCompare(b.fieldPath),
  );
  for (const f of ordered) {
    const d = docByFrom.get(f.documentPageFrom);
    if (!d || d.identityResolution === "other_patient" || d.duplicateOfPage !== null) continue;
    const att = attested(f);
    if (att === null) continue;
    if (!sudCleared && (f.sudDetected || sudPages.has(f.page))) {
      withheld++;
      continue;
    }
    usable.push({ ...f, att });
  }

  // ── patient ──
  const patientValues = new Map<PatientFieldKey, ValueSet>(
    PATIENT_FIELD_ORDER.map((k) => [k, new ValueSet()]),
  );
  const composite = new Map<
    string,
    {
      name: Map<string, string[]>;
      address: Map<string, string[]>;
      cites: CitationSet;
      edited: boolean;
    }
  >();
  for (const f of usable) {
    const simple = SIMPLE_PATIENT_PATH[f.fieldPath];
    if (simple) {
      patientValues.get(simple)?.add(f.att.text, f.att.edited, [citeOf(f)]);
      continue;
    }
    const isName = (NAME_PARTS as readonly string[]).includes(f.fieldPath);
    const isAddress = (ADDRESS_PARTS as readonly string[]).includes(f.fieldPath);
    if (!isName && !isAddress) continue;
    // Compose a name / address from the parts ONE extraction (one document) found.
    const key = `${f.extractionJobId}\u0000${isName ? "name" : "address"}`;
    let c = composite.get(key);
    if (!c) {
      c = { name: new Map(), address: new Map(), cites: new CitationSet(), edited: false };
      composite.set(key, c);
    }
    const parts = isName ? c.name : c.address;
    const list = parts.get(f.fieldPath) ?? [];
    if (!list.some((v) => doclensClinicalLineKey(v) === doclensClinicalLineKey(f.att.text))) {
      list.push(f.att.text);
    }
    parts.set(f.fieldPath, list);
    c.cites.add(citeOf(f));
    c.edited ||= f.att.edited;
  }
  const join = (parts: Map<string, string[]>, path: string): string =>
    (parts.get(path) ?? []).join(" / ");
  for (const c of composite.values()) {
    if (c.name.size > 0) {
      const name = NAME_PARTS.map((p) => join(c.name, p))
        .filter((s) => s !== "")
        .join(" ");
      patientValues.get("legalName")?.add(name, c.edited, c.cites.list);
    }
    if (c.address.size > 0) {
      const street = [join(c.address, ADDRESS_PARTS[0]), join(c.address, ADDRESS_PARTS[1])]
        .filter((s) => s !== "")
        .join(" ");
      const stateZip = [join(c.address, ADDRESS_PARTS[3]), join(c.address, ADDRESS_PARTS[4])]
        .filter((s) => s !== "")
        .join(" ");
      const address = [street, join(c.address, ADDRESS_PARTS[2]), stateZip]
        .filter((s) => s !== "")
        .join(", ");
      patientValues.get("address")?.add(address, c.edited, c.cites.list);
    }
  }
  const patient: SummaryPatientField[] = [];
  for (const key of PATIENT_FIELD_ORDER) {
    const values = patientValues.get(key)?.values() ?? [];
    if (values.length > 0) patient.push({ key, label: PATIENT_FIELD_LABEL[key], values });
  }

  // ── diagnoses: (job, n) = one diagnosis, as in the M7 planner ──
  const groups = new Map<
    string,
    {
      first: number;
      description: Array<SummaryFactInput & { att: { text: string; edited: boolean } }>;
      icd10: Array<SummaryFactInput & { att: { text: string; edited: boolean } }>;
      role: Array<SummaryFactInput & { att: { text: string; edited: boolean } }>;
    }
  >();
  usable.forEach((f, i) => {
    const parsed = parseDiagnosisFieldPath(f.fieldPath);
    if (parsed === null) return;
    const key = `${f.extractionJobId}#${parsed.index}`;
    let g = groups.get(key);
    if (!g) {
      g = { first: i, description: [], icd10: [], role: [] };
      groups.set(key, g);
    }
    g[parsed.slot].push(f);
  });
  const dx = new Map<
    string,
    {
      first: number;
      description: string;
      code: string | null;
      src: DocLensIcd10Source | null;
      role: DocLensDiagnosisRole;
      edited: boolean;
      flags: Map<string, SummaryCodingFlagInput>;
      cites: CitationSet;
    }
  >();
  for (const g of groups.values()) {
    if (g.description.length === 0) continue; // no attested wording ⇒ no diagnosis (the M7 rule)
    const descs: string[] = [];
    for (const f of g.description) {
      if (!descs.some((d) => doclensClinicalLineKey(d) === doclensClinicalLineKey(f.att.text))) {
        descs.push(f.att.text);
      }
    }
    const description = descs.join(" / ");
    let code: string | null = null;
    let src: DocLensIcd10Source | null = null;
    const flags = new Map<string, SummaryCodingFlagInput>();
    for (const f of g.icd10) {
      const raw =
        f.decision === "approve_with_edit" ? (clean(f.editedCode) ?? f.att.text) : f.att.text;
      const normalized = normalizeIcd10CmShape(raw);
      if (normalized === null) {
        flags.set(`icd10_malformed\u0000${raw}`, {
          kind: "icd10_malformed",
          code: raw,
          detail: "Not an ICD-10-CM shaped code; it is not carried to the chart.",
        });
        continue;
      }
      if (code === null) {
        code = normalized;
        src = f.decision === "approve_with_edit" ? "reviewer_edit" : "document";
      }
      // A check judged a code the reviewer then replaced no longer applies.
      for (const fl of f.codingFlags) {
        if (normalizeIcd10CmShape(fl.code) === normalized)
          flags.set(`${fl.kind}\u0000${fl.code}`, fl);
      }
    }
    const roles = new Set(g.role.map((f) => normalizeDiagnosisRole(f.att.text)));
    const role: DocLensDiagnosisRole =
      roles.size === 1 ? ([...roles][0] ?? "unspecified") : "unspecified";
    const all = [...g.description, ...g.icd10, ...g.role];
    if (!sudCleared && (isSudIcd10Code(code) || descriptionHasSudWording(description))) {
      withheld += all.length;
      continue;
    }
    const key = diagnosisDedupeKey(code, description);
    const existing = dx.get(key);
    const cites = existing?.cites ?? new CitationSet();
    for (const f of all) cites.add(citeOf(f));
    if (existing) {
      if (ROLE_RANK[role] < ROLE_RANK[existing.role]) existing.role = role;
      existing.edited ||= all.some((f) => f.att.edited);
      for (const [k, v] of flags) existing.flags.set(k, v);
      if (existing.code === null && code !== null) {
        existing.code = code;
        existing.src = src;
      }
      continue;
    }
    dx.set(key, {
      first: g.first,
      description,
      code,
      src,
      role,
      edited: all.some((f) => f.att.edited),
      flags,
      cites,
    });
  }
  const diagnoses: SummaryDiagnosis[] = [...dx.values()]
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.first - b.first)
    .map((d) => ({
      description: d.description,
      icd10Code: d.code,
      icd10Source: d.src,
      role: d.role,
      edited: d.edited,
      codingFlags: [...d.flags.values()]
        .map(describeFlag)
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
      citations: d.cites.list,
    }));

  // ── medications / allergies: one as-written line each ──
  const meds = new ValueSet();
  const allergies = new ValueSet();
  for (const f of usable) {
    const target = clinicalWritebackTargetOf(f.fieldPath);
    if (target === null) continue;
    if (!sudCleared && lineNamesSudTreatmentMedication(f.att.text)) {
      withheld++;
      continue;
    }
    (target === "medication_history" ? meds : allergies).add(f.att.text, f.att.edited, [citeOf(f)]);
  }
  const lines = (s: ValueSet): SummaryLine[] =>
    s.values().map((v) => ({ text: v.value, edited: v.edited, citations: v.citations }));

  // ── the packet ──
  const documents: SummaryDocument[] = docs.map((d) => ({
    pageFrom: d.pageFrom,
    pageTo: d.pageTo,
    documentType: d.documentType,
    documentTypeLabel: summaryDocTypeLabel(d.documentType),
    title: displayTitle(d),
    date: d.identityResolution === "other_patient" ? null : d.date,
    status:
      d.identityResolution === "other_patient"
        ? "other_patient"
        : d.duplicateOfPage !== null
          ? "duplicate"
          : "included",
    duplicateOfPage: d.duplicateOfPage,
  }));
  const advanceDirectives = documents.filter(
    (d) =>
      d.status === "included" &&
      (d.documentType === "advance_directive" || d.documentType === "dpoa"),
  );

  const summary: Omit<ProspectSummary, "plainText"> = {
    batchId: input.batch.id,
    reviewId: input.review.id,
    completedAt: input.review.completedAt,
    receivedAt: input.batch.uploadedAt,
    sourceChannel: input.batch.sourceChannel,
    filedUnder: {
      patientId: input.batch.patientId,
      patientName: input.batch.patientName,
      referralId: input.batch.referralId,
    },
    patient,
    diagnoses,
    medications: lines(meds),
    allergies: lines(allergies),
    advanceDirectives,
    documents,
    withheld: { part2Values: withheld },
    notCaptured: PROSPECT_SUMMARY_NOT_CAPTURED,
  };
  return { ...summary, plainText: renderProspectSummaryText(summary) };
}

// ── the plain-text rendering (the copyable "text box") ──────────────────────────────────────────────────

const pages = (from: number, to: number): string =>
  from === to ? `p.${from}` : `pp.${from}-${to}`;
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "unknown date");

/** "(Discharge summary p.1, 3; History & physical p.5)" — one group per document, pages in order. */
export function formatCitations(cites: readonly SummaryCitation[]): string {
  if (cites.length === 0) return "";
  const byDoc = new Map<string, number[]>();
  for (const c of cites) {
    const ps = byDoc.get(c.document) ?? [];
    if (!ps.includes(c.page)) ps.push(c.page);
    byDoc.set(c.document, ps);
  }
  return `(${[...byDoc.entries()]
    .map(([doc, ps]) => {
      const sorted = [...ps].sort((a, b) => a - b);
      return `${doc} ${sorted.length === 1 ? "p." : "pp."}${sorted.join(", ")}`;
    })
    .join("; ")})`;
}

const flagLine = (f: SummaryCodingFlag): string =>
  `${f.label} (${f.code})${f.detail ? `: ${f.detail}` : ""}`;

export function renderProspectSummaryText(s: Omit<ProspectSummary, "plainText">): string {
  const out: string[] = [];
  const heading = (h: string): void => {
    out.push("", h.toUpperCase(), "-".repeat(h.length));
  };
  const valueText = (v: SummaryValue | SummaryLine): string => {
    const text = "value" in v ? v.value : v.text;
    return `${text}${v.edited ? " [corrected by reviewer]" : ""} ${formatCitations(v.citations)}`.trim();
  };

  out.push("PROSPECT SUMMARY");
  out.push(
    `Intake fax received ${day(s.receivedAt)}; review completed ${day(s.completedAt)}.`,
    "Reviewer-approved values only, as written in the source documents or as corrected by the reviewer.",
    "Nothing here was generated or inferred. Verify against the cited pages before clinical use.",
  );
  if (s.filedUnder.patientName) out.push(`Filed under: ${s.filedUnder.patientName}`);

  heading("Patient");
  if (s.patient.length === 0) out.push("- No patient details were approved.");
  for (const f of s.patient) {
    if (f.values.length === 1 && f.values[0]) {
      out.push(`- ${f.label}: ${valueText(f.values[0])}`);
    } else {
      out.push(`- ${f.label}: documents differ —`);
      for (const v of f.values) out.push(`    * ${valueText(v)}`);
    }
  }

  heading("Diagnoses");
  if (s.diagnoses.length === 0) out.push("- No diagnoses were approved.");
  for (const d of s.diagnoses) {
    const code = d.icd10Code
      ? ` — ICD-10 ${d.icd10Code}${d.icd10Source === "reviewer_edit" ? " (code entered by reviewer)" : ""}`
      : " — no code";
    out.push(
      `- [${ROLE_LABEL[d.role]}] ${d.description}${code}${d.edited ? " [corrected by reviewer]" : ""} ${formatCitations(d.citations)}`.trimEnd(),
    );
    for (const f of d.codingFlags) out.push(`    ! ${flagLine(f)}`);
  }

  heading("Medications (as listed in the records — not orders)");
  if (s.medications.length === 0) out.push("- No medication lines were approved.");
  for (const m of s.medications) out.push(`- ${valueText(m)}`);

  heading("Allergies (unverified)");
  if (s.allergies.length === 0)
    out.push("- No allergy lines were approved (this is not 'no known allergies').");
  for (const a of s.allergies) out.push(`- ${valueText(a)}`);

  heading("Advance directives");
  if (s.advanceDirectives.length === 0) {
    out.push("- No advance directive or DPOA document in this packet.");
  }
  for (const d of s.advanceDirectives) {
    out.push(
      `- ${d.documentTypeLabel} in packet, ${pages(d.pageFrom, d.pageTo)}${d.title ? ` — "${d.title}"` : ""}${d.date ? `, dated ${d.date}` : ""} (content not extracted; read the document)`,
    );
  }

  heading("Records in this packet");
  for (const d of s.documents) {
    const where = pages(d.pageFrom, d.pageTo);
    if (d.status === "other_patient") {
      out.push(`- ${where} ${d.documentTypeLabel} — another patient's record; excluded`);
      continue;
    }
    if (d.status === "duplicate") {
      out.push(
        `- ${where} ${d.documentTypeLabel} — re-sent copy of p.${d.duplicateOfPage ?? "?"}; skipped`,
      );
      continue;
    }
    out.push(
      `- ${where} ${d.documentTypeLabel}${d.title ? ` — "${d.title}"` : ""}${d.date ? `, dated ${d.date}` : ""}`,
    );
  }

  if (s.withheld.part2Values > 0) {
    heading("Withheld");
    out.push(
      `- ${s.withheld.part2Values} approved value${s.withheld.part2Values === 1 ? " is" : "s are"} not shown: 42 CFR Part 2 (substance use disorder) content. See the review screen.`,
    );
  }

  heading("Not captured by DocLens");
  out.push("Absence of these above does not mean none; check the source documents:");
  for (const n of s.notCaptured) out.push(`- ${n}`);

  return out.join("\n").trim();
}
