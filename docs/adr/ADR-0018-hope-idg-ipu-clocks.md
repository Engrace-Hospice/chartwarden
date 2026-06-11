# ADR-0018 — HOPE SFV anchor, IDG 15-day per-patient clock + MD/DO seat, IPU LOC + RN-coverage fail-open

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 4 (clinical-regulatory correctness)
- **Resolves:** M10-F02/F06/F07, M30-F04; M14-F01, M07-F01; M37-F03/F08/F11/F12
- **Changes:** `WARDENX_MODULE_10_HOPE`, `WARDENX_MODULE_14_IDG`, `WARDENX_MODULE_07_CARE_PLAN`, `WARDENX_MODULE_37_IPU`, `WARDENX_MODULE_30_HQRP`

## Context

Three clinical-regulatory clocks are mis-encoded in ways that either silently under-report HQRP
non-compliance, escape a CoP cadence, or create a patient-safety hazard.

## Decision

### D1 — HOPE SFV 2-calendar-day clock anchored to the VISIT/ASSESSMENT date (M10-F02)

When a HOPE assessment (HUV) records a **J2051 moderate/severe** symptom impact, a **Symptom
Follow-Up Visit (SFV)** must occur **within 2 calendar days** of the **visit/assessment date** — the
clock anchors to the **date of the assessment**, **never** to the signature timestamp. Anchoring to
signature let delayed signing extend the federal deadline, silently under-reporting HQRP
non-compliance and exposing the 4-point APU reduction. M30's HQRP "Timely Follow-Up" measure uses
the **same visit-date anchor** (M30-F04 resolves the 2-calendar-day vs 48-hour contradiction in
favor of 2 calendar days). The HOPE **J-item codes are corrected** (M10-F07 transposition), and an
**iQIES inactivation flow** (correct/withdraw a submitted record) is added (M10-F06).

### D2 — IDG 15-day review is a per-patient (per-plan-of-care) clock (M14-F01)

The IDG reviews and updates each patient's plan of care **at least every 15 calendar days**
(418.56(b)). This is a **per-patient clock anchored to the last review of that plan of care** — not
an escapable location-wide meeting cadence that cancel/reschedule can slip. A missed 15-day review
**escalates** (it does not silently lapse). The review-completed event drives the next clock.

### D3 — The IDG physician seat is MD/DO only (M07-F01 / 418.56)

The IDG's required **physician** member is an **MD or DO** (the hospice medical director or a
physician designee). An **NP may not occupy the IDG physician seat** (an NP may be the attending and
may perform recert F2F, but the CoP IDG physician role is MD/DO). M07/M14 enforce MD/DO for the IDG
physician participant.

### D4 — IPU level-of-care + RN-coverage gate fails OPEN (M37-F03/F08/F11/F12)

- **GIP** has **no fixed 7-vs-14-day imminent-death bound** — it is for symptom management that
  cannot be provided in another setting; the invented bound is removed (M37-F08).
- **IRC** is limited to **5 consecutive days**; **day 6+ reverts to RHC pricing** (not blocked, not
  a 30-day no-reset) — consistent with ADR-0016 D2 (M37-F11/F12).
- The **24/7-RN-coverage requirement must fail OPEN at the order gate**: a stale or missing coverage
  attestation must **not hard-block inpatient orders** (a patient-safety hazard). The gate **warns
  and flags for compliance review** but never blocks a clinically-needed inpatient order (M37-F03
  over-encoded ARCH-188).

## Consequences

- M10 re-anchors the SFV clock to visit date, fixes J-codes, adds iQIES inactivation; M30 aligns the
  Timely-Follow-Up measure to the same anchor.
- M14/M07 enforce the per-patient 15-day clock with escalation and the MD/DO-only IDG physician seat.
- M37 removes the invented LOC bounds and makes the RN-coverage gate fail-open.
