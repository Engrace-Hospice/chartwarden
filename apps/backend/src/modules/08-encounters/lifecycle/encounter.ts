// apps/backend/src/modules/08-encounters/lifecycle/encounter.ts — M8-T04 (§2.3).
//
// The Encounter aggregate lifecycle: draft → finalized → {signed | cosign_pending → cosigned} → (void
// from draft only). Pure transition function: it validates the event is legal from the current state
// (§2.3 graph — nothing transitions on a string match), runs the enumerated guards (failures raise the
// §2.7 code via EncounterStateError), and returns the new state + the §2.8 in-transaction side-effect
// list the service executes. No IO; every fact a guard needs (the Layer-3 gate verdict, step-up
// freshness, the F2F dual-write presence, whether a cosign-eligible RN exists) is resolved upstream and
// passed in as a boolean. Addendum authoring is its own small machine (see ./addendum) — the parent row
// never leaves signed/cosigned, so it is not an event on this aggregate.
import type { EncounterDiscipline, EncounterStatus, LocalDate } from "@chartwarden/types";
import { type EncounterSideEffect, type TransitionResult, result } from "./effects";
import { EncounterStateError, require_ } from "./errors";
import { COSIGN_REQUIRED_DISCIPLINES, TEXT_MINIMUMS } from "./validation";

export type EncounterState = EncounterStatus;

/** The §2.3 encounter lifecycle events (the post-draft transitions). */
export type EncounterEvent =
  | {
      readonly type: "finalize";
      /** Layer-3 gate run as preview at finalize (§2.3 / §2.6). False ⇒ stay draft with remediation. */
      readonly gatePreviewPassed: boolean;
      readonly at: LocalDate;
    }
  | {
      readonly type: "sign";
      readonly discipline: EncounterDiscipline;
      /** Layer-3 gate ENFORCED at sign (§2.6, signing-blocking). */
      readonly gatePassed: boolean;
      /** D13 — step-up auth ≤ 5 min old (resolved via checkStepUpFresh upstream). */
      readonly stepUpFresh: boolean;
      /** §2.7 D1 — is this an F2F encounter, and is the M6 dual-write row present in the same tx. */
      readonly isF2f: boolean;
      readonly f2fDualWriteSatisfied: boolean;
      /** §2.3 gate check 10 — a cosignature-eligible RN exists on the caseload (for LPN/CHHA). */
      readonly eligibleCosignerExists: boolean;
      readonly at: LocalDate;
    }
  | { readonly type: "recordCosignature"; readonly at: LocalDate }
  | {
      readonly type: "void";
      /** Admin-only: the caller holds `encounter.administrative_override` (§2.3). */
      readonly isAdmin: boolean;
      readonly reason: string;
      readonly at: LocalDate;
    };

export type EncounterTransition = TransitionResult<EncounterState, EncounterEvent["type"]>;

/** The legal §2.3 transition graph (from → events accepted). Guards are checked separately. */
export const ENCOUNTER_GRAPH: Readonly<
  Record<EncounterState, ReadonlyArray<EncounterEvent["type"]>>
> = {
  draft: ["finalize", "void"],
  finalized: ["sign"],
  signed: [],
  cosign_pending: ["recordCosignature"],
  cosigned: [],
  voided: [],
};

/** Whether a primary signature by `discipline` routes the encounter into `cosign_pending` (§2.3). */
export function requiresCosignature(discipline: EncounterDiscipline): boolean {
  return COSIGN_REQUIRED_DISCIPLINES.includes(discipline);
}

/**
 * The genesis of an encounter: a `draft` row (§2.3). There is no prior state, so this is a factory, not
 * a transition — the §2.7 draft-creation guards (discipline pair, service-date, volunteer assignment)
 * are composed by the service from ./validation before this runs. Returns the §2.8 side-effect list the
 * service executes inside the create transaction (audit + the `m8.encounter.created` outbox event).
 */
export function planDraftCreation(): ReadonlyArray<EncounterSideEffect> {
  return [{ kind: "audit" }, { kind: "outbox", event: "m8.encounter.created" }];
}

/**
 * Apply an encounter lifecycle event (§2.3). Throws {@link EncounterStateError} `ILLEGAL_TRANSITION` if
 * the event is not accepted from `from`, or the specific §2.7 guard code on a guard failure.
 */
export function transitionEncounter(
  from: EncounterState,
  event: EncounterEvent,
): EncounterTransition {
  if (!ENCOUNTER_GRAPH[from].includes(event.type)) {
    throw new EncounterStateError(
      "ILLEGAL_TRANSITION",
      `encounter cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "finalize": {
      // Layer-3 gate runs as a preview here (§2.3): a failure keeps the row in draft with remediation.
      require_(event.gatePreviewPassed, "COMPLIANCE_GATE_FAILED", "Layer-3 compliance gate failed");
      return result(from, event.type, "finalized", [
        { kind: "persist_assembled_output" },
        { kind: "set_late_entry_tier" },
        { kind: "set_timestamp", field: "finalized_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m8.encounter.finalized" },
      ]);
    }
    case "sign": {
      // Layer-3 gate is ENFORCED at sign (signing-blocking, §2.6) and step-up must be fresh (D13).
      require_(event.stepUpFresh, "STEP_UP_AUTH_REQUIRED", "sign requires fresh step-up auth");
      require_(event.gatePassed, "COMPLIANCE_GATE_FAILED", "Layer-3 compliance gate failed");
      if (event.isF2f) {
        require_(
          event.f2fDualWriteSatisfied,
          "F2F_DUAL_WRITE_REQUIRED",
          "an F2F encounter requires the M6 face_to_face_encounter_id in the same transaction",
        );
      }
      const cosign = requiresCosignature(event.discipline);
      if (cosign) {
        require_(
          event.eligibleCosignerExists,
          "NO_ELIGIBLE_COSIGNER",
          "no cosignature-eligible RN exists on the patient's caseload",
        );
      }
      const base: EncounterTransition["effects"] = [
        { kind: "write_signature", signature: "primary" },
        { kind: "freeze_selections" },
        { kind: "set_timestamp", field: "signed_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m8.encounter.signed" },
      ];
      // LPN/CHHA: the row enters cosign_pending and the D3 cosignature_request is opened + routed.
      return cosign
        ? result(from, event.type, "cosign_pending", [
            ...base,
            { kind: "open_cosignature_request" },
            { kind: "outbox", event: "m8.encounter.cosignature_routed" },
          ])
        : result(from, event.type, "signed", base);
    }
    case "recordCosignature": {
      return result(from, event.type, "cosigned", [
        { kind: "write_signature", signature: "cosignature" },
        { kind: "set_timestamp", field: "cosigned_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m8.encounter.cosigned" },
      ]);
    }
    case "void": {
      // Admin-only true terminal state; reason ≥ 40 chars (§2.3). Row is never deleted.
      require_(
        event.isAdmin,
        "VOID_NOT_PERMITTED",
        "void requires encounter.administrative_override",
      );
      require_(
        event.reason.trim().length >= TEXT_MINIMUMS.voidReason,
        "VOID_REASON_TOO_SHORT",
        `void reason must be ≥ ${TEXT_MINIMUMS.voidReason} characters`,
      );
      return result(from, event.type, "voided", [
        { kind: "set_field", field: "voided_reason" },
        { kind: "set_timestamp", field: "voided_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m8.encounter.voided" },
      ]);
    }
  }
}
