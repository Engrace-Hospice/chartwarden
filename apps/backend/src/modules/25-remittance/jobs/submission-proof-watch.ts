// apps/backend/src/modules/25-remittance/jobs/submission-proof-watch.ts - M25 milestone 6a: the nightly proof-missing
// watch. PURE over an injected store port (the m25-jobs.ts posture). A submission attempt still `needs_manual` (filed,
// but no confirmation reference / receipt recorded) past PROOF_MISSING_DAYS gets one `submission.proof_missing` alert
// per night until someone records the receipt or cancels the attempt. Folded into the existing appeal-deadline cron,
// so there is no new queue. The alert payload is IDs and counts only: no confirmation reference, no free text.
import { PROOF_MISSING_DAYS, isProofMissing } from "../domain";
import type { AlertEmission } from "./m25-jobs";

const MS_PER_DAY = 86_400_000;

/** A `needs_manual` attempt, as the watch sees it. */
export interface ProofMissingRow {
  readonly id: string;
  readonly subjectKind: "adr" | "appeal" | "reopening";
  readonly subjectId: string;
  readonly createdAt: string;
}

export interface SubmissionProofStore {
  needsManualAttempts(): Promise<ProofMissingRow[]>;
}

export async function runSubmissionProofWatch(
  store: SubmissionProofStore,
  now: Date,
  thresholdDays: number = PROOF_MISSING_DAYS,
): Promise<{ readonly alerts: AlertEmission[] }> {
  const alerts: AlertEmission[] = [];
  for (const r of await store.needsManualAttempts()) {
    const createdAt = new Date(r.createdAt);
    if (!isProofMissing({ status: "needs_manual", createdAt, now, thresholdDays })) continue;
    alerts.push({
      kind: "submission.proof_missing",
      detail: {
        subjectKind: r.subjectKind,
        subjectId: r.subjectId,
        daysOpen: Math.floor((now.getTime() - createdAt.getTime()) / MS_PER_DAY),
      },
    });
  }
  return { alerts };
}
