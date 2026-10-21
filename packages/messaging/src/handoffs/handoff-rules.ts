// M36 WP 3.5 - the pure clinical-handoff rules (ADR-0062). No I/O: the service and the stores call these, so the per-item
// transition table, the derived handoff outcome, the policy-capped deadline and the offer limits have one definition.
import {
  HANDOFF_ITEM_KINDS,
  type HandoffAction,
  type HandoffCloseReason,
  type HandoffItemKind,
  type HandoffItemState,
  type HandoffRole,
  type HandoffState,
} from "@chartwarden/types";

export const HANDOFF_MAX_PATIENTS = 50;
export const HANDOFF_MAX_ITEMS = 250;
/** Only the NEXT visit starting inside this window is offered as a pre-filled item. */
export const HANDOFF_VISIT_HORIZON_HOURS = 48;

const MS_PER_MINUTE = 60_000;

/** What can happen to a pending item. `expire` is the system's (deadline); the rest are a person's. */
export type HandoffItemAction = "accept" | "decline" | "cancel" | "expire";

const ITEM_RESULT: Readonly<Record<HandoffItemAction, HandoffItemState>> = {
  accept: "accepted",
  decline: "declined",
  cancel: "cancelled",
  expire: "expired",
};

/** The state an action leads to, or null when the item is not pending (a resolved item is final). */
export function nextItemState(
  from: HandoffItemState,
  action: HandoffItemAction,
): HandoffItemState | null {
  return from === "pending" ? ITEM_RESULT[action] : null;
}

export type HandoffCloseOutcome =
  | { readonly kind: "open" }
  | {
      readonly kind: "closed";
      readonly state: Extract<HandoffState, "accepted" | "declined">;
      readonly reason: Extract<HandoffCloseReason, "all_resolved">;
    };

/** Open while any item is pending; otherwise accepted when at least one item was accepted, else declined. */
export function closeOutcome(items: readonly HandoffItemState[]): HandoffCloseOutcome {
  if (items.includes("pending")) return { kind: "open" };
  return {
    kind: "closed",
    state: items.includes("accepted") ? "accepted" : "declined",
    reason: "all_resolved",
  };
}

/** Items nobody took on: declined or expired. Cancelled items were withdrawn by the sender and do not count. */
export function unacceptedCount(items: readonly HandoffItemState[]): number {
  return items.filter((s) => s === "declined" || s === "expired").length;
}

interface DeadlineFacts {
  readonly offeredAt: Date;
  readonly expiresAt: Date;
}

/**
 * The deadline in force: the stored `expires_at`, never later than offered_at + the tenant's CURRENT minutes. Lowering
 * the policy tightens an in-flight offer; a hand-edited longer row cannot loosen it.
 */
export function effectiveDeadline(h: DeadlineFacts, effectiveMinutes: number): Date {
  const capped = h.offeredAt.getTime() + effectiveMinutes * MS_PER_MINUTE;
  return new Date(Math.min(h.expiresAt.getTime(), capped));
}

export function isPastDeadline(h: DeadlineFacts, effectiveMinutes: number, now: Date): boolean {
  return now.getTime() >= effectiveDeadline(h, effectiveMinutes).getTime();
}

export function handoffRole(
  h: { readonly fromUserId: string; readonly toUserId: string },
  userId: string,
): HandoffRole {
  if (h.fromUserId === userId) return "sender";
  return h.toUserId === userId ? "recipient" : "none";
}

/**
 * The actions `role` may take now. The recipient may act only on an open handoff before its deadline (the tick closes
 * it soon after); the sender may withdraw any open one, even past the deadline, until the tick closes it.
 */
export function allowedHandoffActions(
  h: DeadlineFacts & { readonly state: HandoffState },
  role: HandoffRole,
  now: Date,
  effectiveMinutes: number,
): HandoffAction[] {
  if (h.state !== "offered") return [];
  if (role === "sender") return ["cancel"];
  if (role === "recipient" && !isPastDeadline(h, effectiveMinutes, now))
    return ["accept", "decline"];
  return [];
}

export interface OfferItemShape {
  readonly kind: HandoffItemKind;
  readonly ref_id: string;
  readonly patient_id: string;
}

export type OfferShapeError =
  | "HANDOFF_ITEMS_REQUIRED"
  | "HANDOFF_TOO_MANY_ITEMS"
  | "HANDOFF_ITEM_INVALID";

/** Structural limits only (the service still verifies every item against its source). Null = acceptable. */
export function validateOfferShape(items: readonly OfferItemShape[]): OfferShapeError | null {
  if (items.length === 0) return "HANDOFF_ITEMS_REQUIRED";
  if (items.length > HANDOFF_MAX_ITEMS) return "HANDOFF_TOO_MANY_ITEMS";
  const patients = new Set(items.map((i) => i.patient_id));
  if (patients.size > HANDOFF_MAX_PATIENTS) return "HANDOFF_TOO_MANY_ITEMS";
  const seen = new Set<string>();
  for (const item of items) {
    if (!(HANDOFF_ITEM_KINDS as readonly string[]).includes(item.kind))
      return "HANDOFF_ITEM_INVALID";
    if (item.kind === "patient" && item.ref_id !== item.patient_id) return "HANDOFF_ITEM_INVALID";
    const key = `${item.kind}:${item.ref_id}`;
    if (seen.has(key)) return "HANDOFF_ITEM_INVALID";
    seen.add(key);
  }
  return null;
}
