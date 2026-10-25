# ADR-0103 — Vendor-hosted DDE goes through one `DdeAccessProvider` port, off by default; manual keying stays the baseline and ChartWarden still never touches FISS itself

- **Status:** **Proposed** (2026-10-24). D1 to D4 are built with the port (types, registry, in-memory reference,
  conformance suite). The vendor questions in D7 are open until Episode Alert's write-API documentation is in hand;
  ratify when the first real adapter passes the conformance suite.
- **Date:** 2026-10-24
- **Status note (2026-10-25):** the D7 questions are written and ready to send, not sent, in
  [`EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md`](../audits/clearinghouse-integration/EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md);
  the human onboarding steps and the secrets and configuration names are in the sibling `EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md`
  and `EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md`. Until a person records the answers (issue #762), D7 is unanswered and the
  default stays `manual`.
- **Phase:** post-launch billing work (Medicare submission paths). Tracking issue #755; this ADR is #756, the port is #757.
- **Narrows:** [ADR-0052](ADR-0052-dde-work-queue.md) D2 ("never an integration"). ADR-0052 stays Accepted and unedited;
  D2 is read as narrowed by D3 below. Everything else in ADR-0052 (item types, lifecycle, deadline rule, controls, PHI
  rules) is unchanged.
- **Related:** [ADR-0053](ADR-0053-clearinghouse-transport-port.md) (the registry and conformance pattern this
  mirrors), [ADR-0020](ADR-0020-integration-governance.md).

## Context

ADR-0052 D2 says ChartWarden "stores no DDE credentials, performs no screen automation, and never submits to FISS", so
RTP corrections, adjustments, cancels and NOE/NOTR keying are human work tracked in the M23 queue.

Episode Alert (a CMS-approved Network Service Vendor since 2007) sells hosted DDE access, a daily DDE change report
(SmartDDE) and a REST API for eligibility, claim status and remits. Its public pages document no DDE write
endpoint, no authentication scheme and no field schema; those arrive after signup. A vendor that is itself an
approved NSV is a different thing from screen-scraping a MAC terminal, and the operator's own DDE ID can be kept
per person, which is the rule ADR-0052 was protecting. The product owner wants the option, behind a switch so a
different provider can replace it.

## Decisions

**D1 — A separate port, not an extension of `ClearinghouseTransport`.** `DdeAccessProvider`
(`packages/x12-837-client/src/dde/types.ts`) has three methods: `submitOperation`, `fetchOutcomes` (cursor-paged)
and `fetchOperationStatus`. DDE is keyed per operator and answered by FISS, not a claim file sent to a clearinghouse,
so the clearinghouse context (payer id, billing NPI, control-number identity) does not fit. It sits beside the
clearinghouse port for the same reason that port does (M25 already depends on M23). The operation kinds are exactly the
ADR-0052 D3 item types.

**D2 — Platform configuration, fail closed, manual by default.** `DDE_PROVIDER` is `manual` (also unset or blank),
`in_memory` or `episode_alert`. `manual` binds a provider whose every call answers `DDE_NOT_WIRED`, so nothing is sent and
the ADR-0052 queue behaves exactly as it does today. A set provider with no registered adapter throws at boot;
`in_memory` is refused in production. The credential is platform-held and read from the environment by the adapter's
factory, never stored per tenant. Swapping provider is changing this variable and registering another adapter that passes
the conformance suite.

**D3 — What changes in ADR-0052 D2.** ChartWarden still performs no screen automation, holds no FISS or MAC credential,
and never writes to FISS itself. What is now permitted, only when `DDE_PROVIDER` binds a provider, is asking a
CMS-approved vendor to key an operation on the operator's behalf through that vendor's API. The vendor holds the DDE
session; ChartWarden holds only the vendor's platform API credential.

**D4 — Per-operator attribution is required.** DDE IDs are issued to individuals and cannot be shared. Every call carries
`operatorMembershipId`, and a provider answers `DDE_OPERATOR_NOT_ENROLLED` for an operator it has no DDE ID for, on reads as well as submits. An
adapter must not satisfy a call under another person's ID or a shared vendor ID. If a vendor cannot attribute per
operator, that adapter is not accepted and the item stays on manual keying.

**D5 — Verified is not attested.** A provider outcome (`accepted | returned | rejected`, with the MAC's own date and
FISS reason codes) is provider-verified. An operator's "I keyed it" under ADR-0052 D2 remains an attestation. The queue
must record which it was (`submission_mode`, built in the M23 routes issue, #760) and must never present one as the
other. A provider acceptance feeds `payer_status_date` with a new source value; `record-acceptance` stays for manual.

**D6 — PHI and idempotency.** An operation payload is PHI-bearing (an NOE, NOTR or claim entry names the beneficiary), so an adapter never logs it, echoes it into a reason, or keeps it beyond the vendor call. Receipts, outcomes and degraded reasons carry codes and ids only. State is
partitioned by (organization, provider entity, usage), idempotency keys replay an identical operation by the same operator and conflict on a
different operation or a different operator (an operation is keyed under one person's DDE ID). `controlNumber` is not unique per
operation, so callers derive a deterministic key per queue item and attempt (#760), and `usage: "test"` must reach only vendor test mode. These are conformance cases D1 to D13, not
adapter-specific promises.

**D7 — Open vendor questions (issue #762).** Does Episode Alert expose NOE/NOTR, RTP correction, cancel and adjustment
as API operations at all? Can it key under each operator's own DDE ID (D4)? Is there a sandbox? Push or poll for
outcomes? If it cannot, the Episode Alert adapter ships only for the documented API (eligibility, claim status, remits)
through `ClearinghouseTransport`, and this port stays bound to `manual`.

## Consequences

- No behaviour changes until a provider is bound: the default is `manual`.
- The Episode Alert clearinghouse adapter (#758) and the DDE write adapter (#759) are independent; only the second needs
  this port.
- A provider that passes conformance is still unverified against the real vendor until a trial account proves its field
  names (the DoseSpot precedent in `docs/history/m12-dosespot-adapter.md`).
- `arch:adr-docs` sees one more ADR; no manifest, table or migration change is made by this ADR or the port.

## Amendment 2026-10-25 — the M23 send and sync routes (issue #760)

Built. `POST /api/v1/billing/dde-items/:id/submit-via-provider` (permission `billing.dde.submit_via_provider` plus a recent
step-up, the ADR-0052 D6 assignee-ownership rule) keys an `in_progress` item through the bound provider and records
`submission_mode = provider` and the provider's opaque `provider_reference` (migration 1271; manual keying records
`submission_mode = manual`; a retry clears both). The idempotency key is derived, `dde:<item id>:<attempt number>`, never
minted, so a double click replays one operation and a retry is a new one. The call carries the acting operator's membership
id; `DDE_OPERATOR_NOT_ENROLLED` (409), `DDE_NOT_WIRED` (503) and the other port codes map to stable typed refusals, and a stale
version or wrong state is refused before the vendor is called. `POST .../sync-provider` asks the provider for the status of
one provider-submitted item: an acceptance applies the notice's acceptance with `payer_status_date_source = dde_provider`
(provider-verified, distinct from `dde_manual`), a return or rejection opens the RTP path, a pending answer changes nothing.
The platform binds `DDE_PROVIDER` at boot (`bindDdeProvider`); no vendor adapter exists yet, so the only bindable value is
unset or `manual` and the routes answer `DDE_NOT_WIRED`. **Not built:** a batch ingest of the cursor-paged daily change report
(`fetchOutcomes` needs a persisted cursor), and the beneficiary identifier: the queue holds no MBI (ADR-0052 D7), so the
operation document is the keying sheet (ids, dates, codes) and a real adapter will need an MBI seam before it can key anything.

## Amendment 2026-10-25 (2) — no transaction across the vendor call, and the "possibly sent" marker (issue #760 follow-up)

`submit-via-provider` is three steps, never one transaction. (1) A short org-scoped transaction checks the ownership rule,
the version and the state, refuses an item that is already possibly sent, and durably stamps `provider_in_doubt_at` and
`provider_operator_membership_id` (history event `provider_send_started`, version bump). (2) The vendor call runs with no
connection held, bounded by `DDE_PROVIDER_CALL_TIMEOUT_MS` (30 s); an `AbortSignal` is passed as the optional `DdeContext.signal`
(an adapter hands it to its HTTP client). (3) A second short transaction applies the outcome to the item as it is then, with a
fresh version: a receipt becomes `submitted` and clears the marker; only `DDE_NOT_WIRED`, `DDE_NOT_PROVISIONED`, `DDE_OPERATOR_NOT_ENROLLED` and `DDE_INVALID_REQUEST` prove the
operation never left, so only they clear the marker (`provider_send_refused`), and only for the very send that set it (same
state, attempt and marker timestamp). `DDE_UNAVAILABLE` (it may be a timeout after the request was written),
`DDE_IDEMPOTENCY_CONFLICT` and unknown codes stay in doubt. A timeout, a throwing adapter,
`DDE_IN_DOUBT`, an unusable receipt, or an item that moved while the vendor worked (for example a cancel) leaves the marker set
and appends `provider_in_doubt`; the caller gets `409 DDE_IN_DOUBT`. The idempotency key (`dde:<item>:<attempt>`) and the
optimistic version are unchanged; a double click loses the phase 1 version check (`412`) before any vendor call.

While the marker is set the item reads `providerInDoubt: true` and a second provider send is refused with `409 DDE_IN_DOUBT`
(the port says an in-doubt send must never be retried). The way out is a manual `record-submission`, which clears the marker and
notes `resolvedProviderInDoubt` in the history. A sync cannot resolve it: an in-doubt item holds no provider reference to ask
about (the port has no lookup by idempotency key), and `sync-provider` answers 409 with a message saying so.

**Whose DDE ID.** A DDE ID is per person and an operation is keyed under one person's ID, so a status inquiry is made as the
operator who submitted (`provider_operator_membership_id`), not as whoever clicks sync (an admin stepping in for an absent
assignee). Rows submitted before migration 1272 have no recorded operator; sync falls back to the syncing operator for those.
The audit trail still names the person who synced.

**Still not built:** the batch ingest of the cursor-paged daily change report (`fetchOutcomes` needs a persisted cursor and a real
adapter) and the MBI seam; and the port has no status lookup by idempotency key, so a possibly-sent operation can only be
settled by a person checking DDE.

Phase 3 is applied as the operator who started the send, without re-running the ownership rule: that person's DDE ID keyed the
operation, so recording its outcome against the item is right even if the item was reassigned meanwhile. If a manual
`record-submission` raced the vendor call and the call then succeeded, the marker is put back (history `provider_send_started`
with `restored`, and the opaque provider reference in the `provider_in_doubt` detail) so the live vendor operation is never
invisible. The marker events publish `m23.dde_item.state_changed` with `fromState = toState`; the catalog accepts them and
consumers (none declared) must treat `event` as open. A thrown adapter error is reported only as "in doubt" (no logger is
injected into the queue service); an adapter should log its own failures.

While the marker is set, `cancel` and `retry` are refused with `409 DDE_IN_DOUBT` (either would free the subject for a second
keying); a manual `record-submission`, `record-acceptance` or `record-outcome` by a person who checked DDE settles it. Known
limits: a manual `record-submission` is allowed while a send is still in flight (the marker alone cannot tell a live call from a
crashed one), and if that call then times out the item shows no doubt; the success case is covered by the restored marker. The
`REFUSED_BEFORE_SEND` allowlist is only as sound as the adapter contract: a real adapter must return those four codes only when
nothing left for the vendor, and its conformance test must pin that before it is bound.

## Amendment 2026-10-25 — the daily change report ingest, the MBI seam and the Episode Alert skeleton (issue #793)

Built (this closes the "Not built" list of the #760 amendment except the real vendor adapter).

**Ingest.** A cron on the queue `m23.dde-daily-change` (every 30 minutes, registered only when `DDE_PROVIDER` binds a provider)
reads `fetchOutcomes` for each operator who has a provider-submitted item awaiting its answer and applies every outcome through
`DdeQueueService.applyProviderChange`: the same plan-and-apply code as `sync-provider` (source `dde_provider`, the same `accept`
and `return` edges), as the system actor (history rows say `system`, no membership) and through the real catalog-validating outbox
(`m23.dde_item.state_changed`). Items are matched by (provider entity, provider reference), never by a beneficiary identifier; an
answer naming a different control number is refused. Nothing is read for an org with nothing awaiting, and no vendor call is made
inside a database transaction (the read has its own bounded signal; the store and the apply step are short transactions).

**Identity.** Ingest is not operator-initiated, so the report is read under the DDE ID of the operator who submitted the item
(`provider_operator_membership_id`, set when the send was marked, the same identity `sync-provider` uses for its inquiry); one
cursor per operator. An item is applied only on its submitter's stream.

**In-doubt items.** A possibly-sent item (the durable marker of the #795 amendment) has no recorded provider reference, so a
change cannot be matched to it; it is `unmatched` (traced, then ignored) and stays for the person who settles it by hand. The
ingest never resolves a marker: a marker plus a reference-bearing answer cannot co-occur today, and if it ever did the item is
left alone (`already`). Resolving would turn the vendor's word into the person's check of DDE that the marker exists to force.

**Cursor and poison policy** (migration 1273, `dde_change_cursor`, `dde_change_exception`; forced RLS, audit triggers, no DELETE
grant): per (org, provider entity, vendor, usage, operator), moved page by page as a compare-and-set on `version`. A cursor the
provider refuses is reported and never reset; a chain returning to a position read this tick is a cycle and fails; at most 20 pages
per tick (the rest is a reported backlog). An unknown reference holds its page for one tick before it is ignored (the vendor is
called before the item records its reference, so an answer can beat the submit's commit), then gets one deduped trace row (at most
100 new per tick). An event the apply step refuses (unusable answer, or any 4xx including a deterministic 409 `CONFLICT`) stops its
page, is retried, and after 5 refusals is quarantined and skipped (operator release is a database action, as for 835 files). Only
`VERSION_CONFLICT` (a stale version), a 5xx and an outage are transient and never count. The cron runs one attempt per tick so a
retry seconds later cannot defeat the hold. Nothing from an unknown error reaches a job record, log or row: failures carry ids
and a fixed code. Event ids that look like an MBI and cursors outside a plain token alphabet are refused (they are stored and audited). Known
limits: an error that is neither a 4xx nor a stale version (a bug, a DB outage) is not counted, so it stalls that operator's
stream until fixed, failing and alerting each tick (the by-item `sync-provider` route still works); the submitter's membership
is not re-checked for liveness or permission before the report is read under their DDE ID; quarantine is keyed on the event id.
The two tables have no retention job (no DELETE grant by design); pruning is an admin task to schedule when
volume shows.

**MBI seam.** The only source of the beneficiary is M5's audited `MbiUnlockReader` (the MBI is `patient_payer.subscriber_id` of the
patient's `medicare_ffs` coverage). `buildDdeBeneficiaryPort` unlocks it per send with the new disclosure purpose
`dde_provider_operation` (subject = the DDE item), audited by the reader (`patient_payer.mbi_disclosed`, ids only) in its own
committed transaction. It runs in the send's first phase, before the in-doubt marker, so a refused unlock leaves the item
untouched. The identity rides `DdeOperation.beneficiary` in the provider call's memory only: not in the queue row, history,
outbox event, audit entry or log (asserted live). No MBI on file refuses the send with 422; an unavailable reader refuses with
503 and no detail.

**Episode Alert adapter: a skeleton, deliberately.** `EpisodeAlertDdeProvider` is built to the port with the generic plumbing
(credential and https base URL from the environment, timeout, no redirects, same-origin paths, byte-bounded bodies, HTTP status
to port code). Every vendor-specific fact is isolated in `episode-alert-dde-wire.ts`, which invents nothing: its functions answer
"unverified", so the adapter fails closed with `DDE_NOT_WIRED` and `createEpisodeAlertDdeProviderFromEnv` throws, which keeps
`DDE_PROVIDER=episode_alert` refusing to boot. D7 stays unanswered (issue #759): whether write operations exist, per-operator
DDE IDs, a sandbox, push or poll, paging and cursor shape, authentication and idempotency. A contract kit
(`episode-alert-dde-contract.test.ts`) is skipped unless a trial key is supplied. The conformance suite gained D14 (an outcome
names the operation it answers) and has mutant tests.
