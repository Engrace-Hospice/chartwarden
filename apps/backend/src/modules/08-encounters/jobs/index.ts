export const M8_QUEUES = {
  encounterAttention: "encounter.attention",
  cosignatureSla: "encounter.cosignature-sla",
} as const;

export const M8_JOB_SCHEDULES = {
  encounterAttention: "*/15 * * * *",
  cosignatureSla: "*/15 * * * *",
} as const;

export const M8_QUEUE_PARAMS = {
  encounterAttention: {
    priority: 4,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    concurrency: 2,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
  cosignatureSla: {
    priority: 3,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    concurrency: 2,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
} as const;
