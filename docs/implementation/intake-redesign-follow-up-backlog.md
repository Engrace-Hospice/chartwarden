# Intake redesign follow-up backlog

**Status:** Optional, unapproved future work
**Core initiative:** Closed on 2026-11-14

This file keeps non-blocking ideas separate from the completed intake redesign. An item appearing here is not authorization to implement it. Each item needs its own product decision, architecture and compliance review, delivery plan, and acceptance criteria before code changes begin.

| Candidate | Why it remains separate | Approval boundary |
|---|---|---|
| Authoritative global intake counts | Current worklist counts intentionally describe loaded results; a global count requires a server contract and scale semantics. | Approve API shape, tenant scope, freshness, and pagination/count behavior. |
| Team ownership and team filters | No authoritative team-assignment contract was found during G0. | Approve ownership model, permissions, reassignment audit events, and query contract. |
| Additional referral filters | Blocked-reason and received-date-range filters were not supported by the existing list API. | Approve API/query expansion and indexing evidence. |
| Durable draft/autosave | The delivered workspace does not claim durable autosave. | Approve draft ownership, conflict resolution, retention, encryption, and audit behavior. |
| Atomic referral patient creation | Existing recovery handles partial failure without silently creating another patient; transaction redesign changes backend behavior. | Approve transaction/idempotency design and migration/live-test evidence. |
| Automatic extracted-field writeback | Verified DocLens review remains deliberately human-mediated. | Approve field-level provenance, conflict semantics, authorization, audit, and PHI processing controls. |
| Human staff usability study | The product owner waived this as a G4 blocker, but a later study can still inform refinements. | Approve participants, synthetic scenarios, success measures, and remediation ownership. |

Changes to readiness, eligibility, election, CTI, consent, HOPE, or admission-transition rules are not ordinary follow-ups. They require a separately authorized clinical-policy change and are not implied by this backlog.
