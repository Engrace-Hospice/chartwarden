// @chartwarden/quality — consumed-seam view of M10 (HOPE Engine). PRESENT producer (§4.4).
//
// M30 consumes M10's ORG-LEVEL `HopeOrgRollupProvider` for the HOPE-derived measures and the HOPE-
// compliance dimension of the survey-readiness dashboard (the quarterly-submission-rate < 90% APU-penalty
// signal); it owns NO HOPE data. AGGREGATE-ONLY — every method returns COUNTS, no patient-linked HOPE
// content crosses (D6). Bound to the live M10 org-rollup reader via `getSeam('HopeOrgRollupProvider')` at
// boot (P2C). This consumer mirrors `HopeOrgRollupProvider` (@chartwarden/types/hope) method-for-method so the
// composition root binds `m30HopeConsumer = getSeam('HopeOrgRollupProvider')` with no adapter.
//
// Each method feeds one HOPE-family HQRP measure calculator's already-fetched input:
//   • timepointCompletionRollup → HOPE timepoint on-time rate ({ onTime, late })
//   • submissionPostureRollup   → hope_submission_acceptance_rate ({ submissions, acceptedSubmissions })
//   • sfvTimelinessRollup       → hope_sfv_on_time_rate ({ sfvDue, sfvOnTime })
//   • j2051FollowUpRollup       → TFP-PI / TFP-NPSI (pain vs non-pain triggers + in-window follow-ups)
//   • openSfvObligationCount    → survey-readiness open-SFV signal
import type { HopeOrgRollupProvider } from "@chartwarden/types";

/**
 * M30's consumed view of M10's `HopeOrgRollupProvider`. Structurally identical to the published seam (the
 * five org-scoped aggregate methods); kept as a named consumer interface so M30's ports type against a
 * quality-local symbol rather than reaching into @chartwarden/types at every call site.
 */
export type QualityHopeConsumer = HopeOrgRollupProvider;
