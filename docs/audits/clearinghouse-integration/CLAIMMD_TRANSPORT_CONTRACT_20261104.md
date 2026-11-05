# Claim.MD transport contract (input to the `ClaimMdTransport` adapter)

What `packages/x12-837-client/src/clearinghouse/claimmd-transport.ts` may rely on, with its source. **D** = Claim.MD
documentation (`https://api.claim.md/`, `https://docs.claim.md/docs/test-account-quickstart-guide`, the one-page
companion guide `ClaimMD_Companion_Guide.pdf`, the `Claim-MD/RestAPISamples` repo), read 2026-11-04. **O** = observed by
us in the Claim.MD portal (test account 34652, 2026-11-04). **U** = unverified: the adapter treats it defensively and
it stays U until `scripts/claimmd-sandbox.ts` output is recorded in the results section below.

Decision record: [ADR-0053 amendment 2026-11-04](../../adr/ADR-0053-clearinghouse-transport-port.md). Vendor background:
[`CLEARINGHOUSE_VENDOR_COMPARISON_20261023.md`](./CLEARINGHOUSE_VENDOR_COMPARISON_20261023.md).

## Account and configuration

| Item | Contract | Src |
|---|---|---|
| Host | `https://svc.claim.md/services/<name>/`, POST only; test and production share the host and differ by key | D |
| Auth | `AccountKey` form field on every call (never a header or URL). One key opens one Claim.MD account. Keys look like `<account#>_<random>` and contain `#` and `*`: in an env file the value must be double-quoted, or a dotenv parser cuts it at `#` (observed 2026-11-04: the truncated key answered error 21) | D, O |
| Accounts | One ChartWarden-owned account per usage mode ("single vendor account" model: agencies are provider records on it, enrolled per NPI/TIN). Env: `CLAIMMD_ACCOUNT_KEY` + `CLAIMMD_ACCOUNT_USAGE` (`test`/`production`); a call whose usage has no key answers `CH_NOT_WIRED` | D (model), design |
| BAA | "BAA Received 11/4/2026" and "Customer Service Agreement accepted 11/4/2026" under Settings → Documents | O |
| Account settings | UB04/837I institutional claims **on**; Transmit Approval (hold for approval) **off**; automatic corrected claims **off** (we send frequency 7/8 with REF*F8 ourselves); NCCI edits on; ERA 5010; SFTP inactive (API only, so no second reader consumes responses or 835s). Set 2026-11-04 on the test account; **must be set the same way on the production account** | O |
| Envelope | ISA05/07 `ZZ`; ISA06 and GS02 = our Claim.MD account number; ISA08 and GS03 = `CLAIMMD`. Lives in `billing_edi_profile` (`route_key = 'claimmd'`), no code. The adapter refuses an ISA08 other than `CLAIMMD` | D |
| Rate limit | 100 requests a minute **per account** (all tenants of a usage mode share it), then a temporary block answered HTTP 403 → `CH_UNAVAILABLE` (retryable). We never get there: every request first takes a budget of 7 per 5 s window (`claimmd-rate-limit.ts`; worst case 91 in any 60 s, sustained 84/min) from a counter keyed `claimmd:<usage>` (never the key), shared across processes through the backend's Valkey rate-limit store (`REDIS_URL`; per process without it). With no budget after a wait of at most one window, the request is not sent: an upload releases its reservation like the 403 path, reads answer `CH_UNAVAILABLE`. A counter error (Valkey down) refuses at once (fail closed: a per-process fallback would let N processes spend N budgets and block the account for every tenant) | D, design |
| Hospice payers | Home health + hospice MACs present with UB04 and ERA: CGS J15 `15004`, NGS J6 `06014`, Palmetto JM `1100H`, NGS JK `14011` | O (public payer list) |

## Operations

| Port method | Claim.MD call | Src |
|---|---|---|
| `submitClaim` / `submitNotice` | `upload` (multipart `AccountKey`, `Filename`, `File`), one claim per upload. Raw X12 (`.837`) or Claim.MD JSON (`.json`, `{claim:[{pcn, bill_npi, …}]}`). The answer's `claim[]` entry with `pcn` = our control number is the receipt: its `claimid` when present, else `file:<fileid>`. **Observed 2026-11-04: an X12 upload answers with `fileid` and no `claimid`** | D, O |
| replacement / void | X12 only: CLM05-3 `7`/`8` and the payer ICN in `REF*F8`; the original must be a sent attempt in the same scope (`CH_UNKNOWN_ORIGINAL` otherwise) | D |
| idempotency | Claim.MD refuses a repeated **Filename** whole (HTTP 200, `{"error":{"error_code":61,…"is a duplicate of…Processing Aborted!"}}`, code as a number; observed 2026-11-05) and does nothing else to dedupe, so our attempt store decides (ADR-0053 D6). Our Filename is fixed per (scope, key), so a code-61 answer is proof an earlier upload of this submission landed: **`CH_IN_DOUBT`**, reservation kept, never released. An upload that may have landed (network error, timeout, any 5xx including 502/503, unreadable 2xx, a 2xx without our claim, or an upload whose record could not be saved) answers **`CH_IN_DOUBT`** and keeps its reservation: M23's retry (which mints a new control number) stops for an operator; a retry with the SAME key (M41) waits 15 minutes, then searches `uploadlist` (from one day before the latest reservation, at most 9 days) for our Filename (`cw-<sha256(scope,key)>.837/.json`) and re-uploads only when every day's answer carries a `file` list without it, or is the bare `{}` Claim.MD answers for a day with no uploads (observed 2026-11-05). Any other answer without a `file` list is unknown, never "absent". `uploadlist` entries: `filename`, `inboundid` (number), `uploadtime` (epoch), `file_type`, `file_count`, `file_amount`. Only a 4xx (the 403 rate block included: refused before any work) releases the reservation and is plainly retryable; a 502/503 can be a gateway in front of a service that already filed the upload, so it is in doubt like any 5xx. A 2xx `error` other than 21 and 61 (a file Claim.MD refused to process) releases too (**U**: that such an answer never files the claim is assumed, not observed; a same-key retry would still meet code 61). A file found is recorded as `file:<inboundid>` (status then reads `received`) | D (uploadlist), design |
| `fetchAcknowledgments` | `response` with `ResponseID` = our cursor (`0` to start); `last_responseid` is the next cursor, never lower than the one sent; at most 20,000 per call. Kept only when `bill_npi` = `ctx.billingNpi`. Any read failure other than a credential rejection is `CH_UNAVAILABLE` (never `CH_INVALID_REQUEST`, which makes M23/M41 reset the stored cursor) | D |
| stage | `senderid` `CLMMD` (sender_name `CLAIM.MD`) = clearinghouse stage; any other sender = payer stage. Observed: test-mode payer answers come from `senderid` `FAKE` (`sender_name` `HHH MEDICARE J15`) | D, O |
| disposition | `status` `A` = accepted, `R` = rejected. Any other letter is skipped with an `unmapped_status` anomaly (code only), never guessed | `A`, `R` O; other letters **U** |
| reason codes | `messages[].mesgid` of non-accepted messages (code-shaped only); `message` text is never surfaced | D |
| event id | `claimmd:<usage>:<highest messages[].responseid>` | D |
| occurred at | `response_time` (`2022-09-01 11:34:59am`, or `09-06-2022 13:07`, account-local, zone not stated) → the day only, `2022-09-01` (M41's ack validator rejects a zoneless time) | D, zone **U** |
| payer claim number | `sender_icn` on a payer-stage response | D, O (populated on the payer acceptance) |
| `fetchClaimStatus` | our control number → attempt (`findByControlNumber`). With a numeric Claim.MD claim id: `response` with `ClaimID`. With `file:<id>` (the usual case, see the upload row): the account stream from `ResponseID=0` (at most 5 pages) matched on `pcn` + `bill_npi`. The highest stage reached wins | D, O |
| `fetchRemittances` | `eralist` with `ERAID` = cursor, `NPI` = `ctx.billingNpi`, `NewOnly=0` (the "new" flag is account-wide), then `era835` per `eraid`. **Observed 2026-11-05:** `eralist` answers `last_eraid` and `era[]` (`eraid` as a number, `prov_npi`, `prov_taxid`, `payerid`, `paid_amount`, `paid_date`, `check_number`, `check_type`, `received_time` `MM-DD-YYYY HH:MM`); `era835` answers the same summary keys plus `data`, an **array** whose first element is the 835 interchange (`ISA*…*ZZ*15004…*ZZ*34652…`). The adapter takes a string or a one-element array as one file. How many elements the array can hold is **not yet observed**, so several are read only where the X12 itself decides: every element a whole interchange (ISA first, the only IEA last, IEA02 = ISA13) gives one file per element in order, ids `claimmd-<eraid>`, `claimmd-<eraid>-2`, …; otherwise the elements joined in order must form exactly one such interchange (fragments) and give one file `claimmd-<eraid>`. Any other shape (a mix, junk, non-string or empty elements, an empty array) fails the page and raises the `era_unreadable` anomaly (eraid and element count only); never a guessed join. At most 25 ERAs per call (rate limit); ids at or below the cursor are dropped and the cursor never moves back; the 835 is kept byte-for-byte; an ERA without its 835 fails the page so the cursor never passes it | D |
| `validateOnly` | **Local only.** Claim.MD has no dry-run endpoint and an upload is a submission, so this never calls Claim.MD: it reports the pre-upload checks (`CLAIMMD_PRECHECK`). Claim.MD and payer edits are known only after a real upload | D |
| `checkEligibility` | `eligdata` (form): `ins_name_l/f`, `ins_number` (member id or MBI), `ins_dob`, `pat_rel=18`, `payerid` = `ctx.payerId`, `service_code=30`, `fdos`, `prov_npi`, `prov_taxid` (+`E`). Needs the request's transient `EligibilitySearchFacts` (name, DOB, EIN; M41 reads them per call from M5 and the sealed EIN) and refuses before any call without them. Outcome: any `benefit_coverage_code` 1-4 → `active`, else 6-8 → `inactive`, else `unknown`; as-of = the service date. An `error` element → `CH_INVALID_REQUEST` with codes only (the message can echo the subscriber). Medicare eligibility stays on HETS (M23), not the clearinghouse | D, **U** until a sandbox call |
| `verifyAndParseEvent` | `CH_NOT_WIRED`: Claim.MD webhooks carry enrollment and appeal events only (HMAC-SHA256 of the body keyed with the account key, header `Auth-Signature-Base64`) | D |

## Tenant isolation

One account serves every tenant. Every read is filtered to `ctx.billingNpi` and no call runs without it.
`provider_entity.npi` has a platform-wide unique index, so an NPI names exactly one provider entity of one tenant.
The control number is platform-unique per usage (attempt store), so a stray answer with another tenant's `pcn` and our NPI
cannot occur. Proven in `claimmd-transport.test.ts` ("shows another provider nothing from the shared account stream").
The shared conformance receive cases are skipped by name: they give every tenant the same NPI, which the schema forbids.

**Known ceiling.** Each provider entity reads the whole account response stream from its own cursor. Fine at tens of
tenants; past that, one account-wide reader that fans out by NPI is the upgrade.

## Still open (U rows to close with the sandbox run)

1. ~~The JSON shape of `eralist`, `era835` and `uploadlist`.~~ **O, 2026-11-05** (run 3): see the idempotency and
   `fetchRemittances` rows. One residue: whether `era835`'s `data` array ever holds more than one element (the probe
   printed only its start). **O, 2026-11-05 07:52 UTC** (run 4): a one-element array holding one whole interchange
   (934 chars, ISA ... IEA). Whether Claim.MD ever sends more is unknown, and the adapter does not depend on it: several elements are read
   only where the X12 settles it (see the `fetchRemittances` row), anything else fails closed with an
   `era_unreadable` anomaly. Re-check cheaply, no uploads, up to 5 ERAs (counts, lengths and ISA/IEA flags only):
   `CLAIMMD_ACCOUNT_USAGE=test CLAIMMD_ACCOUNT_NUMBER=34652 PROBE_STEPS=era bun --env-file=.env scripts/claimmd-probe.ts`.
2. Status letters beyond `A`/`R` (go-criterion G2 is met for the accept/reject paths: a payer-stage sample is recorded).
3. ~~What an invalid key returns.~~ **O, 2026-11-04:** HTTP 200, `Content-Type: application/json`, body
   `{"error":{"error_mesg":"Invalid AccountKey.","error_code":"21"}}`: a single top-level object, not an array. The
   adapter classifies code `21` (or a message naming the key) as the credential rejection.
4. ~~NOE/NOTR.~~ **O, 2026-11-05** (run 3): an NOE (81A) and an NOTR (81B) were each accepted by Claim.MD and by the test
   payer (HHH MEDICARE J15, `FAKE`) with a payer claim number. Routing to a real MAC can only be seen on production.
5. ~~Duplicates (G4).~~ **O, 2026-11-05** (run 3): the same file under the same Filename is refused with code 61 and only
   one claim reaches the response stream. A different Filename is not deduped (not tested, and not relied on).

## Sandbox results

Run `bun --env-file=.env scripts/claimmd-sandbox.ts` (needs `CLAIMMD_ACCOUNT_KEY`, `CLAIMMD_ACCOUNT_USAGE=test`,
`CLAIMMD_ACCOUNT_NUMBER`) and paste the `submit`, `ack`, `status` and `raw` lines here with the date. Synthetic data
only.

**2026-11-04, run 1.** Both uploads answered the credential rejection: the key had been cut at its `#` by the env parser
(see Auth). Closed open item 3.

**2026-11-05 07:09 UTC, run 2** (test account 34652, sample NPI 1111111112, payer `15004`, synthetic subscriber, one
interim 837I per upload, TOB 0812). Values are what the adapter returned; vendor message text is shown only because the
data is synthetic.

| Claim | Upload | Clearinghouse ack (poll 1, ~20 s) | Payer ack (poll 2, ~40 s) |
|---|---|---|---|
| plain | `ok`, `file:162561733` | `A`, `CLMMD`, `ACK` "Acknowledged" | `A`, `FAKE` (HHH MEDICARE J15), `sender_icn` 5004899271824 |
| member id `REJECT` | `ok`, `file:162561857` | `R`, `CLMMD`, `PH012-01` "Invalid or incomplete Medicare ID Number." | none (rejected before the payer) |

Findings acted on: the upload answer carries no `claimid`, so `fetchClaimStatus` reported `received` forever; it now reads
the stream by control number (row above). Acks map as designed: two stages, codes only, day-only `occurredAt`, payer claim
number from `sender_icn`.

**2026-11-05 07:24 UTC, run 3** (`scripts/claimmd-probe.ts`, same account, sample NPI and synthetic subscriber).

| Probe | Result |
|---|---|
| NOE (81A) | upload `ok`, `file:163491616`; clearinghouse `A`; payer `A` (`FAKE`), payer claim number 5004899273405 |
| NOTR (81B) | upload `ok`, `file:163491617`; clearinghouse `A`; payer `A` (`FAKE`), payer claim number 5004899273406 |
| same file twice, same Filename | 1st: `claim[]` with `fileid`, `claimmd_id` and empty `claimid`; 2nd: HTTP 200 error code `61` (duplicate, processing aborted); 1 claim in the stream |
| `uploadlist` 2020-01-01 | HTTP 200 `{}` |
| `uploadlist` today | `file[]` with our Filename once (`inboundid`, `uploadtime` epoch) |
| `eralist` / `era835` | ERAs present for the sample NPI; `era835` `data` is an array starting `ISA*` |

Findings acted on: the 835 arrives as an array (`fetchRemittances` failed every ERA before; now reads it); `{}` is an empty
`uploadlist` day (in-doubt uploads can now reconcile automatically); code 61 keeps the reservation in doubt instead of
releasing it (a release would let M23 mint a new control number and bill twice).
