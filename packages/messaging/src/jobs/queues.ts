// @wardenx/messaging — messaging job queue catalog + full BullMQ parameters (M36-T08, §4.4/§4.4.1).
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

/** The twelve §4.4 queue names. */
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
  "messaging.retention_scan": {
    name: "messaging.retention_scan",
    priority: 2,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 300000 },
    concurrency: 3,
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
  "messaging.hash_verify": {
    name: "messaging.hash_verify",
    priority: 2,
    attempts: 2,
    backoff: { type: "fixed", baseMs: 300000 },
    concurrency: 3,
    dlq: "messaging.hash_verify.dlq",
    idempotency:
      "(messageId, verifyRunId); destroyed-DEK (offboarded tenant) decode is skipped, not a mismatch",
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
} as const;
