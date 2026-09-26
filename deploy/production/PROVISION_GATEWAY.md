# The M34 tenant provision gateway — an external service you must supply

`M34_PROVISION_GATEWAY_URL` addresses a service that **is not in this repository and is not
deployed by `compose.yml`**. Nothing starts it for you. Until you supply it, tenant provisioning,
per-tenant DEK unwrap, tenant storage provisioning, tenant shred and invitation delivery all fail
at call time.

> **Name collision, read this once.** The `provision` service in `deploy/production/compose.yml`
> is **not** this gateway. It is a one-shot container running
> `scripts/db/provision-runtime-roles.ts`, which creates the database's runtime roles and exits.
> The two share a word and nothing else.

## Why it is external

[ADR-0038 §3](../../docs/adr/ADR-0038-app-layer-envelope-encryption.md) makes key management a
port: *"KEK custody (KMS/HSM) binds behind `kekUnwrap`; unbound paths fail closed. Binding a
production KMS is integration work, not a mechanism change."* The application process deliberately
holds no KMS knowledge and never sees a KEK. This gateway is where your KMS, your object store's
administrative credentials, and your transactional mail sender live — the three things the
application is designed not to hold.

The client is `apps/backend/src/modules/34-saas-tenant-platform/provision-gateway.ts`. **It is the
authority**; this document is derived from it. If the two disagree, the client is right and this
file is stale.

## Transport

Every call is `POST`, JSON in and JSON out, to `${M34_PROVISION_GATEWAY_URL}${path}` with:

```
authorization: Bearer ${M34_PROVISION_GATEWAY_TOKEN}
accept: application/json
content-type: application/json
```

Any status outside `200`–`299` fails the call. The timeout is
`M34_PROVISION_GATEWAY_TIMEOUT_MS` (default `30000`, accepted range `1000`–`120000`).
`M34_PROVISION_GATEWAY_URL` must be `https://` in production and must not be an RFC 2606 reserved
placeholder host — `assertProductionEnv()` refuses to boot otherwise (#115).

The client **validates every response** and throws on anything it does not recognise, so a
gateway that returns `200 {}` fails loudly rather than silently provisioning nothing.

## The five endpoints

### `POST /dek/wrap` — mint and KEK-wrap a per-tenant DEK

| | |
|---|---|
| Request | `{ "organizationId": "<uuid>" }` |
| Response | `{ "wrappedCiphertextB64": "<non-empty base64>", "kekId": "<non-empty string>" }` |
| Called by | tenant provisioning (`tenant.provision` worker) |
| Rejected if | either field is missing, not a string, or empty |

Mint a fresh 256-bit DEK, wrap it under your KEK, return the wrapped blob and the identifier of
the KEK you used. `kekId` is stored beside the wrapped DEK and handed back on every unwrap, so it
must remain resolvable for as long as any tenant row references it — this is what makes KEK
rotation possible without re-wrapping every tenant at once.

**The plaintext DEK must not appear in this response.** Provisioning stores only the wrapped form.

### `POST /dek/unwrap` — unwrap a stored DEK

| | |
|---|---|
| Request | `{ "wrappedCiphertextB64": "<base64>", "kekId": "<string>" }` |
| Response | `{ "plaintextDekB64": "<base64 of exactly 32 bytes>" }` |
| Called by | every encrypted-column read/write, through `KekUnwrapPort` |
| Rejected if | the field is missing/not a string, or decodes to anything other than 32 bytes |

This is the hot path — it backs `TenantKeyProvider.dekForOrg()`, so it sits under every read of an
encrypted column. Cache accordingly on your side, and note that the client zero-fills a
wrong-length buffer before throwing.

A DEK this endpoint refuses to unwrap is the mechanism behind **crypto-erase**: tenant shred
destroys the key, and every subsequent read fails closed rather than returning plaintext. Do not
add a fallback that reconstructs a destroyed key.

### `POST /storage/tenant-prefixes` — provision per-tenant object-storage prefixes

| | |
|---|---|
| Request | `{ "organizationId": "<uuid>", "prefixes": ["<prefix>", …] }` |
| Response | `{ "prefixesEnsured": ["<prefix>", …] }` |
| Called by | tenant provisioning |
| Rejected if | not an array of strings, **or if any requested prefix is absent from the response** |

The client checks containment, not equality: returning more than was asked is allowed, returning
fewer is a hard failure. Ensure-semantics — this is called on re-provision and must be idempotent.

### `POST /storage/tenant-scope/destroy` — destroy a tenant's object scope

| | |
|---|---|
| Request | `{ "organizationId": "<uuid>", "expectedPrefix": "tenants/<organizationId>/", "includeVersionsAndDeleteMarkers": true }` |
| Response | `{ "prefix": "<must equal expectedPrefix>", "objectsDeleted": <non-negative safe integer> }` |
| Called by | the tenant shred worker |
| Rejected if | `prefix` differs from `expectedPrefix`, or `objectsDeleted` is not a non-negative safe integer |

`expectedPrefix` is computed by the client and echoed back for confirmation. **Treat a mismatch as
a bug on your side and delete nothing** — the echo exists so that a gateway which resolved a
different scope than the caller intended cannot destroy it silently. `includeVersionsAndDeleteMarkers`
is always `true`: object versions and delete markers survive an ordinary delete, and a retained
version of a PHI object defeats the destruction certificate this call is issued for.

This is irreversible and is one half of tenant offboarding; the other half is the DEK destruction
above.

### `POST /notifications/tenant-invitation` — deliver a tenant invitation

| | |
|---|---|
| Request | `{ "to": "<email>", "inviteeFullName": "<string>", "invitationUrl": "<string>", "expiresAt": "<Date, JSON-serialised>" }` |
| Response | `{ "accepted": true }` |
| Called by | tenant onboarding |
| Rejected if | `accepted` is not exactly boolean `true` |

`invitationUrl` is built as `${M34_INVITATION_ACCEPT_URL}/${rawToken}` — that env var is the base,
and it must point at your **web app**, not at the gateway. The token in that URL is the raw
invitation secret; it is delivered here and stored only as a hash, so this payload is sensitive and
must not be logged.

`accepted: true` should mean *handed to the mail transport*, not *delivered to a human inbox*.

## Checklist before a production boot

- [ ] The gateway is deployed, reachable from the `api` and `worker` containers, and serves TLS.
- [ ] `M34_PROVISION_GATEWAY_URL` is its real `https://` origin — not a placeholder.
- [ ] `M34_PROVISION_GATEWAY_TOKEN` is at least 32 characters and is a secret the gateway checks.
- [ ] `M34_INVITATION_ACCEPT_URL` points at the web app's invitation-accept route.
- [ ] All five endpoints answer, and a provision → unwrap round-trip works end to end.
- [ ] `kekId` values issued by `/dek/wrap` stay resolvable by `/dek/unwrap` across a KEK rotation.

Nothing in CI or in the deploy's smoke test exercises this gateway today, so a misconfiguration
here surfaces at the first tenant operation rather than at deploy time.
