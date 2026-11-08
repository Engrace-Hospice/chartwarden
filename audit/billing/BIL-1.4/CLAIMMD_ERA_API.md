# Claim.MD ERA API contract

## Source

The reader targets the official service documentation at [Claim.MD API](https://api.claim.md/) and the [test-account quickstart](https://docs.claim.md/v1/docs/test-account-quickstart-guide). The API has not been contacted by this implementation. These are vendor documentation claims, not runtime certification.

## Implemented source behavior

`packages/x12-837-client/src/clearinghouse/claimmd-account-era.ts` posts URL-encoded forms through the existing `postForm` helper to `/services/eralist/`, `/services/era835/`, and `/services/eradata/`. Every call passes through `budgetedFetch` and the injected shared `ClaimMdRequestCounter`. ERA list requests send `ERAID`, `Page`, and explicit `NewOnly=0`; they do not send NPI, TaxID, or PayerID. Credentials stay within the reader closure. It preserves identifiers as decimal strings and rejects malformed/mismatching responses.

The parser accepts the documented `last_eraid` watermark and list records from supported top-level or `result` envelopes. The page coordinator expects the documented 100-row page boundary, keeps the original cursor fixed across pages, requires a stable `last_eraid`, and exposes one commit call only after a short terminal page. Commit is an injected port; this repository change does **not** implement its SQL transaction or lease fencing.

`/era835/` returns the vendor's original X12 data through the existing strict `rawFiles` parser. `/eradata/` is retained as structured source data; no schema beyond the envelope and matching `eraid` is assumed. The code computes digests but does not yet persist or compare detailed 835 and structured financial values.

## Gaps

- Whether Page results form a stable snapshot while new ERAs arrive is undocumented/uncertified. The coordinator stops on a changed watermark but no durable overlap/reconciliation scheduler exists.
- Empty-list/watermark semantics, maximum page depth, vendor error body cases, 429 retry behavior, and real test/production account separation require synthetic-account certification.
- Vendor docs and this implementation do not prove safe retries, account-wide limiter operation across deployed processes, or complete source detail parity.
- `NewOnly=0` is explicit so the stream is not implicitly restricted to new/unread records. Historical bootstrap needs an operator-created cursor and controlled replay plan.
