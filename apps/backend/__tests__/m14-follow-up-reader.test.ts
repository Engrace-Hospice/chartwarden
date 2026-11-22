// ADR-0114 S5b: IdgFollowUpReader.openFollowUpItems over the in-memory M14 store. Facts only, Part 2 decided per viewer (W-SUD-01), no membership = nothing.
import type { IsoInstant, PatientId } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import type { PacketDisclosurePort } from "../src/modules/14-idg/routes/packet-disclosure";
import {
  MAX_FOLLOW_UP_ITEMS,
  createIdgFollowUpReader,
} from "../src/modules/14-idg/seams/providers";
import { type IdgFollowUpRow, createInMemoryIdgSeamStore } from "../src/modules/14-idg/seams/store";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PATIENT = "00000000-0000-4000-8000-0000000000b1" as PatientId;
const ME = "00000000-0000-4000-8000-0000000000c1";
const VIEWER = { roles: ["rn"], membershipId: ME };

const item = (id: string, over: Partial<IdgFollowUpRow> = {}): IdgFollowUpRow => ({
  actionItemId: id,
  meetingAt: "2026-11-02T15:00:00.000Z" as IsoInstant,
  decisionKind: "referral",
  dueAt: "2026-11-20T08:00:00.000Z" as IsoInstant,
  status: "open",
  needsRelease: false,
  ...over,
});
const seeded = (rows: readonly IdgFollowUpRow[], patientId: PatientId = PATIENT, org = ORG) =>
  createInMemoryIdgSeamStore({
    followUps: rows.map((row) => ({
      organizationId: org,
      patientId,
      assigneeMembershipId: ME,
      row,
    })),
  }).store;

const disclosure = (
  allowed: boolean,
  restrictedToNamedWorkforce = false,
): PacketDisclosurePort => ({
  part2ReleaseActive: vi.fn(async () => ({ allowed, restrictedToNamedWorkforce })),
});

describe("IdgFollowUpReader.openFollowUpItems", () => {
  it("hands over the facts of the viewer's own items, newest meeting first, and nothing else", async () => {
    const reader = createIdgFollowUpReader(
      seeded([
        item("i-old", { meetingAt: "2026-10-01T15:00:00.000Z" as IsoInstant }),
        item("i-new", { decisionKind: "care_plan_update", dueAt: null, status: "in_progress" }),
      ]),
      disclosure(true),
    );

    const items = await reader.openFollowUpItems({
      organizationId: ORG,
      patientId: PATIENT,
      viewer: VIEWER,
    });

    expect(items.map((i) => i.actionItemId)).toEqual(["i-new", "i-old"]);
    expect(items[0]).toEqual({
      actionItemId: "i-new",
      meetingAt: "2026-11-02T15:00:00.000Z",
      decisionKind: "care_plan_update",
      dueAt: null,
      status: "in_progress",
      sudRelated: false,
    });
    for (const i of items) {
      expect(Object.keys(i).sort()).toEqual([
        "actionItemId",
        "decisionKind",
        "dueAt",
        "meetingAt",
        "status",
        "sudRelated",
      ]);
    }
  });

  it("answers nothing for a viewer with no membership, another patient and another organization", async () => {
    const reader = createIdgFollowUpReader(seeded([item("i-1")]), disclosure(true));
    expect(
      await reader.openFollowUpItems({
        organizationId: ORG,
        patientId: PATIENT,
        viewer: { roles: ["rn"], membershipId: null },
      }),
    ).toEqual([]);
    expect(
      await reader.openFollowUpItems({
        organizationId: ORG,
        patientId: "00000000-0000-4000-8000-0000000000b2" as PatientId,
        viewer: VIEWER,
      }),
    ).toEqual([]);
    expect(
      await reader.openFollowUpItems({
        organizationId: "00000000-0000-4000-8000-0000000000a2",
        patientId: PATIENT,
        viewer: VIEWER,
      }),
    ).toEqual([]);
  });

  it("never asks the Part 2 verdict while no item needs a release", async () => {
    const port = disclosure(false);
    const reader = createIdgFollowUpReader(seeded([item("i-1"), item("i-2")]), port);
    expect(
      (await reader.openFollowUpItems({ organizationId: ORG, patientId: PATIENT, viewer: VIEWER }))
        .length,
    ).toBe(2);
    expect(port.part2ReleaseActive).not.toHaveBeenCalled();
  });

  it("hands a flagged patient's item only to a viewer M39 clears, flagged Part 2, and asks the verdict once", async () => {
    const port = disclosure(true);
    const reader = createIdgFollowUpReader(
      seeded([item("i-1", { needsRelease: true }), item("i-2", { needsRelease: true })]),
      port,
    );
    const items = await reader.openFollowUpItems({
      organizationId: ORG,
      patientId: PATIENT,
      viewer: VIEWER,
    });
    expect(items.map((i) => [i.actionItemId, i.sudRelated])).toEqual([
      ["i-2", true],
      ["i-1", true],
    ]);
    expect(port.part2ReleaseActive).toHaveBeenCalledTimes(1);
    expect(port.part2ReleaseActive).toHaveBeenCalledWith({
      organizationId: ORG,
      patientId: PATIENT,
      membershipId: ME,
    });
  });

  it("hands a viewer M39 does not clear NOTHING for a flagged patient, no item and no count, and still lists the unflagged ones", async () => {
    const reader = createIdgFollowUpReader(
      seeded([item("i-flagged", { needsRelease: true }), item("i-clear")]),
      disclosure(false, true),
    );
    const items = await reader.openFollowUpItems({
      organizationId: ORG,
      patientId: PATIENT,
      viewer: VIEWER,
    });
    expect(items.map((i) => i.actionItemId)).toEqual(["i-clear"]);
  });

  it("fails closed when the consent evaluator throws (an outage never discloses)", async () => {
    const port: PacketDisclosurePort = {
      part2ReleaseActive: vi.fn(async () => {
        throw new Error("consent store down");
      }),
    };
    const reader = createIdgFollowUpReader(
      seeded([item("i-flagged", { needsRelease: true })]),
      port,
    );
    expect(
      await reader.openFollowUpItems({ organizationId: ORG, patientId: PATIENT, viewer: VIEWER }),
    ).toEqual([]);
  });

  it("asks the store for at most the candidate cap", async () => {
    const store = seeded(
      Array.from({ length: MAX_FOLLOW_UP_ITEMS + 5 }, (_, n) =>
        item(`i-${String(n).padStart(3, "0")}`),
      ),
    );
    const reader = createIdgFollowUpReader(store, disclosure(true));
    expect(
      (await reader.openFollowUpItems({ organizationId: ORG, patientId: PATIENT, viewer: VIEWER }))
        .length,
    ).toBe(MAX_FOLLOW_UP_ITEMS);
  });
});
