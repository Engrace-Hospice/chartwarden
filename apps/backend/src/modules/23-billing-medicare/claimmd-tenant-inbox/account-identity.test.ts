import { describe, expect, it } from "vitest";
import { resolveTenantClaimMdAccount } from "./account-identity";

const organizationId = "00000000-0000-4000-8000-000000000001";
/** The Eastern day the recorded BAA's end date is judged against: a value the test sets, not the wall clock. */
const TODAY = "2026-11-26";
const config = {
  id: "00000000-0000-4000-8000-000000000002",
  organizationId,
  vendor: "claimmd",
  mode: "production",
  status: "active",
  baaVerifiedAt: new Date("2026-01-01T00:00:00Z"),
  baaRevokedAt: null,
  baaExpiresOn: null,
  credentialFingerprint: "a".repeat(64),
  credentialFingerprintKeyId: "fingerprint-k1",
};
const identity = {
  id: "00000000-0000-4000-8000-000000000003",
  organizationId,
  tenantConfigId: config.id,
  usage: "production" as const,
  state: "verified" as const,
  coverageStartedAt: new Date("2026-02-01T00:00:00Z"),
};
const binding = {
  accountId: identity.id,
  organizationId,
  usage: "production" as const,
  credentialFingerprint: config.credentialFingerprint,
  fingerprintKeyId: config.credentialFingerprintKeyId,
};

describe("a recorded BAA that ended is out of service for the inbox too (CW-AC-17)", () => {
  const resolveOn = (today: string, baaExpiresOn: string | null) =>
    resolveTenantClaimMdAccount({
      today,
      organizationId,
      usage: "production",
      config: { ...config, baaExpiresOn },
      identities: [identity],
      credentialBindings: [binding],
    });

  it("resolves on the last day in force and fails closed from the day after", () => {
    expect(resolveOn("2026-12-31", "2026-12-31")).toMatchObject({ ok: true });
    expect(resolveOn("2027-01-01", "2026-12-31")).toEqual({
      ok: false,
      code: "TENANT_ACCOUNT_NOT_ACTIVE",
    });
  });

  it("never ends a BAA that states no end date", () => {
    expect(resolveOn("2099-01-01", null)).toMatchObject({ ok: true });
  });
});

describe("tenant Claim.MD external account identity", () => {
  it("resolves only the verified identity attached to active same-tenant Claim.MD configuration", () => {
    expect(
      resolveTenantClaimMdAccount({
        today: TODAY,
        organizationId,
        usage: "production",
        config,
        identities: [identity],
        credentialBindings: [binding],
      }),
    ).toEqual({
      ok: true,
      account: identity,
    });
  });

  it.each([
    [null, "TENANT_ACCOUNT_UNKNOWN"],
    [
      { ...config, organizationId: "00000000-0000-4000-8000-000000000099" },
      "TENANT_ACCOUNT_WRONG_ORGANIZATION",
    ],
    [{ ...config, vendor: "stedi" }, "TENANT_ACCOUNT_NOT_CLAIMMD"],
    [{ ...config, status: "draft" }, "TENANT_ACCOUNT_NOT_ACTIVE"],
    [{ ...config, baaRevokedAt: new Date() }, "TENANT_ACCOUNT_NOT_ACTIVE"],
    [{ ...config, mode: "test" }, "TENANT_ACCOUNT_USAGE_MISMATCH"],
  ] as const)("fails closed for invalid account source (%s)", (badConfig, code) => {
    expect(
      resolveTenantClaimMdAccount({
        today: TODAY,
        organizationId,
        usage: "production",
        config: badConfig,
        identities: [identity],
        credentialBindings: [binding],
      }),
    ).toEqual({
      ok: false,
      code,
    });
  });

  it("does not infer identity from configuration or credentials and rejects missing, retired, or ambiguous identity rows", () => {
    expect(
      resolveTenantClaimMdAccount({
        today: TODAY,
        organizationId,
        usage: "production",
        config,
        identities: [],
        credentialBindings: [],
      }),
    ).toMatchObject({
      ok: false,
      code: "TENANT_ACCOUNT_IDENTITY_MISSING",
    });
    expect(
      resolveTenantClaimMdAccount({
        today: TODAY,
        organizationId,
        usage: "production",
        config,
        identities: [{ ...identity, state: "retired" }],
        credentialBindings: [binding],
      }),
    ).toMatchObject({
      ok: false,
      code: "TENANT_ACCOUNT_IDENTITY_RETIRED",
    });
    expect(
      resolveTenantClaimMdAccount({
        today: TODAY,
        organizationId,
        usage: "production",
        config,
        identities: [identity, { ...identity, id: "another" }],
        credentialBindings: [binding],
      }),
    ).toMatchObject({
      ok: false,
      code: "TENANT_ACCOUNT_IDENTITY_AMBIGUOUS",
    });
    expect(
      resolveTenantClaimMdAccount({
        today: TODAY,
        organizationId,
        usage: "production",
        config: { ...config, credentialFingerprint: "b".repeat(64) },
        identities: [identity],
        credentialBindings: [binding],
      }),
    ).toMatchObject({
      ok: false,
      code: "TENANT_ACCOUNT_CREDENTIAL_UNVERIFIED",
    });
  });

  it("keeps the same logical account across an explicitly verified credential rotation", () => {
    const rotatedConfig = {
      ...config,
      credentialFingerprint: "b".repeat(64),
      credentialFingerprintKeyId: "fingerprint-k2",
    };
    const rotatedBinding = {
      ...binding,
      credentialFingerprint: rotatedConfig.credentialFingerprint,
      fingerprintKeyId: rotatedConfig.credentialFingerprintKeyId,
    };
    expect(
      resolveTenantClaimMdAccount({
        today: TODAY,
        organizationId,
        usage: "production",
        config: rotatedConfig,
        identities: [identity],
        credentialBindings: [rotatedBinding],
      }),
    ).toEqual({ ok: true, account: identity });
    expect(
      resolveTenantClaimMdAccount({
        today: TODAY,
        organizationId,
        usage: "production",
        config: rotatedConfig,
        identities: [identity],
        credentialBindings: [binding],
      }),
    ).toMatchObject({ ok: false, code: "TENANT_ACCOUNT_CREDENTIAL_UNVERIFIED" });
  });
});
