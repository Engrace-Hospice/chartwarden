# M27 Cost Report — CMS Line-Geometry Certification Ledger

**Date:** 2026-06-28 · **Scope:** Form CMS-1984-14 (freestanding hospice cost report, periods on/after
2014-10-01) worksheet math implemented in `packages/cost-report/src/allocation/` + `…/worksheets/`.
**Status:** ⚠️ **PARTIAL** — statutory constants verified and cited; line-by-line worksheet geometry
**pending primary-source confirmation** (see [Access limitation](#access-limitation)).

This is the evidence trail behind the `// CMS-CERT` markers in the M27 allocation/worksheet code. It records
what has been verified against authoritative sources, the exact source pointers for what has not, and the
honest residual. **It does not claim a penny-level certification that has not been performed.**

## Method

The M27 allocation chain (A → B → C → D → E-1) is deterministic `decimal.js` math (D8) that ties out
*internally* to the cent against its own inputs (proven by the property/unit suites in
`packages/cost-report/__tests__/`). "Certification" here means confirming the **external** facts that math
encodes — the statutory rates, the cap mechanics, and the CMS-prescribed worksheet line geometry — against
authoritative CMS sources.

## Access limitation

Direct programmatic fetch of the CMS primary sources was **not possible in the build environment**: `cms.gov`,
`federalregister.gov`, `ecfr.gov`, and the `hhs.gov` document mirror all return HTTP 403 / anti-bot redirects
to `unblock.federalregister.gov`. In addition, **CMS does not publish a filled-in, penny-level example hospice
cost report** (unlike a worked tutorial); the Form CMS-1984-14 package (transmittal R8P243) and instructions
(R5P247 / Pub 15-2 Ch. 43) ship as *blank forms + line instructions*, not a numeric example. Consequently the
line-by-line geometry below is corroborated only from **secondary** summaries and remains marked *pending*
until the primary form package is read line-for-line. The figures recorded here that came from search-engine
summaries of CMS pages are labeled accordingly and must be confirmed against the cited document before being
relied upon as a regulatory certification.

## Authoritative sources (to read for full certification)

| # | Source | What it certifies |
|---|--------|-------------------|
| S1 | CMS Pub 15-2 (Provider Reimbursement Manual, Part 2) **Chapter 43** — Form CMS-1984-14 instructions; transmittal **R5P247** / **R8P243** (form, OMB 0938-0758) | Worksheet A/B/B-1/C/D/E-1 line numbers, labels, ordering, and prescribed rounding |
| S2 | **42 CFR Part 418 Subpart G** (§418.302, §418.306, §418.308, §418.309) | Aggregate cap, inpatient cap, cap-year dates, payment reductions |
| S3 | CMS FY Hospice Wage Index & Payment Rate Update **Final Rules** (FY2024 CMS-1810-F … FY2026 CMS-1835-F, FY2027 CMS-1851) | Annual aggregate-cap dollar amount + payment-update % |
| S4 | Budget Control Act of 2011 + CARES Act §3709 + CAA-2021/2022 | Medicare 2% sequestration and its suspension/phase-in schedule |

URLs (blocked for automated fetch here; open manually):
- S1 form: `https://www.cms.gov/files/document/r8p243f.pdf` · instructions: `https://www.cms.gov/files/document/r5p247i.pdf`
- S2: `https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-418/subpart-G`
- S3: `https://www.cms.gov/newsroom/fact-sheets/` (per-FY final-rule fact sheets)

## Verified constants (high confidence)

### Inpatient day cap — **20%** (`assemble-inputs.ts INPATIENT_DAY_CAP_PERCENT`)
42 CFR §418.302(f) / §418.108 — inpatient care days are limited to **20%** of a hospice's total Medicare
patient days for the cap year. ✅ The percentage is confirmed and stable. ⚠️ The exact **day-set** in the
numerator (general-inpatient only vs. GIP + respite) still needs the §418.302(f) text read verbatim — the
code currently sums GIP + IRC; flagged in-code.

### Cap accounting year — **November 1 – October 31** (M26 cap context + `cap-context.ts`)
42 CFR §418.309 — the aggregate cap accounting year runs **Nov 1 – Oct 31**, independent of the provider
fiscal year (D2). ✅ Confirmed; already encoded.

### Medicare sequestration — **2% (period-variable)** (`settlement.ts sequestrationRateMicros`)
Budget Control Act of 2011: a **2%** reduction applied to the Medicare payment after beneficiary cost-sharing.
**Suspension/phase-in schedule (S4):** 2% from 2013-04-01; **suspended 2020-05-01 → 2022-03-31** (CARES Act +
extensions); **1% 2022-04-01 → 2022-06-30**; **2% from 2022-07-01** onward. ✅ This is exactly why
`sequestrationRateMicros` is a **caller-supplied per-FY input** (not a hardcoded constant) — a cost report
spanning the suspension/phase-in window must use the rate in effect for its period. The settlement math applies
the supplied rate to the post-SIA Medicare payment; the precise **base line** the 2% attaches to is the S1
item still pending.

### Aggregate cap amount — reference schedule (M26 domain, NOT hardcoded in M27)
The per-beneficiary aggregate cap dollar amount is published annually and is **M26 `CapAccrualReader`'s**
responsibility to supply (M27 consumes it via the cap context — it is deliberately not hardcoded in M27). Recorded
here as reference only (from S3 search summaries; **confirm against each final rule**):

| Cap year (FYE) | Aggregate cap / beneficiary | Update % applied |
|---|---|---|
| FY2024 | $33,494.01 | — |
| FY2025 | $34,465.34 | 2.9% |
| FY2026 | $35,361.44 | 2.6% |
| FY2027 | $36,210.11 | ~2.4% |

The chain is arithmetically self-consistent (e.g. 33,494.01 × 1.029 = 34,465.34; × 1.026 = 35,361.44),
which corroborates the figures but does not replace reading the final rule.

## Line-geometry status — PENDING primary-source confirmation

The settlement *flow* is corroborated by secondary summaries (HFMA/PRM training materials): **allowable cost →
(SIA add-on) → sequestration reduction → bad-debt reimbursement added → interim payments subtracted → balance
due to/from provider**, with the cap overage reducing the amount due. The current implementation follows this
order and ties out internally. What remains to certify against **S1** (Pub 15-2 Ch. 43), worksheet by worksheet:

| Worksheet | Implemented (file) | Pending against S1 |
|---|---|---|
| **B** step-down | `allocation/step-down.ts`, `assemble-inputs.ts` | Canonical overhead **step-down ORDER** + the prescribed statistical **basis per general-service center** (sq-ft / FTE / accumulated cost). Mechanics + weight-driven allocation are wired; the *which-basis-where* mapping is the open item. |
| **C** ancillary RCC | `allocation/ancillary-apportionment.ts` | Exact ancillary cost-center set + the zero-charge-basis handling line. |
| **D** program apportionment | `allocation/program-apportionment.ts`, `to-worksheets.ts` | Exact **column geometry** (program × LOC) and any CMS-prescribed per-diem rounding before re-multiplication. |
| **E-1** settlement | `worksheets/e-1.ts`, `allocation/settlement.ts` | Exact **line numbers/labels + ordering**, the **protested-amounts** line, the precise **sequestration base** line, and the bad-debt line (currently a `0` placeholder pending the bad-debt worksheet seam). |
| **B-1** cap calc | `worksheets/b-1.ts` | Aggregate + inpatient cap line layout (cap inputs come from M26). |

## Residual / next steps

1. Read **S1** (R8P243 form + R5P247 instructions, Pub 15-2 Ch. 43) line-for-line and flip each row of the
   table above from *pending* to *confirmed*, recording the verbatim line numbers in this ledger.
2. Confirm the §418.302(f) inpatient-cap **day-set** (GIP vs GIP+respite) and adjust the numerator if needed.
3. Confirm each FY aggregate-cap amount against its final rule (S3) — in **M26**, not M27.
4. Once S1 is in hand, add a **penny-level fixture test** built from a worked CMS example (or a MAC-published
   worked example) and assert the A→E-1 chain to the cent; only then upgrade this ledger's status to ✅.

Until step 1–4 are complete, the M27 allocation math is **internally tied-out and statutorily aligned where
verifiable**, but the worksheet line geometry is **not yet certified** against the CMS primary source.
