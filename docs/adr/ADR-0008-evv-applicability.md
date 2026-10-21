# ADR-0008 — EVV applicability: Cures Act is Medicaid-only; Medicare-hospice EVV is operational and never claim-blocking; launch state is Oregon; HQRP has no EVV measure

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (architecture correction)
- **Resolves:** M18-F04, M18-F05; M24 (EVV over-encoding); Medicare-Hospice gaps; Build-Blocking #9
- **Changes:** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §11 Module 18, §11.A (no EVV regulatory rule), §20.A Phase-1 row

## Context

The architecture and Module 18's spec over-encoded EVV as a federal mandate that gates Medicare
hospice claims, and used Texas examples for an Oregon launch tenant. This blocks payable Medicare
claims and mis-scopes the integration:

- **21st Century Cures Act §12006 EVV is a *Medicaid* mandate** for personal-care services (since
  1/1/2020) and home-health services (since 1/1/2023). **Medicare hospice (TOB 81x) is not
  federally EVV-mandated.** State treatment of hospice/hospice-aide services under Medicaid varies.
- The §11.A pre-submission rule library contains **no EVV rule**, yet M18 asserted an EVV
  "regulatory_required" claim gate — which would wrongly RTP compliant Medicare claims.
- **HQRP has no EVV measure** (HQRP = HCI, HVLDL, HOPE-derived, CAHPS). M18 labeled an internal
  ops metric as an "HQRP EVV measure."
- The Phase-1 go-live tenant (Engrace, Pendleton **Oregon**, ARCH-016) was modeled with a Texas
  Medicaid / Sandata-TX adapter and TX examples throughout.

## Decision

1. **EVV applicability is determined per `(state × payer program × service type)`:**
   - **Medicare hospice visits:** EVV is an **operational / internal visit-verification** feature
     only. It **must never** be a `regulatory_required` claim-blocking rule. A tenant may enable
     an *operational* (non-`regulatory_required`, overridable) visit-verification validation, but
     EVV non-compliance never blocks a payable Medicare claim.
   - **Medicaid services:** EVV capture and **state-aggregator submission** are required **only
     where the state mandates EVV for that payer program and service type.** Such a rule may be
     `regulatory_required` for that state's Medicaid claims.
   - The payer/program input that drives this decision comes from a **named, typed seam** (patient
     coverage / payer program), not from patient address state; M18 must declare that seam (its
     manifest/ADR treatment is M18's Phase-2 re-lock work).

2. **§11.A gains no federal EVV rule.** Any EVV pre-submission rule is tenant-configurable and is
   `regulatory_required` **only** for state-Medicaid claims in mandating states.

3. **HQRP has no EVV measure.** Rename M18's "EVV-compliance HQRP measure" to **"EVV compliance
   (operational quality metric)"**; M30 must not build a CMS EVV measure.

4. **Launch state is Oregon.** Default EVV examples, the launch aggregator adapter, and the
   applicability worked-examples use **Oregon Medicaid** (OR-PTC / the Oregon aggregator), not
   Texas/Wisconsin. The TX/WI adapter annotations are corrected.

5. **EVV state aggregators are external PHI integrations.** They must be added to the Integration
   Catalog via the INT-002 five-step process with a BAA / trading-partner determination before
   production PHI flows (M18 Phase-5 work; this ADR fixes only the applicability/architecture).

## Consequences

- Module 18's "Medicare visits" Phase-1 row remains valid as an **operational** capture/gate, not
  a regulatory claim rule. M23/M24 pre-submission rules must encode EVV as operational for
  Medicare and conditionally `regulatory_required` for mandating-state Medicaid only.
- M30 drops any EVV HQRP measure. M18/M24 re-locks (Phase 2/4) implement the applicability matrix,
  the Oregon adapter, and the coverage/payer seam.
