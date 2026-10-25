# ADR-0103 — Vendor-hosted DDE goes through one `DdeAccessProvider` port, off by default; manual keying stays the baseline and ChartWarden still never touches FISS itself

- **Status:** **Proposed** (2026-10-24). D1 to D4 are built with the port (types, registry, in-memory reference,
  conformance suite). The vendor questions in D7 are open until Episode Alert's write-API documentation is in hand;
  ratify when the first real adapter passes the conformance suite.
- **Date:** 2026-10-24
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
