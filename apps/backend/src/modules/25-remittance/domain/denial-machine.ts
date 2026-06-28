// M25 — denial-case state machine (§2.2). PURE. The allowed transitions and the small bits of policy that
// guard them (reopen requires manager+reason; resolution can be reached with or without an appeal).
import type { DenialState } from "./types";

/** Adjacency: from-state → the set of states it may transition to. */
export const DENIAL_TRANSITIONS: Readonly<Record<DenialState, readonly DenialState[]>> = {
  open: ["in_progress", "escalated"],
  in_progress: ["escalated", "resolved"],
  escalated: ["appealed", "resolved"],
  appealed: ["resolved"], // auto on appeal close
  resolved: ["closed"],
  closed: ["open"], // reopen — gated by denial.reopen + reason ≥40 (Billing Manager+)
};

export function canTransitionDenial(from: DenialState, to: DenialState): boolean {
  return DENIAL_TRANSITIONS[from].includes(to);
}

/** The reopen edge is the only one that re-enters an open state; it carries extra authz (Billing Manager+). */
export function isReopen(from: DenialState, to: DenialState): boolean {
  return from === "closed" && to === "open";
}

/** Terminal state — no further transitions except the gated reopen. */
export function isDenialTerminal(state: DenialState): boolean {
  return state === "closed";
}
