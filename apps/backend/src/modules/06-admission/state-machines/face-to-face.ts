// apps/backend/src/modules/06-admission/state-machines/face-to-face.ts — M6-T04 (§2.3.4).
//
// The FaceToFaceEncounter lifecycle: scheduled → completed → attested, with a self-loop on `completed`
// for a Medical-Director window override. The encounter window is the CMS 418.22 prior-to window
// (R-F2F-02); an out-of-window date with no override raises `F2F_OUTSIDE_WINDOW`. Pure transition.
import type { LocalDate } from "@chartwarden/types";
import { type TransitionResult, result } from "./effects";
import { AdmissionStateError, require_ } from "./errors";
import {
  type F2fEncounterLocation,
  type SignedNoteFacts,
  type TelehealthEligibilityAttestation,
  checkF2fModality,
  checkF2fSignedNote,
} from "./f2f-attestation-rules";
import { TEXT_MINIMUMS, checkF2fOverride, checkF2fPerformer, checkF2fWindow } from "./validation";

/**
 * R-F2F-06 — the § 418.22(b)(4) clinical-note attestation: the linked M8 note's facts plus what it must
 * match (the F2F's patient, performer and encounter date).
 */
export interface F2fSignedNoteAttestation {
  readonly note: SignedNoteFacts | null;
  readonly patientId: string;
  readonly performerUserId: string;
  readonly encounterDate: LocalDate | null;
}

/** The §2.3.4 F2F states. */
export type FaceToFaceState = "scheduled" | "completed" | "attested";

/** The §2.3.4 F2F events. */
export type FaceToFaceEvent =
  | {
      readonly type: "recordCompletion";
      readonly performerRole: "hospice_md" | "hospice_np" | "attending";
      readonly periodStart: LocalDate | null;
      readonly encounterDate: LocalDate;
      readonly hasOverride: boolean;
      /** R-F2F-05 — the modality; telehealth is date-limited and attestation-gated. `null` = not recorded
       *  (a non-route internal caller); the route requires it. */
      readonly encounterLocation: F2fEncounterLocation | null;
      readonly telehealthEligibility: TelehealthEligibilityAttestation | null;
      /** MBPM ch. 9 §20.1(5)(d) — period-3+ new admission with documented exceptional circumstances. */
      readonly exceptionDocumented?: boolean;
    }
  | {
      readonly type: "requestWindowOverride";
      readonly isMedicalDirector: boolean;
      readonly reason: string;
    }
  | {
      readonly type: "attest";
      /** The written attestation (≥ 100 chars). Not required when `signedNote` is supplied (R-F2F-06). */
      readonly narrative: string | null;
      /** R-F2F-06 — a linked signed clinical note in place of the written attestation. */
      readonly signedNote?: F2fSignedNoteAttestation | null;
      readonly performerIsActor: boolean;
    };

export type FaceToFaceTransition = TransitionResult<FaceToFaceState, FaceToFaceEvent["type"]>;

/** The legal §2.3.4 transition graph (`requestWindowOverride` is a `completed` self-loop). */
export const FACE_TO_FACE_GRAPH: Readonly<
  Record<FaceToFaceState, ReadonlyArray<FaceToFaceEvent["type"]>>
> = {
  // F-226 - `requestWindowOverride` is ALSO legal from `scheduled` (a self-loop): completion now computes
  // the window from the real encounter date and refuses an outside date unless an override is on file
  // (R-F2F-02), so an override reachable only AFTER completion could never rescue an outside-window F2F.
  scheduled: ["recordCompletion", "requestWindowOverride"],
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
      checkF2fModality({
        encounterLocation: event.encounterLocation,
        encounterDate: event.encounterDate,
        telehealthEligibility: event.telehealthEligibility,
      });
      const { withinWindow } = checkF2fWindow({
        periodStart: event.periodStart,
        encounterDate: event.encounterDate,
        hasOverride: event.hasOverride,
        exceptionDocumented: event.exceptionDocumented,
      });
      return result(from, event.type, "completed", [
        {
          kind: "set_flag",
          field:
            withinWindow === null
              ? "within_window_unknown"
              : withinWindow
                ? "within_window_true"
                : "within_window_false",
        },
        { kind: "audit" },
        // F-100 — this said `m6.f2f.scheduled`: the COMPLETION transition re-announcing that the
        // encounter had been scheduled. Wrong on both counts. Semantically it tells every consumer the
        // opposite of what happened, and mechanically `m6.f2f.scheduled` requires `f2fId` /
        // `electionPeriodId` / `scheduledDate`, none of which `runEffects`' base envelope carries — so
        // `POST /f2f/:id/complete` raised `payload_schema_violation` and rolled back, ON EVERY CALL.
        // Attestation is only reachable from `completed`, so the whole CMS-418.22(a)(4) face-to-face
        // chain was dead one step past scheduling.
        { kind: "outbox", event: "m6.f2f.completed" },
      ]);
    }
    case "requestWindowOverride": {
      checkF2fOverride({ isMedicalDirector: event.isMedicalDirector, reason: event.reason });
      return result(from, event.type, from, [
        { kind: "set_flag", field: "window_override" },
        { kind: "audit" },
        { kind: "outbox", event: "m6.f2f.window_overridden" },
      ]);
    }
    case "attest": {
      if (event.signedNote) {
        // R-F2F-06 — the signed clinical note IS the attestation; no separate narrative is required.
        checkF2fSignedNote(event.signedNote);
      } else {
        require_(
          (event.narrative ?? "").trim().length >= TEXT_MINIMUMS.f2fAttestation,
          "F2F_ATTESTATION_TOO_SHORT",
          `F2F attestation must be ≥ ${TEXT_MINIMUMS.f2fAttestation} characters`,
        );
      }
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
