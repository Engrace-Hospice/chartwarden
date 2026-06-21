// apps/backend/src/modules/06-admission/state-machines/level-of-care.ts — M6-T04 (§2.3.5).
//
// The LevelOfCarePeriod lifecycle: [*] → assigning → active → ended. The transient `assigning` state
// exists ONLY for IRC/GIP to gap the round-trip to M37 for an IPU bed; RHC/CHC go straight to `active`
// (§2.3.5). GIP needs uncontrolled-symptom / end-of-life documentation (R-LCP-01). Pure transition.
import type { LevelOfCare, LocalDate } from "@wardenx/types";
import { AdmissionStateError, require_ } from "./errors";
import { type TransitionResult, result } from "./effects";
import { TEXT_MINIMUMS } from "./validation";

/** The §2.3.5 LCP states (`pending` is the synthetic pre-create sentinel for `requestAssign`). */
export type LevelOfCareState = "pending" | "assigning" | "active" | "ended";

/** The §2.3.5 LCP events. */
export type LevelOfCareEvent =
  | {
      readonly type: "requestAssign";
      readonly level: LevelOfCare;
      readonly admissionActiveOrOnHold: boolean;
      readonly facilityId: string | null;
      readonly wouldOverlap: boolean;
      readonly reason: string;
    }
  | { readonly type: "ipuConfirmBedAssignment"; readonly bedVerified: boolean }
  | { readonly type: "end"; readonly endedAt: LocalDate };

export type LevelOfCareTransition = TransitionResult<LevelOfCareState, LevelOfCareEvent["type"]>;

/** The legal §2.3.5 transition graph. */
export const LEVEL_OF_CARE_GRAPH: Readonly<
  Record<LevelOfCareState, ReadonlyArray<LevelOfCareEvent["type"]>>
> = {
  pending: ["requestAssign"],
  assigning: ["ipuConfirmBedAssignment"],
  active: ["end"],
  ended: [],
};

/** IRC/GIP need an IPU bed (round-trip via M37) — they pass through `assigning`. */
export function needsIpuBed(level: LevelOfCare): boolean {
  return level === "inpatient_respite_care" || level === "general_inpatient_care";
}

/** Apply an LCP event (§2.3.5). */
export function transitionLevelOfCare(
  from: LevelOfCareState,
  event: LevelOfCareEvent,
): LevelOfCareTransition {
  if (!LEVEL_OF_CARE_GRAPH[from].includes(event.type)) {
    throw new AdmissionStateError(
      "ILLEGAL_TRANSITION",
      `level-of-care period cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "requestAssign": {
      require_(event.admissionActiveOrOnHold, "ILLEGAL_TRANSITION", "admission is not active or on hold");
      require_(!event.wouldOverlap, "LEVEL_OF_CARE_OVERLAP", "level-of-care period would overlap an existing period");
      if (needsIpuBed(event.level)) {
        require_(event.facilityId !== null, "IPU_FACILITY_REQUIRED", "IRC/GIP requires a facility_id");
      }
      if (event.level === "general_inpatient_care") {
        require_(
          event.reason.trim().length >= TEXT_MINIMUMS.gipDocumentation,
          "GIP_DOCUMENTATION_INSUFFICIENT",
          `GIP requires ≥ ${TEXT_MINIMUMS.gipDocumentation} chars of uncontrolled-symptom / end-of-life documentation`,
        );
      }
      const to: LevelOfCareState = needsIpuBed(event.level) ? "assigning" : "active";
      const effects: LevelOfCareTransition["effects"] = [
        { kind: "end_level_of_care" }, // close prior LCP if any (§2.3.5 side effect)
        { kind: "audit" },
        ...(needsIpuBed(event.level)
          ? ([] as LevelOfCareTransition["effects"])
          : ([{ kind: "outbox", event: "m6.loc.changed" }] as LevelOfCareTransition["effects"])),
      ];
      return result(from, event.type, to, effects);
    }
    case "ipuConfirmBedAssignment": {
      require_(event.bedVerified, "IPU_FACILITY_REQUIRED", "IPU bed could not be verified with M37");
      return result(from, event.type, "active", [
        { kind: "set_flag", field: "ipu_bed_assignment_id" },
        { kind: "audit" },
        { kind: "outbox", event: "m6.loc.changed" },
      ]);
    }
    case "end": {
      return result(from, event.type, "ended", [
        { kind: "set_timestamp", field: "ended_at", at: event.endedAt },
        { kind: "audit" },
        { kind: "outbox", event: "m6.loc.changed" },
      ]);
    }
  }
}
