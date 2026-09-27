# WardenX — Wave B: M36 Messaging + M38 Terminology + M40 MDM (Archon task plan)

Wave B from `PHASE_1_PLAN.md` — the early platform services **every clinical/billing module consumes**.
All three depend only on Wave A (M1–M4 `done`), depend on **nothing in this wave**, and so may build
**in parallel**. **Conventions, determinism rules, the validate gate, and the legend are inherited
from `M01-M02_VERTICAL_SLICE_PLAN.md`** — read its header first.

Specs: `WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md`, `WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md`,
`WARDENX_MODULE_40_MDM_SPEC_v0_4.md` (all under `docs/modules/`).

> **Wave-B interplay (read first).**
> 1. **Each consumes M4's write-audit trigger generator** (M36 §3.9, M38 §3.8, M40 §3.7) — Wave A
>    must be `done` so `arch:gaps` phi-guards stays green as these tables land.
> 2. **Each registers permission keys into M3** (M36 §4.5, M38 §4.4, M40 §4.4) and publishes the
>    **seam every later module imports**: M36 `AlertEmitter` (§4.6), M38 `TerminologyProvider` (§4.5),
>    M40 `MdmEntityProvider` (§4.5).
> 3. **M40-T06 closes a Wave-A boot-gate stub.** `BaaStatusProvider` (M40 §4.6) is **REQUIRED by M3's
>    `validateSeams()` boot gate**; M3 shipped a deny-stub — M40 replaces it with the real impl.
> 4. **M36 is foundation-tier (M36-F01):** `dependsOn` stays `[1,2,3,4]`. Later modules **contribute**
>    their typed alert payloads via `events-by-mN.ts` registered at *their own* boot (the §3.12
>    Foundation Registry pattern) — **no import edge**. M36 builds the catalog + dispatch infra and
>    validates the catalog at boot without importing any later module.
> 5. **Phase-1 scope flags (default OFF):** M38 semantic search (`concept_embedding`/pgvector,
>    §7.7) rides the `ai.full` flag (Phase 2) — build the table, gate the endpoint. M38 CPT is
>    unreachable until D4 (§7.8). M40's **M29 NPPES-sync consumers (§4.7) are forward-seam/deny-stub**
>    (M29 is Wave H); the **M40 nightly NPPES job is the Phase-1 path** (W-M40-12/13).
> 6. **Infra:** M36 needs the Socket.IO + Valkey adapter wired in `apps/backend/src/bootstrap` (M1).
>    M38 needs the `pg_trgm` + `vector` PostgreSQL extensions (§9.2).

---

## Module 36 — Secure Messaging & Alerts (deps: M1–M4 · codePaths: packages/messaging, apps/backend/src/modules/36-messaging)

ownedTables (15): alert, alert_payload_catalog, alert_rule, channel, channel_member, delivery_endpoint,
message, message_attachment, message_receipt, notification_delivery, presence, tenant_alert_routing_override,
user_notification_preferences, notification_template, tenant_notification_template_overlay.

### M36-T01 — Enums, package layout, channel kinds
- deps: M1–M4 · files: `packages/messaging` (+ schema enums) · spec §3.1, §3.2, §2.3
- do: enums + the single `channel_kind` discriminator that drives lifecycle/membership/retention.
- accept: `tsc -b` green.

### M36-T02 — Schema (all 15 tables)
- deps: M36-T01 · files: `packages/db/src/schema` · spec §3.3–3.6, §3.11, §3.13
- do: channels & membership (§3.3); messages/attachments/receipts (§3.4); presence & delivery
  endpoints (§3.5); alert_rule/alert/notification_delivery/user_notification_preferences (§3.6);
  alert_payload_catalog + tenant_alert_routing_override (§3.11); notification_template + overlay (§3.13, ADR-0024).
- accept: `arch:tables` (M36 owns all 15), `arch:ddl` green.

### M36-T03 — RLS, channel-visibility ABAC, audit triggers, migration
- deps: M36-T02 · files: `packages/db/migrations` · spec §3.7–3.9
- do: RLS & grants (§3.7); channel visibility via ABAC (§3.8, not just RLS); write-audit triggers via
  the M4 generator (§3.9); migration.
- accept: `arch:tenancy` + `arch:ddl` + `arch:gaps` (phi-guards) green; RLS isolation test drafted.

### M36-T04 — Resolution & fan-out + recipient resolution
- deps: M36-T02 · files: `packages/messaging` · spec §2.1
- do: the resolution/fan-out engine and recipient resolution (the core dispatch path).
- accept: unit tests on fan-out; `tsc -b` green.

### M36-T05 — Alert payload catalog + Foundation Registry + seed + boot-validate
- deps: M36-T02 · files: `packages/messaging`, `packages/types` · spec §3.10–3.12
- do: the alert_payload_catalog + per-module contribution pattern (§3.12); seed platform-default,
  `system_locked` alert rules (§3.10); validate the catalog at boot **without importing later modules**
  (M36-F01). Event types live in `packages/types`.
- accept: `arch:gaps` event-catalog passes; boot-catalog-validation test (§7.4 `system_locked`).

### M36-T06 — Seams + PHI sanitization wrapper
- deps: M36-T04, M1-T09 · files: `packages/messaging`, `apps/backend/src/bootstrap` · spec §4.6, §4.7
- do: register the `AlertEmitter`/messaging seam contracts (§4.6) into the M1 registry; the **PHI
  sanitization wrapper (§4.7) — the only path to out-of-band channels**.
- accept: `validateSeams()` passes; `arch:gaps` seam-registry green; §7.2 (no PHI out-of-band) test.

### M36-T07 — Routes + permission keys
- deps: M36-T02, M36-T04 · files: `apps/backend/src/modules/36-messaging` · spec §4.1–4.2, §4.5
- do: route inventory behind `requirePermission`/`requireAbac` + `withOrgContext`; register M36
  permission keys into M3 (§4.5).
- accept: integration tests; `arch:boundaries` green.

### M36-T08 — Realtime, jobs, webhook security, cache
- deps: M36-T07 · files: module + `apps/backend/src/bootstrap` · spec §4.3, §4.4, §4.8, §4.9
- do: Socket.IO event/room contract on the Valkey adapter (§4.3, wired in bootstrap); BullMQ jobs
  (§4.4); webhook security (§4.9, SD-056/INT-016); cache + invalidation (§4.8).
- accept: integration tests for delivery + webhook signature; gates green.

### M36-T09 — Cross-module notification composition (ADR-0024)
- deps: M36-T05, M36-T08 · files: `packages/messaging`, module · spec §4.11, §3.13
- do: notification composition + recipient resolution for cross-module events (ADR-0024 — owned by
  M36, not M14); notification_template rendering + tenant overlay.
- accept: composition unit/integration tests; `docs:ui` unaffected; gates green.

### M36-T10 — Screens, STRIDE, eraser, DR/INT
- deps: M36-T07 · files: UI per spec, module · spec §5, §4.10
- do: screens (§5, WCAG 2.1 AA); STRIDE threat model (§4.10); register eraser incl. message-body
  cryptographic erasure (§7.8); DR tier (SOS = Tier-1) + INT inventory (Twilio/Postmark).
- accept: `docs:ui` green; `validateErasers()` passes.

### M36-T11 — Test plan
- deps: all M36 · files: module + `packages/messaging` · spec §7
- do: §7.1 in-app floor, §7.2 no-PHI-out-of-band, §7.3 auto-membership, §7.4 system_locked, §7.5
  quiet hours, §7.6 vacation forwarding, §7.7 SOS Tier-1 redundancy, §7.8 crypto-erase; RLS isolation.
- accept: `bun run test` green; full `arch:fitness` green.

---

## Module 38 — Clinical Terminology Service (deps: M1–M4 · codePaths: packages/terminology, apps/backend/src/modules/38-terminology)

ownedTables (13): code_system, code_system_version, concept_embedding, concept_icd10cm, concept_loinc,
concept_rxnorm, concept_snomed, deprecation_mapping, terminology_update_log, value_set,
value_set_expansion, value_set_member, value_set_tenant_extension.

### M38-T01 — Enums, package layout, per-system rationale
- deps: M1–M4 · files: `packages/terminology` · spec §3.1, §3.2, §2.3
- do: enums; the per-system-table (not one polymorphic concept table) structure.
- accept: `tsc -b` green.

### M38-T02 — Schema (all 13 tables)
- deps: M38-T01 · files: `packages/db/src/schema` · spec §3.3–3.6
- do: code_system + code_system_version (§3.3); per-system concept tables icd10cm/snomed/loinc/rxnorm
  (§3.4); value_set/value_set_member/value_set_expansion/value_set_tenant_extension (§3.5);
  deprecation_mapping/concept_embedding/terminology_update_log (§3.6).
- accept: `arch:tables` (M38 owns all 13), `arch:ddl` green.

### M38-T03 — RLS, audit triggers, migration, PG extensions
- deps: M38-T02 · files: `packages/db/migrations` · spec §3.7, §3.8, §9.2
- do: platform-shared RLS pattern (§3.7); write-audit triggers via M4 generator (§3.8); migration
  enabling `pg_trgm` + `vector` extensions.
- accept: `arch:tenancy` + `arch:ddl` + `arch:gaps` green.

### M38-T04 — Resolution + as-of-date semantics
- deps: M38-T02 · files: `packages/terminology` · spec §2.1, §7.1–7.2
- do: the as-of-date resolution engine (§7.1 honored on every query; §7.2 two versions coexist,
  older never deleted).
- accept: unit tests for as-of resolution (≥95%, §9.1).

### M38-T05 — TerminologyProvider seam (the consumer contract)
- deps: M38-T04, M1-T09 · files: `packages/terminology`, `apps/backend/src/bootstrap` · spec §4.5
- do: `TerminologyProvider` (validate/lookup/lookupBatch/isMemberOf/expand/asFhirCodeSystem/asFhirValueSet)
  registered into the M1 registry — the surface every clinical/billing module imports.
- accept: `validateSeams()` passes; `arch:gaps` seam-registry green.

### M38-T06 — Routes + permission keys + canonical-write lockdown
- deps: M38-T02, M38-T04 · files: `apps/backend/src/modules/38-terminology` · spec §4.1–4.2, §4.4, §7.4
- do: routes behind `requirePermission`; register keys into M3 (§4.4); tenants cannot write canonical (§7.4).
- accept: integration tests incl. §7.4 denial; `arch:boundaries` green.

### M38-T07 — Value-set expansion + tenant extensions + deprecation
- deps: M38-T04 · files: `packages/terminology`, module · spec §7.3, §7.5, §7.6
- do: fast, freshness-correct expansion (§7.5); tenant extensions add-only, never weaken (§7.6);
  annual deprecation remediation (§7.3, deprecation_mapping).
- accept: §7.3/§7.5/§7.6 tests; gates green.

### M38-T08 — Seed platform value sets (CPT gated)
- deps: M38-T02 · files: `packages/terminology` seed · spec §3.9, §7.8
- do: seed platform code systems + value sets (ICD-10-CM, SNOMED, LOINC, RxNorm, revenue/Q-codes, etc.);
  **CPT unreachable until D4** (§7.8).
- accept: seed integration test; gates green.

### M38-T09 — FHIR projection + semantic search (flag-gated)
- deps: M38-T05 · files: `packages/terminology`, module · spec §7.7, §7.9
- do: FHIR CodeSystem/ValueSet projection consumed by M28 (§7.9); **semantic search
  (concept_embedding/pgvector, §7.7) behind the `ai.full` flag (Phase 2, default OFF)** — table built,
  endpoint gated.
- accept: FHIR projection test (§7.9); semantic-search route returns flag-disabled in Phase 1.

### M38-T10 — Screens, jobs, cache, audit, eraser, DR/INT
- deps: M38-T06 · files: UI per spec, module · spec §5, §4.3, §4.6, §8.1
- do: screens (§5); jobs (§4.3); cache + invalidation (§4.6); audit events (§8.1); eraser; DR tier + INT.
- accept: `docs:ui` green; `validateErasers()` passes.

### M38-T11 — Test plan
- deps: all M38 · files: module + `packages/terminology` · spec §9
- do: unit ≥95% on as-of/expansion/deprecation (§9.1); integration on PG+pg_trgm+vector+Valkey (§9.2);
  boundary & security (§9.3); RLS isolation.
- accept: `bun run test` green; full `arch:fitness` green.

---

## Module 40 — Master Data Management (deps: M1–M4 · codePaths: packages/mdm, apps/backend/src/modules/40-mdm)

ownedTables (11): entity_relationship, external_physician, external_physician_tenant_overlay, facility,
mdm_baa_record, mdm_baa_required, mdm_provisional, merge_request, nppes_sync_coordination, nppes_sync_log, payer.

### M40-T01 — Enums, package layout, canonical-vs-overlay line
- deps: M1–M4 · files: `packages/mdm` · spec §3.1, §3.2, §2.3
- do: enums; the canonical-vs-overlay dividing line (§2.3).
- accept: `tsc -b` green.

### M40-T02 — Schema (all 11 tables)
- deps: M40-T01 · files: `packages/db/src/schema` · spec §3.3–3.5
- do: canonical tables external_physician/facility/payer (§3.3); overlay external_physician_tenant_overlay
  (§3.4); cross-cutting entity_relationship/merge_request/mdm_baa_record/mdm_baa_required/mdm_provisional/
  nppes_sync_coordination/nppes_sync_log (§3.5).
- accept: `arch:tables` (M40 owns all 11), `arch:ddl` green.

### M40-T03 — RLS (two-table pattern), audit triggers, migration
- deps: M40-T02 · files: `packages/db/migrations` · spec §3.6, §3.7, §3.9
- do: the locked two-table canonical/overlay RLS pattern (§3.6) + `mdm_canonical_writer` role;
  write-audit triggers via M4 generator (§3.7); migration `0038_m40_v03_seams.sql` (§3.9).
- accept: `arch:tenancy` + `arch:ddl` + `arch:gaps` green; §7.3 two-tenant overlay isolation + §7.4
  tenants-cannot-write-canonical tests.

### M40-T04 — Resolution + merge redirect
- deps: M40-T02 · files: `packages/mdm` · spec §2.1, §7.1–7.2
- do: resolution architecture; one canonical row per real-world entity (§7.1); merge redirect
  invisible to consumers (§7.2).
- accept: merge-redirect unit tests; `tsc -b` green.

### M40-T05 — MdmEntityProvider seam
- deps: M40-T04, M1-T09 · files: `packages/mdm`, `apps/backend/src/bootstrap` · spec §4.5
- do: `MdmEntityProvider` (resolvePhysician/resolvePayer/resolveFacility, merge-aware) registered into
  the M1 registry — the contract every consumer imports.
- accept: `validateSeams()` passes; `arch:gaps` seam-registry green.

### M40-T06 — BaaStatusProvider seam (closes the M3 boot-gate stub)
- deps: M40-T02, M40-T05 · files: `packages/mdm`, `apps/backend/src/bootstrap` · spec §4.6, §7.7
- do: implement `BaaStatusProvider` (§4.6) — **required by M3's `validateSeams()` boot gate**; replace
  M3's Wave-A deny-stub; BAA gate on disclosure with as-of time-travel (§7.7).
- accept: `validateSeams()` passes with the **real** BaaStatusProvider; W-M40-10 + W-M40-11 tests green.

### M40-T07 — Routes + permission keys + merge approval
- deps: M40-T02, M40-T04 · files: `apps/backend/src/modules/40-mdm` · spec §4.1–4.2, §4.4, §7.6
- do: routes behind `requirePermission`; register keys into M3 (§4.4); merge approval & re-pointing (§7.6).
- accept: integration tests incl. §7.6; `arch:boundaries` green.

### M40-T08 — Seed + NPPES nightly job (the Phase-1 sync path)
- deps: M40-T02 · files: `packages/mdm` seed, module · spec §3.8, §4.3, §7.5
- do: seed platform-owned reference data (§3.8); the nightly NPPES sync job (§4.3) + drift detection
  (§7.5). This nightly job is the **Phase-1 authoritative sync path**.
- accept: NPPES drift test (§7.5); gates green.

### M40-T09 — M29 NPPES-sync consumers (forward-seam / deny-stub)
- deps: M40-T08 · files: module · spec §4.7, §7.11–7.12
- do: the M29 NPPES-sync outbox consumers (§4.7) — **deny-stub now** (M29 is Wave H); document that
  the M40 nightly job (T08) is the fallback. Wire live when M29 lands (W-M40-11 M29-updates-canonical,
  W-M40-12 nightly-fallback-after-M29-outage).
- accept: consumers present as deny-stubs; nightly path covers Phase 1; gates green.

### M40-T10 — Screens, cache, audit, eraser, DR/INT
- deps: M40-T07 · files: UI per spec, module · spec §5, §4.8, §8.1, §7.8
- do: screens (§5); cache + invalidation (§4.8); audit events (§8.1); eraser incl. D7 tenant-offboarding
  destruction (§7.8); DR tier + INT inventory (NPPES).
- accept: `docs:ui` green; `validateErasers()` passes.

### M40-T11 — Test plan
- deps: all M40 · files: module + `packages/mdm` · spec §7
- do: §7.1 canonical uniqueness, §7.2 merge redirect, §7.3 overlay isolation, §7.5 NPPES drift,
  §7.7 BAA gate (W-M40-10/11), §7.8 destruction; RLS isolation.
- accept: `bun run test` green; full `arch:fitness` green.

---

## Wave B acceptance (the workflow's final gate)
1. M36 (15) + M38 (13) + M40 (11) ownedTables exist with RLS + migrations; manifest unchanged.
2. The three consumer seams are live and boot-validated: `AlertEmitter` (M36), `TerminologyProvider`
   (M38), `MdmEntityProvider` (M40); **`BaaStatusProvider` (M40) replaces the M3 deny-stub** and
   `validateSeams()` passes with all real impls.
3. Every org-scoped table carries an M4-generated audit trigger; `arch:gaps` green corpus-wide.
4. Phase-1 flag discipline holds: M38 semantic search behind `ai.full` (off), CPT D4-gated; M40 M29
   consumers deny-stubbed with the nightly NPPES job as the Phase-1 path.
5. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
6. **Wave B complete → Wave C (M5 Patient, M39 Consent) unblocked** — the first modules that consume
   M36/M38/M40 directly.

> Run per module via Archon, e.g.:
> `archon workflow run wardenx-piv --branch feat/m38-terminology "Use the plan at docs/plans/WAVE_B_M36-M38-M40_PLAN.md (Module 38 only)"`
