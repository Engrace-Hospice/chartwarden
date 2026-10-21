// @chartwarden/hope — default alert cadence carried on the schedule / SFV rows (M10-T03; §3.3 `alert_cadence`
// jsonb, §4.8 deadline-alert cron, §4.9 typed payloads). The schedule/SFV creators stamp these typed
// cadence objects into the row's `alert_cadence` column; the `hope-deadline-alerts` cron (M10-T06) reads
// them to decide WHEN to emit the §4.9 M36 alerts. Tenant overrides land in M10-T06 — T03 pins only the
// platform default so the schedule descriptors are complete. Pure data, no IO.

/** The §4.8 cadence for a HOPE timepoint window (Admission / HUV1 / HUV2 / Discharge). Hours-before each
 * boundary that the deadline cron fires the §4.9 `HopeTimepointWindowAlert`. */
export interface TimepointAlertCadence {
  /** Hours before `window_closes_at` to nudge the care team (window still soft). */
  readonly hoursBeforeClose: readonly number[];
  /** Hours before `late_deadline_at` to escalate (capture now requires a late reason, D2). */
  readonly hoursBeforeLateDeadline: readonly number[];
}

/** The §4.8 cadence for a Symptom-Follow-Up-Visit obligation. The D3 2-calendar-day window is short, so
 * the SFV fires `clinical_urgent` on creation (M10-F19 / SD-015) and repeats once overdue. */
export interface SfvAlertCadence {
  /** Emit the §4.9 `HopeSfvAlert` the moment the SFV is created (the window is too short to defer). */
  readonly fireOnCreated: boolean;
  /** Hours before `due_at` to re-nudge. */
  readonly hoursBeforeDue: readonly number[];
  /** Repeat interval (hours) once `due_at` has passed, until `completed` or `missed`. */
  readonly overdueRepeatHours: number;
}

/** Platform-default timepoint cadence (§4.8): two soft-window nudges, three late-window escalations. */
export const DEFAULT_TIMEPOINT_ALERT_CADENCE: TimepointAlertCadence = {
  hoursBeforeClose: [72, 24],
  hoursBeforeLateDeadline: [48, 24, 0],
} as const;

/** Platform-default SFV cadence (§4.9): urgent on create, a 24h pre-due nudge, daily once overdue. */
export const DEFAULT_SFV_ALERT_CADENCE: SfvAlertCadence = {
  fireOnCreated: true,
  hoursBeforeDue: [24],
  overdueRepeatHours: 24,
} as const;
