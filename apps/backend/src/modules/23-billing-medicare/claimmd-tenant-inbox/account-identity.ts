import { baaEnded } from "../tenant-clearinghouse/baa";

export type TenantClaimMdUsage = "test" | "production";

export interface TenantClaimMdConfigFact {
  readonly id: string;
  readonly organizationId: string;
  readonly vendor: string;
  readonly mode: string | null;
  readonly status: string;
  readonly baaVerifiedAt: Date | null;
  readonly baaRevokedAt: Date | null;
  /** The last day the recorded BAA is in force (CW-AC-17); null = no end date stated. Required: a projection that omits it would skip the check. */
  readonly baaExpiresOn: string | null;
  readonly credentialFingerprint: string | null;
  readonly credentialFingerprintKeyId: string | null;
}

export interface TenantClaimMdAccountFact {
  readonly id: string;
  readonly organizationId: string;
  readonly tenantConfigId: string;
  readonly usage: TenantClaimMdUsage;
  readonly state: "verified" | "retired";
  readonly coverageStartedAt: Date;
}

export interface TenantClaimMdCredentialBindingFact {
  readonly accountId: string;
  readonly organizationId: string;
  readonly usage: TenantClaimMdUsage;
  readonly credentialFingerprint: string;
  readonly fingerprintKeyId: string;
}

export type TenantClaimMdAccountResolution =
  | { readonly ok: true; readonly account: TenantClaimMdAccountFact }
  | {
      readonly ok: false;
      readonly code:
        | "TENANT_ACCOUNT_UNKNOWN"
        | "TENANT_ACCOUNT_WRONG_ORGANIZATION"
        | "TENANT_ACCOUNT_NOT_ACTIVE"
        | "TENANT_ACCOUNT_NOT_CLAIMMD"
        | "TENANT_ACCOUNT_USAGE_MISMATCH"
        | "TENANT_ACCOUNT_IDENTITY_MISSING"
        | "TENANT_ACCOUNT_IDENTITY_AMBIGUOUS"
        | "TENANT_ACCOUNT_IDENTITY_RETIRED"
        | "TENANT_ACCOUNT_CREDENTIAL_UNVERIFIED"
        | "PLATFORM_ACCOUNT_NOT_TENANT_OWNED";
    };

/** Resolver over authoritative config and operator-verified identity rows; no API key or payer id is an identity. */
export function resolveTenantClaimMdAccount(input: {
  /** The Eastern day (`YYYY-MM-DD`) the recorded BAA's end date is judged against (CW-AC-17). */
  readonly today: string;
  readonly organizationId: string;
  readonly usage: TenantClaimMdUsage;
  readonly config: TenantClaimMdConfigFact | null;
  readonly identities: readonly TenantClaimMdAccountFact[];
  readonly credentialBindings: readonly TenantClaimMdCredentialBindingFact[];
}): TenantClaimMdAccountResolution {
  const { config } = input;
  if (!config) return { ok: false, code: "TENANT_ACCOUNT_UNKNOWN" };
  if (config.organizationId !== input.organizationId)
    return { ok: false, code: "TENANT_ACCOUNT_WRONG_ORGANIZATION" };
  if (config.vendor !== "claimmd") {
    return {
      ok: false,
      code:
        config.vendor === "platform"
          ? "PLATFORM_ACCOUNT_NOT_TENANT_OWNED"
          : "TENANT_ACCOUNT_NOT_CLAIMMD",
    };
  }
  if (
    config.status !== "active" ||
    !config.baaVerifiedAt ||
    config.baaRevokedAt ||
    baaEnded(config.baaExpiresOn, input.today)
  )
    return { ok: false, code: "TENANT_ACCOUNT_NOT_ACTIVE" };
  if (config.mode !== input.usage) return { ok: false, code: "TENANT_ACCOUNT_USAGE_MISMATCH" };
  const matching = input.identities.filter(
    (identity) =>
      identity.organizationId === input.organizationId &&
      identity.tenantConfigId === config.id &&
      identity.usage === input.usage,
  );
  if (matching.length === 0) return { ok: false, code: "TENANT_ACCOUNT_IDENTITY_MISSING" };
  const verified = matching.filter((identity) => identity.state === "verified");
  if (verified.length > 1) return { ok: false, code: "TENANT_ACCOUNT_IDENTITY_AMBIGUOUS" };
  const account = verified[0];
  if (!account) return { ok: false, code: "TENANT_ACCOUNT_IDENTITY_RETIRED" };
  const credentialBound = input.credentialBindings.some(
    (binding) =>
      binding.accountId === account.id &&
      binding.organizationId === input.organizationId &&
      binding.usage === input.usage &&
      binding.credentialFingerprint === config.credentialFingerprint &&
      binding.fingerprintKeyId === config.credentialFingerprintKeyId,
  );
  if (!config.credentialFingerprint || !config.credentialFingerprintKeyId || !credentialBound)
    return { ok: false, code: "TENANT_ACCOUNT_CREDENTIAL_UNVERIFIED" };
  return { ok: true, account };
}
