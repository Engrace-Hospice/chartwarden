// apps/backend/src/bootstrap/dlq-alerts.ts — DLQ-promotion alerting (TASK-040D, production-readiness
// audit 2026-08-03, OPS-012).
//
// Before this file, a job that exhausted every BullMQ retry attempt, or an outbox row that hit its
// terminal `failed` state, was observable ONLY as a log line — `outbox-dispatcher.ts`'s `☠️` message,
// or nothing at all for every BullMQ `Worker` in the repo (grep for `QueueEvents`/`.on("failed"` across
// `apps/backend/src` returned zero hits before this). This is the shared, generic hook point the task
// text explicitly permits ("a webhook/log-based alert, whatever the existing ops-alert mechanism is, or
// a new `onDlqPromotion` callback if none exists" — none existed).
//
// WHY NOT ROUTE THROUGH M36's AlertEmitter: `AlertEmitter.emit(orgId, ...)` (packages/messaging) is
// inherently TENANT-scoped — every existing call site (M25's `alerts.dispatch` inside a per-org cron
// loop) fires a BUSINESS alert for one org's data. A DLQ promotion is an OPS-level failure: a cron
// queue's processor threw for the WHOLE tick (every org in that run), or an outbox row dead-lettered
// for one org but the failure is infra/code, not a tenant-facing business event. Forcing it through a
// tenant-scoped emitter would either fabricate an org scope for a platform-wide failure or under-report
// (only the last org in a loop). A dedicated ops sink is the honest shape; `organizationId` rides along
// on the event when the failure IS attributable to one org (e.g. an outbox row), and is omitted
// otherwise (e.g. a whole cron-tick throw).
//
// Log-based by default (this file's own `console.error`, always-on — the task's explicit fallback);
// `OPS_ALERT_WEBHOOK_URL` is read at the composition root and threaded in when an operator wants a real
// external sink — this file never reads `process.env` itself (composition-root owns config resolution,
// this module owns mechanism).

/** One DLQ-promotion event — a job/row that will NEVER be retried again. */
export interface DlqPromotionEvent {
  /** The queue/source this promotion came from, e.g. "m7.gates", "outbox", "m25.denial_aging_scan". */
  readonly source: string;
  readonly jobId?: string;
  /** Set when the failure is attributable to one org (e.g. an outbox row); omitted for a whole-tick throw. */
  readonly organizationId?: string;
  readonly attempts?: number;
  readonly error: string;
  readonly occurredAt: string;
}

export type OnDlqPromotion = (event: DlqPromotionEvent) => void;

/**
 * The default sink: an always-on structured, greppable `console.error` line (the task's explicit
 * "log-based alert" fallback), plus an optional best-effort webhook POST when `webhookUrl` is
 * configured. The webhook never blocks or throws into the caller — delivery failure is itself only
 * logged, never re-raised (a DLQ alert must never become a second failure the caller has to handle).
 */
export function buildDlqPromotionSink(opts?: {
  readonly webhookUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
}): OnDlqPromotion {
  const log = opts?.log ?? ((m: string) => console.error(m));
  const webhookUrl = opts?.webhookUrl;
  const doFetch = opts?.fetchImpl ?? fetch;
  return (event: DlqPromotionEvent) => {
    log(
      `🚨 DLQ promotion [${event.source}]${event.organizationId ? ` org=${event.organizationId}` : ""}${
        event.jobId ? ` job=${event.jobId}` : ""
      } after ${event.attempts ?? "?"} attempt(s): ${event.error}`,
    );
    if (!webhookUrl) return;
    doFetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }).catch((err) => {
      log(
        `⚠️  DLQ alert webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
}

/** The minimal shape `attachDlqPromotionAlert` needs — BullMQ's `Worker` satisfies this structurally. */
export interface FailedJobLike {
  readonly id?: string;
  readonly name?: string;
  readonly data?: unknown;
  readonly attemptsMade?: number;
  readonly opts?: { readonly attempts?: number };
}

/** The minimal event-emitter shape `attachDlqPromotionAlert` needs — BullMQ's `Worker` satisfies this. */
export interface WorkerLike {
  on(event: "failed", listener: (job: FailedJobLike | undefined, err: Error) => void): unknown;
}

/**
 * Attach a DLQ-promotion listener to a BullMQ `Worker` (or any `WorkerLike` — deliberately NOT typed
 * against `bullmq`'s `Worker` directly so this stays unit-testable with a plain `EventEmitter`, no Redis
 * connection required). Fires `onDlqPromotion` exactly once per job, only on its FINAL failed attempt
 * (`attemptsMade >= opts.attempts`) — an attempt that will still retry is not a DLQ promotion, it's a
 * normal backoff cycle every queue already has.
 */
export function attachDlqPromotionAlert(
  worker: WorkerLike,
  source: string,
  onDlqPromotion: OnDlqPromotion,
): void {
  worker.on("failed", (job, err) => {
    if (!job) return;
    const attempts = job.opts?.attempts ?? 1;
    const attemptsMade = job.attemptsMade ?? attempts;
    if (attemptsMade < attempts) return; // will retry — not yet a dead letter
    const organizationId =
      job.data && typeof job.data === "object" && "organizationId" in job.data
        ? String((job.data as { organizationId?: unknown }).organizationId)
        : undefined;
    onDlqPromotion({
      source,
      jobId: job.id,
      organizationId,
      attempts: attemptsMade,
      error: err instanceof Error ? err.message : String(err),
      occurredAt: new Date().toISOString(),
    });
  });
}
