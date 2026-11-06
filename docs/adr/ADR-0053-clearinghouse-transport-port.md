# ADR-0053 — The claim cycle runs through one `ClearinghouseTransport` port; ChartWarden resells one clearinghouse (platform configuration); an adapter is done only when it passes the shared conformance cases

- **Status:** **Accepted** — D3 (platform configuration, ChartWarden resells one clearinghouse) was decided by the
  product owner 2026-10-11. D1, D2 and D4–D9 are ratified 2026-10-24 now that a second, non-Stedi adapter
  (`direct_mac`, #706) passes the shared conformance cases for the capabilities it implements. D10 (one submission
  port per lane, 2026-10-24, #705) completes the decision.
- **Date:** 2026-10-11
- **Phase:** post-launch billing work (Medicare submission paths); precedes the Stedi adapter (Phase 4/5).
- **Extends:** [ADR-0028](ADR-0028-adapter-package-codepaths.md) (adapter package code paths) and
  `docs/architecture/CHARTWARDEN_INTEGRATIONS_v0_1.md` §3.1 (adapter package model), which say *that* an integration
  sits behind an interface but not *what* the interface is for claims.
- **Related:** [ADR-0052](ADR-0052-dde-work-queue.md) (NOE timeliness is judged on MAC acceptance, so the port
  must carry the payer's own acknowledgment date), [ADR-0037](ADR-0037-x12-cost-report-typescript.md) (precedent for
  TypeScript X12 codecs instead of a Python sidecar), [ADR-0020](ADR-0020-integration-governance.md).
  Plan: `docs/audits/clearinghouse-integration/ADAPTER_EXPANSION_PLAN_20261011.md`. Vendor facts:
  `docs/audits/clearinghouse-integration/STEDI_QUESTIONS_20261008.md`.

## Context

The claim cycle today is split and keyed on the wrong axis:

- Sending goes through `X12WorkerClient` (an HTTP port to a Python pyx12 sidecar that is **not in this repo**) and
  per-**MAC-jurisdiction** portal clients (`ngs_j6` real, six deny-stubs). Receiving goes through
  `x12-835-client`, whose worker port (`NO_X12_835_PORT`) is unbound in every environment.
- A clearinghouse is not a jurisdiction. Stedi, Availity or any other can route to any MAC, so selecting by
  jurisdiction cannot express "which clearinghouse".
- There is one acknowledgment state. A clearinghouse accepting a file and the MAC accepting the claim are different
  facts, and NOE timeliness depends on the second (ADR-0052 D4).
- The repo contains **no** 837I claim, NOE or NOTR generator and **no** 999 parser (only an 8xC/8xD transfer-notice
  builder, a 270 builder and 271/277CA/835 parsers). Generation lives behind the external gateway/sidecar.
- Stedi's sandbox probe showed the clearinghouse itself enforces edits (and can act as a second validator), that
  enrollment is per payer and provider (Medicare Part A: `ENROLLMENT_REQUIRED`), and that idempotency keys last 24
  hours only. The same properties will recur with any clearinghouse.

## Decisions

**D1 — One port for the whole cycle.** `ClearinghouseTransport`
(`packages/x12-837-client/src/clearinghouse/types.ts`) has eight methods: `checkEligibility`, `validateOnly`,
`submitNotice`, `submitClaim` (replacement and void via `adjustment`), `fetchAcknowledgments`, `fetchRemittances`,
`fetchClaimStatus`, `verifyAndParseEvent`. It lives in `x12-837-client` because M25 already depends on M23
(`dependsOn: [1, 23, 36]`), so no manifest, scaffold or import-boundary change is needed. It is extracted to its
own package only if a consumer outside M23/M25 appears. MAC jurisdiction is payer metadata on the context, never
the selector.

**D2 — Two-stage acknowledgments.** An `AckEvent` has `stage: "clearinghouse" | "payer"` and a status is
`received → clearinghouse_accepted | clearinghouse_rejected → payer_accepted | payer_rejected`. Clearinghouse
acceptance never satisfies NOE timeliness; only a payer-stage event does. The status is the highest stage reached,
not the last event delivered, because delivery order is not guaranteed (C16). The existing single ack state in M23 is
split to match in a follow-up migration (plan A6); until then adapters map onto the old state conservatively
(accepted = payer-accepted only).

**D3 — Platform configuration, not a tenant setting.** ChartWarden resells one clearinghouse (Stedi first), so the
vendor binding is deployment/platform configuration. The credential is platform-held; every call is still
attributed to a ProviderEntity (the payer sees the provider) through `ClearinghouseContext`. A per-ProviderEntity
override can be added later without changing the port. `usage: "test"` must reach only vendor test mode. The
fail-closed default (an unbound production transport answering `CH_NOT_WIRED`) and the boot validation that rejects
an active vendor with no adapter are built (`transport-registry.ts`, `NOT_WIRED_TRANSPORT`; the binding is
injected into the M23 workers, D10).

**D4 — Conformance is the definition of done.** `CLEARINGHOUSE_CONFORMANCE_CASES` (18 behavioural cases covering
eligibility, dry-run, notices, idempotency identity, both ack stages, out-of-order acks, rejections, paging and
cursor validation, adjustments, remittance, push events, enrollment, outage, test/production isolation and tenant
isolation) run against any transport through a `ClearinghouseHarness` (the transport plus a script that drives the
far side for a given scope). The suite is framework-free so it runs under vitest, a live-sandbox smoke script or
CI. `InMemoryClearinghouse` is the executable specification and the double for module tests; it is exported from
`@chartwarden/x12-837-client/testing`, not the package barrel, so production code cannot import it. Mutant
transports (no replay flag, MBI echo, dry-run side effect, throwing, accepting a tampered webhook, ignoring usage,
leaking across tenants, regressing on a late ack, accepting a malformed cursor, payload-only idempotency) each have
to be caught by the case that guards that rule (the usage and tenant leaks are split per method: acknowledgments,
remittances, status); four rules (enrollment, outage recording, paging, adjustments) are guarded by cases but have
no mutant yet. A vendor adapter must pass every case, with its
vendor server stubbed, before it can be bound.

**D5 — Fail closed, never throw.** Every method returns the existing `X12WorkerResult`. Operational failure is a
degraded envelope with a stable code from `CH` (`NOT_WIRED`, `NOT_PROVISIONED`, `NOT_ENROLLED`, `UNAVAILABLE`,
`IDEMPOTENCY_CONFLICT`, `UNKNOWN_ORIGINAL`, `INVALID_SIGNATURE`, `INVALID_REQUEST`). Only `UNAVAILABLE` is
retryable. "Not enrolled" and "not provisioned" are first-class states, not generic errors.

**D6 — Idempotency is ours.** Submission carries an `idempotencyKey` (the deterministic control number). The key binds
the whole business identity — kind, control number, adjustment and payload (JSON key order is irrelevant). The same
key and identical identity returns the original receipt with `replayed: true`; the same key and a different identity,
or reusing a control number under a new key, is `IDEMPOTENCY_CONFLICT` (C04, C18). A refused submission (for example
an unknown original) burns no key (C09). Because Stedi keys expire after 24 hours, the adapter fronts the vendor with its own
attempt record, so the guarantee does not lapse. Dry-run (`validateOnly`) never consumes a key.

**D7 — Event-then-fetch.** Push events carry references only (`eventId`, `kind`, `reference`, `occurredAt`),
are signature-verified per destination, and may arrive out of order or twice; consumers dedupe on `eventId` (the
signature carries no timestamp or replay window, so dedupe is the only replay defence) and fetch content with the
pull methods. Pull methods are cursor-paged with a cursor that is always resumable (`nextCursor` plus `hasMore`); a
malformed cursor is `CH_INVALID_REQUEST`, never a silent restart; and polling reconciliation is the backstop for any
missed event.

**D8 — The transport is the tenant boundary.** ChartWarden holds one platform credential, so nothing in the vendor
separates tenants. All state — submissions, idempotency keys, acknowledgments, remittances, status — is scoped to
(organizationId, providerEntityId, usage) (`ClearinghouseScope`), and a transport that lets another org, another
ProviderEntity or the other usage mode see, replay or collide with it fails C14/C15. Enrollment is per ProviderEntity
and gates sends (claims, notices, eligibility); reads and `validateOnly` are not gated on enrollment.

**D9 — Generation moves into TypeScript and is gated by the vendor's edits.** The claim, NOE and NOTR generators and
a full 999 parser do not exist (only the envelope/date readers in `acks/ack-dates.ts`) in the repo and are built as part of the Stedi adapter (ADR-0037 is the precedent), not
assumed from the sidecar. The generators must satisfy the rules the Stedi sandbox enforced (2026-10-09), recorded
here so they become golden-test inputs:

| Rule found by the sandbox | Requirement on our generator |
|---|---|
| Frequency 1 conflicts with patient status 30 | `deriveTypeOfBill` yields 812/813 for a continuing stay and 811/814 once discharged, but CL103 comes from a separate source (`dischargeCodes.patientStatus`) and nothing forces the two to agree; the generator asserts the pair and a golden test pins it |
| CLM02 must equal the sum of line charges | SIA and G0679 charges need real lines (rule `claim_total_matches_lines` exists) |
| CL102 admission source required | `buildCl1Segment` already supports it; make the generator refuse a null source |
| `BHT06=CH` with a $0 charge is rejected; `RP` passes for NOE (81A) and NOTR (81B) | notice generators emit `BHT06=RP` |
| Discharge hour is `DTP*096*TM`, not a date | emit the time form |
| Frequency 7/8 needs `REF*F8` directly after CL1 | adjustment generator orders it so (Stedi accepts it; whether Original Medicare does is Q17, open) |
| JSON route needs occurrence/value/condition lists as arrays of arrays and requires `attending` | JSON mapper builds that shape |

**D10 — One submission port per lane (decided 2026-10-24, #705; option (a)).** The transport is the only submission
path for **Medicare and commercial** claims, NOE and NOTR. The legacy launch gateway (`M23_MAC_GATEWAY_*` /
`M23_X12_GATEWAY_*` wired straight into the workers) is **retired after the pilot**; until then it is the default path
*only while `CLEARINGHOUSE_VENDOR` is unset*. The switch is that single variable: unset = legacy ports; set = the
bound transport for submit/retry and for the 999/277CA ack crons, with **no silent fallback** between the two (a
degraded transport answer fails the job, and `registerM23LaunchWorkers` refuses to build workers without the binding
while a vendor is configured). The launch gateway is not discarded meanwhile: it is re-expressed as the `direct_mac`
transport, which keeps generation (the X12 sidecar) and the MAC portal drop behind the port. Commercial (M41, ADR-0100)
uses the transport from the start. **Medicaid is decided per state and is not rewritten:** M24 keeps its per-provider
state credentials; **Oregon stays a state-direct adapter** (`packages/medicaid-adapters`) behind the same fail-closed
capability gate (an unconfigured or unprovisioned state answers closed, never falls through to another channel). A
state channel is wrapped as a transport only if and when a state's channel is a clearinghouse in the sense of D1; the
decision for each further state is recorded with that state's adapter. Rejected: (b) both paths chosen per provider
entity (two permanent code paths and a per-entity switch to get wrong), (c) skip direct-MAC and cut over to Stedi
(Stedi cannot yet submit on this account, Q14, and the port would be proven against one vendor only).

## Consequences

- A new clearinghouse is one class plus a conformance run; no module changes.
- Direct-MAC is re-expressed as a transport (plan B1, `direct-mac-transport.ts`) so the port is not fitted to Stedi
  alone. It declares the `submit` conformance capability only: the legacy portal has no claim-status inquiry, no 835
  delivery on this path (M25's worker port), no signed push, and its pending-file ack list is consumed as it is read,
  so the cursor-replay cases (C08, C17) and everything that needs `fetchClaimStatus` are skipped by name, not passed.
  `validate`, `eligibility`, `adjustment` and `enrollment` have no gateway operation either. Its
  `fetchAcknowledgments` is covered by its own tests. The per-vendor limits are visible as skipped cases, never silent.
- Known limits of the worker injection (#707): the two limits recorded at ratification (8xC/8xD transfer notices had no
  `SubmissionKind`; a 277CA "partial" rode as a `PARTIAL`-marked rejection) are closed by the 2026-10-25 amendment. The
  ack crons no longer re-read from a null
  cursor (#749): the position is persisted per (org, provider entity, vendor, usage, stage) in `clearinghouse_ack_cursor`
  and moved by compare-and-set only after the page was applied (at-least-once; replays collapse on the ack row's unique
  key). A cursor the vendor refuses (`CH_INVALID_REQUEST`) resets to a null re-read once. A page whose apply keeps
  failing holds that stream's cursor, so it is surfaced as a failure every tick rather than skipped. One tick reads at most `MAX_ACK_PAGES_PER_TICK` (50) pages per provider entity and stage: the cursor is stored after every applied page, so the rest resumes on the retry the cap hit triggers (logged as a backlog), and a repeated cursor position (a cycle) fails the pull. An over-long cursor (> 512 characters) is refused before apply.
- Follow-up work (separate PRs): the ack-state split (A6), binding
  `fetchRemittances` to the M25 835 worker port (A5), the Stedi adapter (B2).
- The port makes no promise about hospice rules (NOE timeliness, benefit periods, revenue/HCPCS pairing); those stay
  in the §11.A validation rules because clearinghouses do not check them.

## Amendment (2026-10-24) — second clearinghouse (#718): conditional, not yet go

**Decision.** Do **not** build a second vendor adapter yet (#719 stays blocked). Stedi remains the sole production
clearinghouse (D3 unchanged); `direct_mac` remains the non-Stedi adapter that exercises the port. Claim.MD is the leading
candidate, but a build needs four written vendor answers plus a BAA that the vendor alone can give. The spike
(`docs/audits/clearinghouse-integration/CLEARINGHOUSE_VENDOR_COMPARISON_20261023.md`, section 7) read vendor
documentation only; every vendor fact in it is unverified, and the user-supplied answers in its section 6 are not vendor
confirmations.

**Go criteria (all in writing from the vendor).** (G1) hospice 837I (TOB 81x) and NOE/NOTR accepted, with payer list;
(G2) full response-status list and a payer-stage sample mappable onto D2; (G3) a platform account may serve many unrelated
agencies on one key (D8 isolation is then proven by a conformance case: unmatched or conflicting responses are quarantined
and post nothing); (G4) duplicate-upload behaviour and the held-for-approval setting; (G5) a BAA. Then a sandbox run with
synthetic patients (#719).

**Owner action.** Product owner sends the question lists (comparison section 5, plus the BAA request) to Claim.MD and
Stedi. **Flips to go:** G1-G5 answered with no disqualifier, by amending this paragraph. **Flips to no-go:** hospice or
NOE/NOTR not accepted, no platform model, or no BAA; Availity and Office Ally (not yet assessed) are then evaluated.

**Unchanged by this decision.** D6: the attempt store, not any vendor idempotency key, is the idempotency authority, so
no vendor's key lifetime blocks a build.

## Amendment (2026-10-25) — transfer notices are in the port; `partial` is a first-class disposition (#750, #751)

**Transfer notices (#750).** `SubmissionKind` gains `transfer_notice` (837I TOB 8xC change / 8xD cancel). *In the port,
not out of it,* because (a) the CMS 837I NOE Companion Guide governs every NOE-related TOB (8XA-8XE), so an 8xC/8xD is an
NOE-family file that goes to the same MAC by the same channel as NOE/NOTR, (b) the alternative, a documented boundary,
would leave a configured vendor with a path (the legacy portal) that the rest of the cycle is forbidden to use (D1), and
(c) Stedi's sandbox findings expect "the same edit path as NOE". It travels `submitNotice` (no claim adjustment, raw
X12 only: the repo's `build837iTransferNotice` is the generator, the legacy sidecar has none). `submitClaim` refuses it.
The attempt record's kind CHECK is widened (migration 1268). A transport that cannot carry it answers a typed
`CH_INVALID_REQUEST` (or `CH_NOT_WIRED`), which the M23 worker records as `failed_portal`; nothing is dropped and the
legacy portal is never the fallback. Conformance: C03 now covers `transfer_notice` (accepted by `submitNotice`, refused by
`submitClaim`, refused with an adjustment), and every registered transport (`in_memory`, `direct_mac`, `stedi`) passes it.
**Unverified:** whether Stedi's payer routing accepts TOB 8xC/8xD (Q30 is open); the adapter sends it as it does an NOE
and a vendor 4xx surfaces as a typed refusal.

**Partial disposition (#751).** `AckDisposition` is `accepted | rejected | partial`. `partial` is a payer-stage answer
only (a 277CA that accepted part of the claim); a clearinghouse 999 is accepted or rejected, and `routeAckEvent` fails
closed on a clearinghouse-stage partial. `SubmissionState` gains `payer_partial`. The in-memory reference scripts it
(`payerPartiallyAccepts`) and conformance case C07b requires it to surface as `payer_partial` with its reason codes (and no
marker). `direct_mac`'s gateway maps a 277CA partial to the new disposition and `ackFromEvent` no longer reads a
`PARTIAL` reason code. Nothing persisted carried the marker (it was only on the transient pulled event, stripped before
the `claim_acknowledgment` row was written), so no data migration or compatibility shim exists. Stedi has no ack
receive-side yet, so there is no Stedi mapping to change.

## Amendment (2026-10-26) — the ISA13 is a stored value; Stedi claims go as JSON

**The interchange number is remembered, not derived.** The 837I ISA13 used to be a hash of the claim control number.
`SubmissionAttemptStore.allocateInterchangeNumber(org, scope, key, usage)` now returns a 9-digit number drawn from the
same platform-wide per-usage sequences as `allocateControlNumber` and memoizes it per (tenant, scope, idempotency key)
in `clearinghouse_interchange_number` (migration 1281). The memo commits on the store's own org-scoped connection, so a
job that dies after the vendor took the file and is redelivered renders the identical ISA13. The memo also carries the
render clock (`rendered_at`, migration 1282, issue #836; existing rows took their `created_at`), which the worker passes
to the writer as `createdAt`, so ISA09/ISA10, GS04/GS05 and BHT04/BHT05 are byte-identical on a redelivery and a raw-X12
vendor (direct MAC, in-memory) sees the same payload hash instead of a payload conflict. The Stedi JSON carries no
interchange or render timestamp (only service dates), so it was never affected. A new attempt (new control number, new
key) gets a new number and clock. A key remembered under one usage refuses the other. With no attempt store bound, the
claim attempt fails as `failed_worker`; there is no derived fallback. A number drawn for an attempt that then fails on
loader gaps is spent (harmless in a 10^9 space).

**Stedi claims travel as JSON.** The Stedi transport requires ISA13 to equal the submission control number on its
raw-X12 route, which an alphanumeric claim control number never satisfies. A Stedi claim is therefore sent on the JSON
route (`format: "json"`, `buildStediClaimJson`), which carries no ISA13, after `compareStediClaimJsonToX12` proves it
agrees with the X12 rendered from the same input (a disagreement fails the attempt, naming the fields only). Every other
vendor, and every notice, stays raw X12.

**Limitation.** NOE, NOTR and transfer notices still go to Stedi as raw X12 and so still hit the ISA13 == control-number
check; they stay unverified (Q14, Q30) until a Stedi account is provisioned. M41's submission worker keeps its own
`interchange_control_number` sequence and probably has the same mismatch; confirm before enabling Stedi for it.

## Open questions

1. Whether Original Medicare accepts frequency 7/8 replacements through Stedi (docs say no; their edit says yes) — Q17.
2. Whether the Stedi account can submit claims at all in the sandbox (`ACCOUNT_NOT_PROVISIONED`) — Q14.
3. Where the shared breaker/`DegradedError` kit lives once four packages stop carrying their own copies (plan A4).
4. Second vendor go/no-go: conditional on G1-G5 in the 2026-10-24 amendment (#718, #719).

## Amendment 2026-10-27 (#820): the claim-status inquiry carries its inputs

`fetchClaimStatus(ctx, controlNumber, inquiry?)` now takes an optional `ClaimStatusInquiry` (billing provider, TRANSIENT subscriber block, service dates; the payer is `ctx.payerId`). A transport that needs more than the control number reads it from there and refuses `CH_INVALID_REQUEST` without one; a transport that cannot inquire answers `CH_NOT_WIRED` whatever is passed. Stedi now implements the call (276/277 JSON, `stedi-claim-status.ts`) and is **vendor-unverified**: endpoint path, field names and the category-code mapping are not sandbox-observed (contract row stays U). The direct-MAC transport stays `CH_NOT_WIRED`: the MAC portal has no 276 channel and the repo has no 277 (status) parser, only 999/277CA. Neither transport ever answers `not_found` for a payer "cannot locate", and the parser returns `latest: null`, so a status inquiry reports a state and applies no acknowledgment.

## Amendment 2026-11-04 — Claim.MD is a go; `claimmd` is a bindable vendor (supersedes the 2026-10-24 conditional)

**Decision (product owner, 2026-11-04).** Build and allow production for a Claim.MD transport. The product owner
opened a Claim.MD account and took the go decision without the remaining written vendor answers; what is known and what
is still unverified is recorded in
[`CLAIMMD_TRANSPORT_CONTRACT_20261104.md`](../audits/clearinghouse-integration/CLAIMMD_TRANSPORT_CONTRACT_20261104.md).
Against the 2026-10-24 go criteria: **G5 met** (BAA received 2026-11-04, shown in the portal); **G3 met by
documentation** (Claim.MD's "single vendor account" model: agencies are provider records on one account, each enrolled by
NPI/TIN); **G1 met in test** (the home health + hospice MACs CGS J15, NGS J6, Palmetto JM and NGS JK are UB04/ERA payers on
Claim.MD's payer list; sandbox run 2026-11-05: an NOE and an NOTR each accepted by Claim.MD and the test payer; routing to
a real MAC is seen only on production); **G2 met for accept/reject** (sandbox run 2026-11-05: `A`/`R`
at the clearinghouse stage, a payer-stage `A` with the payer's claim number; other letters unseen); **G4 met** (sandbox run
2026-11-05: a repeated Filename is refused with error code 61; nothing else is deduped). Stedi and `direct_mac` are unchanged; the platform still binds exactly one vendor (D3).

**What the adapter does about the open items.** An unknown response status is skipped with an anomaly, never guessed
(G2). Claim.MD dedupes only by Filename (G4), so the attempt store stays the idempotency authority (D6); a code-61
answer to our own fixed Filename is proof of an earlier landing and stays `CH_IN_DOUBT`. An
upload that may have landed answers `CH_IN_DOUBT` (never retried under a new control number) and, retried under the
same key, is reconciled against Claim.MD's upload list by our own Filename before any resend.

**Configuration.** `CLEARINGHOUSE_VENDOR=claimmd`, `CLAIMMD_ACCOUNT_KEY`, `CLAIMMD_ACCOUNT_USAGE` (`test` or
`production`: which Claim.MD account the key opens; a call of the other usage answers `CH_NOT_WIRED`). The envelope ids
(ISA06/GS02 = account number, ISA08/GS03 = `CLAIMMD`) are `billing_edi_profile` rows under `route_key = 'claimmd'`.
Production account settings: 837I on, Transmit Approval off, automatic corrected claims off, SFTP off.
Claim.MD's limit (100 requests a minute per account, then an HTTP 403 block) is spent from one counter per usage mode,
injected by the backend from the shared Valkey rate-limit store so every process draws on one budget; a request with no
budget, or with the store down, is not sent and answers retryable `CH_UNAVAILABLE` (contract doc, Rate limit row).

**Tenant boundary (D8).** One account serves every tenant, so every read is filtered to the context's billing NPI,
which `provider_entity` makes unique platform-wide, and no Claim.MD call runs without it.
`SubmissionAttemptStore.findByControlNumber` (contract case AS-04b) maps a control number to Claim.MD's claim id inside
one tenant and scope.

**Partly implemented.** `validateOnly` is a LOCAL dry run (Claim.MD has none; an upload is a submission), reporting the
pre-upload checks only. `checkEligibility` calls Claim.MD `eligdata` with the request's transient `EligibilitySearchFacts`
(subscriber name, DOB, billing EIN), which M41 reads per call only when Claim.MD is the bound vendor and never stores or
logs; they go to Claim.MD under the BAA (CW-BA-01). `verifyAndParseEvent` (Claim.MD pushes enrollment and appeal events
only) answers `CH_NOT_WIRED`; those reports enter through M23's own ingress (amendment 2026-11-05 below).
Conformance: the five submit-side cases pass; the receive cases are skipped by name and replaced by Claim.MD-specific
tests, because the shared cases give every tenant the same NPI.


## Amendment 2026-11-05 — Claim.MD webhook intake (enrollment and appeal reports)

**Status: built, OFF by default** (`CLAIMMD_WEBHOOK_ENABLED` must be exactly `true`). No real Claim.MD delivery has been
captured yet; the shape is from Claim.MD's documentation (`https://api.claim.md/`, Webhook Events, read 2026-11-05) and
the contract doc's webhook rows say what is D and what is U. Turn it on only when all three hold:

1. Claim.MD support has activated the URL, and one real delivery has been read against those rows.
2. **NPI ownership is platform-verified** (owner decision 2026-11-05). Today any tenant `org.manage` user can register
   any Luhn-valid NPI on a `provider_entity`, so a tenant that registers another hospice's public NPI first would receive
   that hospice's enrollment reports (no PHI, but another provider's vendor data) and lock the real owner out with
   `NPI_TAKEN`. Before enabling, the sweep must route an enrollment only to a provider entity whose NPI platform staff
   have verified, and answer `unroutable_npi` for an unverified one. Appeal routing (by our own platform-sequence control
   number) is not affected.
   **Built 2026-11-05.** M23's `provider_npi_verification` (migration 1326) records "platform staff verified that provider
   entity P owns NPI N", with the evidence, the verifying membership and time, and a revoke (membership and time); rows
   are never deleted. It is a separate table, not a column on `provider_entity`, because tenants can update that row. RLS
   is FORCEd: a tenant reads its own org's rows and writes none; only the platform login writes, through the audited
   `m23.npi_verification` platform context (M1 baseline write-audit trigger). The sweep routes an enrollment only when a
   live row matches the entity's CURRENT NPI, so changing the NPI stops routing (switching back to the same NPI counts
   again only if no other entity has been verified for it since: verifying an NPI closes every other entity's live row
   for it). Platform staff list, verify and
   revoke at `GET /api/v1/admin/billing/npi-verifications` and `POST …/:providerEntityId/verify|revoke`
   (`billing.rule_config.platform_admin` + a platform-ops role; writes add a fresh step-up, the AI-actor block and
   `Idempotency-Key`; verify must name the NPI the operator checked, so a value changed since is refused `NPI_CHANGED`),
   in the admin console under Medicare billing → NPI verification. Before turning the intake on, verify every live
   tenant's NPI there; until then their enrollment reports land as `unroutable_npi`.
3. The Billing add-on binding below is in the mode the operator intends (`CLAIMS_BILLING_ENFORCEMENT`).

**D7 as applied to Claim.MD: a push is a vendor REPORT, not event-then-fetch.** Claim.MD pushes only enrollment and appeal
updates, with their content inline; there is nothing to fetch back, and none of it is an acknowledgment, a claim status or
an ERA. So `ClaimMdTransport.verifyAndParseEvent` stays `CH_NOT_WIRED` (its message names the ingress), the port is
unchanged, and every poll (`/response/`, `eralist`) is unchanged. The reports enter through a Claim.MD-specific ingress
owned by M23 (it owns the D3 binding; M25 and M41 depend on M23, never the reverse):

- `POST /api/v1/webhooks/claimmd/<usage>` (only the configured usage is mounted), CSRF-exempt, anonymous rate tier, 1 MiB.
  `Auth-Signature-Base64` = base64(HMAC-SHA256(key = the account key's Latin-1 bytes, message = the raw body bytes)),
  checked in canonical form and timing-safe (`packages/x12-837-client/src/clearinghouse/claimmd-webhook.ts`); an absent
  header (an account with no active key) is refused like any other failure: one `401 INVALID_SIGNATURE`.
- 200 `{received:n}` only after ONE statement stored the whole batch in the platform-only `claimmd_webhook_event`
  (migration 1322), keyed `(usage, acct_number, eventid)`, each element AES-256-GCM encrypted
  (`CLAIMMD_WEBHOOK_PAYLOAD_KEY`); a database failure is a 5xx and Claim.MD retries. After a valid signature content is
  never refused: an unsplittable body is one `malformed` row keyed `body:<sha256>`, an element without a usable eventid
  `x:<sha256(element)>`.
- A one-minute sweep (`claimmd-webhook-sweep`) settles receipts and publishes `m23.clearinghouse.enrollment_reported`
  (consumer M41) or `m23.clearinghouse.appeal_reported` (consumer M25), ids and one bounded vendor word only, in the same
  transaction that marks the receipt `published`. Test events are settled on receipt (`test_ack`).

**D8 as applied to Claim.MD: tenant resolution never trusts the payload's claims about a tenant.** An enrollment resolves
by `prov_npi` to the one `provider_entity` with that NPI (unique platform-wide), and only when that NPI is platform-verified
(precondition 2); an appeal by `remote_claimid` to the one
live `clearinghouse_submission_attempt` with that `(usage, control_number)` (unique per usage platform-wide). An unknown
NPI or claim is terminal `unroutable_npi` / `unroutable_claim`, logged with ids only. Caveat: Claim.MD documents
`remote_claimid` as the 837 `REF*D9`, which our 837I does not send today, so appeal reports for X12 uploads resolve only
once we send our control number there (or Claim.MD confirms it echoes CLM01); until then they land as `unroutable_claim`.

**The Billing add-on.** After resolution the sweep asks a `BillingEntitlementPort`; an org without the add-on keeps its
receipt encrypted as `awaiting_entitlement`, re-checked hourly and published once the add-on is granted, and becomes
`expired_not_entitled` 90 days after receipt. The port is bound to ADR-0108's `isClaimsBillingEntitled`, so it follows
`CLAIMS_BILLING_ENFORCEMENT`: `off`/`shadow` publish for every resolved org; `enforce` reads M35, and a failed read retries
without spending an attempt.

**What the reports may change.** Enrollment: nothing by itself; M41 lists an advisory report and staff confirm it through
the existing, step-up-guarded enrollment routes (ADR-0100 note). Appeal: M25 records every report, alerts billing staff,
and only on the exact word `created` for exactly one live non-Medicare denial opens an unconfirmed draft level or links an
in-flight one; it never decides, closes or withdraws.

**Retention.** A settled receipt's cipher is cleared 90 days after processing; the digest, ids and outcome stay. Provider
TINs (which can be SSNs) and vendor free text exist only inside that cipher.

## Amendment 2026-11-06 — the clearinghouse is a per-tenant choice (supersedes D3's single platform vendor)

**Decision (product owner, 2026-11-05; owner decisions D1-D6 of 2026-11-06, final).** Each tenant chooses how its claims leave
ChartWarden: `stedi`, `claimmd`, or `outside` ("bills outside ChartWarden"), with its own setup and its own encrypted vendor
credential. Platform operators set it during onboarding (platform routes: `platform_ops`, step-up, a recorded reason, an audit row
naming operator and tenant, accepted only while the tenant is provisioning or onboarding) and the tenant admin sets it on its own
(tenant routes: the org-level `billing.clearinghouse.read` / `.admin` keys, a fresh step-up, no AI actor, `Idempotency-Key`, `If-Match`).
D3's "one platform credential" no longer holds for the tenants that choose; D1, D2 and D4-D10 stand.

**Who may choose (D3 of the owner decisions).** The tenant routes do NOT reuse the provider-entity-scoped `billing.mac_credential.*` keys: choosing the
clearinghouse re-routes every provider entity's claims (PHI) to another vendor, so a billing manager scoped to one entity must not hold it. `billing.clearinghouse.read`
and `.admin` are org-level and bound to the org-wide admin roles only (`org_admin`, `administrator`, through the full-catalog template and a
migration for existing role rows); no other template grants them.

**Data.** `tenant_clearinghouse_config` (M23, migration 1350), one row per organization: vendor, mode (`test` / `production`),
status `draft` -> `verified` -> `active`, the vendor credential sealed with the M23 MAC-secret envelope under its own labels (AAD binds
organization, vendor and mode; the KEK is the existing `M24_CREDENTIAL_ENCRYPTION_KEY`), how it was verified, the last test outcome, and
the tenant-held vendor BAA. RLS ENABLE + FORCE for the app role (SELECT, INSERT, column-level UPDATE, no DELETE: switching to `outside`
is an UPDATE); platform operators write through the tenant's own scope (the app pool under the target org), so there is no platform
grant. The audit trigger scrubs the sealed secret and records `secret_changed` (the scrubbed before and after are identical, so a swapped credential would
otherwise be invisible); the tenant routes also write a field-level audit row naming the changed fields (never values), like the platform lane.
`outside` carries no mode, no secret and no BAA and is stored `active`.

**Rules (service.ts).** Any change starts at `draft` for the new credential (owner decision D6): a vendor or mode change, a first choice, and
a credential rotation alike. Rotating the key of a `verified` or `active` config drops it to `draft` and clears the connection test and the
activation: the new key has not been tried, and claims work HOLDS (a worker hold, not a failure) until it is re-verified and re-activated. A change of
VENDOR also voids the vendor BAA (a new agreement); a same-vendor change keeps it, even a key for a different account of that vendor: the BAA is with the vendor, and ChartWarden cannot see an account id, so the tenant re-records it when its agreement changes. Once a PRODUCTION submission is reserved or sent, vendor and mode are
locked (409 `CLEARINGHOUSE_VENDOR_LOCKED`): the old vendor still owes that org its acknowledgments. A switch away from an ACTIVE vendor (or to `outside`) is also refused
while the org has claims or M41 commercial submissions queued (409 `CLEARINGHOUSE_WORK_WAITING`, with the counts); a draft or verified config sends nothing and cannot drain a queue, so it never locks a switch (it would strand the tenant). The count
reads on the config service's own transaction (never a second pooled connection while the row is locked). Queued NOE / NOTR / transfer notices are not counted: a worker re-resolves the org's transport when it runs, so a notice goes through the new vendor (or parks for `outside`), and holding the switch could cost the 5-day filing deadline. Changes are version-checked (`If-Match`, 428 / 412). In
production the tenant route refuses `mode: "test"` (422 `CLEARINGHOUSE_TEST_MODE_NOT_ALLOWED`): only the platform-ops lane may set it, with its recorded reason.

**The vendor BAA (owner decision D2).** A tenant-held Stedi or Claim.MD account needs BOTH before it can go `active`: (a) the tenant records its vendor BAA
(`POST /api/v1/tenant/clearinghouse/baa`: held by the tenant, the effective date, a screened document reference, never patient information), and (b) a
platform operator verifies that record (`POST /api/v1/platform/tenants/:orgSlug/clearinghouse/baa/verify`: `platform_ops`, the separate
`tenant_clearinghouse.verify_baa_platform` key, fresh step-up, a human actor, `Idempotency-Key`, a reason; the audit row names operator, organization and
reason; NOT limited to an onboarding tenant, because a live tenant that changes vendor needs it too). Activation refuses with 409 `CLEARINGHOUSE_BAA_NOT_VERIFIED` until then,
and the table CHECK holds the same rule, now for the right vendor: the record names the vendor it was made for (`baa_vendor`), and an `active` transmitting config must rest on a verified BAA for ITS vendor. Re-recording a changed BAA voids its verification and takes a live config back to `verified`. The BAA status is in both GET views.
The verification is pinned to the record the operator read: `baa/verify` requires `If-Match` (the `baa.recordedAt` of that record; 428 without it, 422 if malformed), compared under the row lock, and a record the tenant has changed since is a 409 `CLEARINGHOUSE_BAA_CHANGED`, so a swapped document cannot be verified unseen. The audit row names the document reference, effective date and `recordedAt` verified.

**Verification.** Claim.MD has a safe no-PHI probe: `uploadlist` for a day before any account could have uploads answers an empty list for
a valid key and error 21 for a bad one (observed 2026-11-04/05, contract doc), so `verify` runs it (`probeClaimMdAccountKey`). Stedi has NO safe
no-PHI probe in the repo or the audit record, so Stedi `verify` is an attestation with a required evidence note (8-500 characters, screened for SSN and MBI shapes) AND the
confirmation that the note names no patient information. The vendor probe never runs inside a transaction: `verify` reads and decrypts first (read-only, no row lock), probes with nothing open, then locks and
compare-and-sets on the version it read (409 `CLEARINGHOUSE_CHANGED_DURING_VERIFY` when the config moved meanwhile), in the platform lane too. `verify` is rate limited (6/min/user, fail-open); the platform route counts per TARGET tenant (every operator belongs to the one platform org, so counting under the caller's org pooled every tenant into one budget). A failed Claim.MD
test is a 200 carrying the outcome and leaves the config at `draft`. `activate` takes `verified` to `active` (with a verified BAA); an `active` config is what allows claims work.
*Known limits:* the Stedi probe-free attestation cannot tell a test key from a production key (a key-type versus mode check is not built); the Claim.MD probe is not counted in that account's request budget.

**Resolution.** `ClearinghouseBinding.forOrg(organizationId)` (this package) returns that organization's binding; the backend resolver
(`tenant-clearinghouse/resolver.ts`) re-reads the org's row on every call and rebuilds the transport only when its `version` moved, over the tenant's own credential and mode, with one Claim.MD
request budget per org. Each tenant transport is BOUND to its organization and to the vendor mode of the row it was built from: a call whose context names another organization is refused (`CH_INVALID_REQUEST`), and one whose usage is not that mode (the context's usage is read apart from the binding) is refused retryably (`CH_UNAVAILABLE`), both before the vendor.
A credential the resolver cannot open is a typed 503 `CLEARINGHOUSE_CREDENTIAL_UNREADABLE`, never a 500. The top-level binding is deliberately UNBOUND, so a consumer that forgot to resolve per org fails
closed. A row that is `outside`, `draft` or `verified`, or no row, resolves unbound with its reason (`outside`, `not_active`, `not_chosen`): nothing is sent, and the legacy launch-gateway ports are NEVER the fallback.
A claim job for an org that is not live is HELD (moved back to delayed, no attempt spent, one alert per org per window) instead of failing into the DLQ, in every claims-billing enforcement mode. M23's submit, retry,
NOE/NOTR and ack paths, the M25 remittance pull and M41's submission, ack and eligibility paths all resolve per org; an unbound org is reported (one alert) or skipped on its own and never fails the others in a tick, including the
shared M41 crons: an org whose credential cannot be opened or whose config read failed is reported the same way, with the code, and the tick's failure lines name the error code. The credential-rejection hold (#714) hangs on the org's cached transport, so a rejected key holds that org's calls and a re-entered key starts clean.

**The platform env binding.** `CLEARINGHOUSE_VENDOR` (and its credential) stays, but now serves ONLY the organizations named in
`CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS` (comma-separated organization uuids, no blank entries) and only while they have no row: the demo tenant keeps working with no data migration and no secret copied into
the database. Production env validation refuses a malformed list or naming organizations with no vendor bound. A deployment that relied on the platform binding for every tenant must name
them there or they stop sending until they choose their own.

**What stays platform-level.** The X12 generation gateway and `CLEARINGHOUSE_PAYER_ID`. The Claim.MD webhook intake stays platform-account only and OFF (its HMAC key is the platform account
key): a tenant's own Claim.MD account does not deliver enrollment or appeal reports through it, and per-tenant webhook URLs are not built.

**Wizard (owner decision D5).** Step 7 `clearinghouse_selected` is an `either` step settled by `context.clearinghouseSettled` (`outside`, or a vendor in `active` status), so choosing and activating a vendor settles it at once
through the advance pass (migration 1351, `contract`: the previous release's evaluator throws on the unknown field). Choosing `outside` auto-skips steps 8 `mac_configured` and 9 `payer_enrollment` with the system
reason "bills outside ChartWarden", through the wizard service's own skip path (so the audit and the strict sequence hold: a skip an earlier open step still locks waits for the next wizard change); switching back to a vendor reopens exactly the steps the
system skipped, through the wizard's reopen path (a pending go-live attestation blocks a reopen, which is logged).

**The gate (owner decision D1).** ADR-0108 is repurposed: new claims work follows this choice, not an add-on (see its 2026-11-06 amendment), and a suspended, paused or canceled ChartWarden subscription still blocks NEW claims and eligibility work regardless of the clearinghouse.
M35's pricing reads the same choice through the `TenantClearinghouseReader` seam (owner M23) to apply "`outside` means no billing percentage"; this ADR implements no pricing.

**`outside` and the notices (owner decision D4, supersedes the earlier "not decided here").** A tenant that bills outside ChartWarden files its NOE and NOTR itself. ChartWarden still tracks the 5-day deadline, shows "file with your biller", and lets the tenant record the date it was filed;
it transmits nothing: the notice is not enqueued or attempted, it is parked as filed-externally-pending, and a tenant route records the externally-filed date (billing permission, step-up, audited). The deadline watch keeps counting for such notices
until the date is recorded. An org that has chosen nothing yet (still onboarding), or whose config is a draft, has its notice jobs HELD, not failed, with one alert.
Round 2 (owner decisions of 2026-11-05): the DDE watchdog skips an outside org (it raises no DDE work item for an at-risk notice, because ChartWarden never transmitted it; the deadline watch and its at-risk and breached events are unchanged); a transfer notice for an outside org is a typed
409 `CLAIMS_FILE_WITH_YOUR_BILLER` at submit instead of a 202 and a silent hold; a NOE or NOTR recorded as filed AFTER its due date publishes `m23.noe.filed_externally_late` / `m23.notr.filed_externally_late` (ids and dates only, in the record transaction), which raises a critical M36 alert to the tenant's billing and compliance roles and a platform-ops notice;
a breach stamp the watchdog set is what ChartWarden observed and is never cleared by a tenant's record: an in-window date recorded over one keeps the stamp and publishes the same late-filing event with `breachObservedAt` (the stamped date) next to the attested `filedOn`, so compliance and ops see both; a manual cancel of a notice already on file with Medicare is a 409 `NOTICE_FILED_EXTERNALLY` (the correction is Medicare's), and a cancelled externally filed NOTR no longer counts as a prior-election closure. "Today" for these rules is the Eastern (CMS) calendar day. A queued attempt row a parked notice leaves behind is closed only by the job that owns it (the job carries its `submissionId`; the request path never touches the attempt log, because a worker may be uploading that very row), and a resubmit after a park takes the next attempt index instead of handing back the closed row; a submit worker refuses to transmit a notice recorded as filed and closes its own attempt.

A tenant cannot undo a "filed outside ChartWarden" record, and a cancel of a recorded notice is refused, so a mistaken or false record would be permanent. A **platform operator** may withdraw it (`POST /api/v1/platform/tenants/:orgSlug/{noe,notr}-records/:id/withdraw-external-filing`, permission `tenant_notice_filing.withdraw_platform`, the platform_ops role, a fresh step-up, a non-AI actor, an `Idempotency-Key`, a required `reason`, and `If-Match` naming the record's `externalFiling.recordedAt` so a record withdrawn and re-recorded since is a 409). The notice returns to its pre-record state (marker and the three filed columns cleared together; its state is unchanged), so it can be recorded or submitted again. A breach stamp is never cleared, and a NOTR's prior-election closure is derived from the marker, so withdrawing the record reopens the election with nothing stored. The platform audit row names the operator, the tenant, the reason, the filed date withdrawn and the record's `recordedAt`; the notice table's own audit trigger records the change under the operator.

**Not built (deferred, stated).** KEK rotation and a key-id byte in the envelope (a rotation is a re-encrypt of every row); per-tenant Claim.MD webhooks; operator tooling to migrate a tenant between vendors once production submissions exist
(the lock stands until then); a Stedi key-type versus mode check; a Claim.MD probe counted in the account's request budget; a MAC-credential check when a LIVE tenant switches from `outside` to a vendor (round 2, L6): the wizard reopens the MAC and payer-enrollment steps only while a tenant is onboarding,
and neither a hard activation gate nor a payer-enrollment check is built, because MAC credentials are step 8 (after the clearinghouse, so a gate would deadlock onboarding unless split by tenant status), payer enrollment is a human attestation with no machine-readable fact,
and a commercial-only or eligibility-only (M41) tenant legitimately has no Medicare MAC credential. Today a Medicare claim for such an org fails LOUDLY (the claim context refuses a provider entity with no MAC credential), never silently. A readiness warning on the live tenant's clearinghouse view needs an owner decision on commercial-only tenants. The tenant-facing UI for all of this is slices 5 and 7.
