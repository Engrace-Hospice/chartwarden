// apps/backend/src/modules/22-documents/render-variants/render-variants.ts — M22-T09 the §7.12/§7.13/§7.15
// per-aggregate-type render variants + the §7.16 SUD-redacted placeholder render. PURE planning over the
// T04 `DocumentRenderer` handshake (renderer.ts / PLATFORM_TEMPLATE_TABLE).
//
// The §7.2 W2 handshake is ONE render surface: a caller hands a template KEY + a typed payload and M22
// materializes the PDF. T04 fixed the key→descriptor table; THIS file fixes, per source aggregate, HOW its
// typed event payload (M18 EVV / M8 encounter / M11 lab-results) is MAPPED to the right template key + the
// content object the byte renderer consumes — the "render variant". Each variant is a pure function:
// (typed source payload) → { templateKey, content } that the live consumer feeds straight into
// `DocumentRenderer.render(scope, templateKey, content)`. No DB, no PDF library, no producer-package import
// (the source event payloads are locally-declared structural minimums; M22 deps stay [1, 5]).
//
//   • §7.12 W12  EVV verification render  — M18 `m18.evv.aggregator_accepted` → `evv_verification` template,
//                with the geo map-snapshot section OR the alternate-method exception narrative.
//   • §7.13 W13  encounter PDF render     — M8 `m8.encounter.signed` → `encounter` template, with the
//                optional M32 "AI-assisted narrative" sidebar block + capability-disclosure footer.
//   • §7.15 W-M22-22 lab-results render   — M11 `m11.order.results_received` → `lab_results_pdf` template,
//                each observation row rendered plaintext UNLESS it is SUD-class (§7.16 redaction).
//   • §7.16 W-M22-23 SUD-redacted render  — a SUD-class row (or whole document) rendered for a caller WITHOUT
//                an active 42 CFR Part 2 consent yields a deterministic REDACTED PLACEHOLDER (no PHI value);
//                the document carries retention_class `compliance_42cfr_part2` + `metadata.sudRedacted=true`.
import type { DocumentAggregateType, DocumentRetentionClass } from "@chartwarden/types";

// ── §7.16 SUD-redacted placeholder (no PHI) ─────────────────────────────────────────────────────────────

/** The deterministic placeholder text the renderer substitutes for a SUD-class value when 42 CFR Part 2
 * consent is absent (§7.16 / D20). Contains NO PHI — it is a fixed string, asserted by the render-grep test. */
export const SUD_REDACTED_PLACEHOLDER = "[SUD-CLASS RESULT — value not displayed]" as const;

/** The §7.16 banner the rendered PDF places above a redacted result block. Fixed, PHI-free. */
export const SUD_REDACTION_BANNER =
  "This result contains 42 CFR Part 2 (substance use disorder) information that is not displayed without a release of information consent." as const;

/** The retention class a SUD-class (42 CFR Part 2) document is INSERTED with (§7.16 / D23). Immutable. */
export const SUD_RETENTION_CLASS: DocumentRetentionClass = "compliance_42cfr_part2";

/**
 * Redact one rendered value for the SUD gate (§7.16 / D20). When the value is SUD-class AND consent is
 * absent, the value is replaced by the fixed PHI-free {@link SUD_REDACTED_PLACEHOLDER}; otherwise the
 * plaintext value passes through. Pure — the consent fact is injected (the live consumer resolves it via
 * the M39 `ConsentEvaluator` seam, the T06 consent-gate precedent).
 */
export function redactSudValue(args: {
  readonly value: string | null;
  readonly isSudClass: boolean;
  readonly consentPresent: boolean;
}): { readonly value: string | null; readonly redacted: boolean } {
  if (args.isSudClass && !args.consentPresent) {
    return { value: SUD_REDACTED_PLACEHOLDER, redacted: true };
  }
  return { value: args.value, redacted: false };
}

// ── the shared variant result (key + content the byte renderer consumes) ────────────────────────────────

/** The output of a render variant: the template KEY the W2 handshake resolves + the rendered content object.
 * `sudRedacted` flags the document's `metadata.sudRedacted` (D20/D23); `retentionClassOverride` forces the
 * INSERT-time retention class when the variant redacted SUD content (else the template descriptor wins). */
export interface RenderVariantResult {
  readonly templateKey: string;
  readonly aggregateType: DocumentAggregateType;
  readonly content: Record<string, unknown>;
  readonly sudRedacted: boolean;
  readonly retentionClassOverride?: DocumentRetentionClass;
}

// ── §7.12 W12 — EVV verification render variant (M18 `m18.evv.aggregator_accepted`) ─────────────────────

/** The M18 EVV-accepted payload, as M18 hands it on the outbox (structural minimum — M18 owns the canonical
 * superset). When `geoVerification` is present, the variant renders the geo map-snapshot section; when
 * `alternateMethodReason` is set instead, it renders the exception narrative (§7.12). */
export interface EvvVerificationPayload {
  readonly evvRecordId: string;
  readonly patientId: string;
  readonly visitId: string;
  readonly aggregatorRefId: string;
  readonly acceptedAt: string;
  readonly visitWindow?: { readonly start: string; readonly end: string };
  /** A captured geo verification (lat/lng + a pre-rendered map-snapshot ref); absent on alternate-method. */
  readonly geoVerification?: {
    readonly lat: number;
    readonly lng: number;
    readonly mapSnapshotRef?: string;
  };
  /** Set only when geo was unavailable and caregiver attestation was used (§7.12 exception path). */
  readonly alternateMethodReason?: string;
}

/**
 * §7.12 W12 — map an M18 EVV-accepted payload to the `evv_verification` template + content (pure). A
 * geo-verified visit renders the map-snapshot section (the snapshot is captured at render time, never a
 * live API call from the PDF — the variant only references the pre-captured snapshot); an alternate-method
 * visit renders the exception narrative instead. EVV is never SUD-class (operational retention).
 */
export function planEvvVerificationRender(payload: EvvVerificationPayload): RenderVariantResult {
  const hasGeo = payload.geoVerification !== undefined;
  const content: Record<string, unknown> = {
    evvRecordId: payload.evvRecordId,
    patientId: payload.patientId,
    visitId: payload.visitId,
    aggregatorRefId: payload.aggregatorRefId,
    acceptedAt: payload.acceptedAt,
    visitWindow: payload.visitWindow ?? null,
    // §7.12: the geo map-snapshot section XOR the alternate-method exception narrative.
    geoSection: hasGeo
      ? {
          kind: "map_snapshot" as const,
          lat: payload.geoVerification?.lat ?? null,
          lng: payload.geoVerification?.lng ?? null,
          mapSnapshotRef: payload.geoVerification?.mapSnapshotRef ?? null,
        }
      : {
          kind: "exception_narrative" as const,
          narrative: `Geographic verification unavailable; alternate method used: ${
            payload.alternateMethodReason ?? "not specified"
          }`,
        },
  };
  return {
    templateKey: "evv_verification",
    aggregateType: "evv_verification",
    content,
    sudRedacted: false,
  };
}

// ── §7.13 W13 — encounter PDF render variant (M8 `m8.encounter.signed`) ─────────────────────────────────

/** The M8 signed-encounter payload (structural minimum — M8 owns the canonical encounter row; the live
 * consumer hydrates the full body via the M8 reader seam). `aiNarrative` carries the optional M32 Layer-2
 * narrative-enhancement annotations (§7.13); when present the variant renders the AI-assisted sidebar. */
export interface EncounterRenderPayload {
  readonly encounterId: string;
  readonly patientId: string;
  readonly signedAt: string;
  readonly signedByClinician: string;
  readonly body: Record<string, unknown>;
  /** Optional M32 (M8 Layer-2) narrative enhancement — drives the §7.13 "AI-assisted narrative" sidebar. */
  readonly aiNarrative?: {
    readonly text: string;
    readonly capabilityId: string;
    readonly reviewedByClinician: string;
  };
}

/**
 * §7.13 W13 — map an M8 signed-encounter payload to the `encounter` template + content (pure). With no
 * narrative enhancement the content is the standard form body (react-pdf path); with an M32 enhancement the
 * variant adds the "AI-assisted narrative" sidebar block (clearly marked "AI-suggested, reviewed by …") and
 * the capability-disclosure footer (the Puppeteer fallback path). Encounter notes are clinical_record, never
 * SUD-class at the document level.
 */
export function planEncounterRender(payload: EncounterRenderPayload): RenderVariantResult {
  const hasAi = payload.aiNarrative !== undefined;
  const content: Record<string, unknown> = {
    encounterId: payload.encounterId,
    patientId: payload.patientId,
    signedAt: payload.signedAt,
    signedBy: payload.signedByClinician,
    body: payload.body,
    // §7.13: the optional M32 narrative-enhancement sidebar + capability-disclosure footer.
    aiNarrativeSidebar: hasAi
      ? {
          present: true as const,
          text: payload.aiNarrative?.text ?? "",
          label: `AI-suggested, reviewed by ${payload.aiNarrative?.reviewedByClinician ?? "clinician"}`,
          capabilityId: payload.aiNarrative?.capabilityId ?? null,
        }
      : { present: false as const },
    capabilityDisclosureFooter: hasAi,
  };
  return {
    templateKey: "encounter",
    aggregateType: "encounter",
    content,
    sudRedacted: false,
  };
}

// ── §7.15 W-M22-22 / §7.16 W-M22-23 — lab-results render variant (M11 `m11.order.results_received`) ─────

/** One observation value row in a lab-results render (structural minimum). `isSudClass` flags the 42 CFR
 * Part 2 entries M29's parser marks (§7.16); a SUD-class row is rendered redacted when consent is absent. */
export interface LabResultValue {
  readonly observationId: string;
  readonly loincCode: string;
  readonly label: string;
  readonly value: string | null;
  readonly unit?: string | null;
  readonly isSudClass: boolean;
}

/** The M11 lab-results payload (structural minimum — M11/M29 own the canonical observation rows; the live
 * consumer hydrates values via the M29 `LabObservationReader` + M11 `OrderProvider` seams). */
export interface LabResultsRenderPayload {
  readonly orderId: string;
  readonly patientId: string;
  readonly orderingPhysician: string;
  readonly signedAt: string;
  readonly resultValues: ReadonlyArray<LabResultValue>;
}

/**
 * §7.15 / §7.16 — map an M11 lab-results payload to the `lab_results_pdf` template + content (pure). Each
 * observation row renders plaintext UNLESS it is SUD-class AND `consentPresent` is false, in which case the
 * value is replaced by the fixed PHI-free {@link SUD_REDACTED_PLACEHOLDER} and the SUD banner is rendered
 * above the block (§7.16). If ANY row was redacted, the whole document is inserted as
 * `compliance_42cfr_part2` with `metadata.sudRedacted=true` (D23) — the binary then contains no plaintext
 * SUD value anywhere. `consentPresent` is injected (the live consumer resolves it via the M39 seam).
 */
export function planLabResultsRender(args: {
  readonly payload: LabResultsRenderPayload;
  readonly consentPresent: boolean;
}): RenderVariantResult {
  const { payload, consentPresent } = args;
  let anyRedacted = false;
  const rows = payload.resultValues.map((row) => {
    const { value, redacted } = redactSudValue({
      value: row.value,
      isSudClass: row.isSudClass,
      consentPresent,
    });
    if (redacted) anyRedacted = true;
    return {
      observationId: row.observationId,
      loincCode: row.loincCode,
      label: row.label,
      value,
      unit: row.unit ?? null,
      isSudClass: row.isSudClass,
      redacted,
    };
  });
  const content: Record<string, unknown> = {
    orderId: payload.orderId,
    patientId: payload.patientId,
    orderingPhysician: payload.orderingPhysician,
    signedAt: payload.signedAt,
    sudBanner: anyRedacted ? SUD_REDACTION_BANNER : null,
    resultValues: rows,
  };
  return {
    templateKey: "lab_results_pdf",
    aggregateType: "order_record",
    content,
    // §7.16: a redacted document is SUD-class — force `compliance_42cfr_part2` retention + the metadata flag.
    sudRedacted: anyRedacted,
    retentionClassOverride: anyRedacted ? SUD_RETENTION_CLASS : undefined,
  };
}

// ── F-171 (#248) — patient medication-list render variant (M12 `m12.medication_order.list_changed`) ──────

/** One active medication, as M12's real `MedicationOrderProvider.getActiveMedications` DTO projects it
 * (structural minimum — see the consumer for the field-by-field mapping off `MedicationOrderDto`).
 * `isSudTreatment` flags a drug M38's `sud_treatment_medication` value set matches (M12 owns this
 * classification, `packages/types/src/dosespot.ts`); a SUD-class row is redacted per §7.16, the identical
 * rule {@link planLabResultsRender} applies to a lab observation row, extended here to a drug name/sig
 * rather than a lab value — the same statute (42 CFR Part 2), the same disclosure risk. */
export interface PatientMedicationListEntry {
  readonly medicationOrderId: string;
  readonly drugName: string;
  readonly strength: string;
  readonly doseForm: string;
  readonly route: string;
  readonly sigSummary: string;
  readonly status: string;
  readonly isControlledSubstance: boolean;
  readonly deaSchedule: string | null;
  readonly signedAt: string | null;
  readonly isSudTreatment: boolean;
}

/** The patient med-list render payload the live consumer assembles from M12's `getActiveMedications` read
 * (never from the delivered `m12.medication_order.list_changed` payload, which carries only an
 * added/removed order-id DIFF — see the consumer's header for why the diff cannot supply this content). */
export interface PatientMedicationListRenderPayload {
  readonly patientId: string;
  /** The instant the medication set was resolved (render time), not the triggering event's own timestamp —
   *  a redelivery re-resolves the CURRENT list, which may differ from what triggered the original request. */
  readonly asOfIso: string;
  readonly medications: ReadonlyArray<PatientMedicationListEntry>;
}

/**
 * F-171 (#248) — map a resolved active-medication set to the `patient_medication_list` template + content
 * (pure). Each SUD-treatment row's `drugName`/`sigSummary` is redacted UNLESS `consentPresent` (§7.16,
 * `planLabResultsRender`'s rule applied to a drug name instead of a lab value); a non-SUD row's real drug
 * name/strength/sig pass through in full. If ANY row was redacted, the whole document is inserted as
 * `compliance_42cfr_part2` with `metadata.sudRedacted=true` (D23) — the binary then contains no plaintext
 * SUD-treatment drug name anywhere. An empty medication set is a legitimate, honestly-rendered outcome
 * (every order discontinued) rather than a failure — the consumer only calls this once the active set has
 * genuinely resolved (`facts.medicationsResolved`), never on a seam failure.
 */
export function planMedicationListRender(args: {
  readonly payload: PatientMedicationListRenderPayload;
  readonly consentPresent: boolean;
}): RenderVariantResult {
  const { payload, consentPresent } = args;
  let anyRedacted = false;
  const rows = payload.medications.map((m) => {
    const { value: drugName, redacted: nameRedacted } = redactSudValue({
      value: m.drugName,
      isSudClass: m.isSudTreatment,
      consentPresent,
    });
    const { value: sigSummary } = redactSudValue({
      value: m.sigSummary,
      isSudClass: m.isSudTreatment,
      consentPresent,
    });
    if (nameRedacted) anyRedacted = true;
    return {
      medicationOrderId: m.medicationOrderId,
      drugName,
      // Strength/form/route are dosage-form facts, not the drug identity itself; redacting the name and
      // sig already removes what §7.16 protects (which SUD-treatment drug, at what dose/frequency) without
      // also hiding the non-identifying administrative fields a discontinued-order audit still needs.
      strength: nameRedacted ? null : m.strength,
      doseForm: nameRedacted ? null : m.doseForm,
      route: nameRedacted ? null : m.route,
      sigSummary,
      status: m.status,
      isControlledSubstance: m.isControlledSubstance,
      deaSchedule: m.deaSchedule,
      signedAt: m.signedAt,
      isSudTreatment: m.isSudTreatment,
      redacted: nameRedacted,
    };
  });
  const content: Record<string, unknown> = {
    patientId: payload.patientId,
    asOfIso: payload.asOfIso,
    sudBanner: anyRedacted ? SUD_REDACTION_BANNER : null,
    medications: rows,
  };
  return {
    templateKey: "patient_medication_list",
    aggregateType: "patient_medication_list",
    content,
    sudRedacted: anyRedacted,
    retentionClassOverride: anyRedacted ? SUD_RETENTION_CLASS : undefined,
  };
}
