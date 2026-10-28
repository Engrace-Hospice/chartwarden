# 20 — Regression test plan

## Required suites

| ID | Scenario | Layer | Required assertion |
|---|---|---|---|
| RT-001 | Same-day payer-kind replacement | DB/live | never two rank-1 coverages effective on one date |
| RT-002 | Interior payer change across claim range | service/live | assembly rejects or segments; no claim committed |
| RT-003 | Concurrent payer replacement | DB/live | serialization/constraint prevents overlap |
| RT-004 | CI failure propagation | workflow | lint/test/live failure prevents release and deploy |
| RT-005 | Post-migration deploy failure | isolated deploy | incompatible old image is not auto-started |
| RT-006 | Coordinated DB/object restore | DR drill | RPO/RTO, checksums, RLS, audit chain, documents pass |
| RT-007 | HOPE LPN/LVN SFV policy | unit/live/E2E | allowed by correct effective policy; unauthorized roles denied |
| RT-008 | Step-up clinical draft | browser/security | no PHI in Web Storage; one-time expiry and cleanup work |
| RT-009 | Claim payer preflight race | E2E/live | early guidance plus authoritative final rejection |
| RT-010 | Multi-app accessibility | browser/manual | six viewports, keyboard, focus, zoom, SR, axe |
| RT-011 | Docling reproducibility/corpus | image/pytest | locked graph and stable safe parse outputs |
| RT-012 | Resource exhaustion | load/fault | bounded degradation, alerts, and recovery |
| RT-013 | On-call rotation | DB/live | RLS, overlap, effective roster, concurrency |
| RT-014 | Duplicate 837/835/webhook/job | integration | idempotent outcome and correlated audit trail |
| RT-015 | Signed note concurrent addendum | DB/E2E | immutable original, version conflict, complete audit |

Property-based generators should target date intervals, leap/DST boundaries, money rounding,
duplicate identifiers, unexpected enums, null/empty/maximum text, and state-machine transitions.
Failure injection must cover database/cache/queue/vendor outage, worker crash, network loss, expired
credentials, browser refresh/back during mutation, and repeated submit.

Tests that require Postgres must use a private pgvector container and canonical app-role setup;
browser tests require synthetic tenants/patients only. No production endpoint or real PHI is in scope.
