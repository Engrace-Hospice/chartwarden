# Runbook: bind the transactional email provider (Postmark)

Until this is done, production **drops** portal magic-link sign-in emails and the funeral-home / external-collaborator
invite routes answer `503 LINK_DELIVERY_UNAVAILABLE` (and auditor enrolment answers `503 AUDITOR_LINK_DELIVERY_FAILED`).
That is deliberate fail-closed behaviour: no credential is minted that nobody can receive. Design and proof:
[`docs/history/m36-transactional-email-provider.md`](../history/m36-transactional-email-provider.md).

These are **operator steps**; none can be performed from the repository.

## 1. Postmark account and BAA

1. Create the Postmark account for ChartWarden (platform-level, one set of credentials; not per tenant).
2. Execute Postmark's **BAA** (INTEGRATIONS section 6.14 / 6.22: Postmark carries a BAA as defence in depth even though the
   payload carries no PHI by code rule).
3. Create a **Server** for production and use the default **Transactional** message stream (`outbound`). Do not use the
   broadcast stream.

## 2. Verified sender and DNS

1. In Postmark add a **Sender Signature** for the From address, or (preferred) verify the whole **Domain**.
2. Publish the DNS records Postmark gives you on that domain: **DKIM** (TXT), the **Return-Path** CNAME, and an **SPF**
   record that includes Postmark. Add a DMARC record (start at `p=none`, move to `quarantine` once reports are clean).
3. Wait until Postmark shows DKIM and Return-Path as **Verified**. Postmark rejects unverified senders with a permanent 4xx,
   which the adapter reports as `PROVIDER_REJECTED` (no retry).

## 3. Configure the API host

Set in `.env.production` (the `api` service reads it through `env_file`; the dev `docker-compose.yml` passes the same
three through):

```
POSTMARK_SERVER_TOKEN=<server API token from Postmark>
POSTMARK_FROM_ADDRESS=no-reply@<your verified domain>
POSTMARK_SENDER_VERIFIED=true      # your attestation that step 2 is complete
# optional: POSTMARK_MESSAGE_STREAM=outbound
```

Rules enforced at boot (`apps/backend/src/bootstrap/env.ts`): all three or none; a malformed From, a From on an RFC 2606
reserved domain, or `POSTMARK_SENDER_VERIFIED` other than `true` refuses to boot. The token is a secret: keep it only in
`.env.production`, rotate it from Postmark if exposed, never commit it.

## 4. Verify

1. Restart `api`. The log must **not** contain `[m36:email] transactional email provider NOT bound`.
2. From a staff session, invite a funeral home or collaborator to a test recipient you control (`recipientEmail`), or
   request a portal magic link for a test account. Expect `201` and a delivered message whose link is
   `https://<portal>/funeral/redeem#token=...` (token only in the fragment, no patient or organization detail in the body).
3. Each delivery logs `[m36:email] provider=postmark status=200 message_id=<id>`; look the id up in Postmark's activity feed.
4. Watch Postmark bounce / spam-complaint reports for the first week. Bounces and complaints are received by the existing
   signature-verified Postmark webhook receiver in M36.

## Rollback

Blank `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_ADDRESS` and `POSTMARK_SENDER_VERIFIED` and restart: the provider unbinds and
the routes return to 503 (fail closed).
