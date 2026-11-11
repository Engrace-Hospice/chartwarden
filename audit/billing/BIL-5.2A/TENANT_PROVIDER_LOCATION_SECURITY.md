# Tenant, provider and location boundaries

The M23 projection starts from claim IDs returned by the existing organization/provider-scoped repository page. The M41 projection intersects the authorized/caseload-filtered claims with organization, provider and submission identity in its own service. M25 continues to use its organization/provider RLS-backed stage read and server-side location predicate. The authenticated actor context supplies provider and location choices; client query values do not create authority.

No cross-module SQL, central inbox query, tenant-visible quarantine count, or raw 835 projection was added. Application code inspection and existing provider-scope tests are not a substitute for the required integrated real-role HTTP/RLS test; that gate remains open.
