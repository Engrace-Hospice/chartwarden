# Nonposting Review Implementation

## Backend/API

- Existing routes remain `GET /api/v1/remittance/claimmd-era` and `GET /api/v1/remittance/claimmd-era/:id`.
- The list now returns only the authorized stage summary: state/hold/duplicate, staged time, payer/payee label, reported amount/date/method, number of represented claims, identity-exception count, and review eligibility.
- Details are fetched only when a reviewer opens one stage. They include claim and service-line facts, safe adjustments/remarks, provider adjustments and ownership outcomes.
- Both routes retain `remittance.read`, server-derived actor, org/provider scope, audit-read metadata and 404 for a stage outside the caller's scope.
- TypeBox schemas are shared with OpenAPI enrichment; `docs/api/openapi.json` and the generated TypeScript client are regenerated.

## Frontend

`apps/web/src/modules/25-remittance/claimmd-era-review.tsx` adds a Revenue Cycle screen with status filtering, payer/date filtering over records loaded so far, server cursor pagination, summary list, details panel, held/possible-duplicate messaging, adjustment tables, and links to M23/M41/M24 claim pages only where the ownership result supplies both verified claim ID and supported module. The screen says to load more before using payer/date filters to find older stages. Network errors expose a retry action; loading, empty and detail states are covered.

The page and screen registry require `remittance.read`; the backend remains authoritative. Detail is not downloaded for every row. No matching, replay, posting, adjustment override or financial mutation control is present.

## Future stage

The route and screen provide review visibility only. Manual matching of staged lines, reviewer event history, and posting authorization need separate domain contracts and are kept for later BIL-3 work.
