// @chartwarden/messaging — out-of-band retry policy (M36 GAP-101, spec §4.4.1).
//
// The per-queue `attempts` + backoff the §4.4.1 table declares, applied to a delivery ROW (the dispatcher is a
// row-driven sweep, so the budget lives on `notification_delivery.attempt_count`, not on a BullMQ job). Pure.
import {
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
  type MessagingQueueName,
  type QueueParameters,
} from "../jobs/queues";
import type { OutOfBandTransportChannel } from "./transports";

const QUEUE_BY_CHANNEL: { readonly [C in OutOfBandTransportChannel]: MessagingQueueName } = {
  push: MESSAGING_QUEUES.sendPush,
  sms: MESSAGING_QUEUES.sendSms,
  voice: MESSAGING_QUEUES.sendVoice,
  email: MESSAGING_QUEUES.sendEmail,
};

/** The §4.4.1 parameters of the queue that serves `channel`. */
export function queueParametersFor(channel: OutOfBandTransportChannel): QueueParameters {
  return MESSAGING_QUEUE_PARAMETERS[QUEUE_BY_CHANNEL[channel]];
}

/** Delay before attempt number `attemptsMade + 1`, after `attemptsMade` (>= 1) attempts have failed. */
export function backoffDelayMs(params: QueueParameters, attemptsMade: number): number {
  const { type, baseMs, factor = 2, capMs } = params.backoff;
  const raw = type === "fixed" ? baseMs : baseMs * factor ** Math.max(0, attemptsMade - 1);
  return capMs === undefined ? raw : Math.min(raw, capMs);
}

/** True while the row may still be attempted again after `attemptsMade` attempts. */
export function hasAttemptsLeft(params: QueueParameters, attemptsMade: number): boolean {
  return attemptsMade < params.attempts;
}

/** How long a sweep holds a claimed row before another sweep may take it (crash recovery). */
export const DELIVERY_CLAIM_LEASE_MS = 120_000;

/** Max rows one org contributes to one sweep tick — the backlog bound. */
export const DELIVERY_SWEEP_BATCH_LIMIT = 50;

/** Sweep cadence per channel. SOS voice/push are latency-critical; email is the slowest channel. */
export const DELIVERY_SWEEP_INTERVAL_MS: { readonly [C in OutOfBandTransportChannel]: number } = {
  voice: 10_000,
  push: 15_000,
  sms: 15_000,
  email: 30_000,
};
