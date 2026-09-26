# WardenX — Phase 3 upgrades: flag activations (Archon task plan)

Phase 3 upgrades from `PHASE_3_PLAN.md` §3 — **re-open existing modules to flip the last default-off
flags on**, each re-running DoD for the new surface. **Conventions, determinism rules, and the validate
gate are inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`.** No manifest changes (flag activations on
already-owned tables/code). Run **in parallel with the M37 build** (`WAVE_P3_M37_IPU_PLAN.md`).

> **Sequence (PHASE_3_PLAN §4):** M37 first (longest, independent). **M34 multi-tenant before broadly
> onboarding tenants.** M30 CAHPS/HVLDL/HCI needs M27 (Phase 2) live + a full reporting period of data.
> M12 EPCS and M28 write are independent, **gated by external certification**.
>
> **⚠ Certification is an explicit gate task, not code-only (PHASE_3_PLAN note):** M28 `fhir.write`
> (FHIR R4 conformance) and M12 `dosespot.epcs` (DEA EPCS audit) ship **flag-ready** but the flag stays
> **OFF until the certification lands**. Model the cert as its own task with an external dependency.

## P3-U1 — M34 SaaS: activate `saas.multi_tenant`
- **P3-U1-T01** Flip full multi-tenant mode: tenant onboarding maturity + **self-serve signup**
  (`tenant_signup_intent`/`tenant_signup_token`), ops-console (`apps/admin`) maturity. RLS was on from
  Phase 1 — this is **activation, not retrofit**.
- **P3-U1-T02** **Corpus-wide cross-tenant isolation test suite** — a second/third tenant onboards
  self-serve with full RLS isolation across every PHI table (acceptance §6.2). Per-tenant key handling.
- **P3-U1-T03** Tests + DoD for the new surface. → `bun run test` + full `arch:fitness`.

## P3-U2 — M30 HQRP/Quality: activate `quality.cahps` + `quality.hvldl_hci`  (needs M27 live)
- **P3-U2-T01** CAHPS vendor integration (SHP default per ADR-005, `packages/cahps-vendors`): decedent
  sampling → export to the SHP adapter → ingest (`cahps_decedent_sample`/`cahps_result_summary`/
  `cahps_vendor_binding`); sampling-source marking (§4.13 D22).
- **P3-U2-T02** HVLDL / HCI measures compute against a **full reporting period**; consume M27
  `CostReportProvider` (now real from Phase 2) where measures need cost inputs.
- **P3-U2-T03** Tests (CAHPS export/ingest, HVLDL/HCI compute) + DoD. → gates.

## P3-U3 — M26 Cap: activate `cap.full_projection`
- **P3-U3-T01** Agency-wide cap watch + alerts beyond the Phase-1 basic projection: full per-CCN
  aggregate projection + threshold alerts via the M36 `AlertEmitter` + `CapAlertSubscriberProvider`.
- **P3-U3-T02** Tests (agency-aggregate projection + alerts fire at configured thresholds, §6.6) + DoD. → gates.

## P3-U4 — M28 FHIR Gateway: activate `fhir.write`  (certification-gated)
- **P3-U4-T01** Implement R4 write + R5 stub: write paths for the US Core resources Phase 1 served
  read-only; inbound resource apply through the existing proposal pipeline.
- **P3-U4-T02** **FHIR R4 conformance certification** — explicit external gate task; conformance test
  suite green; a US Core R4 resource **round-trips (write + read-back)** (acceptance §6.4).
- **P3-U4-T03** Keep `fhir.write` **OFF until conformance certified**; tests + DoD. → gates.

## P3-U5 — M12 DoseSpot: activate `dosespot.epcs`  (certification-gated)
- **P3-U5-T01** Complete the EPCS architecture built behind the flag in Phase 1 (§2.4, IAL2 + 2FA per
  21 CFR 1311.115/116): controlled-substance prescription with EPCS assertions (`epcs_signing_attempt`).
- **P3-U5-T02** **DEA EPCS audit/certification** — explicit external gate task; flow a controlled
  substance through with EPCS assertions post-cert (acceptance §6.5).
- **P3-U5-T03** Keep `dosespot.epcs` **OFF until DEA-certified**; tests + DoD. → gates.

---

## Phase 3 upgrades acceptance — and Phase 3 / v1 done
1. All five flags ON (M28/M12 only after their certifications); each upgrade passes DoD for its new
   surface; no schema/manifest change beyond what the owning module already owns.
2. M34 multi-tenant: a 2nd/3rd tenant onboards self-serve; **corpus-wide cross-tenant isolation passes**.
3. M30 full quality: CAHPS export + HVLDL/HCI compute; M26 full cap alerts fire; M28 R4 round-trips;
   M12 EPCS flows (post-cert).
4. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
5. **PHASE 3 COMPLETE — with M37, all 40 modules built and every feature flag activated.** Beyond this
   is Phase 4 / v2 (additional state Medicaid adapters, advanced analytics, multi-CCN, HITRUST/SOC2) —
   see `PHASE_4_PLAN.md`.

> Run via Archon, e.g.: `archon workflow run wardenx-piv --branch feat/multi-tenant "Use the plan at docs/plans/PHASE_3_UPGRADES_PLAN.md (P3-U1 only)"`
