// apps/backend/src/modules/12-dosespot/jobs/queues.ts — the §4.8 BullMQ catalog entries for the seven M12 crons
// GAP-037 built (the two vendor-I/O drains `patient_sync` / `fetch_medhx` run in the `dosespot.sync_queue_drain`
// worker, and `dispatch_webhook` is the inline webhook handler). Pure data.
export const M12_CRON_QUEUES = {
  transmitNewRx: "dosespot.transmit_newrx",
  transmitQueuedOnRecovery: "dosespot.transmit_queued_on_recovery",
  rxBenefitPrewarm: "dosespot.rx_benefit_prewarm",
  refillSla: "dosespot.refill_sla",
  ial2ExpiryWarn: "dosespot.ial2_expiry_warn",
  transmissionTimeoutSweep: "dosespot.transmission_timeout_sweep",
  epcsAttemptExpirySweep: "dosespot.epcs_attempt_expiry_sweep",
} as const;

export type M12CronKey = keyof typeof M12_CRON_QUEUES;

export const M12_CRON_SCHEDULES: Readonly<Record<M12CronKey, string>> = {
  // Every minute: a signed prescription should leave within a minute of signing.
  transmitNewRx: "* * * * *",
  // Every 5 minutes: reclaim crashed claims + drain the backlog an outage accumulated (D11).
  transmitQueuedOnRecovery: "*/5 * * * *",
  // Off-peak daily (spec: "daily cron, off-peak window").
  rxBenefitPrewarm: "30 3 * * *",
  refillSla: "5 * * * *",
  ial2ExpiryWarn: "10 4 * * *",
  // Spec says hourly; the pass is also the ack/nack POLL (no verified push channel), so it runs every 10 minutes.
  transmissionTimeoutSweep: "*/10 * * * *",
  epcsAttemptExpirySweep: "* * * * *",
};

/** Retry policy per job (`attempts` + the first backoff step). */
export const M12_CRON_QUEUE_PARAMS: Readonly<
  Record<M12CronKey, { attempts: number; backoffMs: number; concurrency: number; priority: number }>
> = {
  transmitNewRx: { attempts: 3, backoffMs: 5_000, concurrency: 1, priority: 1 },
  transmitQueuedOnRecovery: { attempts: 3, backoffMs: 30_000, concurrency: 1, priority: 2 },
  rxBenefitPrewarm: { attempts: 3, backoffMs: 300_000, concurrency: 1, priority: 9 },
  refillSla: { attempts: 3, backoffMs: 60_000, concurrency: 1, priority: 4 },
  ial2ExpiryWarn: { attempts: 3, backoffMs: 60_000, concurrency: 1, priority: 5 },
  transmissionTimeoutSweep: { attempts: 3, backoffMs: 30_000, concurrency: 1, priority: 3 },
  epcsAttemptExpirySweep: { attempts: 3, backoffMs: 5_000, concurrency: 1, priority: 1 },
};
