// @wardenx/reporting — the `ScheduledReportProvider` PUBLISHED seam (M33 §4.3).
//
// The scheduled-report read + recipient-revocation-cascade surface M34 consults at offboarding and on
// membership revocation. `cascadeRecipientRevocation` removes a revoked membership from every recipient
// list and auto-pauses any schedule left with zero recipients. Registered into the M1 SeamRegistry at
// boot (P2C); fails closed (D13) until the real provider is registered over the deny-stub.

/** Consumed by M34 (offboarding gate, recipient revocation cascade). */
export interface ScheduledReportProvider {
  listActiveSchedulesForOrg(organizationId: string): Promise<
    {
      scheduleId: string;
      reportViewId: string;
      ownerMembershipId: string;
      cronExpression: string;
      recipientCount: number;
      nextRunAt: string | null;
    }[]
  >;

  /** Called by M34 when a membership is being revoked; M33 removes the membership from any recipient lists. */
  cascadeRecipientRevocation(membershipId: string): Promise<{
    schedulesAffected: number;
    schedulesPaused: number; // a schedule with zero recipients post-cascade is auto-paused
  }>;
}
