# Manual exception resolution

The route requires `remittance.match_review`, distinct from `remittance.read`, plus the repository's idempotency-key pre-handler. A reason of 3–500 trimmed characters and the expected decision version are required. The actor/membership and provider scope come from trusted request context. The server does not accept a claim UUID from the client.

Only confirmation or clearing of an already upstream-verified identity is supported. Clearing and later confirmation append revisions. A stale expected version fails; a repeated identical action from the same actor at the immediately preceding version is idempotent. Stage rows are locked while the current encrypted detail is projected and the revision inserted. A known conflicting or ambiguous identity cannot be overridden.

Candidate selection, escalation workflow, and manual resolution of unmatched claims are not implemented. No recovery, ownership reassignment, payment allocation, posting, or financial permission is granted by this capability.
