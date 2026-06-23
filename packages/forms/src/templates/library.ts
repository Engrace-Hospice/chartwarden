// @wardenx/forms — the §4.5 Form Template Library (M22-T05).
//
// The AUTHORITATIVE platform-floor manifest of M22's 31 v1 templates. Each row is the §4.5 taxonomy fact every
// render path needs BEFORE a binary exists: the stable `templateKey`, the §3.2 `aggregateType` it instantiates
// (NB: the key is NOT the aggregate type for the D21 discharge variants, `encounter_pdf`, `lab_results_pdf`,
// `emar_snapshot`, `visit_confirmation_letter`), the render `engine`, the `retentionClass` auto-stamped on the
// rendered `document`, and whether it is patient-facing (portal-eligible). This is the table M22-T04's renderer
// `resolveTemplateManifest` fallback promised to defer to (it is "that table"); the react-pdf / Puppeteer
// component `.tsx` + golden-output tests for each key land in later M22 tasks (§4.5 / §7 render variants).
//
// Decisions embodied here:
//   • D14 — the platform-floor is the source of truth; tenant overlays (`tenant_template_overlay`) TIGHTEN only
//     (branding + state addendum), never removing a mandatory regulatory field. The overlay composer (D16) lands
//     with the routes (M22-T07); this library is the floor it composes onto.
//   • D20 / D23 — a SUD-class render (e.g. a `lab_results_pdf` whose source observation is SUD-class) redacts the
//     value in the binary (D20, the render adapter) AND auto-upgrades the retention class to
//     `compliance_42cfr_part2` (D23). {@link resolveRenderRetentionClass} is the pure D23 upgrade rule.
//   • D21 — the external-source death-discharge two-PDF model is two distinct template keys
//     (`discharge_summary_v2_external_source` + `_cosigned`) both instantiating the `discharge_summary` aggregate.
//
// This module is PURE/typed — no render engine, no IO. It is the contract layer the M22 backend consumes; the
// §25.14 adapter mandate keeps the actual react-pdf / Puppeteer engines elsewhere in this same package.

import type {
  DocumentAggregateType,
  DocumentRetentionClass,
  FormRenderEngine,
} from "@wardenx/types";

/** The source module that owns the render trigger for a template (its `*.document_requested` outbox event, §4.11). */
export type FormTemplateSourceModule =
  | "M5"
  | "M5/M7"
  | "M6"
  | "M8"
  | "M11"
  | "M12"
  | "M12/M13"
  | "M13"
  | "M14"
  | "M15"
  | "M16"
  | "M17"
  | "M18"
  | "M23"
  | "M39";

/** A single §4.5 platform-floor template manifest row (the taxonomy facts; the render component lands per-key later). */
export interface FormTemplateManifestEntry {
  /** Stable template key (the per-`<key>/` directory name + the `m22.document.rendered` `templateKey` discriminator). */
  readonly key: string;
  /** The §3.2 aggregate type this template instantiates — NOT always equal to `key` (D21 variants, `*_pdf`, `*_snapshot`). */
  readonly aggregateType: DocumentAggregateType;
  /** The source module whose `*.document_requested` event triggers this render (§4.11). */
  readonly sourceModule: FormTemplateSourceModule;
  /** The §3.1 render adapter this template targets. */
  readonly engine: FormRenderEngine;
  /** The platform-floor retention class auto-stamped on the rendered `document` (D23 may upgrade to Part 2). */
  readonly retentionClass: DocumentRetentionClass;
  /** Whether the rendered document is patient-facing (portal-eligible, §4.5 column). */
  readonly patientFacing: boolean;
  /** The semver version label of this template's current version (`form_template_version.semver`). */
  readonly currentVersion: string;
}

/**
 * The seven `bereavement_letter` sub-layouts (§4.5). `bereavement_letter` is a SINGLE template key with a
 * `letterKind` discriminator in the render payload selecting one of these — matching M16's D14 outbox event design
 * (`m16.bereavement.outreach_artifact_requested` carries `letterKind`). They are NOT separate `aggregateType`s.
 */
export const BEREAVEMENT_LETTER_KINDS = [
  "condolence",
  "welcome_packet",
  "anniversary",
  "scheduled_contact",
  "complicated_grief_referral",
  "opt_out_confirmation",
  "closeout",
] as const;

export type BereavementLetterKind = (typeof BEREAVEMENT_LETTER_KINDS)[number];

/** The §4.5 platform-floor library: the 31 v1 templates. Frozen so no consumer mutates the shared floor. */
export const FORM_TEMPLATE_LIBRARY: readonly FormTemplateManifestEntry[] = Object.freeze([
  // ── M6 admission / election / certification / discharge (compliance) ──────────────────────────────────────
  { key: "election_statement", aggregateType: "election_statement", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "revocation", aggregateType: "revocation", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "cti", aggregateType: "cti", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: false, currentVersion: "1.0.0" },
  { key: "f2f", aggregateType: "f2f", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: false, currentVersion: "1.0.0" },
  { key: "nor", aggregateType: "nor", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "discharge_summary", aggregateType: "discharge_summary", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  // D21 — external-source death-discharge two-PDF model: two keys, one `discharge_summary` aggregate.
  { key: "discharge_summary_v2_external_source", aggregateType: "discharge_summary", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "discharge_summary_v2_external_source_cosigned", aggregateType: "discharge_summary", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "nomnc", aggregateType: "nomnc", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "abn", aggregateType: "abn", sourceModule: "M23", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "hipaa_privacy_notice", aggregateType: "hipaa_privacy_notice", sourceModule: "M6", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "code_status_directive", aggregateType: "code_status_directive", sourceModule: "M5/M7", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  // ── M8 / M11 / M12 / M13 clinical record ──────────────────────────────────────────────────────────────────
  { key: "encounter_pdf", aggregateType: "encounter", sourceModule: "M8", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "order_record", aggregateType: "order_record", sourceModule: "M11", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  // D20/D23 — SUD-class source observation → value redacted in the binary + retention upgraded to Part 2.
  { key: "lab_results_pdf", aggregateType: "order_record", sourceModule: "M11", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "medication_order", aggregateType: "medication_order", sourceModule: "M12", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "patient_medication_list", aggregateType: "patient_medication_list", sourceModule: "M12/M13", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: true, currentVersion: "1.0.0" },
  { key: "medication_reconciliation_worksheet", aggregateType: "medication_reconciliation_worksheet", sourceModule: "M13", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "emar_snapshot", aggregateType: "medication_administration_record", sourceModule: "M13", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "comfort_kit_receipt", aggregateType: "comfort_kit_receipt", sourceModule: "M13", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: true, currentVersion: "1.0.0" },
  // ── M14 IDG (puppeteer, clinical record) ──────────────────────────────────────────────────────────────────
  { key: "idg_patient_packet", aggregateType: "idg_patient_packet", sourceModule: "M14", engine: "puppeteer", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "idg_minutes", aggregateType: "idg_minutes", sourceModule: "M14", engine: "puppeteer", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  // ── M15 discipline care plans (clinical record) ───────────────────────────────────────────────────────────
  { key: "aide_poc", aggregateType: "aide_poc", sourceModule: "M15", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "msw_plan", aggregateType: "msw_plan", sourceModule: "M15", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "spiritual_plan", aggregateType: "spiritual_plan", sourceModule: "M15", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  { key: "volunteer_plan", aggregateType: "volunteer_plan", sourceModule: "M15", engine: "react_pdf", retentionClass: "clinical_record", patientFacing: false, currentVersion: "1.0.0" },
  // ── M16 bereavement (single key, 7 letterKind sub-layouts; bereavement retention) ─────────────────────────
  { key: "bereavement_letter", aggregateType: "bereavement_letter", sourceModule: "M16", engine: "react_pdf", retentionClass: "bereavement", patientFacing: true, currentVersion: "1.0.0" },
  // ── M17 / M18 operational + compliance ────────────────────────────────────────────────────────────────────
  { key: "visit_confirmation_letter", aggregateType: "visit_confirmation", sourceModule: "M17", engine: "react_pdf", retentionClass: "operational", patientFacing: true, currentVersion: "1.0.0" },
  { key: "evv_verification", aggregateType: "evv_verification", sourceModule: "M18", engine: "puppeteer", retentionClass: "compliance", patientFacing: false, currentVersion: "1.0.0" },
  // ── M5 amendment + M39 consent (compliance) ───────────────────────────────────────────────────────────────
  { key: "patient_amendment_statement_of_disagreement", aggregateType: "patient_amendment_statement_of_disagreement", sourceModule: "M5", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
  { key: "consent_record", aggregateType: "consent_record", sourceModule: "M39", engine: "react_pdf", retentionClass: "compliance", patientFacing: true, currentVersion: "1.0.0" },
]);

/** O(1) lookup index keyed by template key (built once from the frozen library). */
const BY_KEY: ReadonlyMap<string, FormTemplateManifestEntry> = new Map(
  FORM_TEMPLATE_LIBRARY.map((t) => [t.key, t]),
);

/** Resolve a template's §4.5 manifest row by key, or `null` when the key is unknown to the platform floor. */
export function lookupFormTemplate(key: string): FormTemplateManifestEntry | null {
  return BY_KEY.get(key) ?? null;
}

/** True when `key` is a published platform-floor template (the render gate uses this before enqueueing a render). */
export function isKnownFormTemplate(key: string): boolean {
  return BY_KEY.has(key);
}

/**
 * The D23 retention-class rule for a render: a SUD-class render auto-upgrades to `compliance_42cfr_part2`
 * regardless of the template's platform-floor class (the `lab_results_pdf` SUD path, §4.5 / D20). Every other
 * render keeps the floor class from the manifest. Returns the floor class when the key is unknown (caller still
 * validates the key separately).
 */
export function resolveRenderRetentionClass(
  key: string,
  opts: { readonly sudClass?: boolean } = {},
): DocumentRetentionClass {
  if (opts.sudClass === true) return "compliance_42cfr_part2";
  return lookupFormTemplate(key)?.retentionClass ?? "clinical_record";
}
