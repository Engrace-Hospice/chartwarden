// apps/backend/src/modules/36-messaging/ack-escalation/escalation-timers.ts - WP 4.4 (ADR-0070): the delayed BullMQ job that wakes
// the escalation at a request's deadline. The payload is ids and one instant (no text, no name, no patient); the job id is
// deterministic per (request, tier, window deadline), so adding the same timer twice is a no-op in BullMQ itself. The job is only a
// wake-up: it carries the window it was armed for and `processDue` re-reads the request, so a job for an old window does nothing.
import { MESSAGING_QUEUES, MESSAGING_QUEUE_PARAMETERS, escalationJobId } from "@wardenx/messaging";
import type { Queue } from "bullmq";

export interface EscalationTimerJobData {
  readonly organizationId: string;
  readonly requestId: string;
  readonly tier: number;
  /** ISO instant of the deadline of the window this timer was armed for. */
  readonly deadlineAt: string;
}

export interface EscalationTimerArm {
  readonly orgId: string;
  readonly requestId: string;
  readonly tier: number;
  readonly deadlineAt: Date;
}

/** The port the arming consumer and the sweeper call; BullMQ is behind it. A throw means "not armed" (the caller retries). */
export interface EscalationTimerPort {
  arm(timer: EscalationTimerArm, now: Date): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a job payload. Anything that is not exactly ids and an instant is a poison job (null): it must never reach the database. */
export function parseTimerJobData(data: unknown): EscalationTimerJobData | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const deadline = typeof d.deadlineAt === "string" ? Date.parse(d.deadlineAt) : Number.NaN;
  if (
    typeof d.organizationId !== "string" ||
    !UUID.test(d.organizationId) ||
    typeof d.requestId !== "string" ||
    !UUID.test(d.requestId) ||
    typeof d.tier !== "number" ||
    !Number.isSafeInteger(d.tier) ||
    d.tier < 0 ||
    Number.isNaN(deadline)
  ) {
    return null;
  }
  return {
    organizationId: d.organizationId,
    requestId: d.requestId,
    tier: d.tier,
    deadlineAt: new Date(deadline).toISOString(),
  };
}

const TIMER_PARAMETERS = MESSAGING_QUEUE_PARAMETERS[MESSAGING_QUEUES.ackEscalationTimer];

export function createBullmqTimerPort(queue: Pick<Queue, "add">): EscalationTimerPort {
  return {
    async arm(timer, now) {
      const data: EscalationTimerJobData = {
        organizationId: timer.orgId,
        requestId: timer.requestId,
        tier: timer.tier,
        deadlineAt: timer.deadlineAt.toISOString(),
      };
      await queue.add("escalate", data, {
        jobId: escalationJobId(timer.requestId, timer.tier, timer.deadlineAt),
        delay: Math.max(0, timer.deadlineAt.getTime() - now.getTime()),
        attempts: TIMER_PARAMETERS.attempts,
        backoff: { type: TIMER_PARAMETERS.backoff.type, delay: TIMER_PARAMETERS.backoff.baseMs },
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      });
    },
  };
}
