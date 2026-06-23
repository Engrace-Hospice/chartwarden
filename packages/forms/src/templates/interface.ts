// @wardenx/forms — §3.1 / §4.5 the FormTemplate contract (Pillar 2 — the canonical renderer).
//
// M22-T01 ships the DOMAIN layout only: the FormTemplate descriptor shape + the platform-floor template
// registry as pure data. The react-pdf / Puppeteer adapters, the per-template `payload-schema.ts` TypeBox
// schemas, and the `vX_Y_Z.tsx` components land in later M22 tasks. Leaf-import only (`@wardenx/types`).

import type {
  DocumentAggregateType,
  DocumentRetentionClass,
  FormRenderEngine,
} from "@wardenx/types";

/** §4.5 — a platform-published form-template descriptor. The platform-floor template is the source of
 * truth; tenant overlays tighten only (D16). `retentionClass` is the default the renderer stamps on the
 * resulting `document` unless a per-render rule (e.g. D23 SUD auto-tag on `lab_results_pdf`) overrides it. */
export interface FormTemplateDescriptor {
  /** The platform-published template key (e.g. `election_statement`, `cti`). */
  readonly key: string;
  /** The `document.aggregate_type` the rendered output carries. */
  readonly aggregateType: DocumentAggregateType;
  /** Which of the two render backends materializes this template. */
  readonly engine: FormRenderEngine;
  /** The default retention class stamped on the rendered document. */
  readonly retentionClass: DocumentRetentionClass;
  /** Whether the rendered document is exposed in the M31 portal by default. */
  readonly patientFacing: boolean;
}
