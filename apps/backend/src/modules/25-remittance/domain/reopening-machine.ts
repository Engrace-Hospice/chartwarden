// M25 milestone 3 — the MAC reopening aggregate (a 56900 non-response is reopened with the MAC, not appealed).
// PURE. A reopening is its own record, not an appeal tier: it has no tiers, no spawn on an unfavorable decision,
// and a per-MAC form. Filing here RECORDS a request made outside ChartWarden (electronic submission is milestone 6),
// so the filing needs the form used, the channel, and the confirmation the MAC gave.
export type ReopeningState = "draft" | "submitted" | "decided" | "withdrawn" | "closed";

export const REOPENING_TRANSITIONS: Readonly<Record<ReopeningState, readonly ReopeningState[]>> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["decided", "withdrawn"],
  decided: ["closed"],
  withdrawn: [],
  closed: [],
};

export const REOPENING_FILING_CHANNELS = ["mac_portal", "fax", "mail", "other"] as const;
export type ReopeningFilingChannel = (typeof REOPENING_FILING_CHANNELS)[number];

export const REOPENING_OUTCOMES = ["granted", "partial", "denied"] as const;
export type ReopeningOutcome = (typeof REOPENING_OUTCOMES)[number];

export type ReopeningFilingRefusal =
  | "FORM_REQUIRED"
  | "CHANNEL_INVALID"
  | "PROOF_REQUIRED"
  | "FILED_IN_FUTURE";

export function canTransitionReopening(from: ReopeningState, to: ReopeningState): boolean {
  return REOPENING_TRANSITIONS[from].includes(to);
}

export function isReopeningTerminal(state: ReopeningState): boolean {
  return REOPENING_TRANSITIONS[state].length === 0;
}

export function checkReopeningFiling(input: {
  readonly formName: string;
  readonly channel: string;
  readonly confirmationRef: string;
  readonly filedAt: Date;
  readonly now: Date;
}): ReopeningFilingRefusal | null {
  if (input.formName.trim() === "") return "FORM_REQUIRED";
  if (!(REOPENING_FILING_CHANNELS as readonly string[]).includes(input.channel)) {
    return "CHANNEL_INVALID";
  }
  if (input.confirmationRef.trim() === "") return "PROOF_REQUIRED";
  if (input.filedAt.getTime() > input.now.getTime()) return "FILED_IN_FUTURE";
  return null;
}
