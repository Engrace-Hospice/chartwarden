# 07 — Testing, Release & Governance

> Part of the [Messaging Hub plan](./README.md).

## 1. Definition of done (every feature)
Domain rules + state transitions · migration (+ both manifests, enums mirrored, `arch:migration-numbering`) · TypeBox contract + OpenAPI
enrichment · server-side authorization (RBAC key + composed ABAC) · audit event(s) · frontend states (loading/empty/error/forbidden/offline) ·
accessibility behaviour · unit + integration + live tests · monitoring (metrics/alerts) · runbook/docs index entry.
Clinical features additionally need a simulated hospice workflow run and clinical + compliance sign-off.

## 2. Test strategy

| Layer | What | Where / how |
|---|---|---|
| Unit | State machines (ack, handoff, task, message), sanitiser, ACL predicates | vitest in `packages/messaging/__tests__` |
| Contract | TypeBox schemas, OpenAPI, seam types, event catalog | `client:check`, `arch:openapi-*`, `arch:outbox-bindings` |
| Integration (live) | RLS as real `wardenx_app`, workers, M22 scan, M19 seam, outbox with the **real catalog-validating publisher** | New live suites; **private** `pgvector/pgvector:pg18` + `valkey/valkey:8`; one DB at a time |
| Security | IDOR across every route/socket, RLS bypass attempts, stored/reflected XSS corpus, token revocation, search leakage, attachment IDOR | Dedicated adversarial live suite |
| Concurrency | Duplicate sends, concurrent ack/reassign, double timers, edit races | Parallel-call tests with idempotency keys |
| Failure injection | Valkey, DB failover, push vendor, scan service, M19 unavailable | Chaos suite; assert `failed_unreachable` + no silent loss |
| Clinical simulation | Workflows A–F end to end | `test:messaging-hub:<wf>:live` |
| Accessibility | axe, keyboard walk, SR script, 200 % zoom, contrast | CI job + recorded manual evidence |
| Migration | Existing demo conversations preserved; rollback safe | Migration test on a restored snapshot |
| DR | Restore DB + object store; reconcile | Rehearsal report |
| Load | Multi-tenant, large histories, many concurrent care-team threads, reconnect storms, uploads, urgent escalation under infra failure | k6/Artillery profile; results stored under `audit/` |

Coverage: follow the repo's real gate (`bun run typecheck && bun run arch:fitness && bun run test`) first; aim for ≥ 80 % on new
domain code; do not chase the number with shallow tests on glue.

## 3. Proposed fitness gates (add to `arch:fitness`)
- `arch:messaging-no-order-write` — M36 code must not import or call M11/M12 write seams (only read/link seams).
- `arch:messaging-ack-semantics` — no code path sets an acknowledged state from a read/open handler (AST/grep ratchet).
- `arch:messaging-template-phi` — every out-of-band template snapshot contains no identifier tokens (extends sanitiser tests).
- Extend `check-live-suite-coverage`, `check-queue-names` (new `messaging.ack_deadline`, `messaging.scheduled_send`, `messaging.search_index`),
  `check-route-reachability`, and `check-abac-composed` for new routes/predicates. Each new gate documents its incident rationale in
  `docs/history/` and is listed in `CLAUDE.md` (+ `AGENTS.md` verbatim).

## 4. Non-functional targets (to **validate**, not assumed)
| Dimension | Target |
|---|---|
| Message API latency | p95 < 500 ms (excl. attachment transfer) |
| Realtime delivery | p95 < 2 s for connected clients |
| Durability | No acknowledged write lost under tested failures |
| Availability | ≥ 99.9 % for messaging, with separately defined clinical fallback procedures |
| Search | p95 < 1 s for scoped search |
| Accessibility | WCAG 2.2 AA |
| Recovery | RPO/RTO documented, rehearsed, approved before clinical go-live |
| Tenant isolation | 0 cross-tenant reads in adversarial suite |
| Auditability | Every security-relevant mutation yields a traceable audit event |
| Notifications | Failures observable, retried, escalated by policy |

## 5. Release gates (clinical go-live checklist)
- [ ] Existing messaging data migrated/reconciled; demo tenant reseeded where needed
- [ ] All tenant-isolation / authorization tests green
- [ ] Escalation + fallback validated by clinical lead (Workflow A drill recorded)
- [ ] On-call routing, shift-boundary and time-zone scenarios pass
- [ ] Order/chart boundaries verified (no-order-from-chat, promotion attribution)
- [ ] Attachment scan + retention policies verified
- [ ] Push privacy review complete (template snapshots)
- [ ] Accessibility testing complete
- [ ] Monitoring, backups, restore and incident response rehearsed
- [ ] Clinical, security and compliance sign-off recorded
Phase 1 → internal testing only. Phase 6 never gates clinical go-live.

## 6. Rollout and rollback
Per-tenant feature flags: `messaging.realtime`, `messaging.rich_text`, `messaging.clinical_links`, `messaging.handoffs`, `messaging.urgent_ack`,
`messaging.offline`, `messaging.ai`, `messaging.external_partners`. Pilot with the Engrace demo tenant, then a single real pilot tenant.
Additive migrations only until a phase is proven; destructive cleanup (e.g. retiring `message_receipt.ack` semantics) happens a release later.
`main` auto-deploys — hit changed routes on the Docker stack first; batch pushes (debounce #257).

## 7. Risks
| Risk | Mitigation |
|---|---|
| Duplicating M19/M14/M11/M22 | Anti-duplication rules; seam contracts in Phase 0; reviewer checklist |
| Realtime scale/security | ADR, Valkey fan-out, DB-cursor truth, adversarial suite |
| Encrypted-body search | Option A first, measure, ADR for B/C |
| Alert fatigue | Urgency discipline, tighten-only policy, analytics in P6 |
| False sense of safety (“messaging = emergency path”) | UI notice, policy, training, drills |
| Scope creep into P6 | Feature flags; P6 excluded from go-live gate |
| Metered CI minutes | Batch pushes; no new always-on triggers |

## 8. Open decisions for the product owner
*Decided 2026-10-11 (see README "Decisions"): D1 Socket.IO (spike first), D2 thin M36 task table, D3 global search required via option B,
D4 per-urgency ack deadlines with tenant tighten-only.* Still open:

1. Clinical-lead sign-off on the D4 numbers and on which roles may acknowledge which urgency classes.
2. ~~M14 `action_item` generic?~~ **Closed by the Phase 0 audit:** `idg_action_item.idg_meeting_id` is NOT NULL, so D2 stands.
3. Search design review outcome for option B (leakage tolerance of whole-word/prefix tokens).
6. Voice notes/AI/external partners: confirm they stay post-go-live and flag-gated.
7. Push strategy: PWA web-push only for now, or commit to native (Capacitor FCM/APNs) in Phase 5?

## 9. Governance register
Maintain [`08-capability-register.md`](./08-capability-register.md) as the single register
(`feature_id, name, phase, context, deps, risk, owner, schema/api/ui changes, permissions, tests, docs, status, evidence`). Cut work
packages from it, one bounded context per package, with explicit "may not touch" lists (e.g. the escalation package must not edit
medication-order code or add an on-call table). Update `docs/README.md` and, if any rule here becomes a standing habit, `CLAUDE.md` +
`AGENTS.md` verbatim in the same commit.
