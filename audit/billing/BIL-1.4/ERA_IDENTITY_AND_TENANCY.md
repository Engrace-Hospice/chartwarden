# ERA identity and tenancy

## Current code in this branch

`claimmd-era-routing.ts` requires exact NPI; a supplied TIN must also match. TIN-only identity is held because it may be shared. Duplicate NPI candidates are held. For a multi-component artifact, any differing tenant/provider or unresolved payee holds the whole artifact. The helper does not infer location. Duplicate logic marks exact source digest or ISA13/ST02 as exact duplicate and same payment trace digest plus exact integer minor units as a possible duplicate hold.

These are pure decision helpers. No X12 parser currently extracts payee loops into them, no M1 reader supplies candidate identities, and no M25 transaction persists the result. Historical provider evidence and submitted claim references are not consulted. The `providerEntityId` in stage schema is not backed by a cross-module FK, consistent with module ownership rules.

## Intended cardinalities

Tenant → many provider entities; tenant → many locations; a location may map to one foundation provider entity in the current M1 schema, while a provider entity can serve multiple locations. This branch does not introduce a new billing mapping/cardinality. Location is nullable in stage because payee identity alone does not prove a unique service location.

## Required next implementation

Use M1's owner-exported `FoundationSiteReader` under explicit per-organization RLS context to resolve exact billing facts; decrypt sealed TIN only in a narrowly scoped audited resolver. Apply candidate uniqueness at the NPI/provider level and require TIN consistency when present. Feed original M25 parsed transaction-set data and historical submission evidence into the resolution decision. If one source artifact spans tenant/provider identities, hold it as a whole unless M25 can preserve original balancing and provenance at an approved structural boundary.

No actual identifiers are included. Tests use synthetic identifiers only.
