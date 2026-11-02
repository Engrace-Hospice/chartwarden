// apps/backend/src/modules/36-messaging/death-notification/death-notification-alerts.ts - the fixed-text, in-app alerts of the death-notification
// cascade. PHI-free by construction (ADR-0073): no patient, no name, no cause, no item wording in the text, the payload or the correlation id
// (a hash, never a raw id). Every text is PROVISIONAL (no clinical-lead or bereavement-coordinator sign-off). An alert is an inbox entry; it
// never pages anyone, and it NEVER carries medication or equipment instructions (those are board items, not messages).
import { createHash } from "node:crypto";
import type { AlertEmitter } from "@chartwarden/messaging";
import type { DeathNotificationInternalKind } from "@chartwarden/types";
import { emitWithRecipientFallback } from "../alert-recipient-fallback";

export const DEATH_NOTIFICATION_ALERT_PREFIX = "m36.death_notification" as const;
export const DEATH_NOTIFICATION_BLOCKED_ALERT = "m36.death_notification.blocked_no_baa" as const;
export const DEATH_NOTIFICATION_UNACKED_ALERT = "m36.death_notification.unacked" as const;
export const DEATH_NOTIFICATION_DEEP_LINK = "/messaging/death-board";

export const DEATH_NOTIFICATION_TEXT = {
  notice: "A patient death has been recorded. Please open the checklist and acknowledge this notice.",
  blockedNoBaa:
    "A funeral home notice was not sent because no Business Associate Agreement is on file for it. Record the agreement or choose another funeral home.",
  unacked: "A death notice has not been acknowledged. A supervisor should follow up.",
} as const;

/** The role keys each role-resolved internal kind is aimed at. MUST match PLATFORM_DEFAULT_ALERT_RULES (a unit test pins it). */
export const DEATH_NOTIFICATION_ROLE_KEYS: Readonly<
  Record<Exclude<DeathNotificationInternalKind, "attending">, readonly string[]>
> = {
  medical_director: ["medical_director"],
  bereavement_coordinator: ["bereavement_coordinator"],
  billing_lead: ["billing_manager", "biller"],
  pharmacy_liaison: ["pharmacy_liaison"],
  dme_liaison: ["dme_liaison"],
};

export type DeathNotificationWarn = (message: string, context: Record<string, string>) => void;

/** A short hash that dedupes redeliveries; it never carries a raw id. */
export function deathNotificationCorrelationKey(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 32);
}

export const deathNotificationAlertType = (kind: DeathNotificationInternalKind): string =>
  `${DEATH_NOTIFICATION_ALERT_PREFIX}.${kind}`;

/** Tell one internal recipient (or role audience). Falls back to the tenant admins when nobody resolves. Returns the resolved count. */
export async function emitInternalNotice(
  alerts: AlertEmitter,
  orgId: string,
  input: {
    readonly kind: DeathNotificationInternalKind;
    readonly notificationId: string;
    readonly recipientUserId?: string | undefined;
  },
  warn?: DeathNotificationWarn,
): Promise<number> {
  const { resolvedRecipientCount } = await emitWithRecipientFallback(
    alerts,
    orgId,
    {
      eventType: deathNotificationAlertType(input.kind),
      severity: "info",
      correlationId: `death-notification:${deathNotificationCorrelationKey(input.notificationId)}:notice`,
      payload: {
        ...(input.recipientUserId ? { recipientUserId: input.recipientUserId } : {}),
        message: DEATH_NOTIFICATION_TEXT.notice,
        deepLink: DEATH_NOTIFICATION_DEEP_LINK,
      },
    },
    warn,
  );
  return resolvedRecipientCount;
}

async function emitSupervisorAlert(
  alerts: AlertEmitter,
  orgId: string,
  eventType: string,
  notificationId: string,
  message: string,
): Promise<number> {
  const { resolvedRecipientCount } = await alerts.emit(orgId, {
    eventType,
    severity: "warn",
    correlationId: `death-notification:${deathNotificationCorrelationKey(notificationId)}:${eventType}`,
    payload: { message, deepLink: DEATH_NOTIFICATION_DEEP_LINK },
  });
  return resolvedRecipientCount;
}

export const emitBlockedNoBaaAlert = (alerts: AlertEmitter, orgId: string, notificationId: string) =>
  emitSupervisorAlert(
    alerts,
    orgId,
    DEATH_NOTIFICATION_BLOCKED_ALERT,
    notificationId,
    DEATH_NOTIFICATION_TEXT.blockedNoBaa,
  );

export const emitUnackedAlert = (alerts: AlertEmitter, orgId: string, notificationId: string) =>
  emitSupervisorAlert(
    alerts,
    orgId,
    DEATH_NOTIFICATION_UNACKED_ALERT,
    notificationId,
    DEATH_NOTIFICATION_TEXT.unacked,
  );
