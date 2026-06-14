# WardenX — Wave A completion: M3 Authorization + M4 Audit (Archon task plan)

Completes Wave A (M1, M2, M3, M4) from `PHASE_1_PLAN.md`. Build order is **M1 → M2 → M3 → M4**;
this plan assumes M1+M2 are `done` (see `M01-M02_VERTICAL_SLICE_PLAN.md`). **Conventions, determinism
rules, the validate gate, and the legend are inherited from that file** — read its header first.

Specs: `docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_3.md` (has its own §10 Implementation
Tasks + §12 Sign-Off), `docs/modules/WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md` (§13 Implementation Tasks
+ §14 Resolved Decisions). The agent should treat those in-spec task lists as the authoritative
sub-steps and this file as the DoD-aligned ordering + acceptance binding.

> **Wave-A interplay (read before starting M3).**
> 1. **M3 is the authorization contract** (`requirePermission`/`requireAbac`, ABAC predicate
>    registry) that *every* module consumes. It must land before M4 (which registers permission keys
>    *into* M3, §4.5).
> 2. **Audit-trigger ordering.** `arch:gaps` (phi-guards) requires every org-scoped table to carry an
>    audit trigger. M1/M2 shipped a **baseline** trigger so the gate stayed green; **M4 owns the
>    canonical write-audit trigger *generator* (§3.3)**. When M4 lands, normalize/regenerate triggers
>    across M1–M3 org-scoped tables through the generator (back-fill task **M4-T10**).
> 3. **Back-fill the deny-stubs.** M1/M2 deferred real permission registration (M2-T08) and full
>    audit wiring until M3/M4 existed. Those are closed here by **M3-T10** (register M1/M2 permission
>    keys + ABAC predicates) and **M4-T10** (wire real `audit()`/triggers).

---

## Module 3 — Authorization (deps: M2 done · codePaths: packages/auth/src/{rbac,abac,permissions,roles,breakglass,engagements}, apps/backend/src/modules/03-authorization)

ownedTables (6): role, permission, role_permission, membership_role, break_glass_event, auditor_engagement.

### M3-T01 — Enums + code-owned permission catalog
- deps: M2 done · files: `packages/auth/src/permissions` (+ `packages/db/src/schema` enums) · spec §3.2, §3.3
- do: the permission catalog as the **code-owned source of truth, mirrored to the DB** `permission`
  table; enums (§3.2). This catalog is what other modules contribute keys to.
- accept: unit test that code catalog ↔ DB mirror is consistent; `tsc -b` green.

### M3-T02 — Roles, joins + `system_locked` floor
- deps: M3-T01 · files: `packages/db/src/schema`, `packages/auth/src/roles` · spec §3.4, §3.4.1
- do: `role`, `permission`, `role_permission`, `membership_role`; the role catalog + `system_locked`
  permission floor (M03-F06) that tenants cannot strip.
- accept: `arch:tables` (M3 owns these), `arch:ddl`; unit test for the locked floor.

### M3-T03 — Break-glass + auditor engagements schema
- deps: M3-T01 · files: `packages/db/src/schema`, `packages/auth/src/{breakglass,engagements}` · spec §3.5
- do: `break_glass_event`, `auditor_engagement` (time-bound, least-privilege, accountable).
- accept: `arch:tables`, `arch:ddl`, `arch:tenancy` green.

### M3-T04 — RLS + migration
- deps: M3-T02, M3-T03 · files: `packages/db/migrations` · spec §3.6, §3.7
- do: generate the migration; RLS keyed on `app.org_id`; baseline audit trigger on org-scoped M3
  tables (normalized later by M4-T10).
- accept: `arch:tenancy` + `arch:ddl` + `arch:gaps` (phi-guards) green; RLS isolation test drafted.

### M3-T05 — The Authorization Contract (consumed by ALL modules)
- deps: M3-T01 · files: `packages/auth/src/rbac` · spec §4.1, §2.2
- do: `requirePermission` / `requireAbac` + the authorization-resolution pipeline (§2.2). This is the
  single guard surface every module's routes use (M1/M2 routes flip from deny-stub to this).
- accept: unit tests on the resolution pipeline ordering; `tsc -b` green.

### M3-T06 — RBAC engine + scoping
- deps: M3-T02, M3-T05 · files: `packages/auth/src/rbac` · spec §2.2, §7.1–7.3
- do: RBAC evaluation incl. caseload + discipline scoping; on-call time-bound elevation (§7.2).
- accept: integration tests for §7.1 (RN sees only caseload), §7.2, §7.3.

### M3-T07 — ABAC predicate registry
- deps: M3-T05 · files: `packages/auth/src/abac` · spec §4.2
- do: the **named-predicate registry** other modules register predicates into by name (the seam
  every later module relies on for `requireAbac`).
- accept: unit test registering + resolving a named predicate; `arch:gaps` (no unresolved consumer).

### M3-T08 — M3 route inventory + meta-permissions
- deps: M3-T02, M3-T03, M3-T05 · files: `apps/backend/src/modules/03-authorization` · spec §4.3–4.4, §6
- do: manage-roles, break-glass (§7.4), engagement (§7.5), tenant-catalog-customize (§7.6) routes,
  each behind the meta-permissions in §6, via `withOrgContext`.
- accept: integration tests §7.4–7.6; `arch:boundaries` green.

### M3-T09 — Frontend screens
- deps: M3-T08 · files: UI per spec · spec §5.1–5.3
- do: role/permission management, break-glass, auditor-engagement screens; WCAG 2.1 AA.
- accept: `docs:ui` green; `tsc -b` green.

### M3-T10 — Audit events, STRIDE, and **back-fill M1/M2 permission registration**
- deps: M3-T05, M3-T07 · files: module + `packages/auth` · spec §8.1, §8.4
- do: emit M3 audit events (§8.1); record the STRIDE threat model (§8.4); **close M2-T08**: register
  M1/M2 permission keys + ABAC predicates into the now-real catalog; flip M1/M2 route guards from
  deny-stub to `requirePermission`/`requireAbac`. Register M3 eraser; declare DR tier + INT inventory.
- accept: M1/M2 route guards live (their integration tests still green); `validateErasers()` passes.

### M3-T11 — Test plan
- deps: all M3 · files: module + `packages/auth` · spec §9.1–9.6, §12
- do: unit ≥95% on rbac/abac (§9.1), integration (§9.2), **RLS backstop + IDOR (§9.3)**, E2E (§9.4),
  performance (§9.5), fixtures (§9.6); walk the §12 sign-off checklist.
- accept: `bun run test` green incl. IDOR/RLS; full `arch:fitness` green.

---

## Module 4 — Audit & Compliance Log (deps: M3 done · codePaths: packages/audit, apps/backend/src/modules/04-audit)

ownedTables (7): legal_hold, destruction_certificate, state_retention_override, audit_export,
audit_seal, audit_denylist_catalog, audit_action_catalog. (`audit_event` itself stays M1-owned +
helper-only.)

### M4-T01 — Enums + package layout
- deps: M3 done · files: `packages/audit` · spec §3.1, §3.2
- do: `packages/audit` layout + enums; the capture-architecture skeleton (§2.1).
- accept: `tsc -b` green.

### M4-T02 — PHI write-audit trigger generator  ⟵ core
- deps: M4-T01 · files: `packages/audit` · spec §3.3
- do: the generator that emits per-table append-only write-audit triggers into `audit_event`,
  honoring the denylist categories. This is the canonical mechanism M1–M3 baseline triggers normalize to.
- accept: unit test generates a trigger; applying it makes `arch:gaps` phi-guards pass for a sample
  org-scoped table; `arch:tables` (helper-only `audit_event`) green.

### M4-T03 — Read-audit helper `auditRead()`
- deps: M4-T01 · files: `packages/audit` · spec §3.4
- do: `auditRead()` for §164.528 disclosure accounting on every PHI read route.
- accept: unit test; `tsc -b` green.

### M4-T04 — Lifecycle / integrity / catalog tables
- deps: M4-T01 · files: `packages/db/src/schema` · spec §3.5
- do: `legal_hold`, `destruction_certificate`, `state_retention_override`, `audit_export`,
  `audit_seal` (tamper-evidence chain), `audit_denylist_catalog`, `audit_action_catalog` (the last
  four are platform reference / NON_ORG_SCOPED per the tenancy allowlist).
- accept: `arch:tables`, `arch:ddl`, `arch:tenancy` green.

### M4-T05 — RLS, append-only grants + migration
- deps: M4-T04 · files: `packages/db/migrations` · spec §3.6, §3.7
- do: migration; append-only GRANT model (no UPDATE/DELETE on audit), `wardenx_audit_writer` SECURITY
  DEFINER usage, `audit_seal` integrity wiring; RLS on org-scoped M4 tables.
- accept: `arch:tenancy` + `arch:ddl` green; immutability test drafted (§12.3).

### M4-T06 — Capture contract + routes (TypeBox)
- deps: M4-T02, M4-T03, M4-T05 · files: `apps/backend/src/modules/04-audit` · spec §4.1–4.3
- do: the capture contract consumed by all PHI modules; route inventory + complete TypeBox route
  schemas; "no mutation escapes the log" (§10.1), "who touched this chart?" (§10.2).
- accept: integration tests §10.1–10.2; `arch:boundaries` green.

### M4-T07 — PHI denylist category behavior
- deps: M4-T02 · files: `packages/audit` · spec §5.1–5.3
- do: category expansion at trigger generation (§5.1); `sud_value` row-conditional scrubbing (§5.2);
  `compliance_42cfr_part2` defense-in-depth (§5.3).
- accept: W-M4-11 (`sud_value` scrubs `lab_observation_value` triggers) test; `bun run test` green.

### M4-T08 — Eraser + destruction-certificate workflow
- deps: M4-T04, M4-T06 · files: `packages/audit`, `apps/backend/src/bootstrap` · spec §6, §10.5–10.6
- do: the `compliance_42cfr_part2` eraser semantics (§6); destruction-certificate workflow + the
  M1 eraser-registry callbacks; legal-hold supremacy (§10.6).
- accept: W-M4-08 (Part 2 row correct retention class), W-M4-09 (eraser refuses Part 2 during patient
  lifetime); `validateErasers()` passes.

### M4-T09 — Patient accounting of disclosures (§164.528)
- deps: M4-T03, M4-T06 · files: `apps/backend/src/modules/04-audit`, `packages/auth/src/abac` · spec §7.1–7.2
- do: the accounting route + scope differentiation (§7.1); register the `audit_accounting_scope_allowed`
  ABAC predicate (§7.2) into M3's registry.
- accept: W-M4-10 (Part 2 accounting returns lifetime disclosures); integration test §10.3.

### M4-T10 — Permission keys into M3, action catalog, screens, **trigger back-fill**
- deps: M4-T02, M4-T06, M3-T01 · files: module + `packages/audit` · spec §4.5, §4.6, §8, §11.1
- do: register M4 permission keys into M3 (§4.5); seed the action catalog (§4.6); audit-of-audit
  events (§11.1); frontend screens (§8); **normalize/regenerate the M1–M3 org-scoped tables' audit
  triggers through the M4-T02 generator** (closes the baseline-trigger back-fill).
- accept: `arch:gaps` phi-guards green across the whole schema; `docs:ui` green.

### M4-T11 — Jobs + test plan
- deps: all M4 · files: module + `packages/audit` · spec §4.4, §12.1–12.7
- do: BullMQ jobs (§4.4: partition rotation, export, seal); tests — unit ≥95% on triggers/scrub/
  retention (§12.1), integration (§12.2), **immutability & integrity (§12.3)**, RLS isolation (§12.4),
  E2E (§12.5), performance (§12.6), fixtures (§12.7).
- accept: `bun run test` green incl. immutability/integrity; full `arch:fitness` green.

---

## Wave A acceptance (the workflow's final gate for M3+M4)
1. M3 (6) + M4 (7) ownedTables exist with RLS + migrations; manifest unchanged.
2. The **authorization contract** (`requirePermission`/`requireAbac` + ABAC registry) is live and
   **M1/M2 routes now use it** (deny-stubs removed).
3. Every org-scoped table across M1–M4 carries a canonical M4-generated write-audit trigger;
   `arch:gaps` phi-guards green corpus-wide.
4. `validateSeams()` + `validateErasers()` pass; the §164.528 accounting + Part 2 eraser semantics
   pass their W-M4-08/09/10/11 tests.
5. `bun run build && bun run arch:fitness && bun run test` green; fitness fixtures still red.
6. Wave A complete → Wave B (M36 Messaging, M38 Terminology, M40 MDM) unblocked.

> Use the **reusable per-module template** in `M01-M02_VERTICAL_SLICE_PLAN.md` for Wave B onward.
