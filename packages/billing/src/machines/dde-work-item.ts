// @chartwarden/billing — M23 DDE work-queue item lifecycle reducer (ADR-0052 D4).
//
// Shape-identical to `machines/noe.ts`: a flat transition table, a pure `canTransition`, and a non-throwing
// `reduce(state, event, ctx?) => { state, attemptNumber, error? }`. No clock, no DB, no PHI/MBI. The queue is
// human work tracking: `submit` records that an operator keyed the item in DDE (an attestation, never a verified
// fact); ChartWarden performs no FISS call.
//
//   queued -> assigned -> in_progress -> submitted -> accepted | returned, then closed.
//   `cancelled` is reachable only before submission. `returned` (RTP, rejection or ADR request) opens a new
//   attempt: returned -> in_progress (`retry`) increments `attempt_number`.

export const DDE_ITEM_TYPES = [
  "noe",
  "notr",
  "claim_entry",
  "rtp_correction",
  "adjustment",
  "cancel",
  "adr_response",
] as const;
export type DdeItemType = (typeof DDE_ITEM_TYPES)[number];

export const DDE_WORK_ITEM_STATES = [
  "queued",
  "assigned",
  "in_progress",
  "submitted",
  "accepted",
  "returned",
  "closed",
  "cancelled",
] as const;
export type DdeWorkItemState = (typeof DDE_WORK_ITEM_STATES)[number];

export type DdeWorkItemEvent =
  | "assign"
  | "unassign"
  | "start"
  | "submit"
  | "accept"
  | "return"
  | "retry"
  | "close"
  | "cancel"
  | "supersede";

export interface DdeWorkItemTransition {
  readonly from: DdeWorkItemState;
  readonly event: DdeWorkItemEvent;
  readonly to: DdeWorkItemState;
}

export const DDE_WORK_ITEM_TRANSITIONS: readonly DdeWorkItemTransition[] = [
  { from: "queued", event: "assign", to: "assigned" },
  { from: "assigned", event: "unassign", to: "queued" },
  { from: "assigned", event: "start", to: "in_progress" },
  { from: "in_progress", event: "submit", to: "submitted" },
  { from: "submitted", event: "accept", to: "accepted" },
  { from: "submitted", event: "return", to: "returned" },
  { from: "returned", event: "retry", to: "in_progress" },
  { from: "accepted", event: "close", to: "closed" },
  { from: "returned", event: "close", to: "closed" },
  // Cancel is legal only before the item was keyed (pre-submitted states).
  { from: "queued", event: "cancel", to: "cancelled" },
  { from: "assigned", event: "cancel", to: "cancelled" },
  { from: "in_progress", event: "cancel", to: "cancelled" },
  // Supersede is SYSTEM-only: the payer's own electronic acknowledgment (a 277CA acceptance of the claim / notice)
  // resolved the subject, so any open item for it is moot. Recorded in history as a system `close`.
  { from: "queued", event: "supersede", to: "closed" },
  { from: "assigned", event: "supersede", to: "closed" },
  { from: "in_progress", event: "supersede", to: "closed" },
  { from: "submitted", event: "supersede", to: "closed" },
  { from: "returned", event: "supersede", to: "closed" },
] as const;

/** Terminal states: no outbound edge. */
export const DDE_WORK_ITEM_TERMINAL_STATES: readonly DdeWorkItemState[] = [
  "closed",
  "cancelled",
] as const;

/** The states that still count as open work (a notice may have at most one open item per subject). */
export const DDE_WORK_ITEM_OPEN_STATES: readonly DdeWorkItemState[] = [
  "queued",
  "assigned",
  "in_progress",
  "submitted",
  "returned",
] as const;

export interface DdeWorkItemContext {
  /** The item's current attempt number (starts at 1). */
  readonly attemptNumber?: number;
}

export interface DdeWorkItemReduceResult {
  readonly state: DdeWorkItemState;
  readonly attemptNumber: number;
  /** `'INVALID_TRANSITION'` when the step was rejected; absent on success. */
  readonly error?: string;
}

function findTransition(
  from: DdeWorkItemState,
  event: DdeWorkItemEvent,
): DdeWorkItemTransition | undefined {
  return DDE_WORK_ITEM_TRANSITIONS.find((t) => t.from === from && t.event === event);
}

export function canTransition(from: DdeWorkItemState, event: DdeWorkItemEvent): boolean {
  return findTransition(from, event) !== undefined;
}

/** True iff `state` has no outbound transition. */
export function isTerminal(state: DdeWorkItemState): boolean {
  return !DDE_WORK_ITEM_TRANSITIONS.some((t) => t.from === state);
}

/** True iff the item is still open work. */
export function isOpen(state: DdeWorkItemState): boolean {
  return DDE_WORK_ITEM_OPEN_STATES.includes(state);
}

/** Apply an event. NON-THROWING: an illegal pair returns the unchanged state with `error`. Pure. */
export function reduce(
  state: DdeWorkItemState,
  event: DdeWorkItemEvent,
  ctx: DdeWorkItemContext = {},
): DdeWorkItemReduceResult {
  const attemptNumber = ctx.attemptNumber ?? 1;
  const transition = findTransition(state, event);
  if (!transition) return { state, attemptNumber, error: "INVALID_TRANSITION" };
  return {
    state: transition.to,
    attemptNumber: event === "retry" ? attemptNumber + 1 : attemptNumber,
  };
}
