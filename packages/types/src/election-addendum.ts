// @chartwarden/types — FY2027 election statement addendum (42 CFR 418.24(b)(6), (c), (d) as amended by
// CMS-1851-F, effective 2026-10-01). The "Patient Notification of Hospice Non-Covered Items, Services, and
// Drugs" is mandatory for every hospice election whose effective date is on or after 2026-10-01.
//
// M6 owns the `election_addendum` table and its lifecycle. The non-covered items it lists come from other
// modules' relatedness determinations (M7 unrelated problems today; M12 medications, M21 DME/supplies and
// services later), so M6 reads them through the leaf-typed `NonCoveredItemsReader` (./hospice-coverage.ts) — injected at
// the composition root, never a cross-module import. Pure types: no runtime code here.
import type { LocalDate } from "./admission";
import type { NonCoveredItemSnapshot } from "./hospice-coverage";

/** The addendum version lifecycle (mirrors `election_addendum_status`). */
export type ElectionAddendumStatus =
  | "draft"
  | "furnished"
  | "signed"
  | "refused"
  | "signature_not_required"
  | "not_required";

/** Why a version exists (mirrors `election_addendum_trigger`). */
export type ElectionAddendumTrigger = "initial" | "poc_change";

/** How the written addendum was handed over (mirrors `election_addendum_furnish_method`). */
export type ElectionAddendumFurnishMethod = "paper" | "electronic_with_paper_copy";

/** Who acknowledged receipt (mirrors `election_addendum_signer_kind`). */
export type ElectionAddendumSignerKind = "beneficiary" | "representative";

/** How the (c)(9) acknowledgement was captured (mirrors `election_addendum_acknowledgement_source`): keyed in
 *  ChartWarden, or a scanned signed paper copy uploaded to M22. */
export type ElectionAddendumAcknowledgementSource = "structured" | "uploaded";

/** Where a version's 418.24(c) content lives (mirrors `election_addendum_content_source`): in ChartWarden, or on the
 *  signed paper copy that was scanned (an incomplete draft acknowledged on paper). */
export type ElectionAddendumContentSource = "structured" | "scanned_paper";

/** 418.24(d)(3)/(4) — why furnishing or signing was not required (mirrors `election_addendum_exemption_reason`). */
export type ElectionAddendumExemptionReason = "death" | "revocation" | "discharge";

/** One line of the addendum's non-covered list (418.24(c)(5)). */
export type NonCoveredItemCategory = NonCoveredItemSnapshot["category"];

/** Where a non-covered item determination came from. */
export type NonCoveredItemSource = NonCoveredItemSnapshot["source"];

/** One diagnosis line as the addendum prints it (418.24(c)(4)). */
export interface AddendumDiagnosisLine {
  readonly icd10Code: string | null;
  readonly description: string;
}

/** The terminal + related diagnoses on the plan of care, for the addendum's (c)(4) identification block. */
export interface AddendumDiagnoses {
  readonly terminal: readonly AddendumDiagnosisLine[];
  readonly related: readonly AddendumDiagnosisLine[];
}

/** The seam M6 reads the plan of care's terminal/related diagnoses through (M7 implements it). */
export interface AddendumDiagnosesReader {
  diagnosesForAdmission(orgId: string, admissionId: string): Promise<AddendumDiagnoses>;
}

/**
 * The addendum facts M23's `election_addendum_signed` billing rule reads (aggregate, PHI-free). One per
 * admission. `electionEffectiveDate` is the period-1 effective date (null when the admission was never
 * activated); the flags are "any version of the addendum on file satisfies this".
 */
export interface ElectionAddendumComplianceSnapshot {
  readonly admissionId: string;
  readonly electionEffectiveDate: LocalDate | null;
  readonly versionCount: number;
  readonly anyFurnished: boolean;
  readonly anySigned: boolean;
  readonly anyRefusalDocumented: boolean;
  /** A `signature_not_required` or `not_required` version (418.24(d)(3)/(4), reason documented). */
  readonly anyExemptionDocumented: boolean;
  /** How the patient left hospice care, when they have: the (d)(3)/(d)(4) exemption facts. */
  readonly leftCareReason: ElectionAddendumExemptionReason | null;
}

/** The 418.24(c)(1) title, verbatim. */
export const ELECTION_ADDENDUM_TITLE =
  "Patient Notification of Hospice Non-Covered Items, Services, and Drugs";

/**
 * The content M6 hands M22 to render one addendum version (`m6.election_addendum.furnished` /
 * `.acknowledged` → `renderPayload`). Every 418.24(c) element that varies per patient is here; the fixed
 * regulatory language ((c)(6) general statement, (c)(8) purpose + BFCC-QIO immediate advocacy, (c)(9)
 * receipt-only statement) is the template's own text.
 */
export interface ElectionAddendumRenderPayload {
  readonly title: string;
  readonly patientId: string;
  readonly electionAddendumId: string;
  readonly versionNumber: number;
  readonly trigger: ElectionAddendumTrigger;
  readonly hospiceName: string;
  readonly patientName: string;
  readonly medicalRecordNumber: string;
  readonly terminalDiagnoses: readonly AddendumDiagnosisLine[];
  readonly relatedDiagnoses: readonly AddendumDiagnosisLine[];
  readonly items: readonly {
    readonly category: NonCoveredItemCategory;
    readonly description: string;
    readonly reasonNotCovered: string;
  }[];
  readonly noNonCoveredItems: boolean;
  readonly clinicalExplanation: string | null;
  readonly guidelineReferences: string | null;
  /** (c)(10) the date furnished (org-local yyyy-mm-dd). */
  readonly furnishedDate: LocalDate;
  readonly furnishMethod: ElectionAddendumFurnishMethod;
  /** `scanned_paper`: the authoritative (c) content is the scanned paper copy; the render is a record notice. */
  readonly contentSource: ElectionAddendumContentSource;
  /** The scanned paper copy filed for this version (M22 document id + org-local filing date), if any. */
  readonly scannedCopy: { readonly documentId: string; readonly filedDate: LocalDate } | null;
  readonly acknowledgement: {
    /** How receipt was acknowledged; null while pending or for a (d)(4) exemption. */
    readonly source: ElectionAddendumAcknowledgementSource | null;
    readonly outcome: "pending" | "signed" | "refused" | "signature_not_required";
    readonly signedDate: LocalDate | null;
    readonly signerKind: ElectionAddendumSignerKind | null;
    readonly representativeName: string | null;
    readonly representativeRelationship: string | null;
    readonly refusalReason: string | null;
    readonly exemptionReason: ElectionAddendumExemptionReason | null;
    readonly exemptionNote: string | null;
  };
}
