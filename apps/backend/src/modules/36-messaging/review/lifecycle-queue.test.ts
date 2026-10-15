// WP 3.8 - the lifecycle queue: only active care-team tasks of the patient are queued; the M6 death and the M5 death record
// converge on one row per task; a redelivery inserts nothing yet still reports who is affected; a later discharge queues
// again once the earlier review is decided.
import { describe, expect, it } from "vitest";
import {
  ADMISSION,
  ALICE,
  BEREAVEMENT_CH,
  BOB,
  CARE_CH_2,
  P1,
  P2,
  SUPERVISOR,
  actor,
  buildKit,
} from "./review-test-kit";

const ADMISSION_2 = "00000000-0000-4000-8000-0000000000b9";

describe("queueLifecycleReviewForPatient", () => {
  it("queues the patient's active care-team tasks and reports their holders", async () => {
    const kit = buildKit();
    await kit.task(ALICE);
    await kit.task(BOB, { channelId: CARE_CH_2 });

    const { openSubjects } = await kit.queue("discharge", ADMISSION);

    expect(kit.store.rows.size).toBe(2);
    expect(openSubjects).toEqual([ALICE, BOB].sort());
  });

  it("excludes bereavement-channel tasks, closed tasks and other patients' tasks", async () => {
    const kit = buildKit();
    await kit.task(ALICE, { channelId: BEREAVEMENT_CH });
    const done = await kit.task(ALICE);
    await kit.closeElsewhere(done.id, ALICE);
    await kit.task(BOB, { patientId: P2 });

    const { openSubjects } = await kit.queue("death", P1);

    expect(kit.store.rows.size).toBe(0);
    expect(openSubjects).toEqual([]);
  });

  it("converges the M6 death and the M5 death record on one row per task", async () => {
    const kit = buildKit();
    await kit.task(ALICE);

    await kit.queue("death", P1);
    await kit.queue("death", P1);

    expect(kit.store.rows.size).toBe(1);
  });

  it("inserts nothing on a redelivery but still returns the open subjects", async () => {
    const kit = buildKit();
    await kit.task(ALICE);
    await kit.queue("discharge", ADMISSION);

    const again = await kit.queue("discharge", ADMISSION);

    expect(kit.store.rows.size).toBe(1);
    expect(again.openSubjects).toEqual([ALICE]);
  });

  it("does not open a second review for a task that is already under review (discharge then death)", async () => {
    const kit = buildKit();
    await kit.task(ALICE);
    await kit.queue("discharge", ADMISSION);

    await kit.queue("death", P1);

    expect(kit.store.rows.size).toBe(1);
    expect([...kit.store.rows.values()][0]?.cause).toBe("discharge");
  });

  it("queues again for a later admission's discharge once the earlier review is decided", async () => {
    const kit = buildKit();
    const t = await kit.task(ALICE);
    await kit.queue("discharge", ADMISSION);
    const [row] = [...kit.store.rows.values()];
    await kit.service.close(actor(SUPERVISOR), row?.id ?? "", "no_action_needed");
    expect(kit.taskStore.tasks.get(t.id)?.status).toBe("cancelled");
    const next = await kit.task(ALICE);

    await kit.queue("discharge", ADMISSION_2);

    expect([...kit.store.rows.values()].filter((r) => r.state === "open")).toHaveLength(1);
    expect([...kit.store.rows.values()].find((r) => r.state === "open")?.itemId).toBe(next.id);
  });

  it("pages through more tasks than one batch", async () => {
    const kit = buildKit();
    for (let i = 0; i < 205; i += 1) await kit.task(ALICE, { createdBy: BOB });

    await kit.queue("discharge", ADMISSION);

    expect(kit.store.rows.size).toBe(205);
  });
});
