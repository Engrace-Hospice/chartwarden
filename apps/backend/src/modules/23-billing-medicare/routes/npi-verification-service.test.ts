// The NPI-verification state is about the entity's CURRENT NPI only (ADR-0053 amendment precondition 2).
import { describe, expect, it } from "vitest";
import { deriveNpiVerification } from "./npi-verification-service";

const entity = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  organizationName: "Synthetic Org",
  legalName: "Synthetic Hospice",
  npi: "1234567893",
};
const at = (s: string) => new Date(`2026-11-0${s}T12:00:00Z`);
const row = (over: Partial<Parameters<typeof deriveNpiVerification>[1][number]>) => ({
  id: "r",
  organizationId: entity.organizationId,
  providerEntityId: entity.id,
  npi: entity.npi,
  evidence: "NPPES record matches",
  verifiedAt: at("1"),
  verifiedByMembershipId: "m1",
  revokedAt: null,
  revokedByMembershipId: null,
  createdAt: at("1"),
  updatedAt: at("1"),
  ...over,
});

describe("deriveNpiVerification", () => {
  it("is unverified with no row, or with only a live row for a previous NPI", () => {
    expect(deriveNpiVerification(entity, []).state).toBe("unverified");
    const stale = deriveNpiVerification(entity, [row({ npi: "1999999984" })]);
    expect(stale).toMatchObject({ state: "unverified", verificationId: null });
  });

  it("is verified by a live row for the current NPI, even when an older revoked row is newer in the list", () => {
    const view = deriveNpiVerification(entity, [
      row({ id: "old", revokedAt: at("3"), revokedByMembershipId: "m2", verifiedAt: at("3") }),
      row({ id: "live", verifiedAt: at("2") }),
    ]);
    expect(view).toMatchObject({ state: "verified", verificationId: "live" });
  });

  it("is revoked when the newest row for the current NPI is revoked, and names who revoked it", () => {
    const view = deriveNpiVerification(entity, [
      row({ id: "r2", revokedAt: at("4"), revokedByMembershipId: "m2" }),
    ]);
    expect(view).toMatchObject({
      state: "revoked",
      revokedByMembershipId: "m2",
      revokedAt: at("4").toISOString(),
    });
  });

  it("ignores another entity's rows", () => {
    const view = deriveNpiVerification(entity, [row({ providerEntityId: "other" })]);
    expect(view.state).toBe("unverified");
  });
});
