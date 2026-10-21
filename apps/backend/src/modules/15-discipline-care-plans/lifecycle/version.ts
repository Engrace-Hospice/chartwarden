// apps/backend/src/modules/15-discipline-care-plans/lifecycle/version.ts — M15-T03 (§2.2.2).
//
// The `discipline_care_plan_version` lifecycle — M7 D1's hybrid-versioning model verbatim:
// draft → in_review → signed → superseded, with `in_review → draft` (returned for edits, or any required
// signer rejects) and the §2.2.2 integrity rule that an edit after the FIRST signature returns the version
// to draft and clears every prior signature. The `draft → in_review` transition SEALS `state_snapshot` +
// `required_signer_set`; subsequent edits to the underlying goal/intervention/assessment rows do not
// affect the sealed snapshot, which is what makes the signed record reconstructible at survey.
//
// The per-kind finalize readiness (§2.3: an Aide POC needs its aide AND supervising RN; a Volunteer Plan
// needs ≥1 active assignment plus the closed out-of-scope acknowledgment) is checked HERE, at the
// `finalize` transition, because that is the moment §2.3 names. Pure over already-resolved facts; the
// quorum math lives in `./required-signer-set`, the root promotion in `./plan`.
import type {
  DisciplinePlanKind,
  DisciplinePlanVersionKind,
  DisciplineRequiredSignerSet,
  DisciplineSignerRole,
  IsoInstant,
} from "@chartwarden/types";
import { type TransitionResult, result } from "./effects";
import { DisciplinePlanStateError, require_ } from "./errors";
import { decideRecordSignature, resolveRequiredSignerSet } from "./required-signer-set";
import { checkVolunteerOutOfScopeAcknowledged } from "./validation";

/** The §2.2.2 version states (mirrors `discipline_plan_version_status`). */
export type DisciplinePlanVersionState = "draft" | "in_review" | "signed" | "superseded";

/** The per-kind readiness facts §2.3 requires before a version may leave `draft` (resolved by the caller). */
export interface FinalizeReadiness {
  /** `aide_poc` — `discipline_care_plan.aide_membership_id` is set (§2.3). */
  readonly hasAideAssigned: boolean;
  /** `aide_poc` — `discipline_care_plan.supervising_rn_membership_id` is set (§2.3). */
  readonly hasSupervisingRn: boolean;
  /** `volunteer_plan` — ≥1 active `volunteer_assignment` on the plan (§2.3). */
  readonly hasActiveVolunteerAssignment: boolean;
  /** `volunteer_plan` — the §1.1 CLOSED out-of-scope items the plan's `data` payload acknowledges. */
  readonly volunteerOutOfScopeAcknowledged: ReadonlyArray<string>;
}

/** The §2.2.2 version events. */
export type DisciplinePlanVersionEvent =
  | {
      /** `draft → in_review`: the snapshot + the D11 quorum are sealed here (§2.2.2). */
      readonly type: "finalize";
      readonly planKind: DisciplinePlanKind;
      readonly versionKind: DisciplinePlanVersionKind;
      readonly at: IsoInstant;
      readonly readiness: FinalizeReadiness;
      /** A tenant may TIGHTEN the D11 floor (extra slots); never loosen (validated in M15-T06). */
      readonly requiredSignerSet?: DisciplineRequiredSignerSet;
    }
  | {
      /** One signature against the SEALED set; the last one flips the version to `signed`. */
      readonly type: "recordSignature";
      readonly signerRole: DisciplineSignerRole;
      readonly alreadySigned: ReadonlyArray<DisciplineSignerRole>;
      /** The set sealed on the row at `in_review` — never today's constants (§2.3). */
      readonly requiredSignerSet: DisciplineRequiredSignerSet;
      readonly signedAt: IsoInstant;
    }
  /** A required signer rejects, or the author pulls it back: `in_review → draft`. */
  | { readonly type: "returnForEdits"; readonly hasSignatures: boolean }
  /** §2.2.2 — an edit landing after the first signature invalidates the collected signatures. */
  | { readonly type: "editAfterFirstSignature" }
  | { readonly type: "supersede"; readonly at: IsoInstant };

export type DisciplinePlanVersionTransition = TransitionResult<
  DisciplinePlanVersionState,
  DisciplinePlanVersionEvent["type"]
>;

/** The legal §2.2.2 transition graph (from → events accepted). Guards are checked separately. */
export const DISCIPLINE_VERSION_GRAPH: Readonly<
  Record<DisciplinePlanVersionState, ReadonlyArray<DisciplinePlanVersionEvent["type"]>>
> = {
  draft: ["finalize"],
  in_review: ["recordSignature", "returnForEdits", "editAfterFirstSignature"],
  signed: ["supersede"],
  superseded: [],
};

/**
 * The `[*] → draft` factory: open version `sequence` of a plan (§2.2.2). The snapshot and the quorum are
 * captured LATER, at `finalize` — opening a draft commits to nothing. No outbox event: §2.4 publishes on
 * the signed transition, and an opened-then-abandoned draft is not a clinical fact any consumer needs.
 */
export function openDisciplinePlanVersion(versionKind: DisciplinePlanVersionKind): {
  readonly status: "draft";
  readonly kind: DisciplinePlanVersionKind;
  readonly effects: DisciplinePlanVersionTransition["effects"];
} {
  return { status: "draft", kind: versionKind, effects: [{ kind: "audit" }] };
}

/** §2.3 — the per-kind readiness gate at `draft → in_review`. */
function checkFinalizeReadiness(kind: DisciplinePlanKind, readiness: FinalizeReadiness): void {
  if (kind === "aide_poc") {
    require_(
      readiness.hasAideAssigned,
      "AIDE_ASSIGNMENT_REQUIRED",
      "an Aide POC version cannot be finalized before an aide is assigned to the plan",
    );
    require_(
      readiness.hasSupervisingRn,
      "SUPERVISING_RN_REQUIRED",
      "an Aide POC version cannot be finalized before a supervising RN is assigned to the plan",
    );
    return;
  }
  if (kind === "volunteer_plan") {
    require_(
      readiness.hasActiveVolunteerAssignment,
      "VOLUNTEER_ASSIGNMENT_REQUIRED",
      "a Volunteer Plan version cannot be finalized without at least one active volunteer assignment",
    );
    checkVolunteerOutOfScopeAcknowledged(readiness.volunteerOutOfScopeAcknowledged);
  }
}

/** Apply a `discipline_care_plan_version` event (§2.2.2). Throws `ILLEGAL_TRANSITION` if not accepted. */
export function transitionDisciplinePlanVersion(
  from: DisciplinePlanVersionState,
  event: DisciplinePlanVersionEvent,
): DisciplinePlanVersionTransition {
  if (!DISCIPLINE_VERSION_GRAPH[from].includes(event.type)) {
    throw new DisciplinePlanStateError(
      "ILLEGAL_TRANSITION",
      `discipline-plan version cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "finalize": {
      checkFinalizeReadiness(event.planKind, event.readiness);
      // Seal the snapshot with the (possibly tenant-tightened) D11 quorum. The `discharge` kind resolves
      // to an EMPTY set — that version is auto-built and system-signed on `m6.admission.discharged`.
      const set =
        event.requiredSignerSet ?? resolveRequiredSignerSet(event.planKind, event.versionKind);
      return result(from, event.type, "in_review", [
        { kind: "snapshot", requiredSignerSet: set },
        { kind: "set_timestamp", field: "finalized_at", at: event.at },
        { kind: "audit" },
      ]);
    }
    case "recordSignature": {
      const decision = decideRecordSignature(
        event.requiredSignerSet,
        event.alreadySigned,
        event.signerRole,
      );
      if (!decision.quorumMet) {
        // Quorum still open — the version stays `in_review` (e.g. the RN signed, the CHHA has not yet
        // acknowledged the Aide POC, §7.1).
        return result(from, event.type, "in_review", [{ kind: "audit" }]);
      }
      return result(from, event.type, "signed", [
        { kind: "set_timestamp", field: "signed_at", at: event.signedAt },
        { kind: "audit" },
        { kind: "outbox", event: "m15.plan.version_signed" },
      ]);
    }
    case "returnForEdits": {
      return result(from, event.type, "draft", [
        ...(event.hasSignatures
          ? ([{ kind: "clear_signatures" }] as DisciplinePlanVersionTransition["effects"])
          : []),
        { kind: "audit" },
      ]);
    }
    case "editAfterFirstSignature": {
      // §2.2.2 — editing once a signature exists invalidates it: back to draft, signatures cleared, the
      // signers re-sign the corrected plan. The sealed snapshot itself is rebuilt at the next finalize.
      return result(from, event.type, "draft", [{ kind: "clear_signatures" }, { kind: "audit" }]);
    }
    case "supersede": {
      return result(from, event.type, "superseded", [
        { kind: "set_timestamp", field: "superseded_at", at: event.at },
        { kind: "audit" },
      ]);
    }
  }
}
