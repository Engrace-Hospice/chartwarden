// apps/backend/src/m25-staged-835-config.ts — the M25 raw-835 staging constants (#675), shared by the store and the
// tenant-bucket backfill script without loading either's module graph.
/** Orphans (a rolled-back receive, a delete that was never retried) expire after this; a normal stage lives minutes. */
export const M25_STAGED_EXPIRY_DAYS = 30;
export const M25_STAGED_PREFIX = "m25-835/";
