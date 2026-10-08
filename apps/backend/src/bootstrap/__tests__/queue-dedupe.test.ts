// GAP-042 / GAP-047 — a constant BullMQ jobId is retained after completion (removeOnComplete count) or
// failure (removeOnFail false), and `Queue.add` with an existing id is a silent no-op. The helper must
// coalesce while a job is in flight but let a re-trigger through once the prior job is finished.
import { describe, expect, it, vi } from "vitest";
import { type DedupeQueueLike, addJobCoalescingInFlight } from "../queue-dedupe";

function fakeQueue(existingState: string | null) {
  const remove = vi.fn(async () => undefined);
  const add = vi.fn(async (_n: string, _d: unknown, o: { jobId: string }) => ({ id: o.jobId }));
  const queue: DedupeQueueLike = {
    getJob: vi.fn(async () =>
      existingState === null ? undefined : { getState: async () => existingState, remove },
    ),
    add,
  };
  return { queue, add, remove };
}

describe("addJobCoalescingInFlight", () => {
  it("adds when no job with the id exists", async () => {
    const { queue, add, remove } = fakeQueue(null);
    await addJobCoalescingInFlight(queue, "q", { a: 1 }, { jobId: "j" });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(["completed", "failed"])("clears a %s job so the re-trigger runs", async (state) => {
    const { queue, add, remove } = fakeQueue(state);
    await addJobCoalescingInFlight(queue, "q", {}, { jobId: "j" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });
  it.each(["waiting", "active", "delayed"])(
    "keeps a %s job (true in-flight dedupe)",
    async (state) => {
      const { queue, add, remove } = fakeQueue(state);
      const res = await addJobCoalescingInFlight(queue, "q", {}, { jobId: "j" });
      expect(remove).not.toHaveBeenCalled();
      expect(add).toHaveBeenCalledTimes(1);
      expect(res.id).toBe("j");
    },
  );
});
