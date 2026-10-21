// @chartwarden/billing — the `transfer_notice_record` lifecycle reducer: the Medicare hospice Change of Provider /
// Transfer Notice (TOB 81C/82C), its date correction and its 8xD void (CMS Pub. 100-04 ch. 11 §20.1.3 /
// §20.1.4, Rev. 12847). Shape-identical to `machines/noe.ts` / `machines/notr.ts` (a flat transition table + a
// pure guard + a non-throwing `reduce`) and over the SAME `NoticeState` alphabet, so the notice worklist, the
// submission worker and the ack mapping treat all three notice kinds alike.
//
// What differs from the NOE, and why:
//   • `assemble` (DRAFT → READY) is GUARDED. The NOE fast path has no submission gate — it must race a 5-day
//     window. The 8xC has no such window (CGS CR 8877 FAQ: "hospice transfers and the submission of 8XC
//     transactions are not subject to the 5-day timely filing requirement") and instead a HOLD: "The 8XC does
//     not get submitted until after the other provider has finalized their billing" (§20.1.3). The guard fact is
//     the count of open blockers from `transfer-notice/rules.ts` (the hold is one of them); fail-closed when absent.
//   • `cancel` (DRAFT/READY → CANCELLED) is a staff decision with a recorded reason (a transfer recorded in
//     error, a duplicate), not an upstream-reversal fact; the guard is that a reason was given. Once SUBMITTED,
//     a transfer is removed with an 8xD void notice instead (§20.1.4 "Cancellation notices can also be used to
//     remove a transfer ... that was submitted in error") — a new row, not an edge here.
//
// PURE DOMAIN: no Fastify, no DB, no clock, no PHI/MBI (D13).
import type { NoticeState } from "../contracts";

export type TransferNoticeTransitionEvent =
  | "assemble"
  | "cancel"
  | "submit"
  | "ack_999_accepted"
  | "ack_999_rejected"
  | "ack_277ca_accepted"
  | "ack_277ca_rejected";

export interface TransferNoticeTransition {
  readonly from: NoticeState;
  readonly event: TransferNoticeTransitionEvent;
  readonly to: NoticeState;
}

export const TRANSFER_NOTICE_TRANSITIONS: readonly TransferNoticeTransition[] = [
  { from: "draft", event: "assemble", to: "ready" },
  { from: "draft", event: "cancel", to: "cancelled" },
  { from: "ready", event: "cancel", to: "cancelled" },
  { from: "ready", event: "submit", to: "submitted" },
  { from: "submitted", event: "ack_999_accepted", to: "ack_pending" },
  { from: "submitted", event: "ack_999_rejected", to: "ack_rejected" },
  { from: "ack_pending", event: "ack_277ca_accepted", to: "ack_accepted" },
  { from: "ack_pending", event: "ack_277ca_rejected", to: "ack_rejected" },
] as const;

/** `ack_accepted` (success), `ack_rejected` (a redraft is its own row) and `cancelled` have no outbound edge. */
export const TRANSFER_NOTICE_TERMINAL_STATES: readonly NoticeState[] = [
  "ack_accepted",
  "ack_rejected",
  "cancelled",
] as const;

export function isTerminal(state: NoticeState): boolean {
  return !TRANSFER_NOTICE_TRANSITIONS.some((t) => t.from === state);
}

/** The already-resolved guard facts (this module performs no I/O). */
export interface TransferNoticeGuardContext {
  /** For `assemble`: the number of open blockers (`evaluateTransferNotice(...).blockers.length`). */
  readonly openBlockers?: number;
  /** For `cancel`: whether a non-empty cancel reason was supplied. */
  readonly cancelReasonProvided?: boolean;
}

function findTransition(
  from: NoticeState,
  event: TransferNoticeTransitionEvent,
): TransferNoticeTransition | undefined {
  return TRANSFER_NOTICE_TRANSITIONS.find((t) => t.from === from && t.event === event);
}

function guardPasses(
  event: TransferNoticeTransitionEvent,
  ctx: TransferNoticeGuardContext,
): boolean {
  if (event === "assemble") return ctx.openBlockers === 0;
  if (event === "cancel") return ctx.cancelReasonProvided === true;
  return true;
}

/** True iff `event` is legal from `from` AND its guard passes (fail-closed when the guard fact is absent). */
export function canTransition(
  from: NoticeState,
  event: TransferNoticeTransitionEvent,
  ctx: TransferNoticeGuardContext = {},
): boolean {
  return findTransition(from, event) !== undefined && guardPasses(event, ctx);
}

export interface TransferNoticeReduceResult {
  readonly state: NoticeState;
  /** `'INVALID_TRANSITION'` or `'GUARD_FAILED'` when rejected; absent on success. */
  readonly error?: "INVALID_TRANSITION" | "GUARD_FAILED";
}

/** Apply a transition. NON-THROWING: an illegal pair or a failed guard returns the unchanged state + a code. */
export function reduce(
  state: NoticeState,
  event: TransferNoticeTransitionEvent,
  ctx: TransferNoticeGuardContext = {},
): TransferNoticeReduceResult {
  const transition = findTransition(state, event);
  if (!transition) return { state, error: "INVALID_TRANSITION" };
  if (!guardPasses(event, ctx)) return { state, error: "GUARD_FAILED" };
  return { state: transition.to };
}
