# BIL-1.2.2B handoff

Use the BIL-1.2.2A evidence UUID as the join anchor for response identity resolution. Required incoming response processing should:

1. Capture the entire account-scoped Claim.MD response page into a durable immutable inbox before advancing its account/environment cursor.
2. Keep malformed, unresolved, duplicate, and ambiguous records in the inbox/quarantine; never silently drop them or attribute by polling caller.
3. Resolve only by account reference + test/production usage + stored vendor identifier/control evidence, then validate provider/entity/org and immutable submission evidence. Remote identifiers are not tenant authority.
4. Preserve origin and raw status vocabulary. Do not synthesize a 999/277CA unless the normalized Claim.MD status maps faithfully to that transaction and source provenance remains recorded.
5. Feed existing M23/M41 acknowledgment consumers through a compatibility adapter only after deterministic resolution; do not activate resolver or production polling by default.
6. Enrich receipt observations with upload-list reconciliation `inboundid` and original vendor fields where verified. Attempt-store replay has only generic receipt facts today.
7. Include M23 notice submissions, whose present Claim.MD callers fail closed at this evidence gate, before enabling those paths.

## Readiness

**Conditional GO for BIL-1.2.2B implementation. NO-GO for production activation.** Entry conditions: focused source tests/typecheck pass; live evidence RLS is still unverified; Claim.MD test credentials/response fixtures and account reference configuration are not available here. BIL-1.2.2B must keep external calls mocked or use approved synthetic test-account fixtures only, with production launch separately gated.
