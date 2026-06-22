// apps/backend/src/modules/06-admission/state-machines/face-to-face.ts — M6-T04 (§2.3.4).
//
// The FaceToFaceEncounter lifecycle: scheduled → completed → attested, with a self-loop on `completed`
// for a Medical-Director window override. The encounter window is the CMS 418.22 prior-to window
// (R-F2F-02); an out-of-window date with no override raises `F2F_OUTSIDE_WINDOW`. Pure transition.
import type { LocalDate } from "@wardenx/types";
import { type TransitionResult, result } from "./effects";
import { AdmissionStateError, require_ } from "./errors";
import { TEXT_MINIMUMS, checkF2fOverride, checkF2fPerformer, checkF2fWindow } from "./validation";

/** The §2.3.4 F2F states. */
export type FaceToFaceState = "scheduled" | "completed" | "attested";

/** The §2.3.4 F2F events. */
export type FaceToFaceEvent =
  | {
      readonly type: "recordCompletion";
      readonly performerRole: "hospice_md" | "hospice_np" | "attending";
      readonly periodStart: LocalDate;
      readonly encounterDate: LocalDate;
      readonly hasOverride: boolean;
    }
  | {
      readonly type: "requestWindowOverride";
      readonly isMedicalDirector: boolean;
      readonly reason: string;
    }
  | { readonly type: "attest"; readonly narrative: string; readonly performerIsActor: boolean };

export type FaceToFaceTransition = TransitionResult<FaceToFaceState, FaceToFaceEvent["type"]>;

/** The legal §2.3.4 transition graph (`requestWindowOverride` is a `completed` self-loop). */
export const FACE_TO_FACE_GRAPH: Readonly<
  Record<FaceToFaceState, ReadonlyArray<FaceToFaceEvent["type"]>>
> = {
  scheduled: ["recordCompletion"],
  completed: ["requestWindowOverride", "attest"],
  attested: [],
};

/** Apply an F2F event (§2.3.4). */
export function transitionFaceToFace(
  from: FaceToFaceState,
  event: FaceToFaceEvent,
): FaceToFaceTransition {
  if (!FACE_TO_FACE_GRAPH[from].includes(event.type)) {
    throw new AdmissionStateError("ILLEGAL_TRANSITION", `F2F cannot ${event.type} from '${from}'`);
  }

  switch (event.type) {
    case "recordCompletion": {
      checkF2fPerformer({ performerRole: event.performerRole });
      const { withinWindow } = checkF2fWindow({
        periodStart: event.periodStart,
        encounterDate: event.encounterDate,
        hasOverride: event.hasOverride,
      });
      return result(from, event.type, "completed", [
        { kind: "set_flag", field: withinWindow ? "within_window_true" : "within_window_false" },
        { kind: "audit" },
        { kind: "outbox", event: "m6.f2f.scheduled" },
      ]);
    }
    case "requestWindowOverride": {
      checkF2fOverride({ isMedicalDirector: event.isMedicalDirector, reason: event.reason });
      return result(from, event.type, "completed", [
        { kind: "set_flag", field: "window_override" },
        { kind: "audit" },
        { kind: "outbox", event: "m6.f2f.window_overridden" },
      ]);
    }
    case "attest": {
      require_(
        event.narrative.trim().length >= TEXT_MINIMUMS.f2fAttestation,
        "F2F_ATTESTATION_TOO_SHORT",
        `F2F attestation must be ≥ ${TEXT_MINIMUMS.f2fAttestation} characters`,
      );
      require_(
        event.performerIsActor,
        "F2F_INVALID_PERFORMER",
        "attesting user must be the performer",
      );
      return result(from, event.type, "attested", [
        { kind: "audit" },
        { kind: "outbox", event: "m6.f2f.attested" },
        { kind: "close_window", window: "f2f_recert_30d_prior" },
      ]);
    }
  }
}
