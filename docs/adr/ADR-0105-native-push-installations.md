# ADR-0105 — Native push installations extend `delivery_endpoint`; one endpoint per app install, token rotation in place

- **Status:** **Accepted** (2026-11-01)
- **Date:** 2026-11-01
- **Amends:** WP 5.11 / migration 1153 (native push providers `fcm` / `apns`).
- **Related:** ADR-0083 (session-linked endpoints), ADR-0101, `chartwarden-mobile` `docs/backend-gaps-pr-l.md` (the mobile client's gap list, which predated 1153).

## Context

Migration 1153 already lets `POST /api/v1/notifications/endpoints` take an FCM or APNs device token, and the delivery sweep already
dispatches to FCM v1 and APNs with a fixed PHI-free payload. What is missing for a real mobile client is the *installation*:

- An FCM/APNs token rotates (reinstall, restore, OS refresh). Keyed only by token, a rotation left the old row as a second verified
  endpoint for the same phone: one alert pushed twice, and a dead token kept failing.
- There is no way for the app or an operator to see which installs are registered, on which APNs host, or why the last send failed.
- A development build's APNs token is rejected by the production host; the environment lives only in a global env var.
- The FCM / APNs environment variables are read at boot but undocumented in `.env.example`, the production example and `docker-compose.yml`.

The mobile gap doc proposed a new org-scoped installation table. `delivery_endpoint` is deliberately user-owned (a person, not a tenant, owns a
phone; RLS on `app.user_id`; `NON_ORG_SCOPED` in `check-tenancy`), so a per-org binding would contradict that posture and re-declare the table.

## Decision

- **D1. Extend, don't add a table.** `delivery_endpoint` gains nullable `install_id`, `environment` (`sandbox` | `production`), `app_version`,
  `app_build`, `last_failure_code`, `rotated_at` (migration 1299, `compat: contract` because it adds a unique index).
- **D2. Identity.** `install_id` is an opaque, app-minted id (`[A-Za-z0-9_-]{8,128}`), native providers only (CHECK). Unique per
  `(user_id, provider, install_id)` where set. Uniqueness is per user, not per org, matching the table's ownership.
- **D3. Rotation in place.** `POST /notifications/endpoints` with `installId` and a new token updates the install's row, resets
  `consecutive_failures`, stamps `rotated_at`, and deletes any other row of the same user holding that token. The same token, same install is a
  metadata refresh. Without `installId` behavior is unchanged (the previous release and the web client keep working).
- **D4. Visibility.** `GET /notifications/endpoints` lists the caller's own endpoints. It never returns the token or subscription JSON.
- **D5. Token storage.** Tokens stay plaintext in `endpoint_value`. They are routing identifiers, not PHI, and encrypting them would break the
  `(user_id, channel, endpoint_value)` unique index and require a lookup-hash column. Revisit if a provider treats tokens as secrets.
- **D6. Per-token environment (dispatch).** The `environment` column is recorded now; making the APNs transport choose its host per row (instead
  of the global `APNS_ENVIRONMENT`) is a follow-up inside the delivery sweep and does not change this API.
- **D7. Ops.** `FCM_SERVICE_ACCOUNT_JSON` and `APNS_*` are documented in `.env.example`, `deploy/production/.env.production.example` and wired in
  `docker-compose.yml`.
- **D8. No emergency SLA.** An OS push is best-effort. Anything safety-critical keeps a server-side acknowledgment and escalation path.

## Consequences

- One column set and one read route; no new RLS surface, manifest table or queue.
- A mobile client registers on login and again on every token refresh with a stable install id, and deletes its endpoint on logout.
- The sweep still picks one verified endpoint per delivery (newest). Fan-out to every verified device of a user is a separate change.
- ADRs are immutable once Accepted; a later change supersedes this one.
