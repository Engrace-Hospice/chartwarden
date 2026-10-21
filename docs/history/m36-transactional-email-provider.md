# M36 transactional email provider (Postmark adapter)

Closes the "production email" blocker recorded in [`portal-signin-and-link-redemption.md`](./portal-signin-and-link-redemption.md):
M36's `selectTransactionalEmailTransport` had no provider slot filled, `transactionalEmailProviderBound` was a hard-coded
`false`, so in production portal magic-link emails were dropped and the funeral / collaborator invite routes answered
503 `LINK_DELIVERY_UNAVAILABLE`.

## What was built

- **Adapter** - `packages/messaging/src/notification/postmark-transactional-email.ts`. Implements the existing
  provider-agnostic `TransactionalEmailTransport` port over Postmark's `POST {base}/email` with the
  `X-Postmark-Server-Token` header. Postmark is the vendor the integration catalog names (DR/INT #14,
  `CHARTWARDEN_INTEGRATIONS_v0_1.md` rows 14 / 241 / 268: BAA as defence in depth, **no PHI in the payload by rule**). SES can
  follow as a sibling file implementing the same port.
  - 10 s request timeout (AbortController); up to 3 attempts; exponential backoff (250 ms, capped 5 s) honouring a numeric
    `Retry-After`; retry on 429, 5xx, network error and timeout; **permanent** failure on every other 4xx (bad token,
    unverified sender, inactive recipient) and on a 2xx without a `MessageID`.
  - Typed `EmailDeliveryError { code, retryable, status, providerErrorCode }`; its message never contains the recipient,
    subject, body or credentials.
  - Postmark has **no idempotency-key header**. Delivery is therefore at-least-once after an ambiguous timeout; every
    link delivered is single-use, so a duplicate is harmless. A per-send `Metadata.dedupe_key` (stable across the retries
    of one send) makes a duplicate traceable in the Postmark activity feed.
  - `TrackOpens=false`, `TrackLinks=None`: click tracking would route the link (and its token) through a third-party
    redirect.
  - Logs **message id and HTTP status only** (`[m36:email] provider=postmark status=200 message_id=...`).
- **Bind decision** - `apps/backend/src/modules/36-messaging/transactional-email-binding.ts` (`bindTransactionalEmail`,
  used by `index.ts`). Credentials come **only** from env: `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_ADDRESS`,
  `POSTMARK_SENDER_VERIFIED=true` (the operator's attestation that the sender signature / domain is verified in Postmark;
  the adapter cannot prove it), optional `POSTMARK_MESSAGE_STREAM`, test-only `POSTMARK_API_BASE_URL` (https required in
  production). Bound only when all three are valid; otherwise **unbound and fail-closed exactly as before**, with a boot
  line naming each missing / invalid variable (names only, never values).
- **`transactionalEmailProviderBound`** is gone; `linkDeliveryAvailable` is derived from the adapter actually being bound
  (always true outside production).
- **Boot validation** - `bootstrap/env.ts`: the three vars are optional as a set, but once any is set all three are
  required and shape-checked in production (a token without a verified From would otherwise silently leave email
  unbound); a From on an RFC 2606 reserved domain is refused.
- **Auditor invites** - found while binding: `createAuditorLinkEmailDelivery` was given the raw transport, so in production
  it "delivered" through the no-op and the enrolment reported a pending auditor who was sent nothing. It now receives
  `linkEmailTransport`, which **throws when production is unbound**; the enrolment route already maps that to 503
  `AUDITOR_LINK_DELIVERY_FAILED`.
- **Delivery result persistence** - the M36 spec (and `transactional-email.ts` header) keeps these pre-org, PHI-free
  messages **out** of the org-scoped `notification_delivery` pipeline (no org context to scope a pre-auth message under),
  so no table or outbox event was added: the provider message id is logged and kept in Postmark's activity feed.
  Bounce / complaint handling already has its own signature-verified receiver (`packages/messaging/src/webhooks/verify-postmark.ts`);
  no new webhook was required by the spec, so none was added.
- **Magic-link sign-in when unbound in production** is unchanged: the link is still dropped (a link in prod logs is a
  credential in logs). It is now delivered as soon as the adapter is bound.

## Proof

- `packages/messaging/__tests__/postmark-transactional-email.test.ts` - contract tests against a recorded fake `fetch`
  (request shape, retry/backoff, permanent failure, invalid response, no-secret-in-logs, env bind decision).
- `apps/backend/__tests__/env-validation.test.ts`, `scripts/__tests__/env-production-template.test.ts` - boot validation and
  the blank-by-default production template.
- `apps/backend/__tests__/m36-transactional-email.live.test.ts` (`bun run test:m36:transactional-email:live`, CI row "M36
  transactional email provider") - REAL Better Auth magic link and the funeral invite route over the REAL adapter bound
  to a local fake HTTP server (no network): token header, PHI-free body, token only in the URL fragment, single redemption,
  transient 503/429 retry delivering one link, permanent 4xx revoking the link, unbound-in-production 503 minting and
  sending nothing, auditor delivery failing closed, no secret / recipient / token in any log line.
  The invite stores in that suite are the in-memory ones (the durable link store is proven by `m2-link-redemption.live`).

## Still blocked externally (operator steps)

A real Postmark account, a verified sender signature or domain, and DNS (SPF / DKIM / Return-Path) cannot be done from
the repo. See [`docs/runbooks/transactional-email-postmark.md`](../runbooks/transactional-email-postmark.md). Until those
are done and the three env vars are set on the API host, production behaviour is unchanged (unbound, 503).
