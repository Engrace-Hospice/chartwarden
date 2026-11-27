# Claim.MD webhook capture fixtures (synthetic)

Four captures in the `claimmd-webhook-capture/1` format (`claimmd-webhook-capture.ts`), each one delivery as the receiver sees
it: the exact body bytes (`bodyBase64`) and the headers it reads. Every value is invented: account `99999`, the documented
sample provider NPI `1111111112`, control number `SYNTHCTRL0001`, and a signing key that is not a real Claim.MD key:

    SYNTH99999_k#ey*not-real

| Capture | What it carries |
| --- | --- |
| `test-event` | one `test` event (acknowledged on receipt) |
| `enroll-event` | one `enroll` event (routed by `prov_npi`) |
| `appeal-event` | one `appeal` event (routed by `remote_claimid`) |
| `mixed-batch` | a numeric `eventid`, an undocumented `event_type`, and an element with no `eventid` |

Replay them offline (no network; the key comes from the environment, never an argument):

    CLAIMMD_ACCOUNT_KEY='SYNTH99999_k#ey*not-real' bun run claimmd:webhook:replay -- \
      packages/x12-837-client/src/clearinghouse/__fixtures__/claimmd-webhook

## UNVERIFIED

These follow Claim.MD's published webhook page (read 2026-11-05) and our own reading of it. **No real Claim.MD delivery has been
captured**, so none of the following is confirmed by traffic. The list lives in code as `CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED`
(`claimmd-webhook-replay.ts`), and a unit test keeps it in step with what the sweep reads.

- the signature scheme: header `Auth-Signature-Base64`, HMAC-SHA256 keyed with the account API key's Latin-1 bytes over the raw
  body bytes, canonical base64 (the replay report names an alternative reading that WOULD verify, if the real one differs)
- the envelope: `UTCTime` (and its `YYYY-MM-DD HH:MM:SS` format and time zone), `acct_number`, `remote_acct_number`, `events`
- the event: `eventid` (string or number), `event_type`, `event_time` (format), `event_data`
- the event types `enroll`, `appeal`, `test`
- under `event_data.enroll`: `prov_npi`, `enroll_type`, `enrollid`, `event`, `payerid`; under `event_data.appeal`:
  `remote_claimid`, `appealid`, `event`, `appeal_type` (every name the sweep reads; the values are invented, and `event_detail`
  in the `test` event is invented filler)
- the transport: that the body is sent uncompressed, and the `user-agent` value here (invented)

A real delivery replaces these captures only after an operator takes it (`docs/runbooks/claimmd-webhook-first-delivery.md`);
the real capture stays off the repository.
