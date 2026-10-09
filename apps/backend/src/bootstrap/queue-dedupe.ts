// BullMQ producer helper (GAP-042 / GAP-047). A custom `jobId` dedupes only while the earlier job
// hash exists; with `removeOnComplete: { count }` / `removeOnFail: false` the hash is retained, so a
// constant id made every later re-trigger a silent no-op. Here an in-flight job still coalesces, but a
// finished (completed/failed) job with the same id is cleared first so the re-trigger really runs.

export interface DedupeJobLike {
  getState(): Promise<string>;
  remove(): Promise<unknown>;
}

export interface DedupeQueueLike {
  getJob(jobId: string): Promise<DedupeJobLike | undefined | null>;
  add(
    name: string,
    data: unknown,
    opts: { jobId: string } & Record<string, unknown>,
  ): Promise<{ id?: string | undefined }>;
}

const FINISHED_STATES: ReadonlySet<string> = new Set(["completed", "failed"]);

export async function addJobCoalescingInFlight(
  queue: DedupeQueueLike,
  name: string,
  data: unknown,
  opts: { jobId: string } & Record<string, unknown>,
): Promise<{ id?: string | undefined }> {
  const existing = await queue.getJob(opts.jobId);
  if (existing && FINISHED_STATES.has(await existing.getState())) {
    await existing.remove();
  }
  return queue.add(name, data, opts);
}
