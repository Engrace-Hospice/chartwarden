import { describe, expect, it } from "vitest";
import {
  type M40PhysicianReader,
  buildM23ClinicalParticipantsAdapter,
} from "../services/claim-assembly-seam-adapters";

describe("buildM23ClinicalParticipantsAdapter — physician names for the claim snapshot", () => {
  const range = {
    forRange: async () => ({
      admission: { hospicePhysicianId: "doc-h" },
      electionPeriods: [{ attendingPhysicianId: "doc-a" }],
      levelOfCarePeriods: [],
    }),
  };
  const m40: M40PhysicianReader = {
    resolvePhysician: async (_org, id) =>
      id === "doc-a"
        ? {
            canonical: { identifierValue: "1234567893", firstName: "Ada", lastName: "Lovelace" },
            status: "active",
          }
        : { canonical: { identifierValue: "1982736455" }, status: "active" },
  };

  it("carries the M40 canonical first / last name through, and omits them when M40 has none", async () => {
    const adapter = buildM23ClinicalParticipantsAdapter(range as never, () => m40);
    const r = await adapter.resolveClinicalParticipants("org", "pat", "2026-01-01");
    expect(r.attending).toMatchObject({
      npi: "1234567893",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(r.hospicePhysician?.npi).toBe("1982736455");
    expect(r.hospicePhysician).not.toHaveProperty("firstName");
  });
});
