# ADR-0015 — Hospice election & certification correctness (42 CFR 418.22/418.24/418.25/418.26/418.30)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 4 (Medicare correctness)
- **Resolves:** M06-F02/F03/F04/F05/F09/F10
- **Changes:** `WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC`

## Context

M06 encodes the conditions of *payment* for hospice election and certification. Six of them are
wrong in ways that make every election noncompliant or bill uncertified days.

## Decision

### D1 — Election-statement addendum is a first-class entity (418.24(c))

The **Patient Notification of Hospice Non-Covered Items, Services, and Drugs** ("addendum",
effective 10/1/2020) is a **condition of payment** and was entirely absent. M06 adds an
`election_addendum` entity: furnished within **5 days** of election (or within **72 hours** when
requested after day 5), signed/dated by the patient or representative, versioned, amendable when the
plan of care changes. The non-covered DME path (M21) terminates on this addendum. (M06-F02)

### D2 — Certification timing: verbal-then-written, with the 15-day early-completion limit (418.22)

- **Initial cert (CTI):** written certification by the hospice medical director or physician member
  of the IDG **and** the patient's attending physician (if the patient has one). If the written
  cert cannot be completed at admission, a **verbal certification is obtained within 2 calendar
  days** of the period start; the **written cert must be on file before the hospice bills**.
- **Recertification:** for the 2nd and subsequent benefit periods, the cert may be completed **no
  more than 15 calendar days before** the start of the period — not earlier. (The v0.4 spec encoded
  the verbal/written ordering backwards and let cert complete arbitrarily early.) (M06-F03)
- A **CTI narrative** signed and physician-attributable is required; for the 3rd+ benefit period the
  CTI is also signed by the attending physician if the patient has one.

### D3 — One election statement per election, not per benefit period (418.24)

A beneficiary **elects hospice once**; the election continues across benefit periods until revoked,
discharged, or transferred. M06 captures **one signed election statement per election**, not a new
signed statement per benefit period (which would block recerts or induce fabricated re-signings).
Benefit-period sequencing (90/90/60/60…) is tracked separately on the election. (M06-F04)

### D4 — Face-to-face: CMS late-F2F logic + exceptional circumstances (418.22(a)(4))

For the **3rd benefit period and each subsequent recert**, a hospice **physician or NP** must have a
**face-to-face encounter** with the patient **no more than 30 calendar days before** the period
start. M06 removes the invented agency "override" that CMS does not recognize and bills uncertified
days. The **exceptional-circumstances** rule is encoded: when a patient is admitted in the 3rd+
period within 2 days of the period start before a F2F could occur, the F2F must occur **within 2
calendar days of admission**; absent that, the patient is **not certified** (discharge), never
billed. (M06-F05)

### D5 — Live discharge: physician order for all reasons + NOMNC where required (418.26)

A live discharge requires a **physician discharge order** for **every** discharge reason (moved out
of area, no-longer-terminally-ill, discharge-for-cause). For discharge due to **no-longer-terminally-
ill** or **for-cause**, a **Notice of Medicare Non-Coverage (NOMNC)** is issued with appeal rights.
(M06-F09)

### D6 — Transfer requires the 418.30 patient-signed statement

A beneficiary may **transfer hospices once per benefit period**; the transfer requires a
**patient-signed statement** naming the receiving hospice and the effective date. (M06-F10)

## Consequences

- M06 adds the `election_addendum` entity, corrects the cert state machine (verbal→written, 15-day),
  models one-statement-per-election, the CMS F2F/exceptional logic, the discharge-order + NOMNC, and
  the transfer statement.
- M23's claim pre-submission rules (election validity, CTI, F2F) validate against this corrected
  model; M21's non-covered DME terminates on the addendum.

## Amendment (FY2027, 2026-10-06) — D1: the addendum is mandatory for every election from 2026-10-01

The FY2027 hospice final rule (CMS-1851-F, 91 FR 49118, effective 2026-10-01; correction CMS-1851-CN) amended
42 CFR 418.24(b)(6), the (c) introductory text, (c)(9), (c)(10) and (d). Primary-source text and implementation
facts: [`docs/research/FY2027_HOSPICE_COP_RESEARCH.md`](../research/FY2027_HOSPICE_COP_RESEARCH.md) §1. D1 is
amended as follows; everything else in D1 stands.

- **Scope.** The addendum is no longer furnished on request: it is **mandatory for every election whose
  effective date is on or after 2026-10-01**. The "72 hours when requested after day 5" path no longer
  applies to those elections. Earlier elections keep the old rule (not built as a separate workflow).
- **Timeframes (418.24(d)).** Initial: within **5 calendar days** of the election's effective date. Update:
  within **3 calendar days** of a plan-of-care change that affects the determinations. Death, revocation or
  discharge before the addendum is furnished means it need not be furnished; before it is signed means it need
  not be signed for payment. Either way the reason is noted (on the addendum, for a missing signature).
- **Content (418.24(c)).** The exact title "Patient Notification of Hospice Non-Covered Items, Services, and
  Drugs"; a refusal to sign is documented on the addendum with the reason; signing acknowledges receipt only;
  the date furnished is recorded. "No non-covered items" is a documented determination, not a blank form.
- **Election statement (418.24(b)(6)).** The election statement tells the beneficiary they **will** receive the
  addendum.
- **Payment.** CMS treats a signed addendum (or the documented exceptions) as a condition for payment. CMS
  announced enforcement discretion for 2026-10-01 through 2026-12-31 (MLN Connects, 2026-10-01): M23's
  `election_addendum_signed` rule warns during that window and blocks from 2027-01-01.

As built: M6 owns the versioned `election_addendum` table (migrations 0380–0382), its state machine, the
`election_addendum_initial` / `election_addendum_update` compliance windows, the plan-of-care update path
(`openAddendumUpdateWindow`), and automatic settlement on death, revocation or discharge (M6 spec v0.8 §2.6). The
non-covered determinations reach M6 through the `NonCoveredItemsReader` seam (M7 problems today; M12 medications
and M21 DME and supplies next), which is how "the non-covered DME path terminates on this addendum" is realized.
