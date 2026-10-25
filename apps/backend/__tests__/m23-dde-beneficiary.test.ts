// #793 - the MBI seam of the DDE provider path: the only source is M5's audited unlock reader, the disclosure is
// purposed and id-only, and every refusal is a typed error that carries no identity.
import type { MbiUnlockReader } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  DDE_BENEFICIARY_NOT_ON_FILE,
  DDE_BENEFICIARY_UNAVAILABLE,
  UNBOUND_DDE_BENEFICIARY,
  buildDdeBeneficiaryPort,
} from "../src/modules/23-billing-medicare/services/dde-beneficiary";

const MBI = "1EG4TE5MK73";
const REQ = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  patientId: "22222222-2222-4222-8222-222222222222",
  ddeItemId: "33333333-3333-4333-8333-333333333333",
  actorUserId: "44444444-4444-4444-8444-444444444444",
  onDate: "2026-01-17",
};

function reader(result: "found" | "none" | "throws") {
  const inputs: Parameters<MbiUnlockReader["unlockForEligibility"]>[0][] = [];
  const r: MbiUnlockReader = {
    unlockForEligibility: async (input) => {
      inputs.push(input);
      if (result === "throws") throw new Error(`reader exploded with ${MBI}`);
      return result === "none"
        ? null
        : {
            patientPayerId: "p",
            mbi: MBI,
            lastName: "Doe",
            firstName: "Jane",
            dateOfBirth: "1950-01-01",
          };
    },
  };
  return { r, inputs };
}

describe("DDE beneficiary seam", () => {
  it("unlocks through the audited reader with the DDE purpose and the item as subject", async () => {
    const { r, inputs } = reader("found");
    const b = await buildDdeBeneficiaryPort(() => r).unlock({ ...REQ, correlationId: REQ.ddeItemId });
    expect(b).toEqual({ mbi: MBI, lastName: "Doe", firstName: "Jane", dateOfBirth: "1950-01-01" });
    expect(inputs[0]?.disclosure).toEqual({
      purpose: "dde_provider_operation",
      subjectId: REQ.ddeItemId,
      actorUserId: REQ.actorUserId,
      correlationId: REQ.ddeItemId,
    });
  });

  it("drops a correlation id that is not uuid-shaped instead of letting the reader refuse the unlock", async () => {
    const { r, inputs } = reader("found");
    await buildDdeBeneficiaryPort(() => r).unlock({ ...REQ, correlationId: "req-123" });
    expect(inputs[0]?.disclosure.correlationId).toBeUndefined();
  });

  it("refuses with a typed 422 when no MBI is on file", async () => {
    const { r } = reader("none");
    await expect(buildDdeBeneficiaryPort(() => r).unlock(REQ)).rejects.toMatchObject({
      code: DDE_BENEFICIARY_NOT_ON_FILE,
      statusCode: 422,
    });
  });

  it("fails closed without echoing the reader's error text", async () => {
    const { r } = reader("throws");
    const err = await buildDdeBeneficiaryPort(() => r)
      .unlock(REQ)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: DDE_BENEFICIARY_UNAVAILABLE, statusCode: 503 });
    expect(JSON.stringify({ message: (err as Error).message, err })).not.toContain(MBI);
  });

  it("the unbound default refuses", async () => {
    await expect(UNBOUND_DDE_BENEFICIARY.unlock(REQ)).rejects.toMatchObject({
      code: DDE_BENEFICIARY_UNAVAILABLE,
    });
  });
});
