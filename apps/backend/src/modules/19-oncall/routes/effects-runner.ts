// apps/backend/src/modules/19-oncall/routes/effects-runner.ts — M19-T07 (§2.4).
//
// The executor for the DECLARATIVE side-effect lists the §2.2-§2.7 machines return. M19-T03/T04 made every
// transition hand its effects back as DATA (`{kind:'outbox', event}`, `{kind:'pin_protocol', …}`) so the
// machines stay pure and unit-testable with no DB; this is the one place that turns them into writes, and
// it runs INSIDE the caller's transaction. That is what makes "the call was dispositioned but
// `m19.triage_call.visit_needed` never went out" structurally impossible rather than merely reviewed-for.
//
// FIVE RULES SO AN EFFECT CANNOT BE QUIETLY LOST:
//
//   1. An `outbox` effect with NO payload supplied is a THROW, not a skip. A machine that declares an event
//      the service forgot to build a payload for is a bug, and swallowing it would ship a lifecycle whose
//      consumers never hear about one transition — M17 would never receive the dispatch request behind
//      `visit_dispatched_now`, and M16's bereavement timeline would never start.
//   2. An UNKNOWN `set_timestamp.field` is a THROW. This is the M21-T03 lesson written into code: a pure
//      machine's `set_timestamp` effect type-checks against nothing, so an effect naming a column the
//      schema does not have compiles clean and passes every gate while writing nothing. The map below is
//      closed and the `satisfies` pins it to real patch keys.
//   3. `audit` is a NO-OP here, and that is correct: the M4 write-audit triggers (migration 0108) record
//      every mutation with the per-table §3.6 denylist, so a hand-written audit row would be a second,
//      divergent account of the same write.
//   4. `alert` is BEST-EFFORT and outside the failure path (see `AlertPort`'s doc-comment). Everything
//      else — the row writes, the child-row inserts and the outbox — is inside the transaction and fails it.
//   5. AN EFFECT KIND THE RUNNER DOES NOT KNOW IS A THROW. Same argument as rule 2: silence here is a write
//      that never happened, discovered in production. The kinds the runner deliberately does not execute
//      are listed at {@link CALLER_OWNED_EFFECT_KINDS} with the reason.
//
// THE STATE-HISTORY ROW IS THE RUNNER'S, AND THAT IS DELIBERATE. `state_history` is the only effect that
// writes a CHILD row here rather than being handed back to the caller, because §3.3's
// `m19_triage_call_state_history_actor` CHECK ("either a named person's or explicitly the system's") is an
// invariant of the TRANSITION, not of the command — putting it in the caller would mean nine call sites
// each had to remember it, and the one that forgot would be the 2 a.m. path.
import type { M19EventName } from "@wardenx/types";
import type { TriageSideEffect } from "../lifecycle/effects";
import type { AlertPort, OutboxEmission, WriteOutboxPort } from "./write-service";

/** The column patch a transition's mechanical effects accumulate, applied by the caller in one UPDATE. */
export interface EffectPatch {
  // triage_call
  firstResponseAt?: Date;
  documentedAt?: Date;
  closedAt?: Date;
  reenteredAt?: Date;
  selectedProtocolId?: string;
  selectedProtocolVersion?: string;
  disposition?: string;
  dispositionData?: unknown;
  linkedVerbalOrderIds?: unknown;
  // triage_escalation
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  resolvedByMembershipId?: string | null;
  // on_call_shift
  openedAt?: Date;
  policySnapshot?: unknown;
}

/**
 * `set_timestamp.field` (a §3.3 column name) → the patch key it writes. CLOSED (rule 2): every field any
 * machine emits appears here, and anything else throws. The `satisfies` pins the VALUES to
 * {@link EffectPatch} keys, so renaming a patch field breaks this map at compile time — the half of the
 * M21-T03 gotcha a runtime check cannot catch.
 *
 * `closed_at` and `opened_at` are spelled the same on `triage_call` and `on_call_shift`; the collision is
 * safe because an effect list is always read against the ONE aggregate whose transition produced it (the
 * `TriageTimestampField` doc-comment makes the same argument).
 */
const TIMESTAMP_FIELDS = {
  first_response_at: "firstResponseAt",
  documented_at: "documentedAt",
  closed_at: "closedAt",
  acknowledged_at: "acknowledgedAt",
  resolved_at: "resolvedAt",
  reentered_at: "reenteredAt",
  opened_at: "openedAt",
} as const satisfies Readonly<Record<string, keyof EffectPatch>>;

/** Rule 2 / rule 5 — a machine named something the runner (and therefore the schema) does not know. */
export class UnknownTriageEffectError extends Error {
  readonly code = "M19_UNKNOWN_EFFECT";
  constructor(what: string) {
    super(
      `m19: a transition declared '${what}', which the effects runner does not know how to write`,
    );
    this.name = "UnknownTriageEffectError";
  }
}

/** Rule 1 — a machine declared an event the service built no payload for. */
export class MissingOutboxPayloadError extends Error {
  readonly code = "M19_MISSING_OUTBOX_PAYLOAD";
  constructor(eventName: string) {
    super(`m19: no outbox payload was supplied for the declared event '${eventName}'`);
    this.name = "MissingOutboxPayloadError";
  }
}

/**
 * The effect kinds the runner does not execute, and why. Each needs reads or child-row writes the runner
 * has no business doing:
 *
 *   • `record_answer` — the answer row carries the TYPED VALUE (`answer_value_text` / `_int` / `_bool`),
 *     which the effect descriptor deliberately does not repeat: putting a caller's answer text in a pure
 *     machine's return value would put §3.6-denylisted PHI in every unit-test snapshot.
 *   • `create_escalation` — needs the call's tenancy anchor and the tier→recipient resolution off
 *     `tenant_oncall_policy.escalation_tiers`, neither of which a pure machine can read.
 *   • `create_encounter` — D8's seam call. Declared, not called: §2.7's class D-B needs the transition to
 *     COMMIT and the seam call to be retried by the `encounter-creator.consumer` when M8 is unreachable.
 *   • `link_verbal_order` / `link_paper_reentry_worklist` — each writes a second aggregate's row
 *     (`triage_call.linked_verbal_order_ids` append; the worklist's `reentered_at`/`linked_triage_call_id`
 *     pair, which §3.3's CHECK requires to move together).
 *   • `pin_policy_snapshot` — the caller holds the `tenant_oncall_policy` row it is copying, and the
 *     snapshot must be the row VERBATIM (D7), not a projection the runner chose.
 */
export const CALLER_OWNED_EFFECT_KINDS = [
  "record_answer",
  "create_escalation",
  "create_encounter",
  "link_verbal_order",
  "link_paper_reentry_worklist",
  "pin_policy_snapshot",
] as const satisfies readonly TriageSideEffect["kind"][];

const CALLER_OWNED = new Set<string>(CALLER_OWNED_EFFECT_KINDS);

/** The `triage_call_state_history` row a `state_history` effect writes (rule: the runner owns it). */
export interface StateHistoryInsert {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly triageCallId: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly transitionedAt: Date;
  readonly actorMembershipId: string | null;
  readonly systemActor: boolean;
  readonly commandPayloadDigest: string | null;
}

/** The child-row writer the runner delegates its ONE insert to (Drizzle in prod; a spy in tests). */
export interface StateHistoryPort {
  insert(tx: unknown, row: StateHistoryInsert): Promise<void>;
}

/** What the runner needs to turn declared effects into writes. */
export interface EffectContext {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly triageCallId: string;
  readonly at: Date;
  /** The acting membership, or null for a system transition (§3.3's attribution CHECK). */
  readonly actorMembershipId: string | null;
  /** §8.3.3 — a hash of the command payload; the cleartext is never stored on the history row. */
  readonly commandPayloadDigest: string | null;
  readonly outbox: WriteOutboxPort;
  readonly alerts?: AlertPort;
  readonly stateHistory?: StateHistoryPort;
  /** Aggregate identity for the outbox envelope. */
  readonly aggregateKind: string;
  readonly aggregateId: string;
  /** One payload per `outbox` effect the transition declared. A missing entry throws (rule 1). */
  readonly payloads: Partial<Record<M19EventName, Record<string, unknown>>>;
  /** One payload per `alert` effect. A missing entry SKIPS — an alert is advisory, an event is a contract. */
  readonly alertPayloads?: Partial<Record<string, Record<string, unknown>>>;
}

/**
 * Execute the mechanical half of a transition's effect list inside the caller's transaction, returning the
 * accumulated column patch the caller applies with its own optimistic-concurrency UPDATE.
 */
export async function runEffects(
  tx: unknown,
  effects: readonly TriageSideEffect[],
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

      case "state_history": {
        if (!ctx.stateHistory) break;
        await ctx.stateHistory.insert(tx, {
          organizationId: ctx.organizationId,
          providerEntityId: ctx.providerEntityId,
          locationId: ctx.locationId,
          triageCallId: ctx.triageCallId,
          fromState: effect.from,
          toState: effect.to,
          transitionedAt: ctx.at,
          // §3.3's CHECK: a system transition has NO membership, and a human one must have one. Taking
          // the flag from the EFFECT (not from whether an actor happens to be present) is what keeps a
          // route-driven transition from silently recording itself as the system's.
          actorMembershipId: effect.systemActor ? null : ctx.actorMembershipId,
          systemActor: effect.systemActor,
          commandPayloadDigest: ctx.commandPayloadDigest,
        });
        break;
      }

      case "outbox": {
        const payload = ctx.payloads[effect.event];
        if (payload === undefined) throw new MissingOutboxPayloadError(effect.event); // rule 1
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
        if (key === undefined) throw new UnknownTriageEffectError(`set_timestamp('${effect.field}')`);
        set(key, new Date(effect.at));
        break;
      }

      case "pin_protocol": {
        // D4 — written ONCE, at `applyProtocol`. Id and version move together so the frozen pin and the
        // queryable column can never disagree about which revision the caller was walked through.
        set("selectedProtocolId", effect.protocolId);
        set("selectedProtocolVersion", effect.version);
        break;
      }

      case "set_disposition": {
        set("disposition", effect.disposition);
        set("dispositionData", effect.data);
        break;
      }

      case "acknowledge_escalation":
        // The timestamp rides its own `set_timestamp` effect; this records WHO. There is no
        // `acknowledged_by_membership_id` column on `triage_escalation` (§3.3) — the acknowledging actor
        // is captured by the M4 audit row, which is where §8.3.3 puts attribution for this write.
        break;

      case "resolve_escalation":
        set("resolvedByMembershipId", effect.by);
        break;

      default:
        if (!CALLER_OWNED.has(effect.kind)) throw new UnknownTriageEffectError(effect.kind); // rule 5
        break;
    }
  }

  return patch;
}
