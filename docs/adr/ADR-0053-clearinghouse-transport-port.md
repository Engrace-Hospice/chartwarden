# ADR-0053 — The claim cycle runs through one `ClearinghouseTransport` port; WardenX resells one clearinghouse (platform configuration); an adapter is done only when it passes the shared conformance cases

- **Status:** **Proposed** — D3 (platform configuration, WardenX resells one clearinghouse) was decided by the
  product owner 2026-10-11; D1, D2 and D4–D9 are proposed with the first implementation (port, conformance
  suite and in-memory reference) and are ratified when the first real adapter passes the suite.
- **Date:** 2026-10-11
- **Phase:** post-launch billing work (Medicare submission paths); precedes the Stedi adapter (Phase 4/5).
- **Extends:** [ADR-0028](ADR-0028-adapter-package-codepaths.md) (adapter package code paths) and
  `docs/architecture/WARDENX_INTEGRATIONS_v0_1.md` §3.1 (adapter package model), which say *that* an integration
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

**D3 — Platform configuration, not a tenant setting.** WardenX resells one clearinghouse (Stedi first), so the
vendor binding is deployment/platform configuration. The credential is platform-held; every call is still
attributed to a ProviderEntity (the payer sees the provider) through `ClearinghouseContext`. A per-ProviderEntity
override can be added later without changing the port. `usage: "test"` must reach only vendor test mode. The
fail-closed default (an unbound production transport answering `CH_NOT_WIRED`) and the boot validation that rejects
an active vendor with no adapter are **not built yet** — they are plan items A3/B2, and `CH.NOT_WIRED` /
`CH.NOT_PROVISIONED` are reserved codes until then.

**D4 — Conformance is the definition of done.** `CLEARINGHOUSE_CONFORMANCE_CASES` (18 behavioural cases covering
eligibility, dry-run, notices, idempotency identity, both ack stages, out-of-order acks, rejections, paging and
cursor validation, adjustments, remittance, push events, enrollment, outage, test/production isolation and tenant
isolation) run against any transport through a `ClearinghouseHarness` (the transport plus a script that drives the
far side for a given scope). The suite is framework-free so it runs under vitest, a live-sandbox smoke script or
CI. `InMemoryClearinghouse` is the executable specification and the double for module tests; it is exported from
`@wardenx/x12-837-client/testing`, not the package barrel, so production code cannot import it. Mutant
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

**D8 — The transport is the tenant boundary.** WardenX holds one platform credential, so nothing in the vendor
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

## Consequences

- A new clearinghouse is one class plus a conformance run; no module changes.
- Direct-MAC is re-expressed as a transport (plan B1) before the port is declared stable, so it is not fitted to
  Stedi alone.
- Follow-up work (separate PRs): the ack-state split (A6), the platform binding and boot validation (A3), binding
  `fetchRemittances` to the M25 835 worker port (A5), the Stedi adapter (B2).
- The port makes no promise about hospice rules (NOE timeliness, benefit periods, revenue/HCPCS pairing); those stay
  in the §11.A validation rules because clearinghouses do not check them.

## Open questions

1. Whether Original Medicare accepts frequency 7/8 replacements through Stedi (docs say no; their edit says yes) — Q17.
2. Whether the Stedi account can submit claims at all in the sandbox (`ACCOUNT_NOT_PROVISIONED`) — Q14.
3. Where the shared breaker/`DegradedError` kit lives once four packages stop carrying their own copies (plan A4).
