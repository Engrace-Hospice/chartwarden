// apps/backend/src/modules/19-oncall/lifecycle/escalation.ts — M19-T03 (§2.2.4, §2.3, D7, §7.2, §7.3).
//
// The escalation ladder's own three-step life: `open → acknowledged → resolved`. Small machine, one rule
// that carries the whole module's weight:
//
//   A MANDATORY-ESCALATION ROW CANNOT BE AUTO-RESOLVED BY A CALL CLOSE (§2.2.4).
//
// Everything else in D7 — the platform-locked flags, the org-less floor rows, migration 0108's write
// policies — exists to guarantee the row gets WRITTEN. This file guarantees it gets ANSWERED. A hospice
// under staffing pressure does not suppress a suicidal-ideation escalation by editing a protocol it cannot
// write; it does so by closing the call and letting the row lapse with it. `autoResolveOnCallClose`
// refuses exactly that, and returns the un-resolvable rows so the closing path can say which ones.
//
// The second rule is the §3.3 recipient CHECK restated where it can name the tier: `tier_5_external` routes
// to a vendor and every other tier routes to a membership. A tier whose recipient column is empty is a page
// that rings nowhere, and the row would look identical to one that was delivered.
import type {
  IsoInstant,
  MembershipId,
  TriageEscalationId,
  TriageEscalationState,
  TriageEscalationTier,
  TriageEscalationTrigger,
} from "@wardenx/types";
import { type TriageSideEffect, type TriageTransitionResult, result, withAudit } from "./effects";
import { require_ } from "./errors";

/** One `triage_escalation` row as the machine sees it. */
export interface TriageEscalationFacts {
  readonly escalationId: TriageEscalationId;
  readonly tier: TriageEscalationTier;
  readonly triggerKind: TriageEscalationTrigger;
  readonly escalatedAt: IsoInstant;
  readonly acknowledgedAt: IsoInstant | null;
  readonly resolvedAt: IsoInstant | null;
  readonly escalatedToMembershipId: MembershipId | null;
  readonly escalatedToExternalActorId: string | null;
}

/** §2.2.4 — the commands. `resolve` is the escalated party's explicit answer; `autoResolve` is what a call
 *  close attempts, and is the one a mandatory row refuses. */
export type TriageEscalationCommand = "acknowledge" | "resolve" | "autoResolve";

/** §2.2.4 — the escalation's state, derived from its two timestamps rather than stored. There is no
 *  `status` column on `triage_escalation` (§3.3), and deriving keeps "acknowledged" from ever disagreeing
 *  with `acknowledged_at`. The §3.3 CHECK guarantees `resolved_at ⇒ acknowledged_at`, so the ladder cannot
 *  be read out of order. */
export function escalationState(escalation: TriageEscalationFacts): TriageEscalationState {
  if (escalation.resolvedAt !== null) return "resolved";
  if (escalation.acknowledgedAt !== null) return "acknowledged";
  return "open";
}

/** D7 — the two trigger kinds the SERVER writes on the mandatory path. `red_flag_question` is a clinical
 *  concern raised to the supervisor and MAY be auto-resolved with the call; `mandatory_protocol` is one of
 *  the four platform-floor protocols (§1.1) and may not. `sla_breach` is the §4.8 callback detector's. */
export function isMandatoryEscalation(escalation: TriageEscalationFacts): boolean {
  return escalation.triggerKind === "mandatory_protocol";
}

/** §3.3 `m19_triage_escalation_recipient` — exactly one recipient kind, decided by the tier. Checked here
 *  so the refusal names the tier rather than surfacing as a constraint violation from the driver. */
export function assertRecipientCoherent(input: {
  readonly tier: TriageEscalationTier;
  readonly escalatedToMembershipId: MembershipId | null;
  readonly escalatedToExternalActorId: string | null;
}): void {
  if (input.tier === "tier_5_external") {
    require_(
      input.escalatedToExternalActorId !== null && input.escalatedToMembershipId === null,
      "ESCALATION_RECIPIENT_REQUIRED",
      "tier_5_external escalates to an external vendor actor and to no membership",
    );
    return;
  }
  require_(
    input.escalatedToMembershipId !== null && input.escalatedToExternalActorId === null,
    "ESCALATION_RECIPIENT_REQUIRED",
    `${input.tier} escalates to a membership and to no external actor`,
  );
}

/**
 * §2.2.4 — acknowledge. This is the write §7.2 waits on before the call may take any disposition other
 * than `escalated_unresolved`: it is the record that a human at the escalated tier picked up.
 */
export function acknowledgeEscalation(input: {
  readonly escalation: TriageEscalationFacts;
  readonly by: MembershipId;
  readonly at: IsoInstant;
}): TriageTransitionResult<TriageEscalationState, TriageEscalationCommand> {
  const from = escalationState(input.escalation);
  require_(
    from !== "resolved",
    "ESCALATION_ALREADY_RESOLVED",
    "the escalation is already resolved",
  );
  require_(
    from !== "acknowledged",
    "ESCALATION_ALREADY_ACKNOWLEDGED",
    "the escalation is already acknowledged",
  );

  return result(
    from,
    "acknowledge",
    "acknowledged",
    withAudit([
      { kind: "acknowledge_escalation", by: input.by },
      { kind: "set_timestamp", field: "acknowledged_at", at: input.at },
    ]),
  );
}

/**
 * §2.2.4 — resolve, explicitly, by the escalated party. A mandatory row reaches `resolved` ONLY here.
 *
 * The resolution text is required and denylisted from audit value capture (§3.6): it is clinician prose
 * about a person in crisis, and the surveyor-grade answer to "what was decided" is read off the row under
 * ABAC, not out of the audit log.
 */
export function resolveEscalation(input: {
  readonly escalation: TriageEscalationFacts;
  readonly resolution: string;
  readonly by: MembershipId;
  readonly at: IsoInstant;
}): TriageTransitionResult<TriageEscalationState, TriageEscalationCommand> {
  const from = escalationState(input.escalation);
  require_(
    from !== "resolved",
    "ESCALATION_ALREADY_RESOLVED",
    "the escalation is already resolved",
  );
  require_(
    from === "acknowledged",
    "ESCALATION_INVALID_TRANSITION",
    "an escalation is acknowledged before it is resolved — a row resolved without an acknowledgement means nobody answered the page",
  );
  require_(
    input.resolution.trim().length > 0,
    "ESCALATION_RESOLUTION_REQUIRED",
    "a resolution records what the escalated party decided; an empty one closes the rung and says nothing",
  );

  return result(
    from,
    "resolve",
    "resolved",
    withAudit([
      { kind: "resolve_escalation", by: input.by },
      { kind: "set_timestamp", field: "resolved_at", at: input.at },
    ]),
  );
}

/** What a call close did to one escalation row. */
export interface EscalationAutoResolveOutcome {
  readonly escalationId: TriageEscalationId;
  readonly resolved: boolean;
  /** Present when `resolved=false` — why the close could not clear this row. */
  readonly blockedReason?: "mandatory" | "unacknowledged";
}

/** The verdict for a whole call's escalation set. */
export interface CallCloseEscalationVerdict {
  readonly outcomes: readonly EscalationAutoResolveOutcome[];
  /** The rows that must be resolved by hand before the call can close. */
  readonly blocking: readonly TriageEscalationFacts[];
  readonly effects: ReadonlyArray<TriageSideEffect>;
}

/**
 * §2.2.4 — what a `documented → closed` close may do to the call's escalation rows.
 *
 * Two rows are NOT auto-resolvable, for different reasons:
 *   • MANDATORY (`mandatory_protocol`) — §2.2.4 is explicit. These are the four D7 protocols; the whole
 *     point is that the agency can prove a named human answered.
 *   • UNACKNOWLEDGED — a row nobody ever acknowledged cannot be resolved by the system either, because
 *     §3.3's `m19_triage_escalation_ack_before_resolve` CHECK forbids `resolved_at` without
 *     `acknowledged_at`. Auto-resolving it would need the system to fabricate the acknowledgement, which
 *     is the one thing the CHECK exists to prevent.
 *
 * Acknowledged non-mandatory rows resolve with the call and carry `by: null` — the §3.3 schema deliberately
 * has NO `resolved_at ⇒ resolved_by_membership_id` companion so this system write does not have to invent
 * an actor (attribution lives in the M4 audit row's `actor_kind`).
 */
export function autoResolveOnCallClose(
  escalations: readonly TriageEscalationFacts[],
  at: IsoInstant,
): CallCloseEscalationVerdict {
  const outcomes: EscalationAutoResolveOutcome[] = [];
  const blocking: TriageEscalationFacts[] = [];
  const effects: TriageSideEffect[] = [];

  for (const escalation of escalations) {
    if (escalationState(escalation) === "resolved") {
      outcomes.push({ escalationId: escalation.escalationId, resolved: true });
      continue;
    }
    if (isMandatoryEscalation(escalation)) {
      outcomes.push({
        escalationId: escalation.escalationId,
        resolved: false,
        blockedReason: "mandatory",
      });
      blocking.push(escalation);
      continue;
    }
    if (escalationState(escalation) === "open") {
      outcomes.push({
        escalationId: escalation.escalationId,
        resolved: false,
        blockedReason: "unacknowledged",
      });
      blocking.push(escalation);
      continue;
    }
    outcomes.push({ escalationId: escalation.escalationId, resolved: true });
    effects.push(
      { kind: "resolve_escalation", by: null },
      { kind: "set_timestamp", field: "resolved_at", at },
    );
  }

  return { outcomes, blocking, effects: effects.length > 0 ? withAudit(effects) : [] };
}

/** §2.2.4 — the guard the close path calls before it moves the call. Separate from
 *  {@link autoResolveOnCallClose} so a caller can ASK (render the blockers on the §5 panel) without
 *  attempting the close. */
export function assertCallCloseable(escalations: readonly TriageEscalationFacts[]): void {
  const verdict = autoResolveOnCallClose(escalations, new Date(0).toISOString());
  const mandatory = verdict.blocking.filter(isMandatoryEscalation);
  require_(
    mandatory.length === 0,
    "MANDATORY_ESCALATION_AUTO_RESOLVE_FORBIDDEN",
    `${mandatory.length} mandatory escalation(s) still need an explicit resolution by the escalated party`,
  );
}

/** §7.2 — the disposition gate. While ANY mandatory escalation is still `open` (unacknowledged), the only
 *  outcome the call may take is `escalateUnresolved`. Once the escalated party acknowledges, the clinician
 *  chooses with their guidance — which is exactly §7.2's worked sequence (MD acknowledges, then the RN
 *  dispositions `gip_admission_proposed`). */
export function hasUnacknowledgedMandatoryEscalation(
  escalations: readonly TriageEscalationFacts[],
): boolean {
  return escalations.some((e) => isMandatoryEscalation(e) && escalationState(e) === "open");
}

/** §2.3 — `completeProtocol` rejects while any red-flag escalation is still open. A red flag that nobody
 *  has picked up is not a finding the walk may step past. */
export function hasOpenRedFlagEscalation(escalations: readonly TriageEscalationFacts[]): boolean {
  return escalations.some(
    (e) => e.triggerKind === "red_flag_question" && escalationState(e) === "open",
  );
}
