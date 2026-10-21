// @chartwarden/messaging — platform-floor notification templates (M36-T09; spec §3.13.1 Phase C,
// ADR-0024). The six cross-module notification-copy rows M36 owns after ADR-0024 moved them from
// M14: the four referral events (M6), the lab-order transmission failure (M11), and the critical
// results render (M22). Each is a platform-floor row (`organizationId: null`) keyed by
// `(template_key, version)`; a tenant may add an overlay that REWORDS title/body only (§3.13.2).
//
// Source-of-truth-is-code → DB-mirror: the boot slice UPSERTs `toNewNotificationTemplateRows()`
// into `notification_template` (on the `(organization_id, template_key, version)` unique key);
// the table is regenerated from this seed, never hand-edited. Structural row type (no `@chartwarden/db`
// import) so the package stays a leaf — exactly the §3.10 `PLATFORM_DEFAULT_ALERT_RULES` pattern.

import type { NotificationTemplateRow } from "../compose/template-render";

/**
 * The six §3.13 platform-floor templates. `payloadSchema.required` names the placeholders each
 * title/body renders from the SOURCE event payload (the producer resolves display values such as
 * `patientName`/`actorName` before emitting). `defaultPayloadType` references the
 * `alert_payload_catalog` entry the producer module contributes (§3.12.5); for these rows it equals
 * the `template_key`. `defaultRecipientResolver` names a registered M36 resolver — the ADR-0024
 * `intake_supervisor` / `admissions_team` / `ordering_provider` resolvers (./compose/resolvers).
 */
export const PLATFORM_NOTIFICATION_TEMPLATES: readonly NotificationTemplateRow[] = [
  {
    organizationId: null,
    templateKey: "m6.referral.received",
    version: 1,
    titleTemplate: "New referral from {{sendingFacility}}",
    bodyTemplate:
      "A new patient referral was received from {{sendingFacility}} on {{receivedAt}}. " +
      "Please review and triage.",
    payloadSchema: { type: "object", required: ["sendingFacility", "receivedAt"] },
    defaultPayloadType: "m6.referral.received",
    defaultRecipientResolver: "intake_supervisor",
    ownedByModule: "m6",
  },
  {
    organizationId: null,
    templateKey: "m6.referral.accepted",
    version: 1,
    titleTemplate: "Referral accepted",
    bodyTemplate: "Referral for {{patientName}} was accepted by {{actorName}} on {{acceptedAt}}.",
    payloadSchema: { type: "object", required: ["patientName", "actorName", "acceptedAt"] },
    defaultPayloadType: "m6.referral.accepted",
    defaultRecipientResolver: "admissions_team",
    ownedByModule: "m6",
  },
  {
    organizationId: null,
    templateKey: "m6.referral.declined",
    version: 1,
    titleTemplate: "Referral was not accepted",
    bodyTemplate:
      "Referral for {{patientName}} was declined by {{actorName}} on {{declinedAt}}. " +
      "Reason: {{declineReason}}. Review and document if follow-up is needed.",
    payloadSchema: {
      type: "object",
      required: ["patientName", "actorName", "declinedAt", "declineReason"],
    },
    defaultPayloadType: "m6.referral.declined",
    defaultRecipientResolver: "intake_supervisor",
    ownedByModule: "m6",
  },
  {
    organizationId: null,
    templateKey: "m6.referral.withdrawn",
    version: 1,
    titleTemplate: "Referral canceled by referring party",
    bodyTemplate:
      "The referral from {{sendingFacility}} (received {{originalReceivedAt}}) was canceled by " +
      "the referring party on {{withdrawnAt}}. No further action required; archived for record.",
    payloadSchema: {
      type: "object",
      required: ["sendingFacility", "originalReceivedAt", "withdrawnAt"],
    },
    defaultPayloadType: "m6.referral.withdrawn",
    defaultRecipientResolver: "admissions_team",
    ownedByModule: "m6",
  },
  {
    organizationId: null,
    templateKey: "m11.order.transmission_terminal_failed",
    version: 1,
    titleTemplate: "Lab order transmission failed",
    bodyTemplate:
      "Lab order {{orderShortId}} for {{patientName}} could not be transmitted to " +
      "{{partnerLabName}} after {{transmittedAttempts}} attempts. Reason: {{failureReason}}. " +
      "Click here to manually reorder or contact the partner.",
    payloadSchema: {
      type: "object",
      required: [
        "orderShortId",
        "patientName",
        "partnerLabName",
        "transmittedAttempts",
        "failureReason",
      ],
    },
    defaultPayloadType: "m11.order.transmission_terminal_failed",
    defaultRecipientResolver: "ordering_provider",
    ownedByModule: "m11",
  },
  {
    organizationId: null,
    templateKey: "m22.document.rendered_critical_results",
    version: 1,
    titleTemplate: "CRITICAL lab results ready",
    bodyTemplate:
      "Critical lab results for {{patientName}} have been rendered and require immediate review. " +
      "Order: {{orderShortId}}. Open the patient chart to view.",
    payloadSchema: { type: "object", required: ["patientName", "orderShortId"] },
    defaultPayloadType: "m22.document.rendered_critical_results",
    defaultRecipientResolver: "ordering_provider",
    ownedByModule: "m22",
  },
];

/** Row shape the boot slice UPSERTs into `notification_template` (mirrors the Drizzle columns,
 *  §3.13.2). Structural (no `@chartwarden/db` import); `organizationId` is null for every floor row. */
export interface PlatformNotificationTemplateRow {
  readonly organizationId: null;
  readonly templateKey: string;
  readonly version: number;
  readonly titleTemplate: string;
  readonly bodyTemplate: string;
  readonly payloadSchema: Record<string, unknown>;
  readonly defaultPayloadType: string;
  readonly defaultRecipientResolver: string;
  readonly supportedLocales: string[];
  readonly status: "published";
  readonly ownedByModule: string;
}

/** Project the seed into the `notification_template` rows the boot UPSERT inserts (org_id NULL). */
export function toNewNotificationTemplateRows(
  templates: readonly NotificationTemplateRow[] = PLATFORM_NOTIFICATION_TEMPLATES,
): PlatformNotificationTemplateRow[] {
  return templates.map((t) => ({
    organizationId: null,
    templateKey: t.templateKey,
    version: t.version,
    titleTemplate: t.titleTemplate,
    bodyTemplate: t.bodyTemplate,
    payloadSchema: { ...t.payloadSchema },
    defaultPayloadType: t.defaultPayloadType,
    defaultRecipientResolver: t.defaultRecipientResolver,
    supportedLocales: ["en-US"],
    status: "published",
    ownedByModule: t.ownedByModule,
  }));
}

/** A §3.13 seed invariant the boot slice asserts before UPSERTing the floor templates. */
export interface NotificationTemplateSeedViolation {
  readonly templateKey: string;
  readonly type:
    | "not_platform_floor"
    | "duplicate_key"
    | "payload_type_key_mismatch"
    | "empty_resolver";
  readonly detail: string;
}

/**
 * Validate the platform-floor template seed (pure, no DB): every row is a platform floor
 * (`organizationId: null`), no `template_key` is seeded twice, the `default_payload_type` equals
 * the `template_key` (the §3.12.5 contract for these moved rows), and `default_recipient_resolver`
 * is non-empty. Returns every violation (empty ⇒ valid).
 */
export function validateNotificationTemplateSeed(
  templates: readonly NotificationTemplateRow[] = PLATFORM_NOTIFICATION_TEMPLATES,
): NotificationTemplateSeedViolation[] {
  const violations: NotificationTemplateSeedViolation[] = [];
  const seen = new Set<string>();
  for (const t of templates) {
    if (t.organizationId !== null) {
      violations.push({
        templateKey: t.templateKey,
        type: "not_platform_floor",
        detail: `template '${t.templateKey}' is not a platform-floor row (organization_id must be null)`,
      });
    }
    if (seen.has(t.templateKey)) {
      violations.push({
        templateKey: t.templateKey,
        type: "duplicate_key",
        detail: `template key '${t.templateKey}' is seeded more than once`,
      });
    }
    seen.add(t.templateKey);
    if (t.defaultPayloadType !== t.templateKey) {
      violations.push({
        templateKey: t.templateKey,
        type: "payload_type_key_mismatch",
        detail: `template '${t.templateKey}' default_payload_type '${t.defaultPayloadType}' must equal the template key (§3.12.5)`,
      });
    }
    if (t.defaultRecipientResolver.length === 0) {
      violations.push({
        templateKey: t.templateKey,
        type: "empty_resolver",
        detail: `template '${t.templateKey}' declares no default recipient resolver`,
      });
    }
  }
  return violations;
}

/** Boot gate: throw if the floor template seed has any §3.13 violation (fail-closed at startup). */
export function assertNotificationTemplateSeedValid(
  templates: readonly NotificationTemplateRow[] = PLATFORM_NOTIFICATION_TEMPLATES,
): void {
  const violations = validateNotificationTemplateSeed(templates);
  if (violations.length > 0) {
    const lines = violations.map((v) => `  • [${v.type}] ${v.detail}`).join("\n");
    throw new Error(
      `notification template seed invalid (${violations.length} violation(s)) — M36 boot refuses to start:\n${lines}`,
    );
  }
}
