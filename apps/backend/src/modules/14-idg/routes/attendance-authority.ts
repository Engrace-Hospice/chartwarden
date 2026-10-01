// apps/backend/src/modules/14-idg/routes/attendance-authority.ts — the pure ATTENDANCE TRUST matrix (0286).
//
// `idg_attendance` feeds two trust decisions: the §2.7 quorum (`IDG_REQUIRED_QUORUM` matches on the discipline string)
// and the per-discipline note authorization (a non-coordinator may write notes only for a discipline they are recorded
// present for). Both used to trust a free-text discipline any `idg.attend` holder could record for ANY membership. This
// planner is the single decision for one attendance write; the route resolves the facts (who the actor is, what roles
// the target holds) and the service merely stores the verdict.
//
//   actor            target        discipline                    result
//   ---------------  ------------  ----------------------------  ---------------------------------------------
//   any              any           outside the closed vocabulary 422 UNKNOWN_DISCIPLINE
//   non-coordinator  someone else  -                             403 ATTENDANCE_SELF_ONLY
//   non-coordinator  self          coordinatorAttested=true      403 ATTESTATION_REQUIRES_COORDINATOR
//   coordinator      not in org    -                             422 ATTENDANCE_MEMBERSHIP_NOT_FOUND
//   any              self/other    held by the TARGET's roles    OK, validated (disciplineAttested=false)
//   non-coordinator  self          not held                      422 DISCIPLINE_NOT_HELD
//   coordinator      other         not held, no attestation      422 DISCIPLINE_NOT_HELD
//   coordinator      other         not held, coordinatorAttested OK, FLAGGED (disciplineAttested=true)
//   coordinator      self          not held, coordinatorAttested 403 ATTESTATION_SELF_FORBIDDEN (no self-dealing)
//   coordinator      other         target roles unresolvable     503 ATTENDANCE_AUTHORITY_UNAVAILABLE (fail closed)
//
// "coordinator" = holds `idg.coordinate` (resolved server-side; never client input). `administrator` is a member of the
// vocabulary but NOT a quorum seat, so recording an admin under it can never satisfy quorum.
import { isIdgAttendanceDiscipline } from "@wardenx/idg";
import { WardenXError } from "@wardenx/types";

/** What the route learned about the TARGET membership's authoritative disciplines. */
export type AttendanceTargetFacts =
  | { readonly kind: "held"; readonly disciplines: readonly string[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

export interface AttendancePlanInput {
  readonly actorMembershipId: string;
  readonly actorIsCoordinator: boolean;
  readonly targetMembershipId: string;
  readonly discipline: string;
  /** The caller's explicit claim that a coordinator is attesting a discipline the member's roles do not confer. */
  readonly coordinatorAttested: boolean;
  readonly target: AttendanceTargetFacts;
}

export interface AttendancePlan {
  /** True when the discipline is a coordinator's flagged override (the member's roles do not confer it). */
  readonly disciplineAttested: boolean;
}

export const attendanceSelfOnlyError = (): WardenXError =>
  new WardenXError(
    "ATTENDANCE_SELF_ONLY",
    "you may only record your own attendance; a coordinator records other attendees",
    403,
  );

export function planAttendanceRecord(input: AttendancePlanInput): AttendancePlan {
  if (!isIdgAttendanceDiscipline(input.discipline)) {
    throw new WardenXError(
      "UNKNOWN_DISCIPLINE",
      `'${input.discipline}' is not an attendance discipline`,
      422,
    );
  }
  const isSelf = input.actorMembershipId === input.targetMembershipId;
  if (!input.actorIsCoordinator) {
    if (!isSelf) throw attendanceSelfOnlyError();
    if (input.coordinatorAttested) {
      throw new WardenXError(
        "ATTESTATION_REQUIRES_COORDINATOR",
        "only a coordinator may attest a discipline the member's roles do not confer",
        403,
      );
    }
  }
  if (input.target.kind === "not_found") {
    throw new WardenXError(
      "ATTENDANCE_MEMBERSHIP_NOT_FOUND",
      "that membership is not an active member of this organization",
      422,
    );
  }
  if (input.target.kind === "unavailable") {
    throw new WardenXError(
      "ATTENDANCE_AUTHORITY_UNAVAILABLE",
      "could not verify the attendee's disciplines; please retry",
      503,
    );
  }
  if (input.target.disciplines.includes(input.discipline)) return { disciplineAttested: false };
  if (input.actorIsCoordinator && input.coordinatorAttested) {
    if (isSelf) {
      throw new WardenXError(
        "ATTESTATION_SELF_FORBIDDEN",
        "a coordinator may not attest a discipline for themself; ask another coordinator",
        403,
      );
    }
    return { disciplineAttested: true };
  }
  throw new WardenXError(
    "DISCIPLINE_NOT_HELD",
    input.actorIsCoordinator
      ? `the member does not hold the '${input.discipline}' discipline; record it as a coordinator attestation to override`
      : `you do not hold the '${input.discipline}' discipline`,
    422,
  );
}
