// @wardenx/quality — operational/HQRP measure: HOPE submission acceptance rate. Pure. No IO.
// Rate of HOPE assessments accepted by iQIES on submission (higher is better). A quarterly rate < 90% is
// the APU-penalty signal (§1.3). Source: M10 `HopeSubmissionProvider`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult, unavailableResult } from "../result";

/** Already-fetched HOPE submission-acceptance counts. */
export interface HopeSubmissionAcceptanceRateInput extends ComputeMeasureInput {
  /** HOPE assessments submitted to iQIES in the window (denominator). */
  readonly submissions: number;
  /** Submissions accepted by iQIES (numerator). */
  readonly acceptedSubmissions: number;
  /**
   * Batches this agency ASSEMBLED that have never been transmitted (F-058 / #150).
   *
   * The denominator above counts assessments on batches with a terminal iQIES posture, so it is 0 both
   * for an agency with nothing to report and for one whose batches are stacked up unsent. Those are not
   * the same fact and must not render as the same blank cell — see {@link computeHopeSubmissionAcceptanceRate}.
   * Optional so a caller that cannot supply it keeps the pre-F-058 behaviour.
   */
  readonly queuedSubmissions?: number;
  /** The per-FY/agency target (higher-is-better; CMS APU floor is 90%). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/**
 * Compute the HOPE-submission-acceptance rate. Pure.
 *
 * A zero denominator with QUEUED batches behind it is declared UNAVAILABLE rather than suppressed for
 * low N. `insufficient_n` means "we counted, and there were too few to report"; here the count is not
 * the problem — nothing has ever been transmitted, so there is no acceptance to measure. Both collapse
 * to a null rate on the wire, and the quality hub labels every suppressed measure "Suppressed (low N)",
 * which for this one would tell a surveyor the agency is small when the truth is that this deployment
 * has no iQIES transport (`@wardenx/iqies-client` ships only its deny-stub adapter). Same distinction
 * `HCI_UNAVAILABLE_INDICATORS` draws, and the same mechanism: the reason rides in the persisted
 * `computation_snapshot`, so the answer to "why is this blank?" is in the row itself.
 *
 * With no queued batches either, the agency genuinely has nothing in flight and `insufficient_n` is the
 * honest label — so the branch is on evidence, not on a build flag.
 */
export function computeHopeSubmissionAcceptanceRate(
  input: HopeSubmissionAcceptanceRateInput,
): QualityMeasureValueResult {
  const snapshot = {
    measure: "hope_submission_acceptance_rate",
    submissions: input.submissions,
    acceptedSubmissions: input.acceptedSubmissions,
    queuedSubmissions: input.queuedSubmissions ?? 0,
  };

  if (input.submissions <= 0 && (input.queuedSubmissions ?? 0) > 0) {
    return unavailableResult({
      snapshot,
      threshold: input.threshold,
      unavailable: {
        reason:
          "No HOPE submission batch has ever been transmitted to iQIES, so there is no acceptance outcome to measure. This is not a low-volume suppression: batches have been assembled and are queued.",
        requires:
          "A live iQIES transport bound in place of `createUnboundIqiesAdapter` (CMS HOPE submission XML, per-MAC submitter credentials), plus the `iqies-submit-worker` / `iqies-reconcile-worker` stages that call it.",
      },
    });
  }

  return ratioResult({
    numerator: input.acceptedSubmissions,
    denominator: input.submissions,
    threshold: input.threshold,
    warn: input.warn,
    snapshot,
  });
}
