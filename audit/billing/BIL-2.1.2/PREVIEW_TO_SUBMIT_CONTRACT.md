# Preview to submit contract

`GET /api/v1/billing/claims/:id/preparation` returns a safe business projection, preview expiry, and opaque confirmation only when validation, route and renderer readiness pass. It never reserves an attempt or control number.

`POST /api/v1/billing/claims/:id/submit` requires the typed confirmation token, `ifVersion`, `If-Match`, current submit permission/ABAC/step-up and an eligible claim. The server decrypts/verifies the token, re-resolves the route, and runs the same renderer path again. A changed source, actor/scope mismatch, expiry, route/account/environment change, or version difference returns a safe `CLAIM_PREVIEW_STALE` or validation error before reservation.

The request transaction inserts one `claim_submission` with `reviewed_source_fingerprint`, then emits the outbox request carrying the same fingerprint. Duplicate insert resolution must return the same fingerprint or the write is rejected. Older clients cannot submit without the confirmation field.
