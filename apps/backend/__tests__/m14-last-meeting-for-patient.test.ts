// WP 3.1 read seam: IdgScheduleProvider.getLastMeetingForPatient over the in-memory M14 store.
import type { IdgMeetingId, IsoInstant, PatientId } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { createIdgScheduleProvider } from "../src/modules/14-idg/seams/providers";
import { createInMemoryIdgSeamStore } from "../src/modules/14-idg/seams/store";

const P = "p-1" as PatientId;
const row = (org: string, patientId: PatientId, id: string, heldAt: string) => ({
  organizationId: org,
  patientId,
  meetingId: id as IdgMeetingId,
  heldAt: heldAt as IsoInstant,
  status: "adjourned" as const,
});

describe("IdgScheduleProvider.getLastMeetingForPatient", () => {
  it("returns the most recent meeting with asOf and no free text", async () => {
    const { store } = createInMemoryIdgSeamStore({
      lastMeetings: [
        row("o1", P, "m-old", "2026-01-01T10:00:00.000Z"),
        row("o1", P, "m-new", "2026-02-01T10:00:00.000Z"),
      ],
    });
    const r = await createIdgScheduleProvider(store).getLastMeetingForPatient("o1", P);
    expect(r?.meetingId).toBe("m-new");
    expect(r?.status).toBe("adjourned");
    expect(Number.isNaN(Date.parse(r?.asOf ?? ""))).toBe(false);
    expect(Object.keys(r ?? {}).sort()).toEqual(["asOf", "heldAt", "meetingId", "status"]);
  });

  it("returns null when only another org's or patient's meetings exist", async () => {
    const { store } = createInMemoryIdgSeamStore({
      lastMeetings: [
        row("o2", P, "m-x", "2026-02-01T10:00:00.000Z"),
        row("o1", "p-2" as PatientId, "m-y", "2026-02-01T10:00:00.000Z"),
      ],
    });
    expect(await createIdgScheduleProvider(store).getLastMeetingForPatient("o1", P)).toBeNull();
  });
});
