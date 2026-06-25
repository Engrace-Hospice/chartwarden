// @wardenx/saas-tenant-platform — the `TenantOrgCreationProvider` FORWARD seam (M34 §2.5 r2 / §7.1 step 3).
//
// The second seam M34 CONSUMES rather than publishes (the M35 `TenantSubscriptionEntitlementReader`
// being the first): the M2 organization-creation surface the `tenant.provision` worker needs at step 3
// (§7.1 step 2 / the provision-worker `ensureOrganization` port) to mint / attach the per-tenant M2
// `organization` row. M2 owns no public `createOrganization` surface today — so, exactly like the M35
// entitlement reader, this ships a DENY-STUB that resolves `{ kind: 'unavailable', reason:
// 'm2_org_creation_not_yet_locked' }`. The provision worker branches on `kind` and degrades cleanly
// (it never fabricates an org id, never fails open) until M2 registers the real provider over the stub.
//
// WHY A SEAM, NOT AN EDGE (M34 dependsOn [1,2,3,4,36] — the M2 edge already exists, but there is no
// `createOrganization` import target): M34 reaches M2's org-creation through this published interface +
// `getTenantOrgCreationProvider()` rather than a direct import of an M2 internal, mirroring how the
// provision worker reaches every other module through an injected port the boot wiring binds to a seam /
// outbox. The rich-seam deny-stub-proxy pattern (interface in the CONSUMING package; the M34 registry
// holds the live instance; a fail-closed deny-stub default applies until the owner registers) is the
// @wardenx/mdm forward-seam / M35 `TenantSubscriptionEntitlementReader` convention applied to M2.

/** The intent the provision worker hands M2 to create / attach the per-tenant organization (§7.1 step 3).
 *  PHI-free: every field is resolved by the platform-ops route that enqueued the provision job. The
 *  pre-created `organizationId` is the Phase-1 spine (the route mints the org row first, so this is an
 *  idempotent confirm); the field exists so the Phase-3 self-serve path (org minted at provision time)
 *  binds the SAME provider. */
export interface TenantOrgCreationIntent {
  readonly tenantAccountId: string;
  /** The org spine pre-created by the §7.1 step-1 route (Phase 1); the create site for Phase-3 self-serve. */
  readonly organizationId: string;
  readonly legalBusinessName: string;
}

/** The discriminated result of an org-creation request. `unavailable` is the forward-state answer until
 *  M2 locks the `createOrganization` surface; `available` carries the (created or confirmed) M2 org id. */
export type TenantOrgCreationResult =
  | { readonly kind: "available"; readonly organizationId: string }
  | { readonly kind: "unavailable"; readonly reason: "m2_org_creation_not_yet_locked" };

/**
 * The forward seam M34's provision worker consumes from M2 (§2.5 r2 / §7.1 step 3). Deny-stub today —
 * see {@link denyStubTenantOrgCreationProvider}. M2 registers the real provider over the stub when its
 * `createOrganization` surface locks; M34 adds no direct M2-internal import and no new `dependsOn` edge.
 */
export interface TenantOrgCreationProvider {
  /** Create / attach the M2 organization for the tenant (SELECT-then-create; idempotent confirm in
   *  Phase 1). Resolves `unavailable` until M2 registers the real provider — never fabricates an id. */
  createOrganizationForTenant(intent: TenantOrgCreationIntent): Promise<TenantOrgCreationResult>;
}

/**
 * The deny-stub proxy. Returns `{ kind: 'unavailable', reason: 'm2_org_creation_not_yet_locked' }` for
 * every intent until M2 locks its `createOrganization` surface and registers the real provider over it.
 * The provision worker branches on `kind` and degrades cleanly (never fails open on org creation). This
 * is the value the M34 registry holds for `TenantOrgCreationProvider` until M2 ships its implementation.
 */
export const denyStubTenantOrgCreationProvider: TenantOrgCreationProvider = {
  async createOrganizationForTenant(
    _intent: TenantOrgCreationIntent,
  ): Promise<TenantOrgCreationResult> {
    return { kind: "unavailable", reason: "m2_org_creation_not_yet_locked" };
  },
};
