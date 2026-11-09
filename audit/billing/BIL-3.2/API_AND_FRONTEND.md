# API and frontend

The existing tenant ERA list/detail endpoints remain the only inbox. Two narrow routes extend it:

- `GET /api/v1/remittance/claimmd-era/:id/matching` — requires `remittance.read` and returns source identity outcomes, decision history, explicit line-matching unavailability, a read-only balance result, and `postingAuthorized: false`.
- `POST /api/v1/remittance/claimmd-era/:id/matching/claims/:claimIndex/decision` — requires `remittance.match_review`, idempotency header, bounded index, expected version, action and reason.

OpenAPI and the generated client were regenerated. The existing screen now shows the matching summary, read-only balance, upstream verified claim link, reviewer decision/reason history, and why line matching is unavailable. Only users with the separate permission see the confirm/clear controls. No candidate selector or posting control is present.
