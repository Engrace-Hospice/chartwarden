# Security and tenancy

- Candidate data is privileged central account data. Reads run through `withPlatformContext` with `CLAIMMD_IDENTITY_JOB_ID` and `m34PlatformBypassAuditor`; each cross-tenant operation creates the repository's mandatory platform bypass audit event.
- Migration 1353 extends the existing non-login `claimmd_capture` role with narrowly selected source columns and read policies. It grants no application route or tenant user access. `chartwarden_platform` inherits the integration role from 1350; no new BYPASSRLS role was added.
- Evidence and receipt reads are account/environment filtered and linked by evidence UUID. M23/M41 source rows, provider ownership, and location-provider association are independently checked. Account-wide inbox data does not supply WardenX organization/provider/claim authority.
- Candidate query limits at 100; overflow is ambiguous. Search uses exact indexed identifiers or PCN; no all-claims scan. It performs two bounded round trips for evidence and observations, not per-candidate N+1 calls.
- TIN remains ciphertext in DB. AES-GCM uses the existing tenant DEK provider with evidence/org/provider/attempt AAD. Decrypt errors are caught and converted to a safe retry classification. Plaintext is not returned in the resolution record or logs. TIN comparison uses `timingSafeEqual` when lengths match.
- A protected inbox keyring is read from `CLAIMMD_RESPONSE_INBOX_KEYRING`; values are not printed in docs. Missing/invalid keyring blocks explicitly enabled worker startup. Key IDs allow historical decryption while retaining active key rotation.
- Requeue is internal store functionality with safe enumerated reason and actor UUID; no HTTP route was added. It is audited and preserves prior history. Tenant APIs cannot access central resolution rows.
- No resolution path can update M23/M41 claims, acknowledgment rows, M25 remittance, or payments.

## Runtime certification gap

The static RLS/policy/grant review is not a live security test. No private PostgreSQL instance was available/used in this task; the shared `os-postgres-1` cluster remains prohibited for live suites. Run as real NOBYPASSRLS `chartwarden_app` for denial probes and as the least-privilege platform runtime login for central resolver queries. The platform credential's exact deployed grants were not inspected in a live database.
