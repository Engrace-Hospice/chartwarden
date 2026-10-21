// @chartwarden/emar — §2.2 D6 administration-record lifecycle state machine (M13-T03). Pure, IO-free.
//
// The §2.2 machine is deliberately FLAT — administrations are *recorded events*, not multi-step workflows.
// The complexity is at the *write gate* (M12 consistency check, witness check, encounter linkage, late-entry
// tier resolution, five-rights), not the state. Per §2.2 the persisted states are `committed`,
// `pending_caregiver_review`, `superseded`, `voided`; `committing` is a transient request-scoped state the
// write transaction passes through, and `pending_offline_sync` is a device-local synthetic state never
// written server-side. The graph:
//
//   (none) ─recordAdministration→ committing ─commit→ committed         (─validationFailed→ rejected, no row)
//   (none) ─recordCaregiverAttested→ pending_caregiver_review ─acknowledgeByCaseManager→ committed
//   committed ─supersede→ superseded                                    (correction trigger, §5.12)
//   committed | pending_caregiver_review ─void→ voided                  (step-up + supervisor, §2.2)
//
// Pure transition function (the M11/M12 convention): genesis is a factory (no prior state) and the
// from-state transitions validate the event is legal from the current state, run the enumerated §2.2
// guards (failures raise the precise code via AdministrationStateError), and return the new state + the
// in-transaction side-effect list. No IO; every fact a guard needs (eligibility, M12 allow flag, five-rights
// result, late-entry tier resolved, kit-drawdown success) is resolved upstream and passed in.
import type { AdministrationStatus } from "@chartwarden/types";
import {
  type AdministrationSideEffect,
  type AdministrationTransitionResult,
  result,
} from "./effects";
import { AdministrationStateError, require_ } from "./errors";

/** The §2.2 administration-record states, including the transient request-scoped `committing`. */
export type AdministrationState = AdministrationStatus | "committing";

/** §2.2 — the genesis inputs for a clinician-recorded administration (the write gate, D6). Per-event facts
 * are resolved upstream and injected as data (M12 consult result, five-rights result, tier resolution). */
export interface RecordAdministrationInput {
  /** §4.7 — `administering_clinician_eligible[:medClass]` passed for the administering clinician. */
  readonly administeringClinicianEligible: boolean;
  /** §2.6 D7 — the order is a Schedule II–V controlled substance (witness required). */
  readonly isControlled: boolean;
  /** §2.6 D7 / §4.7 — `controlled_substance_witness_eligible` passed (required only when `isControlled`). */
  readonly witnessEligible: boolean;
  /** §2.2 D6 — M12 `getAdministrationContext` returned `allowAdministration=true`. */
  readonly m12AllowAdministration: boolean;
  /** §2.2 / §5.11 — the five-rights validation passed (right patient/drug/dose/route/time). */
  readonly fiveRightsPassed: boolean;
  /** §2.2 / D8 — the late-entry tier was resolved against (administeredAt, recordedAt). */
  readonly lateEntryTierResolved: boolean;
}

/** §2.9 D10 — the genesis inputs for a caregiver-attested administration (the M31 portal path). */
export interface RecordCaregiverAttestedInput {
  /** §2.9 D10 — the actor is an M31 portal session with `actor_kind='caregiver_attested'`. */
  readonly actorIsCaregiver: boolean;
  /** §2.9 D10 — M12 `getAdministrationContext` returned `allowAdministration=true`. */
  readonly m12AllowAdministration: boolean;
  /** §2.9 D10 — the five-rights validation passed against the order (D10 echoes the hint through M31). */
  readonly fiveRightsPassed: boolean;
  /** §2.9 D10 — the caregiver attestation text was recorded (denylisted). */
  readonly attestationRecorded: boolean;
}

/** §2.2 — the from-state lifecycle events (the genesis events are factories; see below). */
export type AdministrationEvent =
  | {
      readonly type: "commit";
      /** §2.6 D7 — the order is controlled (drives the `controlled_witnessed` event). */
      readonly isControlled: boolean;
      /** §2.6 — a partial dose was wasted (drives the `controlled_wasted` event). */
      readonly hasWastage: boolean;
      /** §2.4 D3 — this is a PRN administration (drives the reassessment trigger). */
      readonly isPrn: boolean;
      /** §2.3 — this administration fills a `scheduled_dose` (drives the linkage). */
      readonly isScheduled: boolean;
      /** §2.2 / D9 — an in-flight M8 encounter was resolved (drives the auto-link). */
      readonly hasOpenEncounter: boolean;
      /** §2.7 D5 — this dose is drawn from a comfort kit (drives the drawdown decrement). */
      readonly isComfortKitDrawdown: boolean;
      /** §2.7 D5 — the kit drawdown decrement succeeded (would not go negative). */
      readonly kitDrawdownSucceeded: boolean;
      /** §2.2 — tenant policy requires the per-administration eMAR PDF (default off; on for IPU, D9). */
      readonly perAdministrationPdfRequired: boolean;
    }
  | {
      readonly type: "validationFailed";
    }
  | {
      readonly type: "acknowledgeByCaseManager";
      /** §2.9 D10 — the RN case manager is on the patient's caseload (M5 `CaseloadProvider`). */
      readonly caseManagerOnCaseload: boolean;
    }
  | {
      readonly type: "supersede";
      /** §5.12 — fired by the correction trigger when the replacement row commits (system actor). */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "void";
      /** §2.2 — the actor holds the `administration.void` permission (RN case manager + supervisor). */
      readonly hasVoidPermission: boolean;
      /** §2.2 — step-up re-authentication completed. */
      readonly stepUpCompleted: boolean;
      /** §2.2 — the void reason (≥40 chars; denylisted). */
      readonly reason: string;
    };

export type AdministrationTransition = AdministrationTransitionResult<
  AdministrationState,
  AdministrationEvent["type"]
>;

/** A genesis (no prior state) result label — the two factory entry points (§2.2 / §2.9). */
export type AdministrationGenesisTransition = AdministrationTransitionResult<
  AdministrationState,
  "recordAdministration" | "recordCaregiverAttested"
>;

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const ADMINISTRATION_GRAPH: Readonly<
  Record<AdministrationState, ReadonlyArray<AdministrationEvent["type"]>>
> = {
  committing: ["commit", "validationFailed"],
  committed: ["supersede", "void"],
  pending_caregiver_review: ["acknowledgeByCaseManager", "void"],
  superseded: [],
  voided: [],
};

/** §2.2 minimum void-reason length (mirrors the M8 late-entry / void reason floor). */
export const VOID_REASON_MIN_LENGTH = 40;

/**
 * §2.2 D6 genesis — validate a clinician administration write gate and enter `committing`. There is no prior
 * state, so this is a factory, not a transition. The route's commit (the `commit` event) emits the outbox +
 * child-row effects; the gate itself only audits the validated intent (the row is visible only during the
 * request until commit). Raises the precise §2.2 guard code on failure (no DB write; the route returns 422).
 */
export function planRecordAdministration(
  input: RecordAdministrationInput,
): AdministrationGenesisTransition {
  require_(
    input.administeringClinicianEligible,
    "ADMINISTERING_CLINICIAN_NOT_ELIGIBLE",
    "the administering clinician is not eligible to administer this medication class",
  );
  if (input.isControlled) {
    require_(
      input.witnessEligible,
      "CONTROLLED_WITNESS_NOT_ELIGIBLE",
      "a controlled-substance administration requires an eligible second-clinician witness",
    );
  }
  require_(
    input.m12AllowAdministration,
    "ADMINISTRATION_BLOCKED",
    "M12 reports this medication order does not allow administration (not active)",
  );
  require_(
    input.fiveRightsPassed,
    "FIVE_RIGHTS_VIOLATION",
    "the five-rights validation did not pass",
  );
  require_(
    input.lateEntryTierResolved,
    "LATE_ENTRY_TIER_UNRESOLVED",
    "the late-entry tier could not be resolved",
  );
  return result("committing", "recordAdministration", "committing", [{ kind: "audit" }]);
}

/**
 * §2.9 D10 genesis — validate a caregiver-attested administration and enter `pending_caregiver_review`. The
 * row is committed and counts toward administration totals, with `requires_rn_review=true` driving the cosign
 * queue until a case manager acknowledges. No controlled-substance witness on the caregiver path (§2.9).
 */
export function planRecordCaregiverAttested(
  input: RecordCaregiverAttestedInput,
): AdministrationGenesisTransition {
  require_(
    input.actorIsCaregiver,
    "CAREGIVER_ACTOR_REQUIRED",
    "the caregiver-attested path requires an M31 portal caregiver-attested actor session",
  );
  require_(
    input.m12AllowAdministration,
    "ADMINISTRATION_BLOCKED",
    "M12 reports this medication order does not allow administration (not active)",
  );
  require_(
    input.fiveRightsPassed,
    "FIVE_RIGHTS_VIOLATION",
    "the five-rights validation did not pass",
  );
  require_(
    input.attestationRecorded,
    "CAREGIVER_ATTESTATION_REQUIRED",
    "the caregiver attestation text is required",
  );
  return result("committing", "recordCaregiverAttested", "pending_caregiver_review", [
    { kind: "set_requires_rn_review", value: true },
    { kind: "set_timestamp", field: "recorded_at" },
    { kind: "audit" },
    { kind: "outbox", event: "m13.administration.recorded_caregiver_attested" },
    { kind: "alert", alert: "m13.caregiver_attested_pending_review" },
  ]);
}

/**
 * Apply an administration-record lifecycle event (§2.2 D6). Throws {@link AdministrationStateError}
 * `ILLEGAL_ADMINISTRATION_TRANSITION` if the event is not accepted from `from`, or the specific §2.2 guard
 * code on a guard failure. Returns the new state + the ordered side-effect list the service runs in the
 * administration write transaction.
 */
export function transitionAdministration(
  from: AdministrationState,
  event: AdministrationEvent,
): AdministrationTransition {
  if (!ADMINISTRATION_GRAPH[from].includes(event.type)) {
    throw new AdministrationStateError(
      "ILLEGAL_ADMINISTRATION_TRANSITION",
      `administration cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "commit": {
      // §2.7 D5 — the kit count must reconcile; a decrement that would go negative rejects the write.
      if (event.isComfortKitDrawdown) {
        require_(
          event.kitDrawdownSucceeded,
          "KIT_INSUFFICIENT_QUANTITY",
          "the comfort-kit drawdown decrement would go negative; the administration is rejected",
        );
      }
      const effects: AdministrationSideEffect[] = [
        { kind: "set_timestamp", field: "recorded_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m13.administration.recorded" },
      ];
      if (event.isControlled) {
        effects.push({ kind: "outbox", event: "m13.administration.controlled_witnessed" });
        if (event.hasWastage) {
          effects.push({ kind: "outbox", event: "m13.administration.controlled_wasted" });
        }
      }
      if (event.isComfortKitDrawdown) effects.push({ kind: "decrement_kit_drawdown" });
      if (event.isScheduled) effects.push({ kind: "link_scheduled_dose" });
      if (event.hasOpenEncounter) effects.push({ kind: "link_encounter" });
      if (event.isPrn) {
        effects.push(
          { kind: "emit_prn_reassessment_trigger" },
          { kind: "outbox", event: "m13.prn_administration_recorded" },
        );
      }
      if (event.perAdministrationPdfRequired) {
        effects.push(
          { kind: "request_document" },
          { kind: "outbox", event: "m13.administration_record.document_requested" },
        );
      }
      return result(from, event.type, "committed", effects);
    }

    case "validationFailed": {
      // §2.2 — a guard failed after the gate; no DB write happens. No state row persists.
      return result(from, event.type, "committing", []);
    }

    case "acknowledgeByCaseManager": {
      require_(
        event.caseManagerOnCaseload,
        "CASE_MANAGER_ACK_NOT_PERMITTED",
        "only the patient's RN case manager may acknowledge a caregiver-attested administration",
      );
      return result(from, event.type, "committed", [
        { kind: "set_requires_rn_review", value: false },
        { kind: "audit" },
        { kind: "outbox", event: "m13.caregiver_administration.acknowledged" },
      ]);
    }

    case "supersede": {
      // §5.12 — the correction route's replacement row commits and the trigger flips the original.
      require_(
        event.isSystemActor,
        "NOT_SYSTEM_ACTOR",
        "the supersede transition is a system-actor (correction-trigger) operation",
      );
      return result(from, event.type, "superseded", [
        { kind: "supersede_original" },
        { kind: "audit" },
        { kind: "outbox", event: "m13.administration.corrected" },
      ]);
    }

    case "void": {
      require_(
        event.hasVoidPermission,
        "VOID_NOT_PERMITTED",
        "the actor lacks the administration.void permission",
      );
      require_(
        event.stepUpCompleted,
        "VOID_STEP_UP_REQUIRED",
        "the void path requires step-up re-authentication",
      );
      require_(
        event.reason.trim().length >= VOID_REASON_MIN_LENGTH,
        "VOID_REASON_TOO_SHORT",
        `the void reason must be at least ${VOID_REASON_MIN_LENGTH} characters`,
      );
      return result(from, event.type, "voided", [
        { kind: "write_void", reason: event.reason },
        { kind: "set_timestamp", field: "voided_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m13.administration.voided" },
        { kind: "alert", alert: "m13.administration_voided" },
      ]);
    }
  }
}
