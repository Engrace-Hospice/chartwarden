# WardenX — Wave P2-2: M19 On-Call Triage · M20 Field Safety

Phase 2 Part B, Wave P2-2 from `PHASE_2_PLAN.md` §3 — after-hours coordination + field safety, both
depending on M17 scheduling. **Conventions, determinism rules, the validate gate, and the legend are
inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`.** Each spec ends with a §12 sign-off.

Specs: `docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md`,
`WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_3.md`.

> **Build order: M19 → M20.** Deps: M19←[5,17,36], M20←[17,36]; but M20's after-hours SOS path
> consumes M19's `OnCallProvider` (seam, no edge) — build M19 first or deny-stub.
>
> **Seams that go LIVE this wave (closing Phase-1 deny-stubs):**
> | Now real | Closes |
> |---|---|
> | M19 consumes `m17.visit.no_show_detected` + M11 verbal-order seam during call | M17 (Wave F) no-show consumer; M11 verbal-order during triage |
> | M19 consumes `m18.evv.late_check_out_detected` | M18 (Wave F) late-checkout consumer |
> | M19 `OnCallProvider` → M36 `on_call` channel + M20 after-hours SOS | M36 on-call membership; **replaces the Phase-1 SOS degraded fallback** |
> | M20 consumes M18 `EvvLocationProvider` | M18 (Wave F) last-known-location consumer |
>
> **ADR-0026 (M19 vendor-operator auth):** external triage-vendor operators authenticate via Better
> Auth's `external_triage_vendor` session class (org + vendor + shift scoped, MFA) — **M19 mints no
> tokens**. Requires the M2 session-class addition (Security-Owner sign-off per the ADR).
>
> **AI dependency (advisory only):** M19 `ProtocolSuggestionProvider`/`HospitalizationRiskProvider`
> (M32) are advisory and need Part-A `ai.full`; ship deny-stub until then (AI Governance §2.1.1).
>
> **Manifest note (RESOLVED):** `packages/triage-vendors` is now in M19's `codePaths` and
> `packages/evv-aggregators` in M18's (ADR-0028, applied) — both fitness-governed. No action needed.

## Module 19 — On-Call Triage (deps: 5,17,36 · apps/backend/src/modules/19-oncall) — 10 tables
- **M19-T01** Enums + layout + domain (§2); `packages/triage-vendors` adapter scaffold (see manifest note); types in `packages/types`. → `tsc -b`.
- **M19-T02** Schema (10 tables, §3.3): triage_call(_answer/_state_history), triage_protocol(_question), triage_escalation, on_call_shift, tenant_oncall_policy, external_triage_vendor, triage_paper_reentry_worklist; RLS + M4 audit (caller-quote cipher denylisted) + eraser (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M19-T03** Triage-call lifecycle (§3) + protocol engine; **mandatory escalations** (§7.2 suicidal ideation → supervisor + medical-director); disposition + paper re-entry worklist.
- **M19-T04** On-call roster from M17 `VisitAssignmentReader.tonightsOnCallRoster`; consume `m17.visit.no_show_detected` (closes M17) + `m18.evv.late_check_out_detected` (closes M18) as inbound triggers.
- **M19-T05** Triage encounter via M8 `EncounterCreator` (§7); verbal order during call via M11 `OrderSignatureProvider` with **biometric step-up** (§7.7); M12 refill-inbox surface (read).
- **M19-T06** Five published reader seams (§4.3, incl. **`OnCallProvider`**) into M1 — feeds M36 `on_call` channel + M20; advisory M32 seams as deny-stub (ai.full). → `validateSeams`.
- **M19-T07** Routes (§4.1–4.2) + permission keys (§4.6) + ABAC (§4.7: `oncall_eligible`/`triage_call_owner_or_supervisor`/`external_triage_actor`) into M3; M36 typed alerts + delivery-failed; M39 SUD gating; M40 ExternalTriageVendor; adapter-mandate compliance (§8.5); **PHI minimization at vendor boundary** (§7.10).
- **M19-T08** Screens (§5; portal variants M31) + tests (§9 incl. RLS) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 20 — Field Safety (deps: 17,36 · apps/backend/src/modules/20-field-safety) — 13 tables  (build after M19)
- **M20-T01** Enums + layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M20-T02** Schema (13 tables, §3.3): safety_sos_alert(_state_history/_location_stream), safety_check_in(_schedule), safety_incident(_state_history), safety_policy(_version), safety_high_risk_area, safety_acknowledgment, safety_emergency_contact_consent, safety_supervisor_subscription; RLS + M4 audit (per-table retention split, dispatch-payload cipher denylisted) + eraser (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M20-T03** SOS lifecycle (§7.4 mid-visit cancel within window — biometric, D5); overdue-check-in escalation tiers (§7.3 D4); continuous-location stream during active SOS with consent (§7.9 D6); coverage-gap watchdog (§7.8).
- **M20-T04** Consume M17 `VisitReader`/`VisitAssignmentReader`; **M18 `EvvLocationProvider`** (closes M18 last-known-location); **M19 `OnCallProvider`** for after-hours SOS parallel recipient (§7.5 D14).
- **M20-T05** Seven published reader seams (§4.3) + `SafetySupervisorProvider` composition with M36's recipient resolver (§4.5); the M20-owned emergency-contact override row (M20-F06). → `validateSeams`.
- **M20-T06** Routes (§4.1–4.2) + permission keys (§4.6) + ABAC (§4.7: `safety_supervisor_or_above`/`active_sos_responder`/…) into M3; M36 `field_safety` category + **SOS Tier-1 voice** (system_locked); workers-comp/OSHA incident sign-off (§7.6 D9).
- **M20-T07** Screens (§5; portal variants M31) + tests (§9 incl. RLS) + §12 sign-off. → `bun run test` + full `arch:fitness`.

---

## Wave P2-2 acceptance
1. M19(10)+M20(13) ownedTables exist with RLS + migrations; manifest unchanged (modulo the
   triage-vendors codePath ADR decision).
2. `validateSeams()` passes with M19's five readers (incl. `OnCallProvider`) + M20's seven;
   **M17 no-show, M18 late-checkout + last-known-location deny-stubs closed**; `arch:boundaries` green.
3. **The Phase-1 SOS degraded fallback is replaced** by the real M19 on-call path (PHASE_2 §3 P2-2).
4. ADR-0026 vendor-operator auth in place (M2 session class); M19 mints no tokens; PHI-minimization at
   the vendor boundary holds (§7.10).
5. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
6. **→ Wave P2-3 (M27 Cost Report, M31 Portal, M33 Reporting, M35 Subscription Billing).**

> Run per module via Archon, e.g.: `archon workflow run wardenx-piv --branch feat/m19-oncall "Use the plan at docs/plans/WAVE_P2-2_M19-M20_PLAN.md (Module 19 only)"`
