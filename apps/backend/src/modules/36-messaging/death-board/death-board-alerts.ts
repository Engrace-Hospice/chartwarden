// apps/backend/src/modules/36-messaging/death-board/death-board-alerts.ts - WP 6.9 (ADR-0098): the fixed-text, in-app alerts for the
// death board. PHI-free by construction (ADR-0073): no patient, no name, no item wording, no cause in the text, the payload or the
// correlation id (a hash, never a raw id). Every text is PROVISIONAL (no clinical-lead or bereavement-coordinator sign-off). An alert
// is an inbox entry; it never pages anyone.
import { createHash } from "node:crypto";
import type { AlertEmitter } from "@chartwarden/messaging";

/** Alert types that are alert-rule keys only (seeded in PLATFORM_DEFAULT_ALERT_RULES). */
export const DEATH_BOARD_ASSIGNED_ALERT = "m36.death_board.assigned" as const;
export const DEATH_BOARD_NEEDS_OWNER_ALERT = "m36.death_board.needs_owner" as const;

export const DEATH_BOARD_ALERT_TEXT = {
  assigned: "A follow-up checklist item has been assigned to you.",
  needsOwner: "A follow-up checklist item has no available owner. A supervisor must assign it.",
} as const;

export const DEATH_BOARD_DEEP_LINK = "/messaging/death-board";

export type DeathBoardWarn = (message: string, context: Record<string, string>) => void;

/** A short hash that dedupes redeliveries; it never carries the raw id. */
export function deathBoardCorrelationKey(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 32);
}

export async function emitAssignedAlert(
  alerts: AlertEmitter,
  orgId: string,
  ownerUserId: string,
  dedupeParts: readonly string[],
): Promise<void> {
  await alerts.emit(orgId, {
    eventType: DEATH_BOARD_ASSIGNED_ALERT,
    severity: "info",
    correlationId: `death-board:${deathBoardCorrelationKey(...dedupeParts, ownerUserId)}:assigned`,
    payload: {
      ownerUserId,
      message: DEATH_BOARD_ALERT_TEXT.assigned,
      deepLink: DEATH_BOARD_DEEP_LINK,
    },
  });
}

/** Tell the supervisor audience an item (or a whole board) has no one to own it. Returns how many recipients resolved. */
export async function emitNeedsOwnerAlert(
  alerts: AlertEmitter,
  orgId: string,
  dedupeParts: readonly string[],
): Promise<number> {
  const { resolvedRecipientCount } = await alerts.emit(orgId, {
    eventType: DEATH_BOARD_NEEDS_OWNER_ALERT,
    severity: "warn",
    correlationId: `death-board:${deathBoardCorrelationKey(...dedupeParts)}:needs_owner`,
    payload: { message: DEATH_BOARD_ALERT_TEXT.needsOwner, deepLink: DEATH_BOARD_DEEP_LINK },
  });
  return resolvedRecipientCount;
}
