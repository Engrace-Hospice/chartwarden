# Security and tenancy

The M25 review service reads only `claimmd_era_m25_stage` under organization context and enforces actor provider scope; there is no central inbox route. It decrypts after row scoping and returns an allowlisted projection. Capture uses the audited platform service context and central service role, exact account/environment stream, encrypted inbox, shared rate counter, and keyring preconditions. No auth boundary is inferred from request-supplied organization/provider values.

`1359` changes only the M25 parse-status enum. The tenant RLS/ownership model is unchanged. Database-enforced tenant isolation, grants, operator recovery authorization, and encrypted-key rotation need private PostgreSQL certification; the shared cluster must not be used.
