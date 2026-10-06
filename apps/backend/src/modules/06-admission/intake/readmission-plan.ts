// apps/backend/src/modules/06-admission/intake/readmission-plan.ts — assemble the `BenefitPeriodPlan` the readmission
// and new-admission screens read (routes/readmission-typebox.ts) from already-resolved facts. PURE: the caller loads
// the patient's earlier stays (seams/prior-episodes.ts) and the prior election's NOTR / final-claim status (an M23
// fact, reached through an injected port — M6 never reads M23's tables).
import type { LocalDate } from "@wardenx/types";
import type { BenefitPeriodPlan, ReadmissionBlocker } from "../routes/readmission-typebox";
import type { PriorEpisode } from "../seams/prior-episodes";
import { latestLiveEndedEpisode, rhcPriorStayFacts } from "../seams/prior-episodes";
import { daysBetween } from "../state-machines/validation";
import { requirementsForBenefitPeriod, rhcCarryOver, suggestBenefitPeriod } from "./benefit-period";

/** Whether the prior election is closed out with Medicare (`null` = the M23 fact could not be read). */
export interface PriorElectionClosureFacts {
  readonly notrFiled: boolean;
  readonly finalClaimFiled: boolean;
}

export interface ReadmissionPlanInput {
  readonly patientId: string;
  /** Every earlier stay of the patient (ended admissions), newest ending first. */
  readonly episodes: readonly PriorEpisode[];
  /** Readmission-context only: the admission being readmitted from, with its live state. */
  readonly readmitFrom?: { readonly admissionId: string; readonly state: string } | null;
  /** The patient already has an open (not discharged / bereavement / closed) admission. */
  readonly openAdmissionExists: boolean;
  /** Readmission-context only: a later admission already follows `readmitFrom`. */
  readonly newerAdmissionExists?: boolean;
  /** NOTR / final claim for the latest live-ended stay (`undefined` = no such stay, `null` = unknown). */
  readonly closure: PriorElectionClosureFacts | null | undefined;
  readonly startDate: LocalDate;
  readonly sequence?: number;
}

function previousOf(e: PriorEpisode, startDate: LocalDate): BenefitPeriodPlan["previous"] {
  return {
    admissionId: e.admissionId,
    admissionState: e.admissionState,
    startedOn: e.startedOn,
    endedOn: e.endedOn,
    endKind: e.endKind,
    dischargeType: e.dischargeType,
    transfer: e.endKind === "transfer_out",
    lastSequence: e.lastRanSequence,
    daysSinceDischarge: e.endedOn ? daysBetween(e.endedOn, startDate) : null,
  };
}

function blockersOf(input: ReadmissionPlanInput, from: PriorEpisode | null): ReadmissionBlocker[] {
  const blockers: ReadmissionBlocker[] = [];
  if (input.readmitFrom && !from) blockers.push("NOT_ENDED");
  if (from?.endKind === "death") blockers.push("ENDED_BY_DEATH");
  if (input.openAdmissionExists) blockers.push("OPEN_ADMISSION_EXISTS");
  if (input.newerAdmissionExists) blockers.push("NEWER_ADMISSION_EXISTS");
  return blockers;
}

export function buildBenefitPeriodPlan(input: ReadmissionPlanInput): BenefitPeriodPlan {
  const from = input.readmitFrom
    ? (input.episodes.find((e) => e.admissionId === input.readmitFrom?.admissionId) ?? null)
    : (input.episodes[0] ?? null);
  const suggestion = suggestBenefitPeriod(input.episodes);
  const sequence = input.sequence ?? suggestion.suggestedSequence;
  const liveEnded = latestLiveEndedEpisode(input.episodes);
  const closure: BenefitPeriodPlan["priorElectionClosure"] = liveEnded
    ? {
        admissionId: liveEnded.admissionId,
        status:
          input.closure === null || input.closure === undefined
            ? "unknown"
            : input.closure.notrFiled || input.closure.finalClaimFiled
              ? "filed"
              : "not_filed",
        notrFiled: input.closure?.notrFiled ?? null,
        finalClaimFiled: input.closure?.finalClaimFiled ?? null,
      }
    : null;
  const blockers = blockersOf(input, from);
  return {
    patientId: input.patientId,
    previous: from ? previousOf(from, input.startDate) : null,
    readmission: { eligible: blockers.length === 0 && !!from, blockers },
    priorElectionClosure: closure,
    noeBlocked: closure !== null && closure.status !== "filed",
    suggestion,
    requirements: requirementsForBenefitPeriod(sequence, input.startDate),
    // An earlier transfer-in's sending-hospice span counts too (the new admission itself is not a transfer-in).
    rhc: rhcCarryOver(rhcPriorStayFacts(input.episodes), input.startDate),
  };
}
