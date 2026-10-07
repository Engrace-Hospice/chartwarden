import type { M16EventName } from "@wardenx/types";
// apps/backend/src/modules/16-bereavement/routes/effects-runner.ts — M16-T06 (§2.6).
//
// The executor for the DECLARATIVE side-effect lists the §2.2–§2.4 machines return. M16-T03 deliberately
// made every transition hand back its effects as DATA (`{kind:'outbox', event}`, `{kind:'insert_closure'}`,
// …) so the machines stay pure and unit-testable with no DB; this is the one place that turns them into
// writes, and it runs INSIDE the caller's transaction. That is what makes "the plan closed but
// `plan_closed_completed` never went out" structurally impossible rather than merely reviewed-for.
//
// Three rules the runner enforces so an effect cannot be quietly lost:
//
//   1. An `outbox` effect with NO payload supplied is a THROW, not a skip. A machine that declares an event
//      the service forgot to build a payload for is a bug, and swallowing it would ship a lifecycle whose
//      consumers silently never hear about one transition.
//   2. `audit` is a no-op HERE and that is correct: the M4 write-audit triggers (migration 0102) record
//      every mutation with the per-table §8.1 denylist, so a hand-written audit row would be a second,
//      divergent account of the same write.
//   3. `alert` is BEST-EFFORT and outside the failure path. M36 owns delivery, retry and DLQ; a bereavement
//      touchpoint must not roll back because a notification channel is down. Everything else — the row
//      writes and the outbox — is inside the transaction and fails it.
//
// Effects the runner deliberately does NOT execute are listed at {@link UNHANDLED_EFFECT_KINDS} with the
// reason, so "it silently did nothing" is never the explanation for a missing write.
import type { BereavementSideEffect, M16ErrorCode } from "../lifecycle/index";
import type { AlertPort, OutboxEmission, WriteOutboxPort } from "./write-service";

/** The column patch a transition's `set_*` effects accumulate, applied by the caller in one UPDATE. */
export interface EffectPatch {
  openedAt?: Date;
  pausedAt?: Date;
  closedAt?: Date;
  confirmedAt?: Date;
  optedOutAt?: Date;
  unreachableAt?: Date;
  deceasedAt?: Date;
  ineligibleAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  assignedCounselorUserId?: string;
  assignedCounselorAssignedAt?: Date;
  assignedVolunteerUserId?: string;
  assignedVolunteerAssignedAt?: Date;
  externalSourceMetadata?: unknown;
}

/** `set_timestamp.field` (a §3.3 column name) → the patch key it writes. */
const TIMESTAMP_FIELDS: Readonly<Record<string, keyof EffectPatch>> = {
  opened_at: "openedAt",
  paused_at: "pausedAt",
  closed_at: "closedAt",
  confirmed_at: "confirmedAt",
  opted_out_at: "optedOutAt",
  unreachable_at: "unreachableAt",
  deceased_at: "deceasedAt",
  ineligible_at: "ineligibleAt",
  started_at: "startedAt",
  completed_at: "completedAt",
  cancelled_at: "cancelledAt",
};

/**
 * The effect kinds the runner does not execute, and why. Each is handled by the calling service because it
 * needs reads the runner has no business doing (a roster, a cadence, a cross-module seam):
 *
 *   • `generate_schedule` / `regenerate_schedule` — need the per-contact tier + preferences + the tenant
 *     cadence, and produce many rows whose ids the caller must return.
 *   • `seed_anniversary_reminders` — needs the plan's death date to resolve each mark's target date.
 *   • `cancel_future_outreach` — needs the scope's contact set; the caller already holds it.
 *   • `recompute_risk` — is an entire cross-module evidence gather (§4.3.4) with its own fail-SOFT posture.
 *   • `insert_closure` / `insert_opt_out` / `rescind_opt_out` / `log_external_referral` — carry columns
 *     (narratives, counts, the acting membership) the effect descriptor deliberately does not include,
 *     because putting free-text PHI in a machine's return value would put it in every unit test's snapshot.
 */
export const UNHANDLED_EFFECT_KINDS = [
  "generate_schedule",
  "regenerate_schedule",
  "seed_anniversary_reminders",
  "cancel_future_outreach",
  "recompute_risk",
  "insert_closure",
  "insert_opt_out",
  "rescind_opt_out",
  "log_external_referral",
] as const satisfies readonly BereavementSideEffect["kind"][];

/** What the runner needs to turn declared effects into writes. */
export interface EffectContext {
  readonly organizationId: string;
  readonly at: Date;
  readonly outbox: WriteOutboxPort;
  readonly alerts?: AlertPort;
  /** Aggregate identity for the outbox envelope (`bereavement_plan` + the plan id, unless overridden). */
  readonly aggregateKind: string;
  readonly aggregateId: string;
  /** One payload per `outbox` effect the transition declared. A missing entry throws (rule 1). */
  readonly payloads: Partial<Record<M16EventName, Record<string, unknown>>>;
  /** One payload per `alert` effect. A missing entry SKIPS — an alert is advisory, an event is a contract. */
  readonly alertPayloads?: Partial<Record<string, Record<string, unknown>>>;
}

/** A programming error: a machine declared an event the service built no payload for. */
export class MissingOutboxPayloadError extends Error {
  readonly code: M16ErrorCode | "MISSING_OUTBOX_PAYLOAD" = "MISSING_OUTBOX_PAYLOAD";
  constructor(eventName: string) {
    super(`m16: no outbox payload was supplied for the declared event '${eventName}'`);
    this.name = "MissingOutboxPayloadError";
  }
}

/**
 * Execute the mechanical half of a transition's effect list inside the caller's transaction, returning the
 * accumulated column patch the caller applies with its own optimistic-concurrency UPDATE.
 */
export async function runEffects(
  tx: unknown,
  effects: readonly BereavementSideEffect[],
  ctx: EffectContext,
): Promise<EffectPatch> {
  const patch: EffectPatch = {};

  for (const effect of effects) {
    switch (effect.kind) {
      case "audit":
        break; // rule 2 — the M4 trigger owns the audit row
      case "outbox": {
        const payload = ctx.payloads[effect.event];
        if (payload === undefined) throw new MissingOutboxPayloadError(effect.event);
        const emission: OutboxEmission = {
          // F-105 — the tenant. It was already on the context one case arm below (`alert` passes
          // `ctx.organizationId`), and simply never reached the outbox row: every `m16.*` emission
          // wrote NULL, RLS refused it, and the transition it announced rolled back with it.
          organizationId: ctx.organizationId,
          eventName: effect.event,
          payload,
          aggregateKind: ctx.aggregateKind,
          aggregateId: ctx.aggregateId,
        };
        await ctx.outbox.publish(tx, emission);
        break;
      }
      case "alert": {
        const payload = ctx.alertPayloads?.[effect.alert];
        if (payload === undefined || ctx.alerts === undefined) break;
        // rule 3 — best effort, outside the failure path.
        await ctx.alerts
          .emit({ organizationId: ctx.organizationId, kind: effect.alert, payload })
          .catch(() => undefined);
        break;
      }
      case "set_timestamp": {
        const key = TIMESTAMP_FIELDS[effect.field];
        if (key !== undefined) {
          (patch as Record<string, unknown>)[key] = new Date(effect.at);
        }
        break;
      }
      case "set_assignment": {
        if (effect.role === "counselor") {
          patch.assignedCounselorUserId = effect.membershipId;
          patch.assignedCounselorAssignedAt = new Date(effect.at);
        } else {
          patch.assignedVolunteerUserId = effect.membershipId;
          patch.assignedVolunteerAssignedAt = new Date(effect.at);
        }
        break;
      }
      case "set_external_source_metadata":
        patch.externalSourceMetadata = effect.metadata;
        break;
      default:
        break; // the {@link UNHANDLED_EFFECT_KINDS} set — executed by the calling service
    }
  }

  return patch;
}
