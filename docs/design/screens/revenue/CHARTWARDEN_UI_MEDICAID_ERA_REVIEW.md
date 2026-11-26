# CHARTWARDEN_UI_MEDICAID_ERA_REVIEW

Version: 1.0
Status: Implemented operator workflow
Module: Remittance / Medicaid ERA Review

## Purpose

Give authorized billing staff a tenant- and provider-scoped place to review nonposting Medicaid ERA
assessments, understand reported claim observations, and record an investigation disposition. This
workflow does not retrieve ERAs, post payments, or change Medicaid claim financial state.

## Layout Pattern

Use Work Queue + Review Workspace.

## Entry points

- Worklist: `/remittance/medicaid-era-reviews`
- Investigation: `/remittance/medicaid-era-reviews/:id`
- Source evaluation: selected artifact action in `/remittance/claimmd-era-review`

The worklist uses server cursor pagination. The current API has no filters or total count; the UI
does not present one-page filtering as an organization-wide search. An empty scoped result links to
the existing Claim.MD source screen and does not imply that no remittances exist.

## Worklist

The primary status is the investigation workflow. Assessment outcome, evaluator trust, source
environment, payer/program attribution, claim matching, and duplicate classification remain
separate facts. Legacy-unverified rows do not display payer, environment, or duplicate evidence as
verified. Provider display names and payer directory labels are unavailable in the current contract
and are not fabricated.

## Investigation workspace

Sections present the assessment outcome and reasons, claim-level reported observations, source and
evidence limitations, and the chronological assessment/investigation history. The UI validates the
allowlisted `safeSummary` shape at runtime. Unsupported or malformed summaries display no amounts.
Transaction-level payment totals are not repeated under each claim. All shown financial values are
reported 835 observations, not ledger balances, allocations, allowed amounts, or posted activity.

Point-in-time assessments show their observation timestamp and explicitly say that they do not prove
current eligibility or authorize payment. Historical assessments and events remain marked
unverified; their prior contents are not reconstructed. Reassessment accepts only a review ID and
resolves the staged source on the server.

## Permissions and actions

| Operation | Permission |
|---|---|
| List | `remittance.read` |
| Detail | `remittance.read` and `remittance.financial_review` |
| History | `remittance.read` |
| Evaluate selected staged artifact | `remittance.match_review` |
| Reassess | `remittance.match_review` |
| Record reason or disposition | `remittance.financial_review` |

Actions use repository idempotency keys and expected review versions. Stale conflicts prompt a
refresh; the screen does not update a financial or trust status optimistically. The only disposition
states are investigating, follow-up required, reviewed-not-posted, and reopened. There are no
payment, posting, forced-match, or claim-paid actions in this workflow.

## Accessibility and scope

The page uses Billing/Revenue Cycle navigation, semantic sections and headings, named controls,
visible keyboard focus, asynchronous status announcements, responsive list/detail layouts, and a
reduced-motion-aware presentation. The screen is web-only. Live vendor retrieval and production
qualification remain unavailable.
