export interface M34ShredPreflightFacts {
  readonly certificate: {
    readonly organizationId: string;
    readonly status: string;
    readonly method: string;
    readonly approvedBy: string | null;
  } | null;
  readonly activeLegalHold: boolean;
  readonly actorUserId: string | null;
  readonly tenantAccount: {
    readonly organizationId: string;
    readonly status: string;
    readonly retentionEndsAt: Date | null;
  } | null;
}

/** Pure safety gate evaluated immediately before any registered eraser or destructive primitive runs. */
export function assertM34ShredPreflight(
  orgId: string,
  facts: M34ShredPreflightFacts,
  now: Date,
): void {
  if (
    !facts.certificate ||
    facts.certificate.organizationId !== orgId ||
    facts.certificate.status !== "approved" ||
    !facts.certificate.approvedBy ||
    facts.certificate.method !== "crypto_erasure"
  ) {
    throw new Error("destruction certificate is not approved for tenant cryptographic erasure");
  }
  if (facts.activeLegalHold) {
    throw new Error("active legal hold blocks tenant cryptographic erasure");
  }
  if (!facts.actorUserId || facts.actorUserId === facts.certificate.approvedBy) {
    throw new Error("tenant shred requires a distinct approved-certificate co-signer");
  }
  if (
    !facts.tenantAccount ||
    facts.tenantAccount.organizationId !== orgId ||
    facts.tenantAccount.status !== "destruction_pending" ||
    !facts.tenantAccount.retentionEndsAt ||
    facts.tenantAccount.retentionEndsAt > now
  ) {
    throw new Error("tenant is not eligible for cryptographic erasure");
  }
}
