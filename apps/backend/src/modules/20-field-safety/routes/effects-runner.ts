// apps/backend/src/modules/20-field-safety/routes/effects-runner.ts — M20-T06 (§2.4).
//
// The executor for the DECLARATIVE side-effect lists the §2.2 machines return. M20-T03 made every
// transition hand its effects back as DATA (`{kind:'outbox', event}`, `{kind:'set_cancel_status', …}`) so
// the machines stay pure and unit-testable with no DB; this is the one place that turns them into writes,
// and it runs INSIDE the caller's transaction. That is what makes "the SOS escalated but nobody was paged"
// structurally impossible rather than merely reviewed-for (§2.4).
//
// FIVE RULES SO AN EFFECT CANNOT BE QUIETLY LOST:
//
//   1. An `outbox` effect with NO payload supplied is a THROW, not a skip. A machine that declares an event
//      the service forgot to build a payload for is a bug, and swallowing it would ship a lifecycle whose
//      consumers never hear about one transition — M17 would never receive the visit-cancellation request
//      behind a `visit_cancelled` outcome, and M22 would never render the incident report.
//   2. An UNKNOWN `set_timestamp.field` is a THROW. This is the M21-T03 lesson written into code: a pure
//      machine's `set_timestamp` effect type-checks against nothing, so an effect naming a column the
//      schema does not have compiles clean and passes every gate while writing nothing. The map below is
//      closed and the `satisfies` pins it to real patch keys.
//   3. `audit` is a NO-OP here, and that is correct: the M4 write-audit triggers (migration 0111) record
//      every mutation with the per-table §3.6 denylist, so a hand-written audit row would be a second,
//      divergent account of the same write.
//   4. `alert` is BEST-EFFORT and outside the failure path. M36 owns delivery, retry and DLQ, and an SOS
//      must not roll back because an SMS gateway is down — §2.7's degraded path (the tenant's own
//      emergency number, M20-F01) is the designed answer to that outage, not a failed write. Everything
//      else — the row writes, the child-row inserts and the outbox — is inside the transaction.
//   5. AN EFFECT KIND THE RUNNER DOES NOT KNOW IS A THROW. Same argument as rule 2: silence here is a write
//      that never happened, discovered in production. The kinds the runner deliberately does not execute
//      are listed at {@link CALLER_OWNED_EFFECT_KINDS} with the reason for each.
//
// THE STATE-HISTORY ROW IS THE RUNNER'S, AND THAT IS DELIBERATE. `sos_state_history` is the only effect
// that writes a CHILD row here rather than being handed back to the caller, because §3.3's `systemActor`
// rule ("a watchdog tier advance carries NO `transitioned_by_membership_id`") is an invariant of the
// TRANSITION, not of the command — putting it in the caller would mean eight call sites each had to
// remember it, and the one that forgot would be the 3 a.m. path.
//
// A TRANSITION THAT DOES NOT MOVE THE STATE EMITS NO HISTORY EFFECT AT ALL, and the runner does not
// second-guess that: §3.3's `m20_ssash_no_self` CHECK refuses `from_state = to_state`, so the terminus
// re-page loop and a rejected cancel each build their effect list with `withAudit` instead of
// `withSosHistory` (../lifecycle/effects.ts). A runner that "helpfully" wrote a row for them would die on
// a constraint at exactly the moment nobody is answering.
import type { M20EventName } from "@chartwarden/types";
import type { SafetySideEffect } from "../lifecycle/effects";
import type { AlertPort, OutboxEmission, WriteOutboxPort } from "./write-service";

/** The column patch a transition's mechanical effects accumulate, applied by the caller in one UPDATE. */
export interface EffectPatch {
  // safety_sos_alert
  cancelAttemptedAt?: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  cancelStatus?: string;
  cancelBiometricResult?: string;
  outcome?: string;
  acknowledgedByMembershipId?: string;
  resolvedByMembershipId?: string;
  linkedIncidentId?: string;
  lifecycleState?: string;
  // safety_check_in_schedule
  state?: string;
  overdueDetectedAt?: Date;
  escalatedAt?: Date;
}

/**
 * `set_timestamp.field` (a §3.3 column name) → the patch key it writes. CLOSED (rule 2): every field any
 * machine emits appears here, and anything else throws. The `satisfies` pins the VALUES to
 * {@link EffectPatch} keys, so renaming a patch field breaks this map at compile time — the half of the
 * M21-T03 gotcha a runtime check cannot catch.
 *
 * The five entries are exactly `SafetyTimestampField` (../lifecycle/effects.ts). `posted_at`,
 * `expected_at` and `cancel_window_expired_at` are absent from BOTH, for the reason that type states: all
 * three are written once at insert, and a later transition able to re-stamp `cancel_window_expired_at`
 * could reopen a closed cancel window (D5).
 */
const TIMESTAMP_FIELDS = {
  cancel_attempted_at: "cancelAttemptedAt",
  acknowledged_at: "acknowledgedAt",
  resolved_at: "resolvedAt",
  overdue_detected_at: "overdueDetectedAt",
  escalated_at: "escalatedAt",
} as const satisfies Readonly<Record<string, keyof EffectPatch>>;

/** Rule 2 / rule 5 — a machine named something the runner (and therefore the schema) does not know. */
export class UnknownSafetyEffectError extends Error {
  readonly code = "M20_UNKNOWN_EFFECT";
  constructor(what: string) {
    super(
      `m20: a transition declared '${what}', which the effects runner does not know how to write`,
    );
    this.name = "UnknownSafetyEffectError";
  }
}

/** Rule 1 — a machine declared an event the service built no payload for. */
export class MissingSafetyOutboxPayloadError extends Error {
  readonly code = "M20_MISSING_OUTBOX_PAYLOAD";
  constructor(eventName: string) {
    super(`m20: no outbox payload was supplied for the declared event '${eventName}'`);
    this.name = "MissingSafetyOutboxPayloadError";
  }
}

/**
 * The effect kinds the runner does not execute, and why. Each needs a read, a seam call or a second
 * aggregate's row that the runner has no business doing:
 *
 *   • `request_visit_cancellation` — M20 never writes an M17 row; the §4.10
 *     `visit_cancellation_requested` event IS the request, and its payload needs the visit id plus the
 *     alert's tenancy anchor. The caller builds the payload and the `outbox` effect beside it carries it.
 *   • `dial_emergency_contact` — §2.2.2 (a). Needs the M20-F06 consent row read (`seams/emergency-contact`)
 *     and a voice-channel dispatch, neither of which belongs inside the aggregate's transaction: a
 *     telephony round-trip holding a pooled connection is the M21-T05 finding, and the dial must survive a
 *     rolled-back write rather than be undone by one.
 *   • `surface_psap_number` — §2.2.2 (b). The number is fetched by the RESPONDER's client from M40 against
 *     the jurisdiction id; it never enters an outbox or audit payload (§8.8.2), so there is nothing here
 *     to write. The `sos_terminus_reached` payload's `psapJurisdictionId` is the caller's to resolve.
 *   • `page_wardenx_ops` — §2.2.2 (c) / INT-031. A PLATFORM page, out of band from the tenant's alert
 *     fan-out and outside the tenant transaction entirely.
 */
export const CALLER_OWNED_EFFECT_KINDS = [
  "request_visit_cancellation",
  "dial_emergency_contact",
  "surface_psap_number",
  "page_wardenx_ops",
] as const satisfies readonly SafetySideEffect["kind"][];

const CALLER_OWNED = new Set<string>(CALLER_OWNED_EFFECT_KINDS);

/** The `safety_sos_alert_state_history` row a `sos_state_history` effect writes. */
export interface SosStateHistoryInsert {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly sosAlertId: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly transitionedAt: Date;
  /** NULL when the watchdog moved it — §3.3's own note: inventing an actor would make the ledger claim a
   *  supervisor acted when nobody did. */
  readonly transitionedByMembershipId: string | null;
  readonly reason: string | null;
}

/** The child-row writer the runner delegates its ONE insert to (Drizzle in prod; a spy in tests). */
export interface SosStateHistoryPort {
  insert(tx: unknown, row: SosStateHistoryInsert): Promise<void>;
}

/** What the runner needs to turn declared effects into writes. */
export interface EffectContext {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  /** The SOS alert the history row hangs off. Empty on a check-in-schedule transition (which has none). */
  readonly sosAlertId: string;
  readonly at: Date;
  /** The acting membership, or null for a system transition (§3.3's attribution rule). */
  readonly actorMembershipId: string | null;
  /** §3.6-denylisted free text for the history row (a cancel reason, a manual-escalate reason). */
  readonly reason: string | null;
  readonly outbox: WriteOutboxPort;
  readonly alerts?: AlertPort;
  readonly stateHistory?: SosStateHistoryPort;
  /** Aggregate identity for the outbox envelope. */
  readonly aggregateKind: string;
  readonly aggregateId: string;
  /** One payload per `outbox` effect the transition declared. A missing entry throws (rule 1). */
  readonly payloads: Partial<Record<M20EventName, Record<string, unknown>>>;
  /** One payload per `alert` effect. A missing entry SKIPS — an alert is advisory, an event is a contract. */
  readonly alertPayloads?: Partial<Record<string, Record<string, unknown>>>;
}

/**
 * Execute the mechanical half of a transition's effect list inside the caller's transaction, returning the
 * accumulated column patch the caller applies with its own optimistic-concurrency UPDATE.
 */
export async function runEffects(
  tx: unknown,
  effects: readonly SafetySideEffect[],
  ctx: EffectContext,
): Promise<EffectPatch> {
  const patch: EffectPatch = {};
  const set = (key: keyof EffectPatch, value: unknown): void => {
    (patch as Record<string, unknown>)[key] = value;
  };

  for (const effect of effects) {
    switch (effect.kind) {
      case "audit":
        break; // rule 3 — the M4 trigger owns the audit row

      case "sos_state_history": {
        if (!ctx.stateHistory) break;
        await ctx.stateHistory.insert(tx, {
          organizationId: ctx.organizationId,
          providerEntityId: ctx.providerEntityId,
          locationId: ctx.locationId,
          sosAlertId: ctx.sosAlertId,
          fromState: effect.from,
          toState: effect.to,
          transitionedAt: ctx.at,
          // Taking the flag from the EFFECT (not from whether an actor happens to be present) is what
          // keeps a route-driven transition from silently recording itself as the system's, and a cron's
          // from claiming the supervisor who happened to be logged in.
          transitionedByMembershipId: effect.systemActor ? null : ctx.actorMembershipId,
          reason: ctx.reason,
        });
        // §2.2.2 — the history row and the aggregate's own column are one fact; writing the first without
        // the second is how a ledger and a row start to disagree about what state an alert is in.
        set("lifecycleState", effect.to);
        break;
      }

      case "outbox": {
        const payload = ctx.payloads[effect.event];
        if (payload === undefined) throw new MissingSafetyOutboxPayloadError(effect.event); // rule 1
        const emission: OutboxEmission = {
          eventName: effect.event,
          payload,
          organizationId: ctx.organizationId,
          aggregateKind: ctx.aggregateKind,
          aggregateId: ctx.aggregateId,
        };
        await ctx.outbox.publish(tx, emission);
        break;
      }

      case "alert": {
        const payload = ctx.alertPayloads?.[effect.alert];
        if (payload === undefined || ctx.alerts === undefined) break;
        await ctx.alerts // rule 4 — best effort, outside the failure path
          .emit({ organizationId: ctx.organizationId, kind: effect.alert, payload })
          .catch(() => undefined);
        break;
      }

      case "set_timestamp": {
        const key = (TIMESTAMP_FIELDS as Record<string, keyof EffectPatch | undefined>)[
          effect.field
        ];
        if (key === undefined)
          throw new UnknownSafetyEffectError(`set_timestamp('${effect.field}')`);
        set(key, new Date(effect.at));
        break;
      }

      case "set_cancel_status": {
        // D5 — the triple moves together. §3.3's `m20_ssa_cancel_attempt` CHECK requires exactly that, so
        // the three writes are ONE effect and one branch: a runner cannot write the status and forget the
        // verdict.
        set("cancelStatus", effect.status);
        set("cancelBiometricResult", effect.biometricResult);
        set("cancelAttemptedAt", new Date(effect.attemptedAt));
        break;
      }

      case "set_sos_outcome":
        set("outcome", effect.outcome);
        break;

      case "set_actor":
        set(
          effect.field === "acknowledged_by_membership_id"
            ? "acknowledgedByMembershipId"
            : "resolvedByMembershipId",
          effect.membershipId,
        );
        break;

      case "link_incident":
        set("linkedIncidentId", effect.incidentId);
        break;

      case "set_schedule_state":
        set("state", effect.state);
        break;

      default:
        if (!CALLER_OWNED.has(effect.kind)) throw new UnknownSafetyEffectError(effect.kind); // rule 5
        break;
    }
  }

  return patch;
}
