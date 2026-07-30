// @wardenx/medicaid-adapters — M24 `rb_arrangement` lifecycle reducer (§2.2). Pure hand-rolled transition
// table (the M23 exemplar). DRAFT → ACTIVE (on contract sign + M22 upload) → EXPIRED | TERMINATED |
// SUPERSEDED (all terminal; chain preserved via supersedes_arrangement_id). PURE DOMAIN: no I/O, no PHI.
import type { RbArrangementState } from "../contracts";

export type RbArrangementEvent = "activate" | "expire" | "terminate" | "supersede";

export interface RbArrangementTransition {
  readonly from: RbArrangementState;
  readonly event: RbArrangementEvent;
  readonly to: RbArrangementState;
}

export const RB_ARRANGEMENT_TRANSITIONS: readonly RbArrangementTransition[] = [
  { from: "DRAFT", event: "activate", to: "ACTIVE" },
  { from: "ACTIVE", event: "expire", to: "EXPIRED" },
  { from: "ACTIVE", event: "terminate", to: "TERMINATED" },
  { from: "ACTIVE", event: "supersede", to: "SUPERSEDED" },
] as const;

export const RB_ARRANGEMENT_TERMINAL_STATES: readonly RbArrangementState[] = [
  "EXPIRED",
  "TERMINATED",
  "SUPERSEDED",
] as const;

export function isTerminal(state: RbArrangementState): boolean {
  return !RB_ARRANGEMENT_TRANSITIONS.some((t) => t.from === state);
}

export interface RbArrangementReduceResult {
  readonly state: RbArrangementState;
  readonly error?: string;
}

export function canTransition(from: RbArrangementState, event: RbArrangementEvent): boolean {
  return RB_ARRANGEMENT_TRANSITIONS.some((t) => t.from === from && t.event === event);
}

export function reduce(state: RbArrangementState, event: RbArrangementEvent): RbArrangementReduceResult {
  const transition = RB_ARRANGEMENT_TRANSITIONS.find((t) => t.from === state && t.event === event);
  if (!transition) return { state, error: "INVALID_TRANSITION" };
  return { state: transition.to };
}
