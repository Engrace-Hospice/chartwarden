// @chartwarden/medicaid-adapters — M24 `rb_day` lifecycle reducer (§2.2). Pure transition table.
// pending → billable | excluded; billable → billed; billed → billable (claim voided/replaced) | excluded
// (arrangement corrected); excluded → billable (manual revert w/ reason); voided is terminal. PURE DOMAIN.
import type { RbDayStatus } from "../contracts";

export type RbDayEvent =
  | "mark_billable"
  | "exclude"
  | "bill"
  | "unbill" // claim voided/replaced → returns to billable
  | "revert_exclusion" // Billing Manager manual revert
  | "void";

export interface RbDayTransition {
  readonly from: RbDayStatus;
  readonly event: RbDayEvent;
  readonly to: RbDayStatus;
}

export const RB_DAY_TRANSITIONS: readonly RbDayTransition[] = [
  { from: "pending", event: "mark_billable", to: "billable" },
  { from: "pending", event: "exclude", to: "excluded" },
  { from: "billable", event: "bill", to: "billed" },
  { from: "billable", event: "exclude", to: "excluded" },
  { from: "billable", event: "void", to: "voided" },
  { from: "billed", event: "unbill", to: "billable" },
  { from: "billed", event: "exclude", to: "excluded" }, // arrangement correction
  { from: "excluded", event: "revert_exclusion", to: "billable" },
  { from: "pending", event: "void", to: "voided" },
] as const;

export const RB_DAY_TERMINAL_STATES: readonly RbDayStatus[] = ["voided"] as const;

export function isTerminal(state: RbDayStatus): boolean {
  return !RB_DAY_TRANSITIONS.some((t) => t.from === state);
}

export interface RbDayReduceResult {
  readonly state: RbDayStatus;
  readonly error?: string;
}

export function canTransition(from: RbDayStatus, event: RbDayEvent): boolean {
  return RB_DAY_TRANSITIONS.some((t) => t.from === from && t.event === event);
}

export function reduce(state: RbDayStatus, event: RbDayEvent): RbDayReduceResult {
  const transition = RB_DAY_TRANSITIONS.find((t) => t.from === state && t.event === event);
  if (!transition) return { state, error: "INVALID_TRANSITION" };
  return { state: transition.to };
}
