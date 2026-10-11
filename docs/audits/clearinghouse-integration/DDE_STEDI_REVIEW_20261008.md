# Review: DDE work queue and Stedi integration assessments

**Date:** 2026-10-08
**Reviews:** `DDE_STEDI_PROMPT_ASSESSMENT.md` (first assessment) and
`DDE_STEDI_INTEGRATION_ASSESSMENT_20261008.md` (second review).
**Sources:** repo code, the Stedi OpenAPI specs, Stedi docs, and CMS/MAC documentation (links at end).

## 1. Verdict on the two documents

| Item | First assessment | Second review |
|---|---|---|
| MBI cannot be read | Wrong. `05-patient/mbi-unlock-reader.ts` is real and registered in `05-patient/seams/index.ts:114` | Right |
| 21 validation rules | Stale. There are 22 (`packages/billing/src/rules/index.ts`) | Right |
| Nothing transmits | Mostly true. A launch gateway exists but is env-gated (`index.ts:3001`); the gateway target is not in the repo | Right |
| Generate call passes only IDs | Stale for claims (`claimDocument` is passed); true for NOE/NOTR | Right |
| Claim lacks condition/occurrence/discharge columns | Stale; `claim.ts` has them | Right |
| No visit lines | True | True |
| CHC units wrong | True (`unitCount: seg.days`) | True |
| Placeholder HIPPS value | True; stored in `hipps_calculation`, not in `ClaimDocument837i` | True |
| NGS payer record | n/a | Wrong. Stedi lists 837I and 835 as "Supported, enrollment required"; eligibility, 837P and claim status are unsupported |
| Initial 277CA | n/a | Incomplete. It is Stedi's edit check, not MAC acceptance |
| Platform API key | Wrong idea | Understated. Stedi says new apps must use OAuth |
| Adjustments (TOB 817/818) | Not covered | Not covered |
| Claim total vs lines | Not covered | Not covered |
| DDE queue | Not covered | Correctly missing, but over-specified and treated only as a fallback |

Both documents cite `packages/billing/src/claim-assembly.ts`, which does not exist. The file is
`apps/backend/src/modules/23-billing-medicare/services/claim-assembly.ts`.

## 2. DDE: what it is

- Direct Data Entry is the FISS terminal the MAC gives providers. IDs are individual, non-shareable, and
  require prior EDI enrollment. No sanctioned programmatic access was found.
- A "DDE work queue" in WardenX is therefore work tracking: what to key, when, by whom, and what came back.
- DDE is needed for: hospice claim entry (option 28), NOE/NOTR entry (option 49), Return-to-Provider
  correction (status/location T B9997, held up to 36 months, new receipt date on correction), adjusting
  paid or rejected claims, cancelling paid claims, NOE date corrections, ADR follow-up.
- NOE timeliness: submitted and accepted within 5 calendar days of the admission date; otherwise the gap
  days are provider-liable and billed with occurrence span 77 (WardenX already derives span 77).
- Repo status: no DDE code, table, route, or spec. Only `WARDENX_UI_NOE_NOTR_CLAIM_OPS.md:45` mentions it.

## 3. Stedi: findings from the OpenAPI specs

Confirmed:
- 837I JSON models attending, billing provider, value/occurrence/occurrence-span/condition codes,
  diagnoses, patient status, and service lines (revenue code, procedure code, modifiers, units, charge,
  non-covered charge). An 837I raw X12 endpoint also exists. Both take an `Idempotency-Key`.
- Test API keys work for claims; `usageIndicator: "T"` marks test claims.
- Enrollment supports `institutionalClaimSubmission` and `claimPayment`, with a PTAN field for payers
  that need it.
- Event destinations exist; 277CA and 835 JSON reports are fetched by transaction ID.

Constraints that affect the design:
1. `claimChargeAmount` must equal the sum of service line charges. WardenX computes
   `totalChargeCents = hipps.totalCents + siaCents + g0679ChargeCents`, and SIA is not a line, so claims
   with SIA would fail Stedi's edit.
2. Required but not produced by WardenX: `attending`, `admissionSourceCode`, `admissionTypeCode`.
3. Type of bill is split into `placeOfServiceCode` (facility type) and `claimFrequencyCode`. The
   documented frequency values are 1, 2, 3, 4, 7, 8, 9; NOE/NOTR use A-E. Use raw X12 for NOE/NOTR.
4. The synchronous 277CA reflects Stedi's edits only. Map it to a "clearinghouse accepted" state.
5. 999s are sent only for SFTP. WardenX's claim machine requires submitted, then 999, then 277CA.
6. Idempotency keys last 24 hours; keep a permanent local duplicate guard.
7. Stedi says Original Medicare institutional claims are resubmitted with the original frequency code,
   not 7/8, which conflicts with WardenX's TOB 817/818 model. Unconfirmed whether this covers
   adjustments of paid claims.
8. OAuth integrated accounts are required for new apps.

Unverified: hospice and NOE/NOTR handling, the exact J6 payer coverage, enrollment lead time, event
signing scheme, and CMS eligibility transport shape. See `STEDI_QUESTIONS_20261008.md`.

## 4. Other findings in the repo

- `x12-837-client` is a contract shell; the NGS J6 portal client is a skeleton.
- The repo already has a golden-tested TypeScript 837I builder for transfer notices
  (`build837iTransferNotice`) following the CMS NOE companion guide.
- HETS eligibility already supports `core_mime` with a clearinghouse bearer token.
- The M25 835 worker port is undefined in every environment (`index.ts` comment near line 3010).
- `read-service.ts` exposes `hippsCode` to the UI, so the placeholder is visible even though it is not
  transmitted.

## 5. Recommended path

See `.claude/plans/dde-work-queue-stedi-integration.plan.md`.

## Caveats

Not read: the CMS Ch. 11 PDF and licensed X12 guides. Not tested: any Stedi endpoint. DDE details were
taken from NGS/CGS pages, not the user's own MAC manual.

## Sources

- Stedi: [API reference](https://www.stedi.com/docs/healthcare/api-reference),
  [OpenAPI specs](https://github.com/Stedi/openApi),
  [resubmit or cancel claims](https://www.stedi.com/docs/healthcare/resubmit-cancel-claims),
  [claim response overview](https://www.stedi.com/docs/healthcare/claim-responses-overview),
  [receive claim responses](https://www.stedi.com/docs/healthcare/receive-claim-responses),
  [integrated accounts](https://www.stedi.com/docs/healthcare/integrated-account-overview),
  [NGS payer record](https://www.stedi.com/healthcare/network/MFPWU)
- CMS/MAC: [CMS Ch. 11](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c11.pdf),
  [CGS claims correction](https://www.cgsmedicare.com/hhh/education/materials/pdf/chapter_5-claims_correction_menu.pdf),
  [CGS return to provider](https://cgsmedicare.com/hhh/education/materials/return_to_provider.html),
  [CMS FISS menu](https://data.cms.gov/sites/default/files/2020-08/Fiscal%20Intermediary%20Standard%20System%20(FISS).pdf),
  [NGS hospice billing](https://www.ngsmedicare.com/web/ngs/hospice-billing?selectedArticleId=409551&lob=93617&state=97206&rgion=93624),
  [CMS CR 8877](https://cms.gov/regulations-and-guidance/guidance/transmittals/2019downloads/r4211cp.pdf)
