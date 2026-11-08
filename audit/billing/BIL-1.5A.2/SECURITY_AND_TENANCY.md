# Security and tenancy

- Evidence is tenant-scoped with `organization_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and `app.org_id` policy. App role gets only `SELECT, INSERT`.
- Evidence rows are immutable; receipt observations are append-only. Audit triggers omit the plaintext TIN (only ciphertext is persisted) and scrub it defensively.
- Evidence records contain original organization/provider/notice/submission identity, account reference and test/production usage. The unique key is tenant + submission ID; receipt FK includes evidence, tenant, account and usage.
- Cross-tenant identity is never derived from a PCN, notice control number, patient, or file ID. No tenant API to the central Claim.MD inbox was added.
- TIN is parsed from final outbound bytes and encrypted with tenant DEK and notice-specific AAD; absent key/encryption, reservation fails before transport.
- NOE/NOTR worker attempts are checked against organization, kind, and exact notice ID. Transfer retains its existing attempt association check.
- No claim resolver or acknowledgment state mapping was changed.

Database RLS, trigger and grant behavior has source-level checks only; isolated PostgreSQL runtime certification remains outstanding for BIL-1.5B.
