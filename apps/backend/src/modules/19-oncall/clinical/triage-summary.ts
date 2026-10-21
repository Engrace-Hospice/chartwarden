// apps/backend/src/modules/19-oncall/clinical/triage-summary.ts — F-224 (#248). The PURE content rule behind
// `m19.triage.summary_requested` (the explicit "send the caregiver / attending a summary" staff action).
//
// WHAT CROSSES THE OUTBOX, AND WHAT DOES NOT. The summary is rendered by M22 from the event payload alone, so
// whatever this function returns is written to `outbox_event.payload` and into a PDF a caregiver may hold.
// It is therefore an ALLOWLIST OF ENUMERATED / STRUCTURED FACTS, never a projection of the call:
//
//   CROSSES   the disposition (a closed enum), the requested discipline (validated as a short token), the
//             arrival-by / proposed-for instants and dates, and the transport arranger (a closed enum).
//   NEVER     every FREE-TEXT field of the call — `educationSummary`, `instructionsGiven`, `reason`,
//             `electionText`, `gipCriteriaSummary`, `preferredFacility` — plus the caller's quote, the
//             transcript, every protocol answer and every medication. Those are PHI-bearing clinician words
//             (and medications / answers are where 42 CFR Part 2 content lives: M19's own
//             `redactSudMedications` gate exists because of them). Leaving them out here is what makes the
//             summary safe to hand a caregiver WITHOUT a per-document M39 SUD consent decision: there is no
//             SUD-class content in it to consent to. If a future revision wants clinical free text in the
//             summary, it must resolve `sudDisclosurePermitted` (M39) exactly as `readTriageMedicationContext`
//             does and set `isSudClass` so M22's render gate (F-197) applies — this function's allowlist is
//             the single place that change has to be made deliberately.
import type { TriageDisposition } from "@chartwarden/types";

/** The dispositions that END in something a caregiver/attending can be told. `abandoned` (the caller hung
 *  up) and `escalated_unresolved` (still being worked) have no outcome to summarise. */
export const SUMMARIZABLE_DISPOSITIONS: ReadonlySet<TriageDisposition> = new Set<TriageDisposition>(
  [
    "caregiver_education_only",
    "prn_intervention_authorized",
    "verbal_order_recorded",
    "visit_dispatched_now",
    "visit_scheduled_first_light",
    "gip_admission_proposed",
    "ed_transfer_acknowledged",
    "pronouncement_scheduled",
  ],
);

/** The call states from which a summary may be requested — the disposition has been selected. */
export const SUMMARY_READY_STATES: ReadonlySet<string> = new Set([
  "documented_pending_encounter",
  "documented",
  "closed",
]);

/** The enumerated facts the summary carries (all nullable; absent ≙ not applicable to the disposition). */
export interface TriageSummaryContent {
  readonly disposition: TriageDisposition;
  readonly requestedDiscipline: string | null;
  readonly requestedArrivalBy: string | null;
  readonly proposedForDate: string | null;
  readonly transportArrangedBy: string | null;
}

const TOKEN = /^[a-z][a-z0-9_]{0,31}$/;
const TRANSPORT = new Set(["family", "ems", "facility", "unknown"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const token = (v: unknown): string | null => (typeof v === "string" && TOKEN.test(v) ? v : null);
const instant = (v: unknown): string | null =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const isoDate = (v: unknown): string | null =>
  typeof v === "string" && ISO_DATE.test(v) ? v : null;

/**
 * Project a call's selected disposition + stored `disposition_data` onto the summary's allowlist. Anything
 * not on the allowlist — including any field a future `TriageDispositionData` arm adds — is unreachable
 * from here by construction (nothing is spread).
 */
export function triageSummaryContent(
  disposition: TriageDisposition,
  dispositionData: unknown,
): TriageSummaryContent {
  const d =
    dispositionData !== null && typeof dispositionData === "object"
      ? (dispositionData as Record<string, unknown>)
      : {};
  const empty = {
    requestedDiscipline: null,
    requestedArrivalBy: null,
    proposedForDate: null,
    transportArrangedBy: null,
  };
  switch (disposition) {
    case "visit_dispatched_now":
      return {
        disposition,
        ...empty,
        requestedDiscipline: token(d.requestedDiscipline),
        requestedArrivalBy: instant(d.requestedArrivalBy),
      };
    case "visit_scheduled_first_light":
      return {
        disposition,
        ...empty,
        requestedDiscipline: token(d.requestedDiscipline),
        proposedForDate: isoDate(d.proposedForDate),
      };
    case "pronouncement_scheduled":
      return {
        disposition,
        ...empty,
        requestedDiscipline: token(d.pronouncingDiscipline),
        requestedArrivalBy: instant(d.expectedArrivalBy),
      };
    case "ed_transfer_acknowledged":
      return {
        disposition,
        ...empty,
        transportArrangedBy:
          typeof d.transportArrangedBy === "string" && TRANSPORT.has(d.transportArrangedBy)
            ? d.transportArrangedBy
            : null,
      };
    default:
      return { disposition, ...empty };
  }
}
