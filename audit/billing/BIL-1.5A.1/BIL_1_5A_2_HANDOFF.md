# BIL-1.5A.2 Handoff

Next corrective scope is the Medicare notice evidence compatibility assigned to BIL-1.5A.2. Existing Claim.MD submission evidence must support NOE, NOTR and Transfer notice attempts without changing notice business semantics or enabling unsupported vendor submission.

Trace M23 notice enqueue → immutable at-send identity snapshot → Claim.MD submit/receipt → account-wide response correlation. Preserve the current fail-closed behavior until correct notice metadata can be represented and verified. Add focused tests for each notice kind, identity changes after submission, missing evidence, and no resolver activation. Do not modify M24 direct Medicaid adapters or M25 posting.

BIL-1.5A.1 also leaves recovery operator reachability, durable operational gauges and PostgreSQL concurrency certification open; BIL-1.5B should not treat those as satisfied by this handoff.
