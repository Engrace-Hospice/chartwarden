export const M17_QUEUES = {
  recurringMaterialize: "scheduling.recurring-materialize",
  visitAttention: "scheduling.visit-attention",
  reassignmentScan: "scheduling.reassignment-scan",
  caregiverReminder: "scheduling.caregiver-reminder",
} as const;

export const M17_JOB_SCHEDULES = {
  recurringMaterialize: "0 2 * * *",
  visitAttention: "*/15 * * * *",
  reassignmentScan: "*/15 * * * *",
  caregiverReminder: "*/15 * * * *",
} as const;

export const M17_QUEUE_PARAMS = {
  recurringMaterialize: {
    priority: 5,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    concurrency: 2,
    removeOnComplete: { count: 100 },
    removeOnFail: false,
  },
  visitAttention: {
    priority: 4,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    concurrency: 2,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
  reassignmentScan: {
    priority: 4,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    concurrency: 2,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
  caregiverReminder: {
    priority: 4,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    concurrency: 1,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
} as const;
