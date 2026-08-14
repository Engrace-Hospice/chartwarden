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
  evv_verification: {
    aggregateType: "evv_verification",
    retentionClass: "operational",
    defaultTitle: "Visit Verification",
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
} as const;

/** The shape every W2 caller's typed payload carries (a structural minimum; the full payload is template-
 * specific). The renderer needs the aggregate identity + tenant + (optional) patient to shape the row +
 * the PHI-free key. Extra fields are template content and are passed straight to the byte renderer. */
export interface RenderPayloadCore {
  readonly aggregateId: string;
  readonly patientId?: string | null;
  readonly title?: string;
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
      });

      return { documentId: row.documentId };
    },
  };
}
