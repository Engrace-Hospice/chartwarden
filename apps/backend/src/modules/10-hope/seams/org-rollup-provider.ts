// apps/backend/src/modules/10-hope/seams/org-rollup-provider.ts — M10's ORG-LEVEL `HopeOrgRollupProvider`
// seam impl (#107): PURE orchestration over an injected {@link HopeOrgRollupStore}. The store projects the
// period's intermediate rows; this provider reduces them to the AGGREGATE COUNTS (D6) the M30
// `m30.measure_recompute` worker feeds to the four HOPE-family HQRP calculators. No tenant logic, no clock,
// no IO — RLS + the explicit org param scope every store read.
//
// The single correctness-critical logic lives here (and is unit-tested in hope-org-rollup.test.ts):
//   • PAIN vs NON-PAIN — an entry is PAIN iff its `symptomCode === HOPE_J2051_PAIN_SYMPTOM_CODE`; any other
//     code (anxiety / shortness_of_breath / nausea_vomiting / …) is NON-PAIN. A trigger row counts as a
//     pain trigger iff it has ANY qualifying pain entry, and as a non-pain trigger iff it has ANY qualifying
//     non-pain entry — so an assessment with BOTH counts in both denominators.
//   • QUALIFYING threshold — severity moderate-or-severe (rank ≥ `moderate`), matching the J2051 evaluator's
//     SFV trigger threshold (packages/hope/src/triggers/j2051.ts).
//   • IN-WINDOW — an SFV is on-time iff `completedAt <= dueAt` (the 2-calendar-day window math is the store's
//     `dueAt`; the provider only compares against it).
import {
  HOPE_J2051_PAIN_SYMPTOM_CODE,
  type HopeOrgRollupProvider,
  type J2051Severity,
  J2051_SEVERITY_ORDER,
} from "@chartwarden/types";
import type { HopeOrgRollupStore } from "./org-rollup-store";

/** The §2.3 / D4 qualifying threshold rank — `moderate` (and above) is a qualifying symptom-impact trigger. */
const MODERATE_RANK = J2051_SEVERITY_ORDER.indexOf("moderate");

/** A symptom reading qualifies (drives an SFV obligation / counts in the TFP denominators) at moderate-or-severe. */
const qualifies = (severity: J2051Severity): boolean =>
  J2051_SEVERITY_ORDER.indexOf(severity) >= MODERATE_RANK;

/** True iff `when` is at-or-before `deadline` (both ISO instants); a null on either side is NOT on-time. */
const atOrBefore = (when: string | null, deadline: string | null): boolean =>
  when !== null && deadline !== null && new Date(when).getTime() <= new Date(deadline).getTime();

/**
 * §2 / D10 / D6 — M10's ORG-LEVEL HOPE rollup over the {@link HopeOrgRollupStore}. Every method returns
 * COUNTS only (no patient row crosses, D6). Registered over the boot deny-stub by `registerHopeSeams` when a
 * db/store is present; M30 binds it via `getSeam('HopeOrgRollupProvider')`.
 */
export function createHopeOrgRollupProvider(store: HopeOrgRollupStore): HopeOrgRollupProvider {
  return {
    async timepointCompletionRollup(organizationId, period) {
      const rows = await store.completedTimepoints(organizationId, period);
      let onTime = 0;
      for (const r of rows) {
        if (atOrBefore(r.completingSignedAt, r.lateDeadlineAt)) onTime += 1;
      }
      return { onTime, late: rows.length - onTime };
    },

    async submissionPostureRollup(organizationId, period) {
      const rows = await store.submissionBatches(organizationId, period);
      let submissions = 0;
      let acceptedSubmissions = 0;
      for (const r of rows) {
        submissions += r.itemCount;
        acceptedSubmissions += r.acceptedCount;
      }
      // F-058 — carried beside the counts so a zero denominator is attributable. See the seam contract.
      const queuedSubmissions = await store.queuedSubmissionCount(organizationId);
      return { submissions, acceptedSubmissions, queuedSubmissions };
    },

    async sfvTimelinessRollup(organizationId, period) {
      const rows = await store.terminalSfvs(organizationId, period);
      let sfvOnTime = 0;
      for (const r of rows) {
        if (atOrBefore(r.completedAt, r.dueAt)) sfvOnTime += 1;
      }
      return { sfvDue: rows.length, sfvOnTime };
    },

    async j2051FollowUpRollup(organizationId, period) {
      const rows = await store.j2051Triggers(organizationId, period);
      let painTriggers = 0;
      let painFollowUpsInWindow = 0;
      let nonPainTriggers = 0;
      let nonPainFollowUpsInWindow = 0;
      for (const r of rows) {
        const isPain = r.entries.some(
          (e) => e.symptomCode === HOPE_J2051_PAIN_SYMPTOM_CODE && qualifies(e.severity),
        );
        const isNonPain = r.entries.some(
          (e) => e.symptomCode !== HOPE_J2051_PAIN_SYMPTOM_CODE && qualifies(e.severity),
        );
        const inWindow = atOrBefore(r.sfvCompletedAt, r.sfvDueAt);
        if (isPain) {
          painTriggers += 1;
          if (inWindow) painFollowUpsInWindow += 1;
        }
        if (isNonPain) {
          nonPainTriggers += 1;
          if (inWindow) nonPainFollowUpsInWindow += 1;
        }
      }
      return { painTriggers, painFollowUpsInWindow, nonPainTriggers, nonPainFollowUpsInWindow };
    },

    openSfvObligationCount(organizationId) {
      return store.openSfvObligationCount(organizationId);
    },
  };
}
