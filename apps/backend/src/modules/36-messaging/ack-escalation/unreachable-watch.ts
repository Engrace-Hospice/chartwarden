// apps/backend/src/modules/36-messaging/ack-escalation/unreachable-watch.ts - ADR-0079 (G-5): a `failed_unreachable` request is no longer
// watched by the deadline timer (nothing can escalate it: the database guard allows no failed_unreachable -> escalated, and every
// route to its assignee has just failed). Left alone it would be loud once, at the moment it failed, and silent after. This watch,
// run by the per-minute `messaging.ack_escalation_sweep`, keeps it in front of the supervisors on a BOUNDED, backed-off schedule:
// at most EIGHT reminders (the unroutable cap) over about 103 hours, at the unroutable spacing (windows 1, 2, 4, 8, 16, 24, 24, 24 h; stages
// open at 0, 1, 3, 7, 15, 31, 55, 79 h after the ANCHOR). The anchor is the later of the deadline and the instant the request became
// `failed_unreachable`; when it failed after its deadline, stage 0 is skipped because the failed_unreachable attention alert has just
// fired (no second page at the same moment). It writes nothing to the request and sends nothing to the assignee's failing transport; a
// human moves the request (supervisor reassign, ADR-0078) and the reassign resets it to `pending`, which the timer watches again.
//
// Effect order per stage (a crash between any two steps must not lose the stage): the supervisor alert is EMITTED every time the stage
// has not been emitted by this process (idempotent on its correlation id, so a second worker or a retry converges on one alert row); the
// ops notice and the unpaged notice are each gated by their OWN Valkey claim (once per stage per fleet while Valkey is up; per process
// otherwise), so a failing alert can neither lose the stage nor repeat a webhook notice every minute. The schedule is derived from the
// clock, not stored, so a missed stage (sweep down) is skipped, never replayed late.
import {
  ESCALATION_SWEEP_BATCH,
  UNROUTED_MAX_RECORDS,
  unroutedBackoffMs,
} from "@wardenx/messaging";
import type { OpsNoticeClaims } from "../../../bootstrap/ops-notice-claims";
import type { AckStore } from "../ack-requests/ack-types";
import {
  type SupervisorAttentionDeps,
  UNWATCHED_OPS_KIND,
  raiseSupervisorAttention,
} from "./supervisor-attention";

export interface UnwatchedStage {
  /** 0-based reminder number; the alert id and the claims are per stage. */
  readonly stage: number;
  /** How long this stage lasts (the notice claims' lifetime): the next one starts when it ends. */
  readonly windowMs: number;
}

/** The stage windows in order (1, 2, 4, 8, 16, 24, 24, 24 h: `unroutedBackoffMs` caps at 24 h) and the length of the whole schedule. */
export const UNWATCHED_WINDOWS_MS: readonly number[] = Array.from(
  { length: UNROUTED_MAX_RECORDS },
  (_, i) => unroutedBackoffMs(i + 1),
);
export const UNWATCHED_TOTAL_MS: number = UNWATCHED_WINDOWS_MS.reduce((a, b) => a + b, 0);

/**
 * Which reminder is due `overdueMs` after the anchor, or null before it and after the last stage. Stage k opens at the sum of the
 * first k windows (0, 1, 3, 7, 15, 31, 55, 79 h) and lasts the k-th window; there are UNROUTED_MAX_RECORDS stages and then no more (the
 * request stays on the queue and the gauges). `skipFirst`: the failure itself just raised the attention alert, so stage 0 is not raised.
 */
export function unwatchedStage(overdueMs: number, skipFirst = false): UnwatchedStage | null {
  if (!(overdueMs >= 0)) return null;
  let opensAt = 0;
  for (let stage = 0; stage < UNWATCHED_WINDOWS_MS.length; stage += 1) {
    const windowMs = UNWATCHED_WINDOWS_MS[stage] as number;
    if (overdueMs < opensAt + windowMs)
      return stage === 0 && skipFirst ? null : { stage, windowMs };
    opensAt += windowMs;
  }
  return null;
}

export interface UnreachableWatchDeps {
  readonly store: AckStore;
  /** `messaging.escalation_timers`: the same ops flag as the timer; off = the request is left exactly as it is. A throw propagates. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly claims: OpsNoticeClaims;
  readonly attention: SupervisorAttentionDeps;
  readonly now?: () => Date;
  readonly onError?: (
    context: { organizationId: string; requestId: string },
    error: unknown,
  ) => void;
}

export interface UnreachableWatchSummary {
  readonly raised: number;
  readonly failed: number;
}

export interface UnreachableWatch {
  watch(orgId: string): Promise<UnreachableWatchSummary>;
}

/** Process-local memory of stages whose alert this process has emitted successfully (bounded; a restart simply re-emits idempotently). */
const EMITTED_CAP = 5000;

export function createUnreachableWatch(deps: UnreachableWatchDeps): UnreachableWatch {
  const now = deps.now ?? (() => new Date());
  const emitted = new Set<string>();
  return {
    async watch(orgId) {
      if (!(await deps.isEnabled(orgId))) return { raised: 0, failed: 0 };
      const at = now();
      const rows = await deps.store.readAsSystem(orgId, (tx) =>
        tx.listUnreachableOverdue(
          at,
          ESCALATION_SWEEP_BATCH,
          new Date(at.getTime() - UNWATCHED_TOTAL_MS),
        ),
      );
      let raised = 0;
      let failed = 0;
      for (const row of rows) {
        const failedAt = row.updatedAt && row.updatedAt > row.deadlineAt ? row.updatedAt : null;
        const anchor = failedAt ?? row.deadlineAt;
        const due = unwatchedStage(at.getTime() - anchor.getTime(), failedAt !== null);
        if (!due) continue; // no stage: no alert, no Valkey call
        // The version bumps on every write, so a request that was reassigned and failed again starts a new schedule.
        const correlationId = `ack-unwatched:${row.id}:${row.version}:${due.stage}`;
        if (emitted.has(correlationId)) continue; // this process already finished the stage: no alert, no Valkey call
        try {
          if (await deps.claims.claim(`notice:${correlationId}`, due.windowMs)) {
            // The notice before the alert: a failing alert must not lose it.
            deps.attention.opsNotice({
              kind: UNWATCHED_OPS_KIND,
              summary:
                "An unreachable acknowledgment request is still open past its deadline and needs a human",
              details: {
                organizationId: orgId,
                requestId: row.id,
                ackClass: row.ackClass,
                reminder: due.stage + 1,
              },
              correlationId,
            });
          }
          await raiseSupervisorAttention(
            deps.attention,
            orgId,
            row,
            "unwatched",
            correlationId,
            () => deps.claims.claim(`unpaged:${correlationId}`, due.windowMs),
          );
          if (emitted.size >= EMITTED_CAP) emitted.clear();
          emitted.add(correlationId);
          raised += 1;
        } catch (error) {
          failed += 1;
          deps.onError?.({ organizationId: orgId, requestId: row.id }, error);
        }
      }
      return { raised, failed };
    },
  };
}
