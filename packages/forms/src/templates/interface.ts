// @chartwarden/forms — §3.1 / §4.5 the FormTemplate contract (Pillar 2 — the canonical renderer).
//
// M22-T01 ships the DOMAIN layout only: the FormTemplate descriptor shape + the platform-floor template
// registry as pure data. The react-pdf / Puppeteer adapters, the per-template `payload-schema.ts` TypeBox
// schemas, and the `vX_Y_Z.tsx` components land in later M22 tasks. Leaf-import only (`@chartwarden/types`).

import type {
  DocumentAggregateType,
  DocumentRetentionClass,
  FormRenderEngine,
} from "@chartwarden/types";

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
  /** The current platform-published semver of this template (D14; `form_template_version.version`). The
   * §4.5 v1 lock ships every template at `1.0.0`; later platform versions bump this in the registry. */
  readonly version: string;
  /** §4.5 / §2.3 — the platform-floor REQUIRED layout fields a tenant overlay may neither drop nor weaken
   * (D16 golden-template-diff: NPP wording, ABN required text, NOMNC text, watermarks, signature blocks).
   * The overlay validator rejects any publish that removes one of these keys. */
  readonly requiredFields: readonly string[];
  /** §4.5 / D16 — fields whose value space the overlay may NARROW (tighten) but never WIDEN. Each entry is a
   * field whose platform-floor allowed values are the ceiling; an overlay enumeration must be a subset. */
  readonly tightenableFields: readonly string[];
  /** §4.5 / D16 — platform-mandated watermarks the overlay must preserve (e.g. `CRITICAL RESULT` on the
   * critical lab-results variant, D22; `for hospice use only`). An overlay that drops one is rejected. */
  readonly requiredWatermarks: readonly string[];
}
