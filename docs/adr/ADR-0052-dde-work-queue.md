# ADR-0052 — The DDE work queue is an M23 human work-tracking feature, not an integration; NOE timeliness is judged on MAC acceptance

- **Status:** **Accepted** — owner (M23) and deadline rule (MAC acceptance) decided by the product owner
  2026-10-08; ratified by the product owner 2026-10-08 (D1–D8 as written). The open questions below
  remain open and are settled during Phase 2 or by Stedi's answer to question 3.
- **Date:** 2026-10-08
- **Phase:** post-launch billing work (Medicare submission paths).
- **Extends:** `docs/design/screens/revenue/WARDENX_UI_NOE_NOTR_CLAIM_OPS.md` (NOE Submission Manager
  line "record manual DDE submission + receipt"), which today has no persistence model, API or workflow.
- **Related:** [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (`app.org_id` is the only tenancy GUC),
  [ADR-0027](ADR-0027-phase-0-toolchain-and-scaffold.md) (manifest is the source of truth for owned tables).
  Review basis: `docs/audits/clearinghouse-integration/DDE_STEDI_REVIEW_20261008.md`.

## Context

Medicare Direct Data Entry (DDE) is the FISS terminal each MAC gives hospice providers. We found no
sanctioned programmatic access to it, and its IDs are issued to individuals, cannot be shared or
reassigned, and require prior EDI enrollment. DDE is nonetheless where a hospice does work that an
electronic clearinghouse path may not cover:

- entering hospice claims and NOE/NOTR (FISS claims menu options 28 and 49);
- correcting claims returned to provider (RTP, status/location T B9997, held up to 36 months; a
  correction receives a new receipt date);
- adjusting paid or rejected claims and cancelling paid claims;
- correcting wrong NOE election or revocation dates;
- responding to additional documentation requests (ADR).

As of `main` there is **no DDE code, table, route or spec** — only one UI-spec line. M23 already owns
the surrounding facts: the NOE/NOTR/claim state machines, `noe_record.window_target_at` (election
effective date + 5 days), `payer_status_date` (the MAC's own date for its answer, on which timeliness is
already judged rather than on our receipt time), the late-NOE occurrence span 77 derivation, the
watchdog crons, and the M23 permission and step-up guards.

CMS treats an NOE as timely only if it is submitted **and accepted** within 5 calendar days of the
admission date; otherwise the gap days are provider-liable and billed with occurrence span 77.

Separately, Stedi's published guidance says Original Medicare institutional claims are resubmitted with
their original frequency code (not 7/8) and without the payer claim control number. Whether that covers
adjustments of paid claims is unconfirmed (`docs/audits/clearinghouse-integration/STEDI_QUESTIONS_20261008.md`, question 3). Until
answered, adjustments, cancels and RTP corrections should be assumed to be DDE work.

## Decision

### D1 — Owner: M23

The queue is part of Module 23 (Billing-Medicare), not a new module. Its tables are added to M23's
`ownedTables`, its code lives under M23's `codePaths`, and its routes mount beside the NOE/NOTR routes.
It reads M23's own tables (claim, noe_record, notr_record) and nothing is cross-module except logical
FKs to M5/M6/M40 ids, per the existing policy.

### D2 — It is human work tracking, never an integration

WardenX stores no DDE credentials, performs no screen automation, and never submits to FISS. The queue
tells a biller what must be keyed, by when, and records what came back. Recording that an item was keyed
in DDE is an attestation by the operator, not a verified fact.

### D3 — Item types

`noe`, `notr`, `claim_entry`, `rtp_correction`, `adjustment`, `cancel`, `adr_response`. Each item links to
exactly one subject (claim, noe_record or notr_record) by logical FK and carries the provider entity.

### D4 — Lifecycle

Pure reducer in `@wardenx/billing`, shape-identical to `machines/noe.ts` (flat transition table, non-throwing
`reduce`, no clock, no PHI):

`queued → assigned → in_progress → submitted → accepted | returned`, then `closed`; `cancelled` from any
pre-`submitted` state. `returned` (RTP, rejection or ADR request) opens a new attempt: `returned → in_progress`
with `attempt_number` incremented. The history of each transition is an append-only event row.

**Filing-window watch (respawn rule).** The NOE/NOTR window-watch crons queue work for an in-flight notice whose
filing window target is within three Eastern calendar days (or past). Per notice and item type: a notice that never
had an item gets one (`source = watchdog`); a notice whose **latest item is `closed` with no recorded MAC acceptance**,
with no open item and whose closure has not been respawned, gets a new item linked to the closed one
(`respawned_from_id`). **Each closed item can be followed by at most one respawn, ever** (unique index
`dde_work_item_respawn_once_uq`): a tick cannot loop, two concurrent ticks create one, and a second closure of the
respawned item earns one more respawn, each only after a human closed the previous item. A `cancelled` latest item
**never** respawns (cancelling is an explicit human decision), an open item blocks it, and a closure that followed an
accepted outcome never respawns (its notice is accepted, and the candidate query also requires no MAC acceptance on
the closed item, so the query and the rule agree). Respawn chains are human-gated (each link needs a person to close the previous item) and have **no code cap**; a
`cancel` stops the chain, because a cancelled latest item never respawns. The UI says so beside Close and marks a
respawned item "Re-queued after closure". Decided 2026-10 (closes the respawn open question).

### D5 — Deadline rule: acceptance, not submission

For `noe` (and `notr`) items the deadline is the existing `window_target_at` (election effective date + 5
calendar days; NOTR from the through-date). The deadline is **met only when a MAC acceptance date on or
before it is recorded**; a `submitted` item with no acceptance is still at risk and is surfaced as such.
The recorded acceptance date is the operator-entered FISS date and is stored as the notice's
`payer_status_date` with a new source value `dde_manual`, so the existing late-NOE span-77 derivation and
the timeliness rule keep reading the same column. An acceptance is recorded through its own route,
`record-acceptance` (`record-outcome` is **returned-only**): it applies the notice's existing acceptance
transition through the notice-ack path — the queue never writes a second, divergent acceptance state. The date
may not precede the election (NOE) or termination (NOTR) date and may not be in the future. If the electronic
path accepted the notice first, the notice is left untouched and the item takes the notice's own date.

### D6 — Controls

- **Permissions** (new keys in `M23_PERMISSIONS`): `billing.dde.read`, `billing.dde.work`,
  `billing.dde.mark_submitted` (step-up required, like `billing.noe.submit`), `billing.dde.admin`.
  `record-submission` and `record-acceptance` both require `billing.dde.mark_submitted` plus a recent step-up;
  `record-outcome` (returned) needs `billing.dde.work`. **Granting `billing.dde.mark_submitted` is equivalent to
  conferring the notice's acceptance authority**: the holder can walk a ready NOE/NOTR to `ack_accepted` with no
  `billing.noe.*` permission, as an operator attestation (audited, step-up gated, date-bounded). Assigning an item
  requires an assignee who is an active member holding `billing.dde.work` whose provider-entity reach covers it.
- **Ownership:** an assigned item is worked by its assignee. Start, record-submission / -outcome / -acceptance, retry,
  cancel and close on an item assigned to someone else are refused (403) unless the caller holds `billing.dde.admin`
  over the item; an unassigned item has no owner. An admin who needs to hand work over reassigns it. (Found on the
  Docker stack: before this rule a second eligible worker could start another member's item.)
- **ABAC:** the `provider_entity_billing_scope` predicate, as other M23 filing actions. **The list is scoped too**
  (decided 2026-10): `GET /dde-items` returns only items of provider entities the actor may reach, by the same rule
  (`billingScopeReach`: org-wide billing roles and the system principal see the organization; anyone else only their
  `providerEntityIds`; no reach means nothing), applied in the repository query so cursors and pages stay correct.
  An explicit `providerEntityId` filter outside the reach returns an empty page. Counts and the overdue / at-risk
  summaries are computed in the client from the loaded (scoped) page; there is no separate aggregate endpoint.
- **Tenancy:** org-scoped table, three-column rule, RLS ENABLED and FORCEd.
- **Audit:** every state change writes an audit event; reads are read-audited with a `resourceIdParam`.
- **Events:** `m23.dde_item.*` outbox events carry ids, type, state and codes only — no notes, no names.
- **Separation of duties:** preparer and submitter may be the same user in v1; a tenant policy flag is
  deferred (open question).

### D7 — PHI and MBI rules

- **No MBI is stored.** The queue never holds, displays or logs an MBI. The operator obtains identity
  from the M5 patient chart under existing reveal controls; this ADR does not extend the M23-only
  `MbiUnlockReader` seam.
- DCN/ICN/receipt numbers and RTP reason codes are stored; free-text `notes` are capped, never copied
  into events or logs, and rejected when they match the MBI format. The screen is best-effort (NFKD, marks and non-alphanumerics stripped, non-ASCII lookalikes treated as wildcards of their own kind) and has one known, accepted gap: a non-ASCII *letter* standing in for a *digit* (Cyrillic Ze for 3, Che for 4) is not caught, because allowing letter wildcards at digit positions would flag ordinary non-Latin prose. It guards against accidents, not against a determined attempt to hide an identifier.
- Attachments, if added later, go through M22 with its access controls rather than the queue table.

### D8 — Data shape (illustrative)

`dde_work_item`: id, organization_id, provider_entity_id, patient_id, item_type, subject_kind,
subject_id, state, attempt_number, assignee_membership_id, priority, deadline_at, submitted_at,
mac_accepted_on, dcn, rtp_reason_code, outcome_code, notes, version, timestamps.
`dde_work_event`: append-only history (from/to state, actor, at, PHI-free detail).
Non-partitioned; retention class `compliance`.

## Consequences

- A DDE submission path exists even if the clearinghouse (Stedi) cannot route hospice NOE/NOTR or
  adjustments; the queue stands alone and is not gated on Stedi answers.
- `payer_status_date_source` gains `dde_manual`; mirrors in `packages/db/src/enums.ts`, `packages/types`
  and the manifest (`.ts` and `.cjs`) must be updated with the migration.
- The NOE/NOTR watchdog crons gain a second duty: create queue items for at-risk notices and RTP
  follow-up.
- The UI spec's NOE Submission Manager is updated when the screen is built (Phase 2).
- Acceptance dates are operator-attested; the audit trail records who attested what and when.

## Open questions

1. Tenant-level separation of duties (preparer ≠ submitter)?
2. Attachment handling via M22 for ADR responses?
3. SLA/priority model beyond deadline (e.g. ADR response due dates from the MAC letter)?
4. Does the Stedi answer to question 3 move any adjustment/cancel work back to the electronic path?
