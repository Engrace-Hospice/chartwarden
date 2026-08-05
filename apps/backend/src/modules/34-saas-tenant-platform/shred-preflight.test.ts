import { describe, expect, it } from "vitest";
import { type M34ShredPreflightFacts, assertM34ShredPreflight } from "./shred-preflight";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const eligible = (): M34ShredPreflightFacts => ({
  certificate: {
    organizationId: "org-1",
    status: "approved",
    method: "crypto_erasure",
    approvedBy: "approver-user",
  },
  activeLegalHold: false,
  actorUserId: "cosigner-user",
  tenantAccount: {
    organizationId: "org-1",
    status: "destruction_pending",
    retentionEndsAt: new Date("2026-08-03T12:00:00.000Z"),
  },
});

describe("M34 shred preflight", () => {
  it("admits an eligible tenant with an approved certificate and distinct co-signer", () => {
    expect(() => assertM34ShredPreflight("org-1", eligible(), NOW)).not.toThrow();
  });

  it("fails closed while any legal hold is active", () => {
    expect(() =>
      assertM34ShredPreflight("org-1", { ...eligible(), activeLegalHold: true }, NOW),
    ).toThrow("active legal hold blocks");
  });

  it("rejects self-cosigned, unapproved, or not-yet-retained destruction", () => {
    const selfSigned = eligible();
    expect(() =>
      assertM34ShredPreflight(
        "org-1",
        { ...selfSigned, actorUserId: selfSigned.certificate?.approvedBy ?? null },
        NOW,
      ),
    ).toThrow("distinct approved-certificate co-signer");
    expect(() =>
      assertM34ShredPreflight(
        "org-1",
        { ...eligible(), certificate: { ...eligible().certificate!, status: "pending" } },
        NOW,
      ),
    ).toThrow("not approved");
    expect(() =>
      assertM34ShredPreflight(
        "org-1",
        {
          ...eligible(),
          tenantAccount: {
            ...eligible().tenantAccount!,
            retentionEndsAt: new Date("2026-08-05T12:00:00.000Z"),
          },
        },
        NOW,
      ),
    ).toThrow("not eligible");
  });
});
