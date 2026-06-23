// @wardenx/forms — the §7 render-variant payload builders (M22-T09).
//
// These are the PURE content-layer transforms that turn a source module's already-resolved data into the typed
// render payload a `@wardenx/forms` template consumes. They embody the render-CONTENT rules the spec pins to the
// template library (not the seam-hydration, which is the backend's job): the D20 SUD-aware redaction
// (§7.16 W-M22-23), the D22 critical-result watermark (§7.18), the D13 Statement-of-Disagreement attach-to-
// disclosures flag (§7.5 W5), and the W12 EVV (§7.12) / W13 encounter (§7.13) layout-variant selectors.
//
// They live HERE — beside the §4.5 template library and the D23 `resolveRenderRetentionClass` rule — because the
// SUD placeholder/banner text, the critical watermark, and the abnormal-flag highlighting are render-content facts
// the §25.14 adapter boundary owns. They are PURE/typed (no IO, no engine, no PHI persist); the backend resolves
// the source data through the consumed reader seams (M29 `LabObservationReader`, M5 `PatientReader`, …) and feeds
// it in, so the redaction rule is unit-testable without a render engine or a database.

import type { DocumentRetentionClass } from "@wardenx/types";

// ── §7.16 W-M22-23 / D20 — the exact SUD-class redaction strings (surveyor-defensible, spec-verbatim) ──────────

/** D20 — the placeholder rendered in place of a SUD-class observation value (never the plaintext). Spec-verbatim. */
export const SUD_REDACTED_PLACEHOLDER = "[SUD-CLASS RESULT — value not displayed]" as const;

/** D20 — the banner rendered above a result block that contains any SUD-class value. Spec-verbatim. */
export const SUD_RESULT_BANNER =
  "This result is subject to 42 CFR Part 2 protections. To view the value, request an unredact grant via the SUD Disclosure workflow." as const;

/** D22 — the watermark stamped across every page of a critical-result PDF (18pt red, applied by the engine). */
export const CRITICAL_RESULT_WATERMARK = "CRITICAL RESULT" as const;

// ── §7.15 W-M22-22 + §7.16 W-M22-23 — lab results PDF (SUD-aware) ─────────────────────────────────────────────

/** One observation value as resolved by M29's `LabObservationReader` (the backend hydrates this; we never read M29). */
export interface LabResultValueInput {
  readonly analyteName: string;
  readonly loincCode: string;
  /** The measured value plaintext. Redacted to `null` in the render payload when `isSudClass` (D20). */
  readonly value: string | null;
  readonly unit?: string | null;
  readonly referenceRange?: string | null;
  /** §7.15 abnormal-flag highlighting (`H`/`L`/`HH`/`LL`/`A`/null). */
  readonly abnormalFlag?: string | null;
  /** D20 — true when the parent observation is SUD-class (`sud_redaction_status != 'not_applicable'`). */
  readonly isSudClass: boolean;
}

/** The resolved inputs to a `lab_results_pdf` render (resolved by the backend lab consumer through its seams). */
export interface LabResultsRenderInput {
  readonly orderId: string;
  readonly observationId: string;
  /** §7.15 ordering-provider chart-banner context (resolved via M40 `MdmEntityProvider.resolvePhysician`). */
  readonly orderingProviderName?: string | null;
  readonly resultValues: readonly LabResultValueInput[];
  /** §7.18 D22 — the critical lane (adds the watermark; the consumer also emits `rendered_critical_results`). */
  readonly critical?: boolean;
}

/** One result row as it appears in the rendered payload — SUD-class rows carry the placeholder, never the value. */
export interface LabResultValueRendered {
  readonly analyteName: string;
  readonly loincCode: string;
  readonly value: string | null;
  readonly unit: string | null;
  readonly referenceRange: string | null;
  readonly abnormalFlag: string | null;
  readonly isSudClass: boolean;
  /** The display string the engine prints for `value`: the plaintext, or {@link SUD_REDACTED_PLACEHOLDER}. */
  readonly displayValue: string;
}

/** The typed `lab_results_pdf` render payload (D20 redaction applied, D23 retention resolved, D22 watermark set). */
export interface LabResultsRenderPayload {
  readonly templateKey: "lab_results_pdf";
  readonly orderId: string;
  readonly observationId: string;
  readonly orderingProviderName: string | null;
  readonly resultValues: readonly LabResultValueRendered[];
  /** Rendered above the result block when ANY value is SUD-class (D20). `null` when no SUD content present. */
  readonly sudBanner: string | null;
  /** D22 — the page watermark, or `null` for the routine lane. */
  readonly watermark: string | null;
  /** D23 — `compliance_42cfr_part2` when ANY value is SUD-class, else `clinical_record`. */
  readonly retentionClass: DocumentRetentionClass;
  /** The invisible-but-searchable metadata layer (D20): identifies Part 2 documents without parsing the PDF text. */
  readonly metadata: {
    readonly sudRedacted: boolean;
    readonly observationId: string;
    readonly m11OrderId: string;
  };
}

/**
 * Build the `lab_results_pdf` render payload, applying the D20 SUD-aware redaction (§7.16 W-M22-23): every
 * SUD-class value is forced to `null` and rendered as {@link SUD_REDACTED_PLACEHOLDER}; when any SUD-class value
 * is present the {@link SUD_RESULT_BANNER} is set and the document retention upgrades to `compliance_42cfr_part2`
 * (D23). The metadata layer always records `sudRedacted` + the observation/order ids so M22's catalog can isolate
 * Part 2 documents without parsing the binary. The critical lane sets the D22 watermark (§7.18). PURE — the
 * SUD-class plaintext NEVER appears in the output, regardless of caller permission (defense in depth, D20).
 */
export function buildLabResultsRenderPayload(input: LabResultsRenderInput): LabResultsRenderPayload {
  let anySud = false;
  const resultValues: LabResultValueRendered[] = input.resultValues.map((v) => {
    const isSud = v.isSudClass === true;
    if (isSud) anySud = true;
    // D20 — drop the plaintext for SUD-class entries BEFORE it can reach the engine/binary.
    const value = isSud ? null : v.value;
    return {
      analyteName: v.analyteName,
      loincCode: v.loincCode,
      value,
      unit: v.unit ?? null,
      referenceRange: v.referenceRange ?? null,
      abnormalFlag: v.abnormalFlag ?? null,
      isSudClass: isSud,
      displayValue: isSud ? SUD_REDACTED_PLACEHOLDER : (value ?? ""),
    };
  });
  return {
    templateKey: "lab_results_pdf",
    orderId: input.orderId,
    observationId: input.observationId,
    orderingProviderName: input.orderingProviderName ?? null,
    resultValues,
    sudBanner: anySud ? SUD_RESULT_BANNER : null,
    watermark: input.critical === true ? CRITICAL_RESULT_WATERMARK : null,
    retentionClass: anySud ? "compliance_42cfr_part2" : "clinical_record",
    metadata: { sudRedacted: anySud, observationId: input.observationId, m11OrderId: input.orderId },
  };
}

// ── §7.5 W5 / D13 — Statement of Disagreement attachment ──────────────────────────────────────────────────────

/** The M5 amendment-decision data the SoD builder shapes (resolved by the backend via M5's amendment lookup). */
export interface StatementOfDisagreementInput {
  readonly amendmentRequestId: string;
  readonly patientId: string;
  /** M5's §4.6 decision; the SoD renders ONLY for `'denied'` (any other decision → no render). */
  readonly decision: string;
  /** The patient's statement-of-disagreement narrative (read from M5's amendment-request record). */
  readonly statementText?: string | null;
  /** The privacy officer's denial rationale (rendered in the document body for the §164.526 record). */
  readonly denialReason?: string | null;
}

/** The typed `patient_amendment_statement_of_disagreement` render payload (D13 — carries to every disclosure). */
export interface StatementOfDisagreementRenderPayload {
  readonly templateKey: "patient_amendment_statement_of_disagreement";
  readonly patientId: string;
  readonly statementText: string | null;
  readonly denialReason: string | null;
  /** D13 — set so M5/M28 + M22's outbound-disclosure subsetter attach this to every later disclosure. */
  readonly attachToDisclosures: true;
  /** The §7.5 tag linking the SoD back to its originating amendment request (queryable on the document). */
  readonly tags: { readonly original_amendment_request_id: string };
  /** SoDs are §164.526 compliance records (never `clinical_record`). */
  readonly retentionClass: DocumentRetentionClass;
}

/**
 * Build the Statement-of-Disagreement render payload for §7.5 W5 / D13, or `null` when the amendment was NOT
 * denied (the SoD renders only on a denial; M5 emits the decision for every outcome). The document carries
 * `attach_to_disclosures=true` and the `original_amendment_request_id` tag so every subsequent disclosure of the
 * underlying record includes the statement (§164.526). PURE.
 */
export function buildStatementOfDisagreementPayload(
  input: StatementOfDisagreementInput,
): StatementOfDisagreementRenderPayload | null {
  if (input.decision !== "denied") return null;
  return {
    templateKey: "patient_amendment_statement_of_disagreement",
    patientId: input.patientId,
    statementText: input.statementText ?? null,
    denialReason: input.denialReason ?? null,
    attachToDisclosures: true,
    tags: { original_amendment_request_id: input.amendmentRequestId },
    retentionClass: "compliance",
  };
}

// ── §7.12 W12 — EVV verification render variant ───────────────────────────────────────────────────────────────

/** The geo-verification snapshot the EVV variant embeds (captured at render time, no live API call from the PDF). */
export interface EvvGeoVerificationInput {
  readonly latitude: number;
  readonly longitude: number;
  /** True when a map snapshot raster was captured for embedding (W12 — embedded as a raster, never a live call). */
  readonly snapshotPresent: boolean;
}

/** The resolved inputs to an `evv_verification` render (from `m18.evv.aggregator_accepted`). */
export interface EvvVerificationRenderInput {
  readonly visitId: string;
  readonly evvRecordId: string;
  readonly aggregatorRefId: string;
  readonly acceptedAt: string;
  readonly geoVerification?: EvvGeoVerificationInput | null;
  /** §7.12 — set when geo is unavailable and a caregiver-attestation alternate method was used. */
  readonly alternateMethodReason?: string | null;
}

/** The typed `evv_verification` render payload — exactly one of `mapSection` / `exceptionNarrative` is populated. */
export interface EvvVerificationRenderPayload {
  readonly templateKey: "evv_verification";
  readonly visitId: string;
  readonly evvRecordId: string;
  readonly aggregatorRefId: string;
  readonly acceptedAt: string;
  readonly geoVerified: boolean;
  /** The map block (visit-location pin) when geo-verified; `null` on the alternate-method path. */
  readonly mapSection: { readonly latitude: number; readonly longitude: number; readonly snapshotPresent: boolean } | null;
  /** The exception narrative block when geo is unavailable; `null` on the geo-verified path. */
  readonly exceptionNarrative: string | null;
}

/** §7.12 W12 — verbatim map-section copy for an alternate-method (geo-unavailable) EVV verification. */
export function evvAlternateMethodNarrative(reason: string): string {
  return `Geographic verification unavailable; alternate method used: ${reason}`;
}

/**
 * Build the `evv_verification` render payload (§7.12 W12). When a geo snapshot is present the map section carries
 * the visit-location pin (captured at render time — the PDF makes no live call); otherwise the exception narrative
 * is populated with the alternate-method reason. Exactly one of the two sections is non-null. PURE.
 */
export function buildEvvVerificationRenderPayload(
  input: EvvVerificationRenderInput,
): EvvVerificationRenderPayload {
  const geo = input.geoVerification ?? null;
  const geoVerified = geo !== null && geo.snapshotPresent === true;
  return {
    templateKey: "evv_verification",
    visitId: input.visitId,
    evvRecordId: input.evvRecordId,
    aggregatorRefId: input.aggregatorRefId,
    acceptedAt: input.acceptedAt,
    geoVerified,
    mapSection: geoVerified
      ? { latitude: geo!.latitude, longitude: geo!.longitude, snapshotPresent: true }
      : null,
    exceptionNarrative: geoVerified
      ? null
      : evvAlternateMethodNarrative(input.alternateMethodReason ?? "not specified"),
  };
}

// ── §7.13 W13 — encounter PDF render variant ──────────────────────────────────────────────────────────────────

/** The M32 (M8 Layer 2) narrative enhancement the encounter variant renders in its AI-assisted sidebar. */
export interface EncounterNarrativeEnhancementInput {
  readonly text: string;
  /** The clinician who reviewed the AI suggestion (the sidebar marks "AI-suggested, reviewed by <clinician>"). */
  readonly reviewedBy: string;
  /** The M32 capability id whose disclosure footer the PDF carries. */
  readonly capabilityId: string;
}

/** The resolved inputs to an `encounter_pdf` render (from `m8.encounter.signed` / `m8.encounter.addendum_signed`). */
export interface EncounterPdfRenderInput {
  readonly encounterId: string;
  /** True for `m8.encounter.addendum_signed` — renders as a NEW `document_version` (v2, v3, …) per W13. */
  readonly isAddendum?: boolean;
  /** §7.13 — present only when M8 Layer 2 attached an M32 narrative enhancement. */
  readonly narrativeEnhancement?: EncounterNarrativeEnhancementInput | null;
}

/** §7.13 — the AI-assisted sidebar block + the mandated capability disclosure footer. */
export interface EncounterNarrativeSidebar {
  readonly text: string;
  /** "AI-suggested, reviewed by <clinician>" — the surveyor-defensible attribution marker. */
  readonly attribution: string;
  /** The M32 capability disclosure footer the PDF carries when an enhancement is present. */
  readonly capabilityDisclosureFooter: string;
}

/** The typed `encounter_pdf` render payload (W13 — addendum → new version; M32 sidebar when enhanced). */
export interface EncounterPdfRenderPayload {
  readonly templateKey: "encounter_pdf";
  readonly encounterId: string;
  /** The §2.2.2 version reason: `'addendum'` appends a new version, `'initial'` is v1. */
  readonly versionReason: "initial" | "addendum";
  /** The AI-assisted sidebar + capability footer, or `null` for a plain (non-enhanced) encounter. */
  readonly narrativeSidebar: EncounterNarrativeSidebar | null;
}

/** §7.13 W13 — the attribution marker the AI-assisted sidebar prints. */
export function encounterNarrativeAttribution(reviewedBy: string): string {
  return `AI-suggested, reviewed by ${reviewedBy}`;
}

/** §7.13 W13 — the M32 capability disclosure footer an enhanced encounter PDF carries. */
export function encounterCapabilityDisclosureFooter(capabilityId: string): string {
  return `AI-assisted content generated under M32 capability ${capabilityId}; reviewed and attested by the signing clinician.`;
}

/**
 * Build the `encounter_pdf` render payload (§7.13 W13). An addendum renders as a NEW `document_version` (the prior
 * version is untouched — the append-only ledger). When M8 Layer 2 attached an M32 narrative enhancement, the
 * AI-assisted sidebar block is populated and the PDF carries the capability disclosure footer; otherwise both are
 * absent. PURE.
 */
export function buildEncounterPdfRenderPayload(input: EncounterPdfRenderInput): EncounterPdfRenderPayload {
  const enh = input.narrativeEnhancement ?? null;
  return {
    templateKey: "encounter_pdf",
    encounterId: input.encounterId,
    versionReason: input.isAddendum === true ? "addendum" : "initial",
    narrativeSidebar: enh
      ? {
          text: enh.text,
          attribution: encounterNarrativeAttribution(enh.reviewedBy),
          capabilityDisclosureFooter: encounterCapabilityDisclosureFooter(enh.capabilityId),
        }
      : null,
  };
}
