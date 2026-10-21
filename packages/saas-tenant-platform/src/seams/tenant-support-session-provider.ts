// @chartwarden/saas-tenant-platform — the `TenantSupportSessionProvider` seam (M34 §4.6).
//
// The read surface over platform-ops break-glass support sessions (`support_session` +
// `support_consent_grant`, §3.3) — tenant-consented, time-boxed access a platform-ops actor holds
// into a tenant org. Two consumers:
//   - M4's audit middleware enriches `actor_kind` on every PHI access by asking
//     {@link isActorInSupportSession} (so a break-glass read is stamped as such in the audit ledger).
//   - The §4.5 support-session distinct-actor ABAC predicate resolves a grant via {@link grantById}
//     to enforce grantor ≠ grantee (the consenting tenant admin cannot be the platform actor).
// The interface lives HERE in the feature package; the M1 registry holds the registered instance
// opaquely and validateSeams() fails closed at boot.

/** A resolved support-consent grant (§3.3) — the consenting tenant-admin membership, the tenant
 *  account it grants into, and when the grant expires. `null` from the resolver means no such grant. */
export interface SupportConsentGrant {
  readonly grantorMembershipId: string;
  readonly tenantAccountId: string;
  readonly expiresAt: Date;
}

/**
 * The boot-registered support-session read surface (§4.6). Consumed by M4 audit-actor enrichment and
 * the §4.5 distinct-actor predicate; never exposes PHI — only the grant envelope.
 */
export interface TenantSupportSessionProvider {
  /** Used by audit middleware to enrich the `actor_kind` field on PHI accesses — true when the actor
   *  holds an active (unexpired, consented) support session into the org. */
  isActorInSupportSession(actorMembershipId: string, orgId: string): Promise<boolean>;

  /** Used by the support-session distinct-actor predicate — resolves a grant by id, or `null` when no
   *  such grant exists (the predicate denies on `null`). */
  grantById(grantId: string): Promise<SupportConsentGrant | null>;
}
