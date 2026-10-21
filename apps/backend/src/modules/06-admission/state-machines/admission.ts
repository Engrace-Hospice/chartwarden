// apps/backend/src/modules/06-admission/state-machines/admission.ts — M6-T04 (§2.3.1).
//
// The Admission lifecycle: referred → pending → active ⇄ on_hold →
// discharged|bereavement → closed. Pure transition function: it validates the event is legal from the
// current state (§2.3 graph — nothing transitions on a string match), runs the enumerated guards
// (failures raise the §2.4 code via AdmissionStateError), and returns the new state + the §2.5
// in-transaction side-effect list the service executes. No IO; every fact a guard needs (M5 privacy
// flags, the M9 48h window status) is resolved upstream and passed in.
import type { AdmissionStatusValue } from "@chartwarden/types";
import type { LocalDate } from "@chartwarden/types";
import { type TransitionResult, result } from "./effects";
import { AdmissionStateError, require_ } from "./errors";
import { checkDeathCertifier } from "./validation";

/** The §2.3.1 admission events (the `Event` column). */
export type AdmissionEvent =
  | {
      readonly type: "createAdmission";
      readonly referralAccepted: boolean;
      readonly hasOtherOpenAdmission: boolean;
    }
  | { readonly type: "acknowledgeNoticeOfRights"; readonly alreadyAcknowledged: boolean }
  | {
      readonly type: "activate";
      readonly electionStatementSigned: boolean;
      readonly certificationSigned: boolean;
      readonly noticeOfRightsAcknowledged: boolean;
      readonly privacyFlagBlock: boolean;
      readonly initialAssessment48hOverdue: boolean;
      readonly donOverride: boolean;
      readonly isFirstElectionPeriod: boolean;
      readonly at: LocalDate;
    }
  | { readonly type: "placeOnHold"; readonly reason: string }
  | { readonly type: "releaseFromHold" }
  | {
      readonly type: "executeDischarge";
      readonly dischargeType:
        | "death"
        | "revocation"
        | "transfer"
        | "routine"
        | "for_cause"
        | "moved"
        | "no_longer_terminal";
      readonly effectiveAt: LocalDate;
      readonly admissionAt: LocalDate;
      readonly forCauseCosigned: boolean;
      readonly deathAt?: LocalDate;
      readonly today?: LocalDate;
      readonly deathCertifierCredentialed?: boolean;
    }
  | { readonly type: "closeAdmission"; readonly cleanupConfirmed: boolean };

export type AdmissionState = AdmissionStatusValue;
export type AdmissionTransition = TransitionResult<AdmissionState, AdmissionEvent["type"]>;

/** The legal §2.3.1 transition graph (from → events accepted). Guards are checked separately. */
export const ADMISSION_GRAPH: Readonly<
  Record<AdmissionState, ReadonlyArray<AdmissionEvent["type"]>>
> = {
  referred: ["createAdmission"],
  pending: ["acknowledgeNoticeOfRights", "activate"],
  notice_of_rights_acknowledged: ["activate"],
  active: ["placeOnHold", "executeDischarge"],
  on_hold: ["releaseFromHold", "executeDischarge"],
  discharged: ["closeAdmission"],
  bereavement: ["closeAdmission"],
  closed: [],
};

/** Resolve the discharge target state from the discriminator (§2.3.1: death → bereavement). */
function dischargeTarget(type: string): AdmissionState {
  return type === "death" ? "bereavement" : "discharged";
}

/**
 * Apply an admission lifecycle event (§2.3.1). Throws {@link AdmissionStateError} `ILLEGAL_TRANSITION`
 * if the event is not accepted from `from`, or the specific §2.4 guard code on a guard failure.
 */
export function transitionAdmission(
  from: AdmissionState,
  event: AdmissionEvent,
): AdmissionTransition {
  if (!ADMISSION_GRAPH[from].includes(event.type)) {
    throw new AdmissionStateError(
      "ILLEGAL_TRANSITION",
      `admission cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "createAdmission": {
      require_(event.referralAccepted, "ILLEGAL_TRANSITION", "referral is not accepted");
      require_(
        !event.hasOtherOpenAdmission,
        "PATIENT_ALREADY_ELECTED",
        "patient has another open admission",
      );
      return result(from, event.type, "pending", [
        { kind: "audit" },
        { kind: "outbox", event: "m6.admission.draft_created" },
        { kind: "open_window", window: "initial_assessment_48h" },
        { kind: "open_window", window: "comprehensive_assessment_5d" },
        { kind: "open_window", window: "care_plan_5d" },
        { kind: "open_window", window: "notice_of_rights" },
      ]);
    }
    case "acknowledgeNoticeOfRights": {
      require_(
        !event.alreadyAcknowledged,
        "ILLEGAL_TRANSITION",
        "notice of rights already acknowledged",
      );
      return result(from, event.type, "notice_of_rights_acknowledged", [
        { kind: "close_window", window: "notice_of_rights" },
        { kind: "audit" },
        { kind: "outbox", event: "m6.nor.acknowledged" },
      ]);
    }
    case "activate": {
      // R-ADM-01 / activation guards (§2.3.1): ES + CTI + NOR + no privacy block.
      require_(
        event.noticeOfRightsAcknowledged,
        "NOTICE_OF_RIGHTS_REQUIRED",
        "notice of rights not acknowledged",
      );
      require_(
        event.electionStatementSigned,
        "ELECTION_STATEMENT_REQUIRED",
        "election statement not signed",
      );
      require_(event.certificationSigned, "CERTIFICATION_REQUIRED", "CTI not signed");
      require_(
        !event.privacyFlagBlock,
        "PRIVACY_FLAG_BLOCK",
        "an M5 privacy flag blocks activation",
      );
      require_(
        !event.initialAssessment48hOverdue || event.donOverride,
        "INITIAL_ASSESSMENT_OVERDUE",
        "the initial 48-hour assessment window is overdue; DON override is required",
      );
      const effects: AdmissionTransition["effects"] = [
        { kind: "set_timestamp", field: "activated_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m6.admission.activated" },
      ];
      return result(from, event.type, "active", [
        ...effects,
        ...(event.isFirstElectionPeriod
          ? ([
              { kind: "outbox", event: "m6.election.period_started" },
            ] as AdmissionTransition["effects"])
          : []),
      ]);
    }
    case "placeOnHold": {
      require_(event.reason.trim().length > 0, "HOLD_REASON_REQUIRED", "a hold reason is required");
      return result(from, event.type, "on_hold", [
        { kind: "audit" },
        { kind: "outbox", event: "m6.admission.on_hold" },
      ]);
    }
    case "releaseFromHold": {
      return result(from, event.type, "active", [
        { kind: "audit" },
        { kind: "outbox", event: "m6.admission.resumed" },
      ]);
    }
    case "executeDischarge": {
      require_(
        event.dischargeType !== undefined && event.effectiveAt >= event.admissionAt,
        "DISCHARGE_BEFORE_ADMISSION",
        "discharge effective date precedes admission date",
      );
      if (event.dischargeType === "for_cause") {
        require_(
          event.forCauseCosigned,
          "FOR_CAUSE_REQUIRES_COSIGN",
          "for-cause discharge requires DON + Medical Director co-sign",
        );
      }
      if (event.dischargeType === "death") {
        checkDeathCertifier({
          deathAt: event.deathAt ?? event.effectiveAt,
          today: event.today ?? event.effectiveAt,
          certifierIsCredentialed: event.deathCertifierCredentialed ?? false,
        });
      }
      const to = dischargeTarget(event.dischargeType);
      // `m6.discharge.created`/`m6.discharge.death` are keyed to a real `discharge_event` row
      // (payload requires `dischargeEventId`) — revocation/transfer never create one (they have their
      // own `m6.revocation.created`/`m6.transfer.created`, keyed to `revocation_event`/`transfer_event`
      // instead). Firing a second "discharge" event for those types claimed an aggregate that doesn't
      // exist, and unconditionally including it here made `payload_schema_violation` unavoidable for
      // every revocation/transfer (there is no discharge_event id the caller could ever supply). Only
      // "real" discharge reasons (the DischargeReason-derived types) get this effect.
      const isRealDischarge =
        event.dischargeType !== "revocation" && event.dischargeType !== "transfer";
      const effects: AdmissionTransition["effects"] = [
        { kind: "end_level_of_care" },
        {
          kind: "end_election_period",
          cause:
            event.dischargeType === "revocation"
              ? "revocation"
              : event.dischargeType === "transfer"
                ? "transfer"
                : "discharge",
        },
        { kind: "audit" },
        { kind: "outbox", event: "m6.admission.discharged" },
        ...(isRealDischarge
          ? ([
              {
                kind: "outbox",
                event:
                  event.dischargeType === "death" ? "m6.discharge.death" : "m6.discharge.created",
              },
            ] as AdmissionTransition["effects"])
          : []),
      ];
      return result(from, event.type, to, [
        ...effects,
        ...(to === "bereavement"
          ? ([
              { kind: "outbox", event: "m6.bereavement.eligible" },
            ] as AdmissionTransition["effects"])
          : []),
      ]);
    }
    case "closeAdmission": {
      require_(
        event.cleanupConfirmed,
        "ILLEGAL_TRANSITION",
        "post-discharge cleanup not confirmed",
      );
      return result(from, event.type, "closed", [{ kind: "audit" }]);
    }
  }
}
