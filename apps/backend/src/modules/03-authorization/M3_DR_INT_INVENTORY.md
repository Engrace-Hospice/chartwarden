# Module 3 (Authorization) — DR Tier + Integration Inventory (M3-T10)

Per-module declaration required by the Phase-1 Definition-of-Done (`docs/IMPLEMENTATION_ROADMAP.md`
§DoD): "DR tier + INT inventory declared; degraded-mode behavior documented where on a cross-phase
path." Authoritative sources: `docs/architecture/WARDENX_DR_BCP_v0.1.md` (DR tiers, §2 service
matrix) and `docs/architecture/WARDENX_INTEGRATIONS_v0_1.md` (integration catalog).

## 1. Disaster-Recovery Tier — **Tier 1 (Critical patient care)**

Authorization is on the **hot path of every PHI request**: `requirePermission` / `requireAbac`
resolve the actor's effective permissions and ABAC predicates before any clinical handler runs.
Without it no clinician reaches eMAR, orders, or the chart — and break-glass is the emergency
access path itself. The DR_BCP §2 service matrix classifies **Backend API** and **Valkey** (which
backs M3's effective-permission cache, D6) as **Tier 1**; M3 inherits that tier.

| Target | Internal | Customer SLA |
|---|---|---|
| RTO | 1 hour | 2 hours |
| RPO | 5 minutes | 15 minutes |

### Degraded-mode behavior

- **Valkey (effective-permission cache) unavailable** → resolution falls back to a direct
  `membership_role ⋈ role ⋈ role_permission` read under `withOrgContext` (slower; the p95 < 1 ms
  cached target relaxes). Authorization stays available and correct — the cache is an accelerator,
  never the source of truth (`rbac/resolve.ts` resolves from the store on a cache miss).
- **Authorization DB unavailable** → the effective-permission resolver cannot load grants; the
  contract **fails closed** (deny) rather than fail open. This is the reason M3 is Tier 1, not
  Tier 2: a degraded authorization layer must never widen access.
- **Stale cache after a revoke** → bounded by event-driven invalidation in the revoke transaction
  plus the 60-second TTL safety net, and the TTL is capped by the soonest grant expiry so a
  time-bound (on-call) elevation cannot be served past its window (D6, STRIDE cache-staleness row).
- **Break-glass during a Valkey/notification outage** → the glass grant is written to PostgreSQL
  (`break_glass_event`) and enforced from there; the Compliance notification (via M36) may queue
  and deliver late, but the `critical` per-access audit rows are written synchronously with access.

## 2. Integration Inventory

### 2.1 Owned by M3

**None.** Module 3 owns no external (third-party) integration. Its cross-cutting machinery is
internal: the effective-permission **Valkey** cache (DR_BCP Tier-1 infra, not a vendor
integration) and three internal BullMQ queues — `authz.reap_breakglass`, `authz.close_engagements`,
`authz.cache_invalidate` (§4.5.1; idempotent consumers per the Module 1 test suite).

### 2.2 Consumed via other modules — not M3-owned

| Capability | Touchpoint | Owner | Edge |
|---|---|---|---|
| Compliance notification on break-glass invoke | `m3.breakglass.invoked` → alert within seconds (§7.4 / D1) | **M36** (Secure Messaging & Alerts) | outbox event → M36 notification seam; **no** `dependsOn` edge, no vendor import in M3 |
| Auditor session minting | `AuditorSessionMinter` boot-validated seam (D2; M2 §4.7) | **M2** (Identity) | M3 `dependsOn: [2]`; resolved via the seam registry |
| Caseload / on-call / bereavement ABAC predicates | `caseload_membership`, `oncall_shift_active`, … resolved by name | **M5 / M17 / M18 / M6 / M39** | boot-registered provider seams with deny-stub defaults (M03-F03); M3 never reads those modules' tables |

The "no PHI in payload" rule (architecture §36) means the break-glass alert carries only a generic
notice + an authenticated deep link, never clinical content.

## 3. Right-to-Erasure (eraser)

**Module 3 registers no data eraser — it owns no erasable PHI subject-data class.** Its owned
tables are authorization configuration (`role`, `permission`, `role_permission`, `membership_role`)
and **compliance-retained accountability records** (`break_glass_event`, `auditor_engagement`).
Per §8.1 the break-glass and engagement events are `compliance` retention (6–7 years; HIPAA
§164.316(b)(2)) — they **must survive** a patient's right-to-erasure request during the retention
window (legal-hold supremacy, M4 §10.6), so erasing them would itself be a compliance violation.
The closed `DataClass` union (`@chartwarden/types`) therefore carries no M3 class, and `validateErasers()`
remains satisfied by the existing required classes. When a membership is offboarded, its
`membership_role` grants are dropped by the role-revoke path (not the erasure path); the role
catalog is org configuration, not subject data. Destruction-certificate workflow for the
compliance-retained rows lands with M4 (§6, M4-T08).
