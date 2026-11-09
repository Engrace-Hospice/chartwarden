# CHARTWARDEN_UI_CLAIMMD_ERA_REVIEW

Version: 1.0
Status: Screen Specification
Module: Remittance / Claim.MD ERA Review

## Purpose

Review encrypted Claim.MD ERA details only after the BIL-1 ownership decision has produced a tenant-owned M25 stage. This is a nonposting review surface and remains separate from legacy M25 advice ingestion and posting.

## Primary Users

- Billing specialist with `remittance.read` and server-derived provider scope.
- Billing manager with the same tenant-scoped access.

## Layout Pattern

Use Work Queue + Review Workspace.

## Main View

- Staged date, payer/payee, reported payment, stage state, claim count and identity-exception count.
- Filters for stage state, payer text and staged date range.
- Cursor pagination supplied by the server.
- Clear empty, loading and unavailable states.

## Detail View

- Reported payment date and amount, verified payer/payee summary, claims and service lines.
- Claim/service adjustments, provider-level adjustments and safe hold reason.
- Claim identity outcomes derived from historical submission evidence, clearly distinguished from financial allocation.
- Link to an internally verified claim only when the server returns a claim ID and supported module.

## Safety and Access

- The API enforces `remittance.read`, organization scope, and provider scope. Navigation visibility is not authorization.
- No central ERA inbox or raw 835 endpoint is exposed.
- The screen provides no matching, reconciliation, replay, or posting command.
- Display a persistent notice that viewing does not create a payment, adjustment, balance update, or ledger entry.
- Never show TIN, member identifiers, raw X12, or protected free text.

## States

Show the server stage state and possible-duplicate/hold reason. A `staged` state means eligible for review only; it does not mean reconciled, paid, or settled.
