import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, P1, actor, buildKit, sha, standardRequest } from "./promotion-test-kit";

const m8 = { targetModule: "m8", reviewerUserId: CAROL, withText: true } as const;
const m8NoText = { targetModule: "m8", reviewerUserId: CAROL } as const;
const m14 = { targetModule: "m14", reviewerUserId: CAROL } as const;

async function proposed(kit: ReturnType<typeof buildKit>, target: "m8" | "m14" = "m8") {
  const a =
    target === "m8"
      ? standardRequest
      : { ...standardRequest, targetModule: "m14", targetKind: "idg_agenda_item" };
  return (await kit.service.request(actor(ALICE), a)).promotion;
}

describe("ChartPromotionSourceReader.forReview", () => {
  it("returns the attribution, the hash and the quoted text for an m8 reviewer", async () => {
    const kit = buildKit();
    const p = await proposed(kit);
    const review = await kit.reader.forReview(actor(ALICE).orgId, p.id, m8);
    expect(review).toMatchObject({
      requestId: p.id,
      patientId: P1,
      sourceAuthorUserId: BOB,
      requestedByUserId: ALICE,
      sourceBodySha256: sha("Patient reports new pain in left hip"),
      snapshotText: "Patient reports new pain in left hip",
      sourceState: "current",
    });
  });

  it("hands out no text for the m14 target", async () => {
    const kit = buildKit();
    const p = await proposed(kit, "m14");
    const review = await kit.reader.forReview(actor(ALICE).orgId, p.id, m14);
    expect(review?.snapshotText).toBeNull();
    expect(review?.requestId).toBe(p.id);
  });

  it("serves no text when the sender edited the message afterwards, only that the source changed", async () => {
    const kit = buildKit();
    const p = await proposed(kit);
    kit.editMessage("Edited text");
    const review = await kit.reader.forReview(actor(ALICE).orgId, p.id, m8);
    expect(review).toMatchObject({ snapshotText: null, sourceState: "edited_since" });
  });

  it("serves no text unless the caller asks withText", async () => {
    const kit = buildKit();
    const p = await proposed(kit);
    const review = await kit.reader.forReview(actor(ALICE).orgId, p.id, m8NoText);
    expect(review?.snapshotText).toBeNull();
    expect(review?.sourceState).toBe("current");
  });

  it("never opens (decrypts) a body for a caller that did not ask for the text", async () => {
    const kit = buildKit();
    const p = await proposed(kit);
    const opened: string[] = [];
    const { createPromotionSourceReader } = await import("./promotion-source-reader");
    const reader = createPromotionSourceReader({
      store: kit.store,
      isEnabled: async () => true,
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
      bodies: {
        ...kit.bodies,
        open: async (o, c) => {
          opened.push("x");
          return kit.bodies.open(o, c);
        },
      },
      permissionsFor: async () => new Set(["patient.read", "encounter.addendum_sign"]),
    });
    await reader.forReview(actor(ALICE).orgId, p.id, m8NoText);
    kit.editMessage("Edited text");
    await reader.forReview(actor(ALICE).orgId, p.id, m8);
    expect(opened).toEqual([]);
  });

  it.each([["encounter.addendum_sign"], ["patient.read"]])(
    "returns null for an m8 reviewer who lacks %s",
    async (perm) => {
      const kit = buildKit({ missingPermission: [`${CAROL}:${perm}`] });
      const p = await proposed(kit);
      expect(await kit.reader.forReview(actor(ALICE).orgId, p.id, m8)).toBeNull();
      expect(
        await kit.reader.pendingForPatients(actor(ALICE).orgId, {
          ...m8,
          patientIds: [P1],
          limit: 5,
        }),
      ).toEqual([]);
    },
  );

  it("returns null when the reviewer permission lookup throws", async () => {
    const kit = buildKit();
    const p = await proposed(kit);
    const { createPromotionSourceReader } = await import("./promotion-source-reader");
    const reader = createPromotionSourceReader({
      store: kit.store,
      isEnabled: async () => true,
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
      bodies: kit.bodies,
      permissionsFor: async () => {
        throw new Error("down");
      },
    });
    expect(await reader.forReview(actor(ALICE).orgId, p.id, m8)).toBeNull();
  });

  it("returns null when the recorded hash matches nothing the message ever held", async () => {
    const kit = buildKit();
    const p = await proposed(kit);
    const row = kit.store.rows.get(p.id);
    if (row) kit.store.rows.set(p.id, { ...row, sourceBodySha256: sha("something never written") });
    expect(await kit.reader.forReview(actor(ALICE).orgId, p.id, m8)).toBeNull();
  });

  it("returns null when the stored body no longer hashes to the recorded value", async () => {
    const kit = buildKit();
    const p = await proposed(kit);
    const tampered = { ...kit.bodies, open: async () => "tampered body" };
    const { createPromotionSourceReader } = await import("./promotion-source-reader");
    const reader = createPromotionSourceReader({
      store: kit.store,
      isEnabled: async () => true,
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
      bodies: tampered,
      permissionsFor: async () => new Set(["patient.read", "encounter.addendum_sign"]),
    });
    expect(await reader.forReview(actor(ALICE).orgId, p.id, m8)).toBeNull();
  });

  it.each([
    ["the message was erased", (k: ReturnType<typeof buildKit>) => k.eraseMessage()],
    [
      "the request is no longer proposed",
      async (k: ReturnType<typeof buildKit>) => {
        const [row] = [...k.store.rows.values()];
        if (row) await k.service.withdraw(actor(ALICE), row.id);
      },
    ],
  ])("returns null when %s", async (_name, change) => {
    const kit = buildKit();
    const p = await proposed(kit);
    await change(kit);
    expect(await kit.reader.forReview(actor(ALICE).orgId, p.id, m8)).toBeNull();
  });

  it("returns null for a missing request, the wrong target module and an unknown module", async () => {
    const kit = buildKit();
    const p = await proposed(kit);
    expect(
      await kit.reader.forReview(actor(ALICE).orgId, "00000000-0000-4000-8000-0000000000ee", m8),
    ).toBeNull();
    expect(await kit.reader.forReview(actor(ALICE).orgId, p.id, m14)).toBeNull();
    expect(
      await kit.reader.forReview(actor(ALICE).orgId, p.id, {
        targetModule: "m11" as never,
        reviewerUserId: CAROL,
      }),
    ).toBeNull();
  });

  it("returns null when the reviewer is denied by Part 2 or the gate throws", async () => {
    const denied = buildKit({ part2Denied: [`${CAROL}:${P1}`] });
    // The requester is not denied, so the request exists; only the reviewer is.
    const p1 = await proposed(denied);
    expect(await denied.reader.forReview(actor(ALICE).orgId, p1.id, m8)).toBeNull();
    const throwing = buildKit();
    const p2 = await proposed(throwing);
    const failing = buildKit({ part2Throws: true });
    failing.store.rows.set(p2.id, throwing.store.rows.get(p2.id) as never);
    expect(await failing.reader.forReview(actor(ALICE).orgId, p2.id, m8)).toBeNull();
  });

  it("returns null and an empty list when the tenant flag is off", async () => {
    const kit = buildKit({ flagOn: false });
    const p = await proposed(kit);
    expect(await kit.reader.enabled(actor(ALICE).orgId)).toBe(false);
    expect(await kit.reader.forReview(actor(ALICE).orgId, p.id, m8)).toBeNull();
    expect(
      await kit.reader.pendingForPatients(actor(ALICE).orgId, {
        ...m8,
        patientIds: [P1],
        limit: 5,
      }),
    ).toEqual([]);
  });
});

describe("ChartPromotionSourceReader.pendingForPatients", () => {
  it("lists metadata only (no text, no hash) for the target module", async () => {
    const kit = buildKit();
    await proposed(kit);
    const rows = await kit.reader.pendingForPatients(actor(ALICE).orgId, {
      ...m8,
      patientIds: [P1],
      limit: 5,
    });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain("snapshotText");
    expect(Object.keys(rows[0] ?? {})).not.toContain("sourceBodySha256");
    expect(
      await kit.reader.pendingForPatients(actor(ALICE).orgId, {
        ...m14,
        patientIds: [P1],
        limit: 5,
      }),
    ).toEqual([]);
  });

  it("omits a patient the reviewer fails the Part 2 gate for, and an unknown module", async () => {
    const kit = buildKit({ part2Denied: [`${CAROL}:${P1}`] });
    await proposed(kit);
    expect(
      await kit.reader.pendingForPatients(actor(ALICE).orgId, {
        ...m8,
        patientIds: [P1],
        limit: 5,
      }),
    ).toEqual([]);
    expect(
      await buildKit().reader.pendingForPatients(actor(ALICE).orgId, {
        targetModule: "m11" as never,
        patientIds: [P1],
        reviewerUserId: CAROL,
        limit: 5,
      }),
    ).toEqual([]);
  });
});
