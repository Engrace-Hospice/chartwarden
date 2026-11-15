import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import {
  type TenantClaimMdAccountResolution,
  type TenantClaimMdUsage,
  resolveTenantClaimMdAccount,
} from "./account-identity";

const C = schema.tenantClearinghouseConfig;
const A = schema.claimMdTenantResponseAccounts;
const Q = schema.claimMdTenantResponseAccountCredentials;

/** Resolves only an active Claim.MD tenant config with a separately operator-verified stable account id. */
export function createTenantClaimMdAccountIdentityStore(input: {
  readonly db: DbClient;
  readonly authorizeIdentityAdmin: (
    organizationId: string,
    membershipId: string,
  ) => Promise<boolean>;
}) {
  const { db } = input;
  return {
    async resolveForOrg(input: {
      readonly organizationId: string;
      readonly usage: TenantClaimMdUsage;
    }): Promise<TenantClaimMdAccountResolution> {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: "" },
        async (tx) => {
          const [config] = await tx
            .select({
              id: C.id,
              organizationId: C.organizationId,
              vendor: C.vendor,
              mode: C.mode,
              status: C.status,
              baaVerifiedAt: C.baaVerifiedAt,
              baaRevokedAt: C.baaRevokedAt,
              credentialFingerprint: C.credentialFingerprint,
              credentialFingerprintKeyId: C.credentialFingerprintKeyId,
            })
            .from(C)
            .where(eq(C.organizationId, input.organizationId))
            .limit(1);
          if (!config)
            return resolveTenantClaimMdAccount({
              ...input,
              config: null,
              identities: [],
              credentialBindings: [],
            });
          const identities = await tx
            .select({
              id: A.id,
              organizationId: A.organizationId,
              tenantConfigId: A.tenantConfigId,
              usage: A.usage,
              state: A.state,
              coverageStartedAt: A.coverageStartedAt,
            })
            .from(A)
            .where(
              and(
                eq(A.organizationId, input.organizationId),
                eq(A.tenantConfigId, config.id),
                eq(A.usage, input.usage),
              ),
            );
          const identityId = identities.find((identity) => identity.state === "verified")?.id;
          const credentialBindings = identityId
            ? await tx
                .select({
                  accountId: Q.accountId,
                  organizationId: Q.organizationId,
                  usage: Q.usage,
                  credentialFingerprint: Q.credentialFingerprint,
                  fingerprintKeyId: Q.fingerprintKeyId,
                })
                .from(Q)
                .where(
                  and(
                    eq(Q.organizationId, input.organizationId),
                    eq(Q.accountId, identityId),
                    eq(Q.usage, input.usage),
                  ),
                )
            : [];
          return resolveTenantClaimMdAccount({ ...input, config, identities, credentialBindings });
        },
      );
    },

    /** Internal, authorization-gated provisioning primitive. No credential or vendor ID is accepted. */
    async registerVerified(input: {
      readonly organizationId: string;
      readonly tenantConfigId: string;
      readonly usage: TenantClaimMdUsage;
      readonly verifiedByMembershipId: string;
      readonly verificationReference: string;
      readonly verifiedAt: Date;
      readonly coverageStartedAt: Date;
    }): Promise<string> {
      if (!(await argumentsAuthorize(input.organizationId, input.verifiedByMembershipId)))
        throw new Error("CLAIMMD_ACCOUNT_IDENTITY_FORBIDDEN");
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.verificationReference))
        throw new Error("CLAIMMD_ACCOUNT_VERIFICATION_REFERENCE_INVALID");
      if (input.coverageStartedAt > input.verifiedAt)
        throw new Error("CLAIMMD_ACCOUNT_COVERAGE_DATE_INVALID");
      const id = randomUUID();
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: input.verifiedByMembershipId },
        async (tx) => {
          const [config] = await tx
            .select({
              vendor: C.vendor,
              mode: C.mode,
              status: C.status,
              baaVerifiedAt: C.baaVerifiedAt,
              baaRevokedAt: C.baaRevokedAt,
              credentialFingerprint: C.credentialFingerprint,
              credentialFingerprintKeyId: C.credentialFingerprintKeyId,
            })
            .from(C)
            .where(and(eq(C.id, input.tenantConfigId), eq(C.organizationId, input.organizationId)))
            .for("update")
            .limit(1);
          if (
            !config ||
            config.vendor !== "claimmd" ||
            config.mode !== input.usage ||
            config.status !== "active" ||
            !config.baaVerifiedAt ||
            config.baaRevokedAt ||
            !config.credentialFingerprint ||
            !config.credentialFingerprintKeyId
          )
            throw new Error("CLAIMMD_TENANT_CONFIG_NOT_ELIGIBLE");
          const [row] = await tx
            .insert(A)
            .values({
              id,
              organizationId: input.organizationId,
              tenantConfigId: input.tenantConfigId,
              vendor: "claimmd",
              usage: input.usage,
              state: "verified",
              verifiedByMembershipId: input.verifiedByMembershipId,
              verificationReference: input.verificationReference,
              verifiedAt: input.verifiedAt,
              coverageStartedAt: input.coverageStartedAt,
            })
            .returning({ id: A.id });
          if (!row) throw new Error("CLAIMMD_ACCOUNT_IDENTITY_WRITE_FAILED");
          await tx.insert(schema.claimMdTenantResponseAccountCredentials).values({
            organizationId: input.organizationId,
            accountId: row.id,
            usage: input.usage,
            credentialFingerprint: config.credentialFingerprint,
            fingerprintKeyId: config.credentialFingerprintKeyId,
            verifiedByMembershipId: input.verifiedByMembershipId,
            verificationReference: input.verificationReference,
            verifiedAt: input.verifiedAt,
          });
          return row.id;
        },
      );
    },

    /** Explicitly bind a rotated key to the same logical account; the account UUID and stored response history do not change. */
    async confirmCredentialRotation(input: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly tenantConfigId: string;
      readonly usage: TenantClaimMdUsage;
      readonly verifiedByMembershipId: string;
      readonly verificationReference: string;
      readonly verifiedAt: Date;
    }): Promise<void> {
      if (!(await argumentsAuthorize(input.organizationId, input.verifiedByMembershipId)))
        throw new Error("CLAIMMD_ACCOUNT_IDENTITY_FORBIDDEN");
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.verificationReference))
        throw new Error("CLAIMMD_ACCOUNT_VERIFICATION_REFERENCE_INVALID");
      await withOrgContext(
        db,
        { organizationId: input.organizationId, userId: input.verifiedByMembershipId },
        async (tx) => {
          const [account] = await tx
            .select({ id: A.id })
            .from(A)
            .where(
              and(
                eq(A.id, input.accountId),
                eq(A.organizationId, input.organizationId),
                eq(A.tenantConfigId, input.tenantConfigId),
                eq(A.usage, input.usage),
                eq(A.state, "verified"),
              ),
            )
            .for("update")
            .limit(1);
          const [config] = await tx
            .select({
              vendor: C.vendor,
              mode: C.mode,
              status: C.status,
              baaVerifiedAt: C.baaVerifiedAt,
              baaRevokedAt: C.baaRevokedAt,
              credentialFingerprint: C.credentialFingerprint,
              credentialFingerprintKeyId: C.credentialFingerprintKeyId,
            })
            .from(C)
            .where(and(eq(C.id, input.tenantConfigId), eq(C.organizationId, input.organizationId)))
            .for("update")
            .limit(1);
          if (
            !account ||
            !config ||
            config.vendor !== "claimmd" ||
            config.mode !== input.usage ||
            config.status !== "active" ||
            !config.baaVerifiedAt ||
            config.baaRevokedAt ||
            !config.credentialFingerprint ||
            !config.credentialFingerprintKeyId
          )
            throw new Error("CLAIMMD_TENANT_CONFIG_NOT_ELIGIBLE");
          await tx
            .insert(schema.claimMdTenantResponseAccountCredentials)
            .values({
              organizationId: input.organizationId,
              accountId: input.accountId,
              usage: input.usage,
              credentialFingerprint: config.credentialFingerprint,
              fingerprintKeyId: config.credentialFingerprintKeyId,
              verifiedByMembershipId: input.verifiedByMembershipId,
              verificationReference: input.verificationReference,
              verifiedAt: input.verifiedAt,
            })
            .onConflictDoNothing();
        },
      );
    },

    /** Retires but never deletes an account identity; caller must provide the exact previously reviewed id. */
    async retire(input: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly membershipId: string;
    }): Promise<boolean> {
      if (!(await argumentsAuthorize(input.organizationId, input.membershipId)))
        throw new Error("CLAIMMD_ACCOUNT_IDENTITY_FORBIDDEN");
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: input.membershipId },
        async (tx) => {
          const rows = await tx
            .update(A)
            .set({ state: "retired" })
            .where(
              and(
                eq(A.id, input.accountId),
                eq(A.organizationId, input.organizationId),
                eq(A.state, "verified"),
              ),
            )
            .returning({ id: A.id });
          return rows.length === 1;
        },
      );
    },
  };

  function argumentsAuthorize(organizationId: string, membershipId: string) {
    return input.authorizeIdentityAdmin(organizationId, membershipId);
  }
}
