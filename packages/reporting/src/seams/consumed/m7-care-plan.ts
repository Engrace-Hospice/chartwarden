// @wardenx/reporting — consumed-seam view of M7 (Care Plan / IPOC). PRESENT producer (§4.4).
//
// M33 reads care-plan overdue rollups + goal-progress aggregates. Bound to the live M7
// `CarePlanReader.overdueRollup` / `GoalProgressReader` via `getSeam` at boot (P2C). Aggregate only.
export interface ReportingCarePlanConsumer {
  /** M7 `CarePlanReader.overdueRollup` — count of care plans overdue against the 5-/15-day clock. */
  overdueCarePlanCount(organizationId: string): Promise<number>;
  /** M7 `GoalProgressReader` — goal-progress distribution (met / in-progress / not-met) over a window. */
  goalProgressRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
}
