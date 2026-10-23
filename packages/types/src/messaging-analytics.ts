// M36 WP 6.2 (ADR-0110, PROPOSED) - response analytics. AGGREGATES ONLY: counts, rates and durations of acknowledgment requests and
// handoffs; no message content, no patient, no user id. There is deliberately NO per-person field anywhere in this contract.
// M36 owns the numbers (it owns the tables); M33 serves the HTTP route over the `MessagingResponseAnalyticsReader` seam.

/** Tenant ops flag (absent = off). Off is a uniform 404 on the route; the screen shows the "not turned on" panel. */
export const RESPONSE_ANALYTICS_FLAG_KEY = "messaging.response_analytics";

/** Read permission. Configuration is the flag (platform admin API); there is no tenant-side manage key. */
export const RESPONSE_ANALYTICS_PERMISSION = "messaging.analytics.read";

/**
 * PROVISIONAL minimum cohort (ADR-0110): a figure is shown only when at least this many DISTINCT people stand behind it. Counting people,
 * not requests, because five requests answered by one clinician is that clinician's record. The value is a placeholder for the HR/compliance
 * decision (11-decision-sheet); lowering it needs that sign-off, raising it does not.
 */
export const ANALYTICS_MIN_COHORT = 5;

/** Longest window a single read may cover (live query over indexed tables; an MV-backed longer range is a follow-up). */
export const ANALYTICS_MAX_RANGE_DAYS = 92;

/** Breakdown dimensions. `discipline` is the assignee's clinical role key, never the person. Team and shift are not built (ADR-0110). */
export const ANALYTICS_GROUP_BY = ["class", "discipline"] as const;
export type AnalyticsGroupBy = (typeof ANALYTICS_GROUP_BY)[number];

export interface ResponseAnalyticsKpis {
  readonly requests: number;
  readonly acknowledged: number;
  /** Share of requests acknowledged at or before their deadline (0..1); null when there are none. */
  readonly ackedBeforeDeadlineRate: number | null;
  /** Share of requests that were escalated at least once (0..1). */
  readonly escalationRate: number | null;
  readonly medianAckSeconds: number | null;
  /** Handoff figures are null when fewer than the minimum cohort of distinct recipients stand behind them. */
  readonly handoffsOffered: number | null;
  readonly handoffsAccepted: number | null;
  /** Null when fewer than the minimum cohort of distinct recipients stand behind the handoff figures. */
  readonly medianHandoffAcceptSeconds: number | null;
}

export interface ResponseAnalyticsCell {
  /** Ack class (`important`/`urgent`/`critical_symptom`) or a clinical role key, or `unspecified`. */
  readonly group: string;
  readonly requests: number;
  readonly acknowledged: number;
  readonly ackedBeforeDeadlineRate: number | null;
  readonly escalationRate: number | null;
  readonly medianAckSeconds: number | null;
}

export type ResponseAnalyticsReport =
  | { readonly status: "insufficient_data"; readonly minCohort: number }
  | {
      readonly status: "ok";
      readonly from: string;
      readonly to: string;
      readonly minCohort: number;
      readonly groupBy: AnalyticsGroupBy;
      readonly kpis: ResponseAnalyticsKpis;
      readonly cells: readonly ResponseAnalyticsCell[];
      /** Groups left out because fewer than `minCohort` people stand behind them (never named, never sized). */
      readonly suppressedGroups: number;
      /** True when no breakdown can be shown without exposing a residual under the floor (the KPIs above still stand). */
      readonly breakdownWithheld: boolean;
    };

/** M36's published read (seam `MessagingResponseAnalyticsReader`); M33 serves it. `enabled` is the tenant flag. */
export interface MessagingResponseAnalyticsReader {
  enabled(organizationId: string): Promise<boolean>;
  report(
    organizationId: string,
    query: { readonly from: Date; readonly to: Date; readonly groupBy: AnalyticsGroupBy },
  ): Promise<ResponseAnalyticsReport>;
}
