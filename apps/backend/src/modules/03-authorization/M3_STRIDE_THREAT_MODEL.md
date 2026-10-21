# Module 3 (Authorization) — STRIDE Threat Model (M3-T10 / M03-F08 — SEC-007)

Recorded per the §20.B template STRIDE requirement (ADR-0021). Authoritative source: the
Module 3 spec §8.4 (`docs/modules/CHARTWARDEN_MODULE_03_AUTHORIZATION_SPEC_v0_3.md`) and Security
Hardening v0.2 §3.1. Module 3 is the authorization layer — the highest-risk module for
privilege abuse — so each threat below maps to an existing control and the negative test that
verifies it (M3-T11 §9 / spec §12 STRIDE suite).

**Framework:** Spoofing / Tampering / Repudiation / Information disclosure / Denial of service /
Elevation of privilege.

| STRIDE | Threat | Vector | Control (where implemented) | Verifying test |
|---|---|---|---|---|
| **E** | Privilege escalation via role self-grant | An `org_admin` grants themselves (or a role) a permission above their own ceiling | Anti-escalation check in the role-create/edit handler: `actor.effectivePermissions ⊇ role.permissionKeys` evaluated server-side; 403 + `m3.authz.escalation_blocked` audited at `warn` (`routes/authz-routes.ts`, `audit/authz-audit.ts`) | escalation: self-grant + grant-above-ceiling → 403 (`authz-routes.test.ts` §7.6) |
| **I** | IDOR on role / break-glass / engagement objects | A tenant-B actor uses a tenant-A `break_glass_event` / `auditor_engagement` / `membership_role` id | RLS keyed on `app.org_id` (§3.6, migration 0009) + `requireAbac` resource-ownership check; existence non-leak → 404 not 403 (`require-abac.ts` `notFoundOnDeny`) | IDOR suite: cross-tenant object access → 404 (M3-T11 §9.3) |
| **E** | ABAC-predicate bypass via client-supplied context | A client asserts `caseload_member=true` / `oncall=true` in body/headers to short-circuit ABAC | `AbacContext` is **server-assembled** from session + DB only (`require-abac.ts` `abacContextFrom`); no client field reaches predicate evaluation; predicates are typed server functions with deny-stub defaults | context-assembly: client context stripped (M3-T11 §9.1) |
| **E** | Cache-staleness elevation | A revoked high-privilege role still resolves from the effective-permission cache within the TTL | Event-driven invalidation in the same transaction as the revoke + 60 s TTL safety net; TTL capped by soonest grant expiry so on-call elevation cannot outlive its window (`rbac/resolve.ts`, `rbac/cache.ts`, D6) | invalidation: revoke → cache key gone same-tx; TTL boundary (M3-T11 §9.2) |
| **E** | Break-glass abuse | Invoking glass on a patient already on the actor's caseload, or repeated invocation to harvest PHI | Glass opens only on access the normal ABAC pipeline DENIED (§2.2 branch in `require-abac.ts`); every access under glass audited at `critical` (`m3.breakglass.access`, `contract.ts`); Compliance notified; 4-hour time-box; per-org invocation counter (D1/D5) | scope-check: glass refused when ABAC would allow; per-access critical audit (`authz-routes.test.ts` §7.4) |
| **I** | Auditor-scope expansion | An auditor session reads PHI outside the engagement scope or `[start_at, end_at]` window | `engagement_scope` ABAC predicate evaluates `target ∈ scope ∧ now ∈ window` server-side; auditor sessions are M2-minted + HMAC-signed; window expiry revokes the session (`authz.close_engagements` queue, §4.5) | auditor-scope: out-of-scope → 404; past `end_at` → 403; window-expiry revoke (M3-T11 §9) |

## Cross-reference to platform STRIDE (Security Hardening v0.2 §3.2)

- Cross-tenant access (I+E, §3.2.1) — the IDOR row + M3 RLS (§3.6). M3 is the application-layer
  defense; Module 1 is the database-layer backstop (layer-independence proven in M3-T11 §9.3).
- Privilege escalation (E, §3.2.4) — instantiated as M3's anti-escalation check ("cannot grant
  what you don't hold").
- Audit-log tampering (T+R, §3.2.2) — a Module 4 concern; M3 contributes by emitting every
  break-glass and role-change event into M4's append-only `audit_event` (M3 cannot UPDATE/DELETE
  it; the M3 audit events are filed at `compliance`/`operational` retention per §8.1).
