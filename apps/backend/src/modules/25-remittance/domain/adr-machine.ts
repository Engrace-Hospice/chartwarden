// M25 — ADR (additional documentation request) state machine (milestone 2). PURE. A packet always passes
// through review before it is submitted; review may send it back to assembly. `submitted` can only close
// (a MAC that never decides is handled by the claim/denial path, not here). Terminal rows are frozen.
import type { AdrState } from "./types";

export const ADR_TRANSITIONS: Readonly<Record<AdrState, readonly AdrState[]>> = {
  received: ["in_assembly", "denied_no_response", "withdrawn"],
  in_assembly: ["in_review", "denied_no_response", "withdrawn"],
  in_review: ["in_assembly", "submitted", "denied_no_response", "withdrawn"],
  submitted: ["closed"],
  denied_no_response: [],
  withdrawn: [],
  closed: [],
};

export function canTransitionAdr(from: AdrState, to: AdrState): boolean {
  return ADR_TRANSITIONS[from].includes(to);
}

export function isAdrTerminal(state: AdrState): boolean {
  return ADR_TRANSITIONS[state].length === 0;
}
