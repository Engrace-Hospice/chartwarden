// M30 incident lifecycle actions the detail panel offers (GAP-048). Pure: which write is legal from which state.
// The server stays the authority (state machine + `capVerifyAuthority` + the resolver-not-assignee control);
// this only decides which button to show so a user is never offered a transition the machine will 409.
export type IncidentLifecycleState =
  | "draft"
  | "submitted"
  | "triaged"
  | "under_investigation"
  | "resolved"
  | "closed_followup_complete"
  | "reopened";

export type IncidentLifecycleAction = "submit" | "resolve" | "close" | "reopen";

export interface IncidentActionSpec {
  readonly action: IncidentLifecycleAction;
  readonly label: string;
  /** The free-text field the server requires for this action, if any. */
  readonly textField: null | {
    readonly name: "resolutionNote" | "reopenReason";
    readonly label: string;
  };
}

const ACTIONS: Readonly<Record<IncidentLifecycleAction, IncidentActionSpec>> = {
  submit: { action: "submit", label: "Submit report", textField: null },
  resolve: {
    action: "resolve",
    label: "Resolve",
    textField: { name: "resolutionNote", label: "Resolution note" },
  },
  close: { action: "close", label: "Close incident", textField: null },
  reopen: {
    action: "reopen",
    label: "Reopen",
    textField: { name: "reopenReason", label: "Reason for reopening" },
  },
};

const BY_STATE: Readonly<Record<IncidentLifecycleState, readonly IncidentLifecycleAction[]>> = {
  draft: ["submit"],
  submitted: [],
  triaged: [],
  under_investigation: ["resolve"],
  resolved: ["close"],
  closed_followup_complete: ["reopen"],
  reopened: ["reopen"],
};

/** The lifecycle writes this panel can perform from `state` (triage / investigate need member pickers: not built). */
export function availableIncidentActions(
  state: IncidentLifecycleState,
): readonly IncidentActionSpec[] {
  return BY_STATE[state].map((action) => ACTIONS[action]);
}

/** A human message for a refused lifecycle write — the server's 403/409/422 mean different things to the user. */
export function incidentActionError(status: number | undefined): string {
  if (status === 403) return "You are not permitted to do this to this incident.";
  if (status === 409) return "This incident is no longer in a state that allows this - reload it.";
  if (status === 422) return "The server refused this change - check the required fields.";
  if (status === 401) return "Session expired - sign in again.";
  return status ? `The change failed (HTTP ${status}).` : "The server could not be reached.";
}
