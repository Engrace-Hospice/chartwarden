// @wardenx/messaging — notification-template resolution + render (M36-T09, spec §3.13, ADR-0024).
//
// The pure half of the cross-module notification composer (§4.11): given a platform-floor
// `notification_template` row and an optional per-tenant overlay, compute the EFFECTIVE template
// and render its title/body placeholders from the source event payload. Nothing here touches a
// DB, a clock, or a vendor — the composer (./compose-cross-module) loads the rows over injected
// ports and feeds them in.
//
// Tenant overlay is TIGHTEN-ONLY in the M22 `form_template` sense (§3.13.2): an overlay may
// REWORD the title/body for brand voice, but it can NEVER change the `payload_schema`, the
// `default_payload_type`, or the `default_recipient_resolver`. That rule is enforced
// STRUCTURALLY here — {@link resolveTemplate} only ever reads title/body off the overlay and
// always takes schema/payload-type/resolver from the floor — so a tenant simply cannot express
// a loosening change.

/** A platform-floor `notification_template` row as the composer consumes it (§3.13.2). A NULL
 *  `organizationId` row is the platform floor; the schema/payload-type/resolver fields are
 *  platform-owned and never overridable by a tenant overlay. */
export interface NotificationTemplateRow {
  /** `null` = platform-floor row; a uuid = a tenant-scoped published row. */
  readonly organizationId: string | null;
  readonly templateKey: string;
  readonly version: number;
  readonly titleTemplate: string;
  readonly bodyTemplate: string;
  /** JSON-schema object whose `required: string[]` names the placeholders the template renders. */
  readonly payloadSchema: Readonly<Record<string, unknown>>;
  readonly defaultPayloadType: string;
  readonly defaultRecipientResolver: string;
  readonly ownedByModule: string;
}

/** A per-tenant overlay row (§3.13.2). `titleTemplate`/`bodyTemplate` are nullable — a null
 *  means "use the platform default". The overlay carries NO schema/resolver/payload-type field,
 *  so it is incapable of loosening the platform floor (tighten-only by construction). */
export interface TenantTemplateOverlayRow {
  readonly organizationId: string;
  readonly templateKey: string;
  readonly titleTemplate: string | null;
  readonly bodyTemplate: string | null;
}

/** The effective template the composer renders: the floor's schema/payload-type/resolver with the
 *  overlay's wording applied (or the floor's wording when the overlay leaves a field null). */
export interface EffectiveNotificationTemplate {
  readonly templateKey: string;
  readonly titleTemplate: string;
  readonly bodyTemplate: string;
  readonly payloadSchema: Readonly<Record<string, unknown>>;
  readonly defaultPayloadType: string;
  readonly defaultRecipientResolver: string;
}

/** The rendered, ready-to-dispatch copy. PHI-bearing by design (it may name a patient); it travels
 *  only on the in-perimeter in-app channel — the §4.7 sanitizer strips it for any out-of-band hop. */
export interface RenderedTemplate {
  readonly title: string;
  readonly body: string;
}

/** Thrown when an overlay for one `template_key` is paired with a floor for a different key — a
 *  caller wiring bug, never a tenant-reachable state. */
export class TemplateOverlayMismatchError extends Error {
  constructor(
    readonly floorKey: string,
    readonly overlayKey: string,
  ) {
    super(
      `template_overlay_mismatch: overlay for '${overlayKey}' cannot tighten floor for '${floorKey}'`,
    );
    this.name = "TemplateOverlayMismatchError";
  }
}

/** Thrown when the source event payload is missing a placeholder the template's `payload_schema`
 *  declares required (§3.13) — the composer refuses to dispatch a half-rendered notification. */
export class MissingTemplateVariableError extends Error {
  constructor(
    readonly templateKey: string,
    readonly missing: readonly string[],
  ) {
    super(
      `missing_template_variable: template '${templateKey}' requires [${missing.join(", ")}] not present in the source payload`,
    );
    this.name = "MissingTemplateVariableError";
  }
}

/** `{{placeholder}}` — a single word inside double braces, optional inner whitespace. */
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** The `required` placeholder list declared by a template's `payload_schema` (empty if absent). */
function requiredVariables(payloadSchema: Readonly<Record<string, unknown>>): string[] {
  const req = payloadSchema.required;
  return Array.isArray(req) ? req.filter((k): k is string => typeof k === "string") : [];
}

/**
 * Compute the EFFECTIVE template from a platform floor and an optional tenant overlay (§3.13.2).
 * The overlay can only reword title/body; schema, `default_payload_type`, and
 * `default_recipient_resolver` always come from the floor — so the overlay cannot loosen the
 * platform contract (tighten-only by construction). Throws {@link TemplateOverlayMismatchError}
 * if the overlay names a different `template_key` than the floor.
 */
export function resolveTemplate(
  floor: NotificationTemplateRow,
  overlay?: TenantTemplateOverlayRow | null,
): EffectiveNotificationTemplate {
  if (overlay && overlay.templateKey !== floor.templateKey) {
    throw new TemplateOverlayMismatchError(floor.templateKey, overlay.templateKey);
  }
  return {
    templateKey: floor.templateKey,
    titleTemplate: overlay?.titleTemplate ?? floor.titleTemplate,
    bodyTemplate: overlay?.bodyTemplate ?? floor.bodyTemplate,
    // Platform-owned — never sourced from the overlay (tighten-only, §3.13.2):
    payloadSchema: floor.payloadSchema,
    defaultPayloadType: floor.defaultPayloadType,
    defaultRecipientResolver: floor.defaultRecipientResolver,
  };
}

/**
 * Render the effective template's title/body from the SOURCE event payload (§4.11 step 2). First
 * validates that every `payload_schema.required` placeholder is present (throws
 * {@link MissingTemplateVariableError} otherwise), then substitutes `{{key}}` occurrences with the
 * stringified payload value. Pure and total over a well-formed input.
 */
export function renderTemplate(
  template: EffectiveNotificationTemplate,
  sourcePayload: Readonly<Record<string, unknown>>,
): RenderedTemplate {
  const required = requiredVariables(template.payloadSchema);
  const missing = required.filter(
    (k) => sourcePayload[k] === undefined || sourcePayload[k] === null,
  );
  if (missing.length > 0) throw new MissingTemplateVariableError(template.templateKey, missing);

  const substitute = (tpl: string): string =>
    tpl.replace(PLACEHOLDER, (whole, key: string) => {
      const v = sourcePayload[key];
      return v === undefined || v === null ? whole : String(v);
    });

  return { title: substitute(template.titleTemplate), body: substitute(template.bodyTemplate) };
}
