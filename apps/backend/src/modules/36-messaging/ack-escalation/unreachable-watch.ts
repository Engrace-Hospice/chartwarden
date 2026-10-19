// apps/backend/src/modules/36-messaging/ack-escalation/unreachable-watch.ts - ADR-0079 (G-5): a `failed_unreachable` request is no longer
// watched by the deadline timer (nothing can escalate it: the database guard allows no failed_unreachable -> escalated, and every
// route to its assignee has just failed). Left alone it would be loud once, at the moment it failed, and silent after. This watch,
// run by the per-minute `messaging.ack_escalation_sweep`, keeps it in front of the supervisors on a BOUNDED, backed-off schedule:
// once the deadline has passed, at most EIGHT reminders (the unroutable cap) over about four days, at the same 1 h / 2 h / 4 h ... 24 h
// spacing as the unroutable reminders. It writes nothing to the request and sends nothing to the assignee's failing transport; a human
// moves the request (supervisor reassign, ADR-0078) and the reassign resets it to `pending`, which the timer watches again.
//
// Fleet-wide once-per-stage: the claim (Valkey, ADR-0079) says which process raises a stage; the alert correlation id converges anyway.
// The schedule is derived from the clock and the deadline, not stored, so a missed stage (sweep down) is skipped, never replayed late.
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
  /** 0-based reminder number; the claim and the alert id are per stage. */
  readonly stage: number;
  /** How long this stage lasts (the claim's lifetime): the next one starts when it ends. */
  readonly windowMs: number;
}

/**
 * Which reminder is due `overdueMs` after the deadline, or null before the deadline and after the last stage. Stage k opens at the sum of
 * the first k unroutable backoffs (0, 1 h, 3 h, 7 h, 15 h, 39 h, 63 h, 87 h) and lasts the next backoff, so there are UNROUTED_MAX_RECORDS
 * stages in all and then no more (the request stays on the queue and the gauges; nothing further is raised for it).
 */
export function unwatchedStage(overdueMs: number): UnwatchedStage | null {
  if (!(overdueMs >= 0)) return null;
  let opensAt = 0;
  for (let stage = 0; stage < UNROUTED_MAX_RECORDS; stage += 1) {
    const windowMs = unroutedBackoffMs(stage + 1);
    if (overdueMs < opensAt + windowMs) return { stage, windowMs };
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

export function createUnreachableWatch(deps: UnreachableWatchDeps): UnreachableWatch {
  const now = deps.now ?? (() => new Date());
  return {
    async watch(orgId) {
      if (!(await deps.isEnabled(orgId))) return { raised: 0, failed: 0 };
      const at = now();
      const rows = await deps.store.readAsSystem(orgId, (tx) =>
        tx.listUnreachableOverdue(at, ESCALATION_SWEEP_BATCH),
      );
      let raised = 0;
      let failed = 0;
      for (const row of rows) {
        const due = unwatchedStage(at.getTime() - row.deadlineAt.getTime());
        if (!due) continue;
        // The version bumps on every write, so a request that was reassigned and failed again starts a new schedule.
        const correlationId = `ack-unwatched:${row.id}:${row.version}:${due.stage}`;
        if (!(await deps.claims.claim(correlationId, due.windowMs))) continue;
        try {
          // The notice first, then the alert: a failing alert must not lose it (the order of ack-unreachable-notifications).
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
          await raiseSupervisorAttention(deps.attention, orgId, row, "unwatched", correlationId);
          raised += 1;
        } catch (error) {
          failed += 1;
          await deps.claims.release(correlationId);
          deps.onError?.({ organizationId: orgId, requestId: row.id }, error);
        }
      }
      return { raised, failed };
    },
  };
}
