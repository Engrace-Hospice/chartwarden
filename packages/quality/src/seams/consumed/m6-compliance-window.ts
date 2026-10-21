// @chartwarden/quality — consumed-seam view of M6's compliance-window aggregate (F-178, #248). PRESENT producer.
//
// M6's own spec (§7.5, W-OVR-02) and M30's own spec are both decisive M30 is a real consumer of M6's
// `compliance_window` F2F-window state — the M30 dashboard's on-time rate and Overrides count — but the
// `ComplianceWindowReader` seam that spec text names was NEVER actually built (only referenced in comments;
// see `m6-admission.ts`'s header for the F-149 finding that first surfaced the gap). This is the REAL seam:
// a nightly-batch measure-computation pull over `compliance_window` (matching how M30 already pulls M15's
// `DisciplineComplianceProvider` and M7/M8's readers), not an event-driven push consumer of M6's six
// `m6.compliance.window.*` / `m6.f2f.window_*` outbox events — see `events-by-m6.ts` for the corresponding
// `seamConsumers` correction on those six catalog entries. Bound to the live M6 provider via `getSeam`
// (`ComplianceWindowCountsProvider`, opaque in the M1 registry — `unknown` — per the `ClaimLineReader` /
// `PatientDaysProvider` precedent: interface lives here on the consumer side, not in `@chartwarden/types`).
//
// NOTE (F-178b): `m6.f2f.window_missed` now HAS a real producer (`runF2fWindowMissedScanCron`,
// `apps/backend/src/modules/06-admission/jobs/cron-workers.ts`, built the same round as this seam) — it
// opens the `f2f_recert_30d_prior` compliance_window row and publishes the event the moment
// `decideF2fWindowStatus` first reads "missed". This seam does not consume that event (it reads table
// state directly on its own nightly batch pull), but the row the producer opens is exactly the row this
// seam's `f2fWindowOnTimeCounts`/`f2fWindowOverrideCounts` queries read.
export interface ComplianceWindowRateCounts {
  readonly numerator: number;
  readonly denominator: number;
}

export interface ComplianceWindowScope {
  readonly orgId: string;
  readonly providerEntityId?: string;
  readonly fromIso: string;
  readonly toIso: string;
}

export interface ComplianceWindowCountsView {
  /** F2F windows (compliance_window.window_kind = 'f2f_recert_30d_prior') due to close in the scope window
   *  (must_complete_by falls in [fromIso, toIso)). Numerator = those closed ON TIME — closed_at IS NOT NULL
   *  AND closed_at <= must_complete_by AND override_reason IS NULL. A late-but-overridden close does NOT
   *  count as on-time (see f2fWindowOverrideCounts for that separate signal). Denominator = every such
   *  window due in the scope window, regardless of current status (open/closing_soon/overdue/closed) — a
   *  window still stuck open past its due date correctly drags the rate down, it does not disappear from
   *  the denominator. */
  f2fWindowOnTimeCounts(scope: ComplianceWindowScope): Promise<ComplianceWindowRateCounts>;
  /** The SAME F2F window population as f2fWindowOnTimeCounts (same denominator), but the numerator counts
   *  how many closed via a documented Medical-Director override (override_reason IS NOT NULL) instead of a
   *  plain on-time attestation. M6's own spec (§7.5, W-OVR-02) is decisive this is a real, separately
   *  tracked metric — "M30 dashboard's Overrides count increments" / "override count is part of the M30
   *  weekly compliance digest" — not folded into the on-time rate. */
  f2fWindowOverrideCounts(scope: ComplianceWindowScope): Promise<ComplianceWindowRateCounts>;
}
