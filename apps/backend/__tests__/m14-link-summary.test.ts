// WP 3.2 read seam: IdgScheduleProvider.linkSummary / meetingLocation over the in-memory M14 store.
import type { IdgMeetingId, IsoInstant } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { createIdgScheduleProvider } from "../src/modules/14-idg/seams/providers";
import { createInMemoryIdgSeamStore } from "../src/modules/14-idg/seams/store";

const provider = () =>
  createIdgScheduleProvider(
    createInMemoryIdgSeamStore({
      linkMeetings: [
        {
          organizationId: "o1",
          id: "m-1" as IdgMeetingId,
          status: "scheduled",
          scheduledStart: "2026-03-01T10:00:00.000Z" as IsoInstant,
          locationId: "loc-1",
        },
      ],
    }).store,
  );

describe("IdgScheduleProvider.linkSummary", () => {
  it("returns exactly four keys with a null patientId and scheduled_start as occurredAt", async () => {
    const r = await provider().linkSummary("o1", "m-1");
    expect(r).toEqual({
      id: "m-1",
      patientId: null,
      status: "scheduled",
      occurredAt: "2026-03-01T10:00:00.000Z",
    });
    expect(Object.keys(r ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
  });

  it("returns null for an unknown id and for another org's meeting", async () => {
    expect(await provider().linkSummary("o1", "nope")).toBeNull();
    expect(await provider().linkSummary("o2", "m-1")).toBeNull();
  });

  it("throws on a blank org or id", async () => {
    await expect(provider().linkSummary(" ", "m-1")).rejects.toThrow();
    await expect(provider().linkSummary("o1", "")).rejects.toThrow();
  });
});

describe("IdgScheduleProvider.meetingLocation", () => {
  it("returns the location, null for unknown/wrong org, and throws on blank", async () => {
    expect(await provider().meetingLocation("o1", "m-1")).toBe("loc-1");
    expect(await provider().meetingLocation("o1", "nope")).toBeNull();
    expect(await provider().meetingLocation("o2", "m-1")).toBeNull();
    await expect(provider().meetingLocation("", "m-1")).rejects.toThrow();
    await expect(provider().meetingLocation("o1", " ")).rejects.toThrow();
  });
});
