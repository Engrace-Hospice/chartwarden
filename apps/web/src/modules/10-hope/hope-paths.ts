// apps/web/src/modules/10-hope — the in-app paths other screens link to, kept apart from the hooks that read them.

/** The query parameter the SFV queue's Complete link adds to open the completion dialog on arrival. */
export const COMPLETE_SFV_PARAM = "completeSfv";

/** Where the queue's Complete link goes: the triggering assessment, asking for its completion dialog. */
export function completeSfvPath(triggeringAssessmentId: string): string {
  return `/hope/assessments/${encodeURIComponent(triggeringAssessmentId)}?${COMPLETE_SFV_PARAM}=1`;
}
