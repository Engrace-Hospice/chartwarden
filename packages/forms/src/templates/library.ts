// @wardenx/forms — §4.5 the Form Template Library (D14, D16, D20, D21): template lookup + versioning +
// tenant-overlay resolution. The platform-floor template is the SOURCE OF TRUTH; a tenant overlay may
// only TIGHTEN it (add branding, narrow a value space, customize prose) and may NEVER WEAKEN it (drop a
// regulatory-required field, widen an enumeration, remove a watermark). This mirrors the M38 terminology
// tenant-extension (add-only) and M36 alert-template (tighten-only) overlay semantics.
//
// Two enforcement points (D16 defense-in-depth): `validateOverlay` runs at OVERLAY PUBLISH time (gives the
// tenant admin field-level feedback) and `resolveTemplate` re-runs it at RENDER time (catches drift if the
// platform floor evolved and the overlay was not re-validated). Both are PURE over the registry data —
// no DB, no react-pdf/puppeteer import. The backend wires the published-version lookup + the stored overlay
// row to these functions (M22-T05 seams/library-store + the §4.5 admin routes in a later task).

import type { DocumentRetentionClass } from "@wardenx/types";
import type { FormTemplateDescriptor } from "./interface";
import { FORM_TEMPLATE_REGISTRY, findFormTemplate } from "./registry";

/** A tenant's add-only/tighten-only customization of one platform template (D14/D16). The branding fields
 * are pure additions; `narrowedFields` constrains a {@link FormTemplateDescriptor.tightenableFields} value
 * space; `bodyTextOverride` re-prose-s a template with explicit tenant-text support (bereavement letters,
 * encounter PDF — §7.7 W7). NOTHING here can drop a `requiredField` or a `requiredWatermark`. */
export interface TenantTemplateOverlay {
  readonly templateKey: string;
  readonly organizationId: string;
  /** The overlay's own monotonic version (D14; `tenant_template_overlay.version`). */
  readonly version: number;
  /** Pure-addition branding: letterhead/logo/footer/signature-block style. PHI-free by construction. */
  readonly branding?: {
    readonly logoObjectKey?: string;
    readonly footerText?: string;
    readonly letterheadText?: string;
    readonly signatureBlockStyle?: string;
  };
  /** Per-field value-space NARROWING (subset of the platform-floor allowed values). Key must be in the
   * template's `tightenableFields`; values must be a SUBSET of `platformAllowedValues[key]`. */
  readonly narrowedFields?: Readonly<Record<string, readonly string[]>>;
  /** Tenant prose customization for templates with explicit text support (bereavement, encounter PDF). */
  readonly bodyTextOverride?: string;
  /** Fields the overlay attempts to REMOVE — modeled so the validator can reject a loosening publish with a
   * field-level diff (the overlay editor surfaces this list, §5.1 `FORM.TemplateOverlayEditor`). */
  readonly droppedFields?: readonly string[];
  /** Watermarks the overlay attempts to REMOVE — modeled so the validator can reject (D16). */
  readonly droppedWatermarks?: readonly string[];
  /** Per-field value-space WIDENING the overlay attempts (the loosening failure mode — always rejected). */
  readonly widenedFields?: Readonly<Record<string, readonly string[]>>;
}

/** §4.5 — the platform-floor allowed value space per tightenable field. Used by the D16 validator to verify
 * a `narrowedFields` entry is a subset (tightening) and a `widenedFields` entry is rejected. The v1 lock
 * only ships `code_status_field` (the rest of the tightenable fields enumerate at the per-template schema). */
export const PLATFORM_FIELD_VALUE_SPACE: Readonly<Record<string, readonly string[]>> = {
  code_status_field: ["full_code", "dnr", "dnar", "dni", "comfort_only"],
} as const;

/** One reason an overlay publish was rejected by the D16 golden-template-diff validator (§7.7 W7). */
export interface OverlayViolation {
  readonly kind:
    | "dropped_required_field"
    | "dropped_required_watermark"
    | "widened_field"
    | "narrowed_field_not_subset"
    | "narrowed_field_not_tightenable"
    | "unknown_template";
  readonly field?: string;
  readonly detail: string;
}

/** The result of the D16 validator — accepted, or rejected with the field-level diff the overlay editor renders. */
export type OverlayValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly OverlayViolation[] };

/**
 * §4.5 / D16 — the golden-template-diff validator. PURE over the platform-floor descriptor + the proposed
 * overlay. Rejects any overlay that (a) drops a platform-required field, (b) drops a platform-required
 * watermark, (c) WIDENS any field's value space, or (d) NARROWS a field that is not in `tightenableFields`
 * or to a set that is not a subset of the platform floor. Add-only branding + body-text override always pass.
 * Runs at publish time AND at render time (defense in depth).
 */
export function validateOverlay(overlay: TenantTemplateOverlay): OverlayValidationResult {
  const floor = findFormTemplate(overlay.templateKey);
  if (floor === undefined) {
    return {
      ok: false,
      violations: [{ kind: "unknown_template", detail: `no platform template for key '${overlay.templateKey}'` }],
    };
  }
  const violations: OverlayViolation[] = [];

  for (const field of overlay.droppedFields ?? []) {
    if (floor.requiredFields.includes(field)) {
      violations.push({
        kind: "dropped_required_field",
        field,
        detail: `overlay drops platform-required field '${field}'`,
      });
    }
  }
  for (const wm of overlay.droppedWatermarks ?? []) {
    if (floor.requiredWatermarks.includes(wm)) {
      violations.push({
        kind: "dropped_required_watermark",
        field: wm,
        detail: `overlay drops platform-required watermark '${wm}'`,
      });
    }
  }
  for (const field of Object.keys(overlay.widenedFields ?? {})) {
    violations.push({
      kind: "widened_field",
      field,
      detail: `overlay widens the value space of '${field}' (widening is loosening — rejected)`,
    });
  }
  for (const [field, values] of Object.entries(overlay.narrowedFields ?? {})) {
    if (!floor.tightenableFields.includes(field)) {
      violations.push({
        kind: "narrowed_field_not_tightenable",
        field,
        detail: `field '${field}' is not platform-tightenable`,
      });
      continue;
    }
    const ceiling = PLATFORM_FIELD_VALUE_SPACE[field] ?? [];
    const offending = values.filter((v) => !ceiling.includes(v));
    if (offending.length > 0) {
      violations.push({
        kind: "narrowed_field_not_subset",
        field,
        detail: `narrowed values [${offending.join(", ")}] for '${field}' are not a subset of the platform floor`,
      });
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** The effective template the renderer materializes: the platform-floor descriptor + the validated overlay
 * applied (branding merged, value spaces narrowed). The required fields/watermarks ALWAYS reflect the
 * platform floor (the overlay can only add). */
export interface ResolvedTemplate {
  readonly key: string;
  readonly version: string;
  readonly engine: FormTemplateDescriptor["engine"];
  readonly aggregateType: FormTemplateDescriptor["aggregateType"];
  readonly retentionClass: DocumentRetentionClass;
  readonly patientFacing: boolean;
  /** The platform-floor required fields (overlay can never drop one). */
  readonly requiredFields: readonly string[];
  /** The platform-floor required watermarks (overlay can never drop one). */
  readonly requiredWatermarks: readonly string[];
  /** The effective value space per tightenable field after overlay narrowing. */
  readonly effectiveFieldValues: Readonly<Record<string, readonly string[]>>;
  /** The branding the overlay contributed (undefined when no overlay). */
  readonly branding?: TenantTemplateOverlay["branding"];
  /** The tenant body-text override when present (bereavement/encounter), else undefined. */
  readonly bodyTextOverride?: string;
  /** The overlay version applied, or null when rendering the bare platform floor. */
  readonly overlayVersion: number | null;
}

/** Raised when `resolveTemplate` is asked for an unknown platform template key, or an overlay that fails the
 * D16 render-time re-validation (drift since publish — §7.7 W8 / §9.3 `overlay_loosens_platform_floor`). */
export class TemplateResolutionError extends Error {
  readonly code: "UNKNOWN_TEMPLATE" | "OVERLAY_LOOSENS_PLATFORM_FLOOR";
  readonly violations: readonly OverlayViolation[];
  constructor(
    code: "UNKNOWN_TEMPLATE" | "OVERLAY_LOOSENS_PLATFORM_FLOOR",
    message: string,
    violations: readonly OverlayViolation[] = [],
  ) {
    super(message);
    this.name = "TemplateResolutionError";
    this.code = code;
    this.violations = violations;
  }
}

/**
 * §4.5 — resolve the effective template the renderer uses: select the platform-floor descriptor by key,
 * RE-validate the overlay (D16 render-time check, defense in depth), then apply the validated overlay's
 * branding + value narrowing. The platform floor's required fields/watermarks always carry through (the
 * overlay can only add). With no overlay, returns the bare platform floor. PURE; the version-resolution
 * (published-at-render-time) policy is the caller's — pass the descriptor's `version` straight through.
 */
export function resolveTemplate(
  templateKey: string,
  overlay?: TenantTemplateOverlay,
): ResolvedTemplate {
  const floor = findFormTemplate(templateKey);
  if (floor === undefined) {
    throw new TemplateResolutionError("UNKNOWN_TEMPLATE", `no platform template for key '${templateKey}'`);
  }

  const effectiveFieldValues: Record<string, readonly string[]> = {};
  for (const field of floor.tightenableFields) {
    effectiveFieldValues[field] = PLATFORM_FIELD_VALUE_SPACE[field] ?? [];
  }

  if (overlay === undefined) {
    return {
      key: floor.key,
      version: floor.version,
      engine: floor.engine,
      aggregateType: floor.aggregateType,
      retentionClass: floor.retentionClass,
      patientFacing: floor.patientFacing,
      requiredFields: floor.requiredFields,
      requiredWatermarks: floor.requiredWatermarks,
      effectiveFieldValues,
      overlayVersion: null,
    };
  }

  // D16 render-time re-validation — refuse to render an overlay that loosens the floor.
  const validation = validateOverlay(overlay);
  if (!validation.ok) {
    throw new TemplateResolutionError(
      "OVERLAY_LOOSENS_PLATFORM_FLOOR",
      `overlay for '${templateKey}' loosens the platform floor`,
      validation.violations,
    );
  }

  for (const [field, values] of Object.entries(overlay.narrowedFields ?? {})) {
    effectiveFieldValues[field] = values; // validated as a subset above
  }

  return {
    key: floor.key,
    version: floor.version,
    engine: floor.engine,
    aggregateType: floor.aggregateType,
    retentionClass: floor.retentionClass,
    patientFacing: floor.patientFacing,
    requiredFields: floor.requiredFields,
    requiredWatermarks: floor.requiredWatermarks,
    effectiveFieldValues,
    branding: overlay.branding,
    bodyTextOverride: overlay.bodyTextOverride,
    overlayVersion: overlay.version,
  };
}

/** §4.5 / D14 — list the published platform catalog (for `documents.read_templates` + the admin editor). */
export function listPlatformTemplates(): readonly FormTemplateDescriptor[] {
  return FORM_TEMPLATE_REGISTRY;
}
