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

## Open questions

1. Whether Original Medicare accepts frequency 7/8 replacements through Stedi (docs say no; their edit says yes) — Q17.
2. Whether the Stedi account can submit claims at all in the sandbox (`ACCOUNT_NOT_PROVISIONED`) — Q14.
3. Where the shared breaker/`DegradedError` kit lives once four packages stop carrying their own copies (plan A4).
4. Second vendor go/no-go: conditional on G1-G5 in the 2026-10-24 amendment (#718, #719).
