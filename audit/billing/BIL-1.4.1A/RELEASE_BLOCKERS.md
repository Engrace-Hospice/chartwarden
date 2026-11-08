# Release blockers

- Do not activate ownership resolution, ERA capture, staging, or posting until the private PostgreSQL migration/RLS suite runs with the repository's real NOBYPASSRLS roles on a dedicated cluster.
- The new resolution store needs DB-backed tests for exact account/environment scope, digest/decryption failures, repeated writes, sticky owner changes, history versioning, and concurrent re-resolution.
- Synthetic Claim.MD evidence is unavailable here; production/test API payload parity, source cursor behavior, and parser behavior on vendor-specific 835 variants remain uncertified.
- The matching history is intentionally limited to Claim.MD immutable send evidence. External claims remain unmatched; no portal/manual owner mapping is implemented.
- Current M1 location relationship is validated, while historical provider identity comes from immutable send evidence. If current M1 association changed, the old location evidence is held out; operator review is needed for those cases.
- BIL-1.4.1B must revalidate source digest, resolution version, algorithm version, verified owner and claim outcomes before tenant staging. No staging delivery is connected in this phase.
- Independent code/security review is required before opening a PR under repository policy.
