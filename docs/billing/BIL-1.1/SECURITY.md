# Security and data handling

- The new tables contain no `organization_id`; an account response may concern any tenant, so exposing it through ordinary tenant queries would be unsafe. The migration FORCEs RLS and grants access only to a `NOLOGIN NOBYPASSRLS` `claimmd_capture` role. The app role receives no grants or policy.
- Access in code is through `withPlatformContext` and the injected `PlatformBypassAuditor`, with fixed job identity. The database role membership is conditional on `chartwarden_platform` existing at migration time. This code is inactive until platform-context registration and role binding are verified in the actual deployment topology.
- Full vendor pages are encrypted with AES-256-GCM; stream ID and cursor are authenticated as AAD. Encryption key material is injected. This change does not load keys from environment/configuration, provision a KMS key, rotate keys, or wire key recovery. Do not activate until those controls exist.
- Logs expose bounded counts and stable error codes only; exceptions do not copy vendor body/message text. The reader preserves raw response content only inside the encrypted batch. No payload is printed in tests/docs.
- Event metadata carries digests, indexes, response IDs and capture states; it does not contain raw vendor message fields. It can still be sensitive operational metadata and needs retention/access auditing.
- No runtime SQL/RLS certification was performed. `FORCE ROW LEVEL SECURITY` and grants in migration source are evidence of intended controls, not proof against superuser/bypass role behavior, table ownership, or actual deployment grants.
- No secrets, PHI, account keys, or production payloads were read, emitted, or transacted.
