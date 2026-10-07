// M23 BullMQ job ids. BullMQ (job.js `validateOptions`) refuses a custom id containing ':' unless it splits into
// exactly three parts — "Custom Id cannot contain :". The eligibility.refresh bridge key (`patient:date:event`) and
// the claim.submit.retry key (`submission:attempt`) are composite, so every "Run HETS check" was accepted (202) and
// then failed in the outbox relay forever. Found on a live boot with the sandbox HETS transport.
import { describe, expect, it } from "vitest";
import { m23JobId } from "../jobs/queues";

/** BullMQ's own rule for a custom job id (bullmq/dist/cjs/classes/job.js). */
const bullmqAccepts = (id: string): boolean =>
  `${Number.parseInt(id, 10)}` !== id && (!id.includes(":") || id.split(":").length === 3);

describe("m23JobId", () => {
  it("keeps a simple key as m23:<queue>:<key>", () => {
    expect(m23JobId("validation-run", "run-1")).toBe("m23:validation-run:run-1");
  });

  it("folds a composite key's ':' so BullMQ accepts it, deterministically", () => {
    const key =
      "eb6cde34-1638-40f9-9a3b-c404734cb56b:2026-10-06:47fb252b-b95b-4000-8740-0bb7b643a3b3";
    const id = m23JobId("eligibility.refresh", key);
    expect(bullmqAccepts(`m23:eligibility.refresh:${key}`)).toBe(false); // the bug
    expect(bullmqAccepts(id)).toBe(true);
    expect(id).toBe(m23JobId("eligibility.refresh", key)); // a redelivery is still a no-op
    expect(bullmqAccepts(m23JobId("claim.submit.retry", "sub-1:2"))).toBe(true);
  });
});
