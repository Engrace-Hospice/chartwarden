// M5 MbiUnlockReader — the disclosure context is ids-only, so a malformed one is refused BEFORE any DB read.
import { describe, expect, it } from "vitest";
import { buildMbiUnlockReader } from "../mbi-unlock-reader";

const UUID = "11111111-1111-4111-8111-111111111111";

/** A db that fails the test if anything touches it: proves the refusal happens before any read. */
const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be touched");
    },
  },
) as never;

const base = {
  organizationId: UUID,
  patientId: UUID,
  onDate: "2026-10-01",
};

describe("buildMbiUnlockReader disclosure validation", () => {
  const reader = buildMbiUnlockReader(untouchableDb);

  it.each([
    [
      "a non-uuid correlationId",
      { purpose: "hets_270_eligibility", subjectId: UUID, correlationId: "MBI-1EG4-TE5-MK73" },
      /correlationId/,
    ],
    [
      "a non-uuid subjectId",
      { purpose: "hets_270_eligibility", subjectId: "not-a-uuid" },
      /subjectId/,
    ],
    [
      "a non-uuid actorUserId",
      { purpose: "hets_270_eligibility", subjectId: UUID, actorUserId: "bob" },
      /actorUserId/,
    ],
    ["an unknown purpose", { purpose: "free text", subjectId: UUID }, /purpose/],
  ])("refuses %s before any DB read", async (_name, disclosure, message) => {
    await expect(
      reader.unlockForEligibility({ ...base, disclosure: disclosure as never }),
    ).rejects.toThrow(message);
  });
});
