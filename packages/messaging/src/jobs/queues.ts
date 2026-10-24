// @chartwarden/messaging — messaging job queue catalog + full BullMQ parameters (M36-T08, §4.4/§4.4.1).
//
// The canonical names + the §4.4.1 parameter table (priority / attempts / backoff / concurrency /
// DLQ name / idempotency) for every M36 queue (M36-F12 / SD-059 / SD-060 / ARCH-262 / OPS-035) as
// PURE DATA — no BullMQ import. The thin Worker/Queue construction lives in the app composition root
// (M1 infra owns the Valkey connection + the vendor adapters: web-push/Twilio/Postmark); M36 owns
// the policy + these descriptors here, the same M1-owns-mechanism / module-owns-policy split as the
// M38 terminology jobs. A run that exhausts its `attempts` lands in `<queue>.dlq` and is recorded as
// `m36.dlq_job` (§4.4.1 OPS-035 — no silent DLQ drain; ./processors.recordDlqLanding).

/** A BullMQ backoff policy as pure data (the worker builder maps it onto BullMQ's `backoff`). */
export interface QueueBackoff {
  readonly type: "fixed" | "exponential";
  /** Base delay in milliseconds. */
  readonly baseMs: number;
  /** Exponential multiplier (×2 typical); omitted/1 for fixed. */
  readonly factor?: number;
  /** Optional cap in milliseconds (exponential queues that bound the delay). */
  readonly capMs?: number;
}

/** One queue's full §4.4.1 parameters. `dlq` is the dead-letter queue an exhausted job lands in. */
export interface QueueParameters {
  readonly name: string;
  readonly priority: number;
  readonly attempts: number;
  readonly backoff: QueueBackoff;
  readonly concurrency: number;
  readonly dlq: string;
  /** Human note on the idempotency key the consumer dedupes on (§4.4.1). */
  readonly idempotency: string;
}

/** The §4.4 queue names (WP 1.5 added `attachment_scan`, WP 2.6 `scheduled_send`, WP 3.5 `handoff_expiry`, WP 4.4 the two ack-escalation queues, WP 4.10 `reminder_sweep`). */
export const MESSAGING_QUEUES = {
  fanOut: "messaging.fan_out",
  sendInApp: "messaging.send_in_app",
  sendPush: "messaging.send_push",
  sendSms: "messaging.send_sms",
  sendVoice: "messaging.send_voice",
  sendEmail: "messaging.send_email",
  channelSync: "messaging.channel_sync",
  endpointHealth: "messaging.endpoint_health",
  retentionScan: "messaging.retention_scan",
  bereavementClose: "messaging.bereavement_close",
  deliveryReconcile: "messaging.delivery_reconcile",
  hashVerify: "messaging.hash_verify",
  attachmentScan: "messaging.attachment_scan",
  scheduledSend: "messaging.scheduled_send",
  handoffExpiry: "messaging.handoff_expiry",
  ackEscalationTimer: "messaging.ack_escalation_timer",
  ackEscalationSweep: "messaging.ack_escalation_sweep",
  reminderSweep: "messaging.reminder_sweep",
  breakGlassReviewSweep: "messaging.break_glass_review_sweep",
  exportBuild: "messaging.export_build",
  exportExpirySweep: "messaging.export_expiry_sweep",
  deathBoardStallSweep: "messaging.death_board_stall_sweep",
} as const;

/** A queue name from the catalog. */
export type MessagingQueueName = (typeof MESSAGING_QUEUES)[keyof typeof MESSAGING_QUEUES];

/** The §4.4.1 parameter table — every queue declares its full BullMQ config (M36-F12 / SD-059). */
export const MESSAGING_QUEUE_PARAMETERS: { readonly [K in MessagingQueueName]: QueueParameters } = {
  "messaging.fan_out": {
    name: "messaging.fan_out",
    priority: 10,
    attempts: 5,
    backoff: { type: "exponential", baseMs: 1000, factor: 2 },
    concurrency: 20,
    dlq: "messaging.fan_out.dlq",
    idempotency: "correlationId — skip fan-out if an alert row with the same correlationId exists",
  },
  "messaging.send_in_app": {
    name: "messaging.send_in_app",
    priority: 10,
    attempts: 3,
    backoff: { type: "fixed", baseMs: 500 },
    concurrency: 100,
    dlq: "messaging.send_in_app.dlq",
    idempotency:
      "notification_delivery.id — already-delivered rows skipped (emit is fire-and-forget)",
  },
  "messaging.send_push": {
    name: "messaging.send_push",
    priority: 8,
    attempts: 4,
    backoff: { type: "exponential", baseMs: 2000, factor: 2 },
    concurrency: 50,
    dlq: "messaging.send_push.dlq",
    idempotency: "notification_delivery.id + endpoint_id",
  },
  "messaging.send_sms": {
    name: "messaging.send_sms",
    priority: 8,
    attempts: 5,
    backoff: { type: "exponential", baseMs: 5000, factor: 2, capMs: 300000 },
    concurrency: 10,
    dlq: "messaging.send_sms.dlq",
    idempotency:
      "vendor_message_id (Twilio SID) — skip re-send if SID already stored; honour 429 Retry-After",
  },
  "messaging.send_voice": {
    name: "messaging.send_voice",
    priority: 10,
    attempts: 3,
    backoff: { type: "fixed", baseMs: 2000 },
    concurrency: 5,
    dlq: "messaging.send_voice.dlq",
    idempotency:
      "notification_delivery.id; SOS-only guard re-checked at consumer entry; all-3-failures → field_safety.escalated + page ops",
  },
  "messaging.send_email": {
    name: "messaging.send_email",
    priority: 6,
    attempts: 5,
    backoff: { type: "exponential", baseMs: 5000, factor: 2, capMs: 600000 },
    concurrency: 20,
    dlq: "messaging.send_email.dlq",
    idempotency: "vendor_message_id (Postmark Message-ID) — skip if already stored",
  },
  "messaging.channel_sync": {
    name: "messaging.channel_sync",
    priority: 5,
    attempts: 3,
    backoff: { type: "fixed", baseMs: 10000 },
    concurrency: 10,
    dlq: "messaging.channel_sync.dlq",
    idempotency:
      "(orgId, channelKind, subjectId) — BullMQ deduplication key dedupes duplicate sync jobs",
  },
  "messaging.endpoint_health": {
    name: "messaging.endpoint_health",
    priority: 3,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 30000 },
    concurrency: 5,
    dlq: "messaging.endpoint_health.dlq",
    idempotency: "(userId, channel) per daily window",
  },
  // WP 1.9: the weekly tick is ONE fan-out job over every org, so concurrency is 1 (a second concurrent tick would
  // only re-plan the same rows). attempts/backoff are applied to the repeatable trigger (scheduleM36IntegrityJobs).
  "messaging.retention_scan": {
    name: "messaging.retention_scan",
    priority: 2,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 300000 },
    concurrency: 1,
    dlq: "messaging.retention_scan.dlq",
    idempotency: "(channelId, retentionClass, windowEnd); legal-hold rows skipped (M36-F10)",
  },
  "messaging.bereavement_close": {
    name: "messaging.bereavement_close",
    priority: 3,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 5,
    dlq: "messaging.bereavement_close.dlq",
    idempotency: "channelId",
  },
  "messaging.delivery_reconcile": {
    name: "messaging.delivery_reconcile",
    priority: 4,
    attempts: 3,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 5,
    dlq: "messaging.delivery_reconcile.dlq",
    idempotency: "(vendorMessageId, channel) per reconcile window",
  },
  // WP 1.9: attempts is 1 ON PURPOSE. The tick fails when a hash mismatches, and a mismatch is deterministic: a retry
  // would find the same rows and double the critical `m36.integrity.hash_mismatch` audit rows. The first failure is
  // already final, so the DLQ alert (which fires only on the last attempt) fires at once. The backoff is inert at
  // one attempt and kept for the table's shape. Concurrency 1: two overlapping ticks would race the rotation cursor.
  // Trade-off: a TRANSIENT failure (database or Redis blip) also gets no retry, so that org stays unverified until the
  // next night's run. It is alerted (failed tick + DLQ alert on the first failure), not retried.
  "messaging.hash_verify": {
    name: "messaging.hash_verify",
    priority: 2,
    attempts: 1,
    backoff: { type: "fixed", baseMs: 300000 },
    concurrency: 1,
    dlq: "messaging.hash_verify.dlq",
    idempotency:
      "(messageId, verifyRunId); destroyed-DEK (offboarded tenant) decode is skipped, not a mismatch",
  },
  // WP 1.5: the retry path for attachments the scanner could not answer for (the inline scan on `complete` is the
  // fast path). Idempotent by construction: a verdict is applied with `WHERE scan_state = 'pending'`, so a second
  // run, or a concurrent inline scan, settles nothing twice. A scanner outage defers (row stays pending); it never
  // fails the job into the DLQ and never marks anything clean.
  "messaging.attachment_scan": {
    name: "messaging.attachment_scan",
    priority: 3,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 1,
    dlq: "messaging.attachment_scan.dlq",
    idempotency: "attachmentId; verdict applied WHERE scan_state='pending' (first writer wins)",
  },
  // WP 2.6: a per-minute sweep (not one delayed job per message, so a cancel or reschedule never has to find a queued
  // job). It claims each due row under FOR UPDATE SKIP LOCKED and sends it with client_message_id = the scheduled id, so
  // a retried or overlapping tick can never send twice. Concurrency 1: one sweeper; a missed tick is made up by the next.
  "messaging.scheduled_send": {
    name: "messaging.scheduled_send",
    priority: 6,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 1,
    dlq: "messaging.scheduled_send.dlq",
    idempotency:
      "scheduledMessageId (= message.client_message_id); row locked FOR UPDATE SKIP LOCKED and deleted in the send transaction",
  },
  // WP 3.5: a per-minute sweep that closes the handoff offers whose deadline passed. Each handoff is locked FOR UPDATE and
  // re-checked in its own transaction, so a retried or overlapping tick (or an accept racing the tick) can never close one
  // twice. Concurrency 1: one sweeper; a missed tick is made up by the next. Runs for flag-off tenants too (safety).
  "messaging.handoff_expiry": {
    name: "messaging.handoff_expiry",
    priority: 6,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 1,
    dlq: "messaging.handoff_expiry.dlq",
    idempotency:
      "handoffId; row locked FOR UPDATE and re-checked (state='offered' and past the policy-capped deadline) in the close transaction",
  },
  // WP 5.8 (ADR-0087): an hourly sweep that raises the overdue alert for each break-glass review still open three days after its grant
  // ended. The alert is unique on (organization, correlation id) with the review id in the id, so a retried or overlapping tick re-emits
  // harmlessly and never alerts twice. Concurrency 1: one sweeper; a missed tick is made up by the next. Runs for flag-off tenants too
  // (accountability for a grant that exists must not stall on a flag).
  "messaging.break_glass_review_sweep": {
    name: "messaging.break_glass_review_sweep",
    priority: 5,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 1,
    dlq: "messaging.break_glass_review_sweep.dlq",
    idempotency:
      "alert correlationId = break-glass:<reviewId>:overdue; the (organization, correlation_id) alert dedupe absorbs a repeat emit",
  },
  // WP 6.9 (ADR-0098 D13): an hourly sweep that flags needs_owner on an open death-board item whose owner lost eligibility outside the offboarding
  // sweep and tells the supervisors (fixed text). Alert correlationId = item + version, so a repeat alerts once; the flag is a guarded, locked
  // transition that skips an item already flagged. Bounded per org per tick. Concurrency 1. Flag-independent: a board that exists must not stall.
  "messaging.death_board_stall_sweep": {
    name: "messaging.death_board_stall_sweep",
    priority: 5,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 1,
    dlq: "messaging.death_board_stall_sweep.dlq",
    idempotency:
      "alert correlationId = hash(item id, version); the item is locked FOR UPDATE and re-checked (open, unflagged, same owner) before the flag",
  },
  // WP 5.7 (ADR-0089): builds ONE approved export into its encrypted artefact. Enqueued by the `m36.export.approved` consumer with the job id as
  // the BullMQ job id; the build claims the row approved -> building (a guarded forward-only transition), so a duplicate or retried job is a
  // no-op. Concurrency 1: a build pages up to 50 000 messages. Runs for flag-off tenants too (approval already happened).
  "messaging.export_build": {
    name: "messaging.export_build",
    priority: 5,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 1,
    dlq: "messaging.export_build.dlq",
    idempotency:
      "jobId = export job id; the build claims approved -> building under the guard trigger, so a repeat finds a job already past approved and does nothing",
  },
  // WP 5.7: an hourly sweep that deletes the stored artefact of every ready export past its 24 h expiry and moves it ready -> expired (the guard
  // nulls the wrapped key). Each job is its own transaction; an object already gone is fine. Flag-independent: an artefact must expire even
  // when the feature is switched off.
  "messaging.export_expiry_sweep": {
    name: "messaging.export_expiry_sweep",
    priority: 5,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 1,
    dlq: "messaging.export_expiry_sweep.dlq",
    idempotency:
      "export job id; ready -> expired is guarded (expires_at <= now(), DB clock) and the object delete tolerates an already-gone object",
  },
  // WP 4.4 (ADR-0070): ONE delayed job per (request, tier, window deadline) with a deterministic job id, so a duplicate add is a
  // no-op. The job only WAKES the escalation: the database decides what is due and the guarded write decides who escalates, so a
  // retry, a duplicate or a second worker cannot escalate twice. Five attempts with exponential backoff; a payload that is not
  // ids is unrecoverable and goes straight to the DLQ, where it is audited as `m36.dlq_job`. A job in the DLQ loses nothing: the
  // sweeper below still finds the request.
  "messaging.ack_escalation_timer": {
    name: "messaging.ack_escalation_timer",
    priority: 10,
    attempts: 5,
    backoff: { type: "exponential", baseMs: 2000, factor: 2, capMs: 60000 },
    concurrency: 5,
    dlq: "messaging.ack_escalation_timer.dlq",
    idempotency:
      "jobId = (requestId, tier, window deadline); the escalation is one write guarded by the row lock and its version",
  },
  // WP 4.4: a per-minute sweep over the database (open requests past their deadline), the safety net for a lost or flushed Redis
  // and the retry loop while no router can answer. Same guarded write as the timer job, so the two can run together. Concurrency 1.
  "messaging.ack_escalation_sweep": {
    name: "messaging.ack_escalation_sweep",
    priority: 9,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 30000 },
    concurrency: 1,
    dlq: "messaging.ack_escalation_sweep.dlq",
    idempotency:
      "requestId; each due request is locked FOR UPDATE and re-checked (waiting, past its deadline, same version) in its own transaction",
  },
  // WP 4.10 (ADR-0077): every minute, raises the alert of each due reminder and deletes the row. The alert's correlation id is the
  // reminder id, so a retry, an overlapping tick or a second worker is absorbed by the emitter. Concurrency 1: one sweeper; a missed
  // tick is made up by the next. A tenant with the flag off is skipped (rows wait).
  "messaging.reminder_sweep": {
    name: "messaging.reminder_sweep",
    priority: 6,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 60000 },
    concurrency: 1,
    dlq: "messaging.reminder_sweep.dlq",
    idempotency:
      "reminder id; the alert correlation id `reminder:<id>` is unique per organisation, and the row is deleted only after the alert is raised",
  },
};

/** The repeat cadences for the scheduled jobs (UTC cron). Event-triggered queues have no entry. */
export const MESSAGING_JOB_SCHEDULES = {
  /** channel_sync: every 5 minutes (also runs on M5/M16/M17/M19/M2 outbox events). */
  channelSync: "*/5 * * * *",
  /** endpoint_health: daily 03:00 UTC. */
  endpointHealth: "0 3 * * *",
  /** retention_scan: weekly, Sunday 02:00 UTC. */
  retentionScan: "0 2 * * 0",
  /** bereavement_close: daily 01:00 UTC. */
  bereavementClose: "0 1 * * *",
  /** delivery_reconcile: hourly at :15. */
  deliveryReconcile: "15 * * * *",
  /** hash_verify: nightly off-peak, 04:00 UTC. */
  hashVerify: "0 4 * * *",
  /** attachment_scan: every minute (sweeps completed uploads still awaiting a verdict). */
  attachmentScan: "* * * * *",
  /** scheduled_send: every minute (sends the scheduled messages that came due). */
  scheduledSend: "* * * * *",
  /** handoff_expiry: every minute (closes the handoff offers that passed their deadline). */
  handoffExpiry: "* * * * *",
  /** ack_escalation_sweep: every minute (escalates the requests that passed their deadline and re-asks the ones that could not be routed). */
  ackEscalationSweep: "* * * * *",
  /** reminder_sweep: every minute (raises the alert of each reminder that came due). */
  reminderSweep: "* * * * *",
  /** break_glass_review_sweep: hourly at :20 (alerts the compliance reviewers to a review still open three days after its grant ended). */
  breakGlassReviewSweep: "20 * * * *",
  /** export_expiry_sweep: hourly at :40 (deletes the artefact of each export past its 24 h link and marks it expired). */
  exportExpirySweep: "40 * * * *",
  /** death_board_stall_sweep: hourly at :50 (flags the open items whose owner is no longer eligible and tells the supervisors). */
  deathBoardStallSweep: "50 * * * *",
} as const;
