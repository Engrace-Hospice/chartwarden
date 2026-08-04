// apps/backend/src/modules/19-oncall/lifecycle/effects.ts — M19-T03 (§2.4 side-effect table).
//
// §2.4's whole posture in one type: every M19 mutation has a defined audit + state-history + outbox + alert
// result, and the COMMIT binds the domain row, the M4 audit row, the append-only
// `triage_call_state_history` row and the outbox row atomically — "the call was dispositioned but
// `m19.triage_call.visit_needed` never went out" is eliminated structurally rather than by review. The
// machines here return those side effects DECLARATIVELY as data; the M19-T07 route layer and the §4.8
// workers execute them inside the aggregate's transaction. Keeping them as data is what makes the machines
// deterministic and unit-testable with no DB — the discipline M6/M7/M15/M16/M21 each fixed.
//
// `outbox` is restricted to the §4.10 `m19.*` catalog and `alert` to the §4.9 union, so a typo cannot
// invent a name the dispatcher (and `arch:gaps`) would not recognise.
//
// TIMESTAMP FIELDS ARE A CLOSED UNION, not `string`. M21-T03's finding: a `set_timestamp` effect naming a
// column the schema does not have compiles clean and passes every gate, because a pure machine's effects
// type-check against nothing. `TriageTimestampField` lists the `triage_call` / `triage_escalation` /
// `on_call_shift` timestamp columns migration 0107 actually created; one more is a compile error here
// rather than a silent no-op at 2 a.m.
import type {
  IsoInstant,
  M19EventName,
  MembershipId,
  OncallAlertPayload,
  TriageCallState,
  TriageDisposition,
  TriageDispositionData,
  TriageEscalationTier,
  TriageEscalationTrigger,
  TriageProtocolId,
  TriageProtocolQuestionId,
} from "@wardenx/types";

/**
 * The timestamp columns a transition may stamp — exactly the ones in migration 0107.
 *
 * `opened_at` / `closed_at` belong to `on_call_shift` (M19-T04's §2.2.2 machine); `closed_at` is spelled
 * the same on `triage_call`, and that collision is safe because an effect list is always read against the
 * ONE aggregate whose transition produced it — the call machine never returns a shift effect and vice
 * versa. Splitting the union per aggregate would buy nothing the effect-runner does not already know.
 */
export type TriageTimestampField =
  | "first_response_at"
  | "documented_at"
  | "closed_at"
  | "acknowledged_at"
  | "resolved_at"
  | "reentered_at"
  | "opened_at";

/** One in-transaction side effect a transition declares (§2.4). */
export type TriageSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present — see {@link withAudit}). */
  | { readonly kind: "audit" }
  /**
   * §2.2.1 — append the `triage_call_state_history` row for this transition. Separate from `audit`
   * because the two answer different questions and have different readers: the M4 row is the tamper-
   * evident who/when across every table, while the history row is the CALL's own ordered narrative and
   * is what §2.7 step 3 scans for the outage gap. `systemActor` mirrors the §3.3 CHECK — a transition is
   * either a named person's or explicitly the system's, never unattributed.
   */
  | {
      readonly kind: "state_history";
      readonly from: TriageCallState | null;
      readonly to: TriageCallState;
      readonly systemActor: boolean;
    }
  /** Publish an `m19.*` outbox event in the same tx (§4.10 catalog). */
  | { readonly kind: "outbox"; readonly event: M19EventName }
  /** Raise a §4.9 typed M36 alert. Only the DISCRIMINATOR is declared — the recipient set is resolved by
   *  the service layer from `tenant_oncall_policy.escalation_tiers`, which needs reads a pure machine
   *  cannot do. */
  | { readonly kind: "alert"; readonly alert: OncallAlertPayload["eventType"] }
  /** Stamp one of the aggregate's timestamp columns. */
  | {
      readonly kind: "set_timestamp";
      readonly field: TriageTimestampField;
      readonly at: IsoInstant;
    }
  /** D4 — freeze the protocol + its version onto the call. Written ONCE, at `applyProtocol`; every later
   *  transition reads it and none rewrites it, so a mid-call catalog revision cannot re-key the answers
   *  already recorded. */
  | {
      readonly kind: "pin_protocol";
      readonly protocolId: TriageProtocolId;
      readonly version: string;
      /** D12 — did the clinician accept the M32 suggestion, or override it? The AI-governance audit
       *  channel (§8.6 / architecture §17) reads this; `null` means no suggestion was offered. */
      readonly aiAccepted: boolean | null;
    }
  /** §2.2.3 — append one `triage_call_answer` row. `redFlagHit` is the SERVER's D5 evaluation of the
   *  question's `red_flag_match`, never a client assertion. */
  | {
      readonly kind: "record_answer";
      readonly questionId: TriageProtocolQuestionId;
      readonly redFlagHit: boolean;
      readonly isCorrection: boolean;
    }
  /**
   * D5 / D7 — insert a `triage_escalation` row in the SAME transaction as the event that caused it.
   * `mandatory` marks the D7 rows a call close may not auto-resolve (§2.2.4). `notifyTiers` is the M36
   * fan-out, which is WIDER than the row's own tier: §7.2 dispatches to the medical director AND the
   * on-call supervisor whose shift the call is on. The row records the ladder rung; the fan-out records
   * who was told.
   */
  | {
      readonly kind: "create_escalation";
      readonly tier: TriageEscalationTier;
      readonly triggerKind: TriageEscalationTrigger;
      readonly mandatory: boolean;
      readonly notifyTiers: readonly TriageEscalationTier[];
    }
  /** §2.2.4 — acknowledge / resolve an existing escalation row. */
  | { readonly kind: "acknowledge_escalation"; readonly by: MembershipId }
  | { readonly kind: "resolve_escalation"; readonly by: MembershipId | null }
  /** D6 — write the disposition + its typed payload onto the call. */
  | {
      readonly kind: "set_disposition";
      readonly disposition: TriageDisposition;
      readonly data: TriageDispositionData;
    }
  /** D8 — invoke M8's `EncounterCreator` seam (idempotent on `triage_call_id`, §2.6). Declared, not
   *  called: §2.7's D-B degraded class needs the transition to succeed and the seam call to be retried by
   *  the `encounter-creator.consumer` worker when M8 is unreachable. */
  | { readonly kind: "create_encounter" }
  /** D9 — the `verbal_order_recorded` disposition takes the order through M11's `OrderSignatureProvider`
   *  with M2 step-up (§7.7); M19 stores only the id it gets back. */
  | { readonly kind: "link_verbal_order"; readonly orderRecordId: string }
  /** §2.7 step 3 — close a `triage_paper_reentry_worklist` row against the re-entered call. */
  | { readonly kind: "link_paper_reentry_worklist"; readonly worklistId: string }
  /**
   * D7 / §2.2.2 (M19-T04) — pin `on_call_shift.policy_snapshot` to the `tenant_oncall_policy` row as it
   * stands at the `scheduled → active` transition, so a later policy edit cannot retroactively change
   * what escalation ladder was in effect during a past night.
   *
   * The snapshot is carried as an opaque value rather than a typed policy shape: the column is `jsonb` and
   * its whole purpose is to preserve the policy row VERBATIM, including any field a future migration adds.
   * Narrowing it to today's fields here would silently drop tomorrow's from the survey record.
   */
  | { readonly kind: "pin_policy_snapshot"; readonly snapshot: unknown };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface TriageTransitionResult<S extends string, C extends string> {
  readonly from: S;
  readonly command: C;
  readonly to: S;
  readonly effects: ReadonlyArray<TriageSideEffect>;
}

/** Build a {@link TriageTransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, C extends string>(
  from: S,
  command: C,
  to: S,
  effects: ReadonlyArray<TriageSideEffect>,
): TriageTransitionResult<S, C> {
  return { from, command, to, effects };
}

/** The §2.4 invariant: every M19 mutation writes an M4 audit row. Every machine builds its effect list
 *  through this helper so "we forgot the audit row on the rare edge" cannot happen. */
export function withAudit(
  effects: ReadonlyArray<TriageSideEffect>,
): ReadonlyArray<TriageSideEffect> {
  return [{ kind: "audit" }, ...effects];
}

/** §2.2.1 — the call-state transitions additionally append the history row. Ordered audit → history →
 *  the transition's own effects so a reader of the effect list sees the two invariants first. */
export function withAuditAndHistory(
  from: TriageCallState | null,
  to: TriageCallState,
  systemActor: boolean,
  effects: ReadonlyArray<TriageSideEffect>,
): ReadonlyArray<TriageSideEffect> {
  return [{ kind: "audit" }, { kind: "state_history", from, to, systemActor }, ...effects];
}
