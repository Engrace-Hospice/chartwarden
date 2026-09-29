// apps/backend/src/modules/22-documents/seams/renderer.ts — M22-T04 the §4.3 `DocumentRenderer` impl: the
// §7.2 W2 render-from-typed-payload handshake. M22 publishes ONE render surface every source module (M5,
// M6, M8, M11, M12, M13, M14, M15, M16, M17, M18, M23, M39) calls instead of importing M22's schema. The
// caller hands a typed payload + a template KEY (`cti`, `encounter`, `consent_record`, …); the renderer
// selects the template descriptor, derives the PHI-free object key (D11, ./lifecycle/storage), "renders"
// the bytes (here a deterministic stand-in — the real react-pdf/puppeteer adapter is injected later, §7.2
// step 4), writes them through the injected {@link ObjectStorePort}, and upserts the `document` (+ genesis
// `document_version`, or a NEW version on the addendum/correction path — W2 step: an addendum is a new
// VERSION, not a new DOCUMENT). It returns `{ documentId }` per the leaf-typed `DocumentRenderer` contract
// (@wardenx/types); the `m22.document.rendered` outbox dispatch + the source-module back-ref are the
// downstream half of the handshake (separate task). Pure orchestration over the two injected ports — no DB,
// no MinIO SDK, no real PDF library here.
import type {
  DocumentAggregateType,
  DocumentRenderer,
  DocumentRetentionClass,
  OrgScope,
} from "@wardenx/types";
import { deriveObjectKey, deriveTenantBucket } from "../lifecycle/storage";
import type { DocumentSeamStore, ObjectStorePort } from "./store";

/** Raised when the W2 handshake is asked to render an unknown template key (no descriptor). The caller's
 * worker retries-then-dead-letters per §7.2 (no `document` row is created). */
export class UnknownTemplateError extends Error {
  readonly code = "UNKNOWN_TEMPLATE";
  constructor(templateKey: string) {
    super(`no published M22 template for key '${templateKey}'`);
    this.name = "UnknownTemplateError";
  }
}

/** The descriptor a template key resolves to (the manifest the §7.2 step-2 lookup returns). Phase-1 reads
 * this from the `form_template` / `form_template_version` tables under RLS; the slice keys on this fixed
 * table so the handshake is exercisable with no DB. `aggregateType` is the `document.aggregate_type` the
 * rendered row carries; `retentionClass` is the INSERT-time retention class (D23, never updated). */
export interface TemplateDescriptor {
  readonly aggregateType: DocumentAggregateType;
  readonly retentionClass: DocumentRetentionClass;
  readonly defaultTitle: string;
}

/**
 * The platform-floor template table the slice resolves keys against (a faithful subset of the §7.2
 * template manifest). Production resolves the descriptor from the published `form_template_version` row.
 * Keys mirror the §7.2 examples + the M39 `consent_record` key the consent module already renders through.
 */
export const PLATFORM_TEMPLATE_TABLE: Readonly<Record<string, TemplateDescriptor>> = {
  cti: {
    aggregateType: "cti",
    retentionClass: "compliance",
    defaultTitle: "Certification of Terminal Illness",
  },
  f2f: {
    aggregateType: "f2f",
    retentionClass: "compliance",
    defaultTitle: "Face-to-Face Encounter",
  },
  nor: { aggregateType: "nor", retentionClass: "compliance", defaultTitle: "Notice of Right" },
  // GAP-038 — the CMS-R-131 Advance Beneficiary Notice M23 requests via `m23.abn.required`. Same class as
  // the other CMS beneficiary notices above (`nor`): a signed notice of non-coverage is compliance
  // evidence, not a clinical record.
  abn: {
    aggregateType: "abn",
    retentionClass: "compliance",
    defaultTitle: "Advance Beneficiary Notice of Noncoverage",
  },
  election_statement: {
    aggregateType: "election_statement",
    retentionClass: "compliance",
    defaultTitle: "Hospice Election Statement",
  },
  revocation: {
    aggregateType: "revocation",
    retentionClass: "compliance",
    defaultTitle: "Revocation",
  },
  discharge_summary: {
    aggregateType: "discharge_summary",
    retentionClass: "clinical_record",
    defaultTitle: "Discharge Summary",
  },
  encounter: {
    aggregateType: "encounter",
    retentionClass: "clinical_record",
    defaultTitle: "Encounter Note",
  },
  order_record: {
    aggregateType: "order_record",
    retentionClass: "clinical_record",
    defaultTitle: "Order",
  },
  medication_order: {
    aggregateType: "medication_order",
    retentionClass: "clinical_record",
    defaultTitle: "Medication Order",
  },
  medication_administration_record: {
    aggregateType: "medication_administration_record",
    retentionClass: "clinical_record",
    defaultTitle: "Medication Administration Record",
  },
  bereavement_letter: {
    aggregateType: "bereavement_letter",
    retentionClass: "bereavement",
    defaultTitle: "Bereavement Letter",
  },
  // M21's two supply artifacts, keyed by the `documentKind` discriminator on
  // `m21.supply_request.document_requested`. M22's §4.5 registry never allocated a template for either,
  // which is why M21 had been emitting render requests nothing could resolve (mig 0196 adds the
  // matching aggregate types). The BOL is a shipping manifest — `operational`. The return receipt is a
  // DEA-1304 controlled-substance disposition record — `compliance`, not the clinical class its
  // deployment-side sibling (`comfort_kit_receipt`, M13) carries.
  supply_bill_of_lading: {
    aggregateType: "supply_bill_of_lading",
    retentionClass: "operational",
    defaultTitle: "Bill of Lading",
  },
  comfort_kit_return_receipt: {
    aggregateType: "comfort_kit_return_receipt",
    retentionClass: "compliance",
    defaultTitle: "Comfort Kit Return Receipt",
  },
  // M33's two report artifacts (GAP-051, mig 0197), keyed by the `aggregateType` discriminator on
  // `m33.scheduled_report.render_requested`. Both are `operational`: a report snapshot is aggregate-only
  // (D6 — no row-level PHI reaches the renderer), so neither is a clinical record nor compliance evidence.
  // `scheduled_report` files against the OCCURRENCE, not the schedule — a weekly report renders a new
  // document every week, and `report_schedule_run.document_id` is the column waiting for it.
  report_export: {
    aggregateType: "report_export",
    retentionClass: "operational",
    defaultTitle: "Report Export",
  },
  scheduled_report: {
    aggregateType: "report_schedule_run",
    retentionClass: "operational",
    defaultTitle: "Scheduled Report",
  },
  evv_verification: {
    aggregateType: "evv_verification",
    retentionClass: "operational",
    defaultTitle: "Visit Verification",
  },
  // ── F-099: the six render requests that were emitted from production write paths and rendered by
  // nothing. Adding a source module is one REQUEST_SHAPES row plus its descriptor(s) here; these are the
  // descriptors. Retention is the artifact's own class, not the requesting module's.
  //
  // M10 — the printable HOPE summary. A `clinical_record`: it is the assessment as filed, on the chart.
  hope_summary: {
    aggregateType: "hope_summary",
    retentionClass: "clinical_record",
    defaultTitle: "HOPE Assessment Summary",
  },
  // M16 — the D14 welcome packet. `bereavement_letter` is ONE aggregate type with several template keys
  // (the letter kinds), so this needs no new type; only this key is emitted today. A key M16 has not
  // started emitting deliberately gets NO descriptor: an unpublished template is a visible
  // retry-then-DLQ, and publishing descriptors for renders nobody requests would manufacture coverage.
  bereavement_welcome_packet: {
    aggregateType: "bereavement_letter",
    retentionClass: "bereavement",
    defaultTitle: "Bereavement Welcome Packet",
  },
  // M20 — `compliance`, not `operational`: an OSHA-recordable workplace-injury report is retained
  // evidence, and the patient-safety ones feed M30's QAPI review.
  safety_incident_report: {
    aggregateType: "safety_incident_report",
    retentionClass: "compliance",
    defaultTitle: "Safety Incident Report",
  },
  // M25 — the tier-specific denial-appeal letter as submitted to the MAC/QIC/ALJ.
  appeal_packet: {
    aggregateType: "appeal_packet",
    retentionClass: "compliance",
    defaultTitle: "Appeal Packet",
  },
  // M25 — the manual (no-appeal) denial-resolution letter, filed against `denial_case`. F-144 (#248):
  // catalogued (`m25.denial_resolution_letter.render_requested`) and never emitted before this pass.
  denial_resolution_letter: {
    aggregateType: "denial_resolution_letter",
    retentionClass: "compliance",
    defaultTitle: "Denial Resolution Letter",
  },
  // M23's four §4.10 document kinds behind ONE wire event (`m23.billing.document_render_requested`,
  // discriminated by `kind`) — F-144 (#248): `consumers/document-render.ts`'s four typed builders had
  // every payload shape and no caller. All `compliance`: each is CMS-filing-adjacent correspondence, the
  // same class `abn`/`nor`/`cti` already carry, not a clinical record.
  noe_confirmation_receipt: {
    aggregateType: "noe_confirmation_receipt",
    retentionClass: "compliance",
    defaultTitle: "Notice of Election Confirmation Receipt",
  },
  notr_confirmation_receipt: {
    aggregateType: "notr_confirmation_receipt",
    retentionClass: "compliance",
    defaultTitle: "Notice of Termination/Revocation Confirmation Receipt",
  },
  claim_acknowledgment_letter: {
    aggregateType: "claim_acknowledgment_letter",
    retentionClass: "compliance",
    defaultTitle: "Claim Acknowledgment Letter",
  },
  denial_appeal_cover_letter: {
    aggregateType: "denial_appeal_cover_letter",
    retentionClass: "compliance",
    defaultTitle: "Denial Appeal Cover Letter",
  },
  // M24's §4.10 equivalent of `claim_acknowledgment_letter` above, behind its own wire event
  // (`m24.medicaid_billing.document_render_requested`) — F-144 (#248). The other three kinds the M24
  // spec names (R&B contract summary / remittance summary / denial-appeal cover letter) have no
  // producer transition yet and deliberately get no descriptor here (an unpublished template is a
  // visible retry-then-DLQ; publishing one for a render nobody requests would manufacture coverage).
  medicaid_claim_acknowledgment_letter: {
    aggregateType: "medicaid_claim_acknowledgment_letter",
    retentionClass: "compliance",
    defaultTitle: "Medicaid Claim Acknowledgment Letter",
  },
  // M27's three, keyed by the `artifactKind` discriminator. The event's own payload schema pins
  // `retentionClass: "compliance"` for all three, which is what these carry.
  cost_report_ecr: {
    aggregateType: "cost_report_ecr",
    retentionClass: "compliance",
    defaultTitle: "Electronic Cost Report",
  },
  cost_report_pi: {
    aggregateType: "cost_report_pi",
    retentionClass: "compliance",
    defaultTitle: "Provider Information Supplement",
  },
  cost_report_supporting_doc: {
    aggregateType: "cost_report_supporting_doc",
    retentionClass: "compliance",
    defaultTitle: "Cost Report Supporting Document",
  },
  // M37 — the artifact `ipu_body_release.release_document_id` was built to point at; the schema comment
  // on that column already names this template.
  body_release_authorization: {
    aggregateType: "body_release_authorization",
    retentionClass: "compliance",
    defaultTitle: "Body Release Authorization",
  },
  consent_record: {
    aggregateType: "consent_record",
    retentionClass: "compliance",
    defaultTitle: "Consent",
  },
  // §7.5 W5 — the Statement-of-Disagreement template (M5 amendment-denied; compliance class, D13).
  patient_amendment_statement_of_disagreement: {
    aggregateType: "patient_amendment_statement_of_disagreement",
    retentionClass: "compliance",
    defaultTitle: "Statement of Disagreement",
  },
  // §7.15 W-M22-22 — the Phase-F lab-results template (D14). Default retention is `clinical_record`; the
  // §7.16 SUD-redacted variant overrides the INSERT-time class to `compliance_42cfr_part2` (D23).
  lab_results_pdf: {
    aggregateType: "order_record",
    retentionClass: "clinical_record",
    defaultTitle: "Lab Results",
  },
  // GAP-048 — M34's §7.3 DSAR-export worker renders the assembled FHIR Bundle chart PDF through this key
  // (a direct `DocumentRenderer.render()` call, not an outbox round-trip — no DSAR-specific aggregate
  // exists, so the job id itself is the back-referenced aggregate, `aggregateType: "other"`).
  dsar_bundle: {
    aggregateType: "other",
    retentionClass: "compliance",
    defaultTitle: "DSAR Export Bundle",
  },
  // GAP-094 — M34's §3.7/§7.6 tenant-export worker renders the cover-letter PDF that accompanies the
  // whole-tenant NDJSON archive through this key (a direct `DocumentRenderer.render()` call, same as
  // `dsar_bundle` above — the job id is the back-referenced aggregate, `aggregateType: "other"`).
  tenant_export_cover_letter: {
    aggregateType: "other",
    retentionClass: "compliance",
    defaultTitle: "Tenant Export Cover Letter",
  },
  // F-161 (#248) — two of the seven events in M22's own `handlers-unbound` group's "decisively named by
  // the producing module's own outbox table" bucket that actually turned out to be real, buildable
  // renders (the other five — m14.minutes.amended, m21.supply_request.delivered, and all three
  // m39.consent.* events — are NOT document renders at all; see the render-consumer.ts comment on each).
  //
  // M17 §4.11 D15 — the caregiver visit-confirmation reminder. `visit_confirmation` has been a published
  // `document_aggregate_type` value since the enum's base definition with no descriptor here and no
  // producer request event ever wired to it.
  visit_confirmation: {
    aggregateType: "visit_confirmation",
    retentionClass: "operational",
    defaultTitle: "Visit Confirmation Reminder",
  },
  // M7 §2.4 — the care-plan PDF. `m7.care_plan.version_signed`'s own catalog comment ("drives the M8
  // encounter gate + M22 PDF") is decisive; mig 0252 adds the `document_aggregate_type` value.
  care_plan: {
    aggregateType: "care_plan",
    retentionClass: "clinical_record",
    defaultTitle: "Plan of Care",
  },
  // F-166 (#248) — M14's two IDG render requests. Both `document_aggregate_type` values have existed
  // since migration 0048 with no descriptor and no subscription — F-162's own precise finding
  // ("even a first-ever render would hit `unknown_template` today"). `clinical_record`: both are the
  // signed record of an IDG meeting (the packet and the minutes), not correspondence.
  idg_patient_packet: {
    aggregateType: "idg_patient_packet",
    retentionClass: "clinical_record",
    defaultTitle: "IDG Patient Packet",
  },
  idg_minutes: {
    aggregateType: "idg_minutes",
    retentionClass: "clinical_record",
    defaultTitle: "IDG Meeting Minutes",
  },
  // F-166 (#248) — M15's four discipline plans, one `m15.plan.version_signed` event discriminated by
  // `kind`, one descriptor per kind (never a shared type — the F-160/M23 "a shared type would make one
  // kind's render read as an idempotent redelivery of a different kind's under the same
  // (aggregateType, aggregateId) key" reasoning, and here the four kinds share nothing else either: a
  // signed Aide POC and a signed MSW plan are different `discipline_care_plan.id` rows to begin with, so
  // this is belt-and-suspenders rather than load-bearing). All four `document_aggregate_type` values have
  // existed since the platform-floor enum's base definition (migration 0048) with no descriptor and no
  // producer request wired to any of them until now — the `visit_confirmation`/`care_plan` shape a third
  // time. `clinical_record`: each is a signed, in-force plan of care the surveyor expects on the chart.
  aide_poc: {
    aggregateType: "aide_poc",
    retentionClass: "clinical_record",
    defaultTitle: "Aide Plan of Care",
  },
  msw_plan: {
    aggregateType: "msw_plan",
    retentionClass: "clinical_record",
    defaultTitle: "Medical Social Work Plan",
  },
  spiritual_plan: {
    aggregateType: "spiritual_plan",
    retentionClass: "clinical_record",
    defaultTitle: "Spiritual Care Plan",
  },
  volunteer_plan: {
    aggregateType: "volunteer_plan",
    retentionClass: "clinical_record",
    defaultTitle: "Volunteer Plan",
  },
} as const;

/** The shape every W2 caller's typed payload carries (a structural minimum; the full payload is template-
 * specific). The renderer needs the aggregate identity + tenant + (optional) patient to shape the row +
 * the PHI-free key. Extra fields are template content and are passed straight to the byte renderer. */
export interface RenderPayloadCore {
  readonly aggregateId: string;
  readonly patientId?: string | null;
  readonly title?: string;
  /** F-168 (#248) — the delivered outbox event that requested this render, when the caller has one.
   *  Forwarded straight through to `RenderUpsert.sourceEventId` (`document_version.source_event_id`) — the
   *  §4.11 render-consumer sets this; every other `render()` caller (DSAR/tenant-export jobs, the M39
   *  consent render, the lab-backref/statement-of-disagreement variants) leaves it unset, which the store
   *  writes as NULL, exactly its prior behaviour. */
  readonly sourceEventId?: string | null;
}

/** Injectable wall clock (ISO instant). Overridable for deterministic tests; defaults to real time. */
export type NowClock = () => string;
const realClock: NowClock = () => new Date().toISOString();

/** A 12-char PHI-free short token for the object filename (D11). Deterministic in tests via `rng`. */
export type ShortIdFn = () => string;
const realShortId: ShortIdFn = () =>
  Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

/** Deterministic stand-in for the §7.2 step-4 PDF render. The real react-pdf/puppeteer adapter is injected
 * in a later task; this produces stable bytes from the template key + payload so the handshake (key shape,
 * version chain, immutability) is testable with no PDF library. */
function renderBytes(templateKey: string, payload: unknown): Uint8Array {
  const json = JSON.stringify({ templateKey, payload });
  return new TextEncoder().encode(`%PDF-1.7\n% wardenx-render\n${json}\n`);
}

/** Every current template resolves through {@link renderBytes}' PDF stand-in (GAP-095). */
const RENDER_MIME_TYPE = "application/pdf";

export interface DocumentRendererDeps {
  readonly store: DocumentSeamStore;
  readonly objects: ObjectStorePort;
  readonly templates?: Readonly<Record<string, TemplateDescriptor>>;
  readonly now?: NowClock;
  readonly shortId?: ShortIdFn;
}

/**
 * Build the §4.3 `DocumentRenderer` (the W2 handshake) over the two injected ports. `render(scope,
 * templateKey, payload)` resolves the template, derives the PHI-free per-version object key, writes the
 * rendered bytes through the object store, and upserts the `document` (+ version) — returning `{ documentId }`.
 * The org scope comes from `scope.orgId` (RLS-pinned); the renderer never switches tenants.
 */
export function createDocumentRenderer(deps: DocumentRendererDeps): DocumentRenderer {
  const templates = deps.templates ?? PLATFORM_TEMPLATE_TABLE;
  const now = deps.now ?? realClock;
  const shortId = deps.shortId ?? realShortId;

  return {
    async render(
      scope: OrgScope,
      templateKey: string,
      payload: unknown,
    ): Promise<{ documentId: string }> {
      const descriptor = templates[templateKey];
      if (descriptor === undefined) throw new UnknownTemplateError(templateKey);

      const core = (payload ?? {}) as RenderPayloadCore;
      if (typeof core.aggregateId !== "string" || core.aggregateId.length === 0) {
        throw new UnknownTemplateError(templateKey); // payload missing the aggregate identity — refuse
      }
      const organizationId = scope.orgId;
      const patientId = core.patientId ?? null;
      const bucket = deriveTenantBucket(organizationId);

      // §7.2 step 4: render the bytes. (Stand-in until the react-pdf/puppeteer adapter lands.)
      const bytes = renderBytes(templateKey, payload);

      // §7.2 step 5 / D11: derive the PHI-free per-version key, then write the bytes BEFORE the row exists
      // (a failed write never leaves an orphan `document` row). The documentId is not yet known on a
      // first render, so the key keys on the aggregate (stable, PHI-free) + a short version token.
      const objectKey = deriveObjectKey({
        kind: patientId === null ? "intake" : "rendered",
        aggregateType: descriptor.aggregateType,
        documentId: core.aggregateId,
        patientId,
        batchId: patientId === null ? core.aggregateId : null,
        shortVersionId: shortId(),
      });
      const { sha256Hex } = await deps.objects.putObject({ bucket, objectKey, bytes });

      // §7.2 step 5: upsert the `document` (genesis) or append a new version (W2 addendum/correction).
      const row = await deps.store.upsertRenderedDocument({
        organizationId,
        aggregateType: descriptor.aggregateType,
        aggregateId: core.aggregateId,
        patientId,
        retentionClass: descriptor.retentionClass,
        title: core.title ?? descriptor.defaultTitle,
        objectKey,
        bucket,
        sha256Hex,
        byteSize: bytes.byteLength,
        mimeType: RENDER_MIME_TYPE,
        renderedAt: now(),
        sourceEventId: core.sourceEventId ?? null,
      });

      return { documentId: row.documentId };
    },
  };
}
