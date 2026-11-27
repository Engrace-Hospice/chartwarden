# Claim.MD webhook: checking the first real delivery (CW-TX-02)

Operator runbook. The receiver (`POST /api/v1/webhooks/claimmd/<usage>`) follows Claim.MD's published webhook page and is proven
only against our own synthetic captures (register row CW-TX-02, `partial`). `CLAIMMD_WEBHOOK_ENABLED` stays `false` until a real
delivery from Claim.MD's **test** account has been captured and replayed as below. Nothing here sends traffic to Claim.MD or to
production, and an agent never runs the capture step.

## What the receiver already guarantees

- Off unless `CLAIMMD_WEBHOOK_ENABLED=true` and the account key, usage, payload key and platform pool are all present (503 before the
  body is read); only the configured usage's path is mounted.
- The `Auth-Signature-Base64` HMAC-SHA256 over the exact raw body bytes (the key's Latin-1 bytes, canonical base64, timing-safe
  compare) is the only credential. A missing, repeated, malformed or wrong signature is one 401 `INVALID_SIGNATURE`, storing nothing.
- Body limit 1 MiB (413). After a valid signature, content is never refused: the batch is stored in one statement, encrypted, and
  deduplicated on `(usage, acct_number, event_id)`, so a redelivery or a replayed capture adds nothing (200 either way). A database
  failure is a 5xx and Claim.MD retries.
- A refused delivery writes one warning, `claimmd.webhook.refused`, with the usage, the body size and a verdict. It never carries the
  signature, the key or a byte of the body.

| `verdict` | Meaning |
| --- | --- |
| `header_missing` | no `Auth-Signature-Base64` header at all |
| `header_malformed` | present, but not one canonical base64 SHA-256 (hex, base64url, a prefix, a repeated header) |
| `mismatch` | well-formed, but not the HMAC of these bytes under our key (wrong key, changed bytes, another signing scheme) |
| `no_key` | the process holds no key (cannot happen while the ingress is bound) |

There is deliberately no timestamp window: Claim.MD retries for up to four days and the format and time zone of `UTCTime` are
unverified, so refusing on it could drop a real delivery. Replay protection is the event-id deduplication above.

## Taking and checking the first delivery (the operator's steps)

0. Before you start: a Claim.MD **test** account's `test` event should carry no patient data, but treat every capture as PHI at rest.
   Use a managed machine with full-disk encryption, and confirm the Claim.MD business associate agreement is recorded
   (`compliance/vendor-agreements.yaml`, CW-BA-01; its row reads `pending` until a person confirms it). If anything other than a
   `test` event arrives, stop, keep the capture on that machine only, and tell the compliance owner. An agent must not run the
   capture step: it opens a socket and receives real vendor traffic (policy; no harness rule blocks it).
1. On that machine: `bun run claimmd:webhook:capture -- --out ~/claimmd-captures --max 3`. It listens on `127.0.0.1` only
   and writes each request's exact bytes and headers (other headers: names only) to a `0600` file outside this repository.
2. Expose that port with your own tunnel and point the **test** account's webhook at it in the Claim.MD portal; trigger a test event.
   (Which tunnel, and the portal change, are yours; nothing in the repository does either.) Mind three things. The tunnel's
   operator terminates TLS and sees the body in plaintext, so use one your organisation controls or holds a BAA with. The listener
   is unauthenticated (it records any POST until `--max` is reached, and any page in your browser can POST to loopback), so keep the
   window short and trigger only a `test` event. Check the capture directory afterwards: only the files you expect.
3. Replay offline, with the test account's key in the environment (never as an argument, and not typed into the command line, where
   shell history keeps it): `read -rs CLAIMMD_ACCOUNT_KEY && export CLAIMMD_ACCOUNT_KEY`, then
   `bun run claimmd:webhook:replay -- ~/claimmd-captures`, then `unset CLAIMMD_ACCOUNT_KEY`. It runs the real route in process: no
   network. The database store behind the route is replaced by a stub that keeps nothing; the real store is proven by the live suite.
4. Read the report. Signature `ok` and `route: 200` confirm the scheme. `mismatch` or `header_malformed` lists the alternative readings
   that WOULD verify (hex, base64url, a `sha256=` prefix, a trailing newline, re-serialised JSON, gunzipped bytes, a trimmed key, a
   UTF-8 key) so the fix is known without guessing. The findings list every departure from the documented shape: unknown keys,
   an unlisted `event_type`, missing `event_data` names the sweep reads, the `UTCTime` format.
5. Share the **report** with engineering, never the capture or the key. The report carries counts, types, key names and value shapes
   rather than field values: digits are masked, and a name, event type, path, media type or header name that does not look like a
   field name or a known token is shown as `<other>`. A name a sender chose to put in a key, event-type or header-name position (it
   starts with a letter, uses letters, `_ . -` and at most two digits in a row, and is short) would still be listed, so read the
   report before you send it. Lists are capped at 50. A real capture can hold a provider TIN or NPI. Delete the capture
   directory when done.
6. Only then: replace the synthetic fixtures (`packages/x12-837-client/src/clearinghouse/__fixtures__/claimmd-webhook/`) with
   invented values in the real shape, fix any field name the report showed wrong (the list is `CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED`),
   update the CW-TX-02 row, and decide separately whether to set `CLAIMMD_WEBHOOK_ENABLED=true` for the test usage.

A passing replay shows the route and parser accept what Claim.MD sent. It does not prove the store (stubbed in the replay), delivery
behaviour under retries, that the key scope is the one we hold, or anything about production: those stay open in the register row.
