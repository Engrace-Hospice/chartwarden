// apps/backend/__tests__/hope-g2-twin-id-spelling.test.ts — the in-memory HOPE backend judges a caller's id on the spelling
// the database backend would: a uuid column compares case-insensitively, so a schedule id that arrives upper-cased in the
// request body names the same schedule. (backend-s1-19, class: caller-spelling keys. The in-memory `triggeringAssessmentId`
// compares already lower-cased; the `scheduleId` one did not.)
import { describe, expect, it } from "vitest";
import { createInMemoryHopeBackend } from "../src/modules/10-hope/index";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
// Hex letters on purpose: an upper-cased spelling differs from the stored one.
const SCHEDULE = "55555555-5555-4555-8555-5555555555ab";
const NOW = "2026-06-08T12:00:00.000Z";

function backend() {
  return createInMemoryHopeBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    admissionPatients: { [ADMISSION]: PATIENT },
    schedules: [
      {
        id: SCHEDULE,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        rfaKind: "02_huv1",
        status: "open",
        windowOpensAt: "2026-06-06T00:00:00.000Z",
        windowClosesAt: "2026-06-20T00:00:00.000Z",
        lateDeadlineAt: "2026-06-27T00:00:00.000Z",
      },
    ],
  });
}

const draftArgs = (scheduleId: string) => ({
  rfaKind: "02_huv1" as const,
  scheduleId,
  targetDate: NOW,
  authorDiscipline: "RN" as const,
  data: {},
});

describe("in-memory HOPE backend: a schedule id is matched on its canonical spelling", () => {
  it("records against the schedule when the body spells its id in upper case", async () => {
    const draft = await backend().recordTimepoint(
      ORG,
      "rn_1",
      ADMISSION,
      draftArgs(SCHEDULE.toUpperCase()),
    );

    expect(draft.status).toBe("draft");
  });

  it("still answers 404 for a schedule id that names no schedule of the admission", async () => {
    const other = "55555555-5555-4555-8555-5555555555cd";

    await expect(
      backend().recordTimepoint(ORG, "rn_1", ADMISSION, draftArgs(other)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
