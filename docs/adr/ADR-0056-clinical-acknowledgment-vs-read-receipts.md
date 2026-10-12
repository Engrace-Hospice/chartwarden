# ADR-0056 — Clinical acknowledgment is its own aggregate (acknowledgment request + append-only events), distinct from delivery and read receipts; deadlines are per-urgency defaults a tenant may only tighten

- **Status:** **Proposed** — needs product-owner acceptance **and clinical-lead sign-off of the deadline numbers** (decision D4)
  before Phase 4 ships. Drafted in Phase 0.
- **Date:** 2026-10-11
- **Phase:** Messaging Hub Phase 4 (WP 4.1, 4.2, 4.4, 4.5, 4.6); the `ack` retirement (WP 1.6/1.9) lands in Phase 1.
- **Extends:** M36 spec §3.4 (`message_receipt`). Resolves audit F7.
- **Related:** ADR-0057 (escalation ownership; this ADR owns request/ack state, that one owns who is paged),
  ADR-0055 (an ack binds to a message revision), ADR-0054 (realtime hints),
  [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md).


## Context

- Audit F7: `message_receipt.status = 'ack'` exists as `MessageReceiptStatus = "delivered" | "read" | "ack"`
  (`packages/messaging/src/interfaces/kinds.ts`) **and** as the Postgres enum `message_receipt_status` in
  `packages/db/src/enums.ts` (`["delivered","read","ack"]`). Nothing writes `ack`. `message_receipt` is unique per
  `(message_id, user_id)` (`packages/db/src/schema/messaging/message-receipts.ts`), so it can hold one status per recipient and
  cannot express a deadline, an assignee, a reassignment, or an escalation. Read receipts are written via `/messages/:id/read`.
- A separate table, `alert_receipt`, is inbox state for alerts (one row per alert x recipient), unrelated to clinical
  acknowledgment. The word "acknowledged" must not be reachable from either.
- Plan invariant 6 (`02-architecture-and-domain.md` §1): delivery, push-sent, read and acknowledged are four distinct records.
- Hazards to control (`05` §4): H-01 (urgent treated as delivered when only pushed), H-02 (wrong recipient), H-09 (duplicate
  escalation/ack on retries).
- Precedent for tighten-only: migration `0334_m36_alert_rule_locked_tighten_only.sql` and the `tenant_alert_routing_override`
  table (`packages/db/src/schema/messaging/tenant-alert-routing-override.ts`) enforce "tenants may raise severity or add channels,
  never loosen" in the database.
- M19 already has escalation concepts, but for **triage calls** (`triage_escalation`, five tiers, per-tier SLA); see ADR-0057.

## Decision

1. **New aggregate.** `message_acknowledgment_request` (one per ack-required message revision) and `message_acknowledgment_event`
   (append-only), as sketched in `02` §4 Phase 4. Request columns: `message_id`, `message_revision_no`, `patient_id`,
   `assigned_user_id` or `required_role`, `urgency`, `requested_at` (never changes), `deadline_at`, `status`, `current_tier`,
   `resolved_at`, `resolution_note_ref`. Events: `requested`, `delivered`, `opened`, `acknowledged`, `overdue`, `escalated(tier)`,
   `reassigned`, `resolved`, `cancelled`, `delivery_failed`. Three-column rule, RLS FORCE, PHI write-audit trigger; events are
   `SELECT, INSERT` only for `wardenx_app`.
2. **State machine** (authoritative; matches `02` §5):
   `pending -> acknowledged -> resolved`; `pending -> escalated(tier n) -> acknowledged`; `acknowledged -> pending` on reassign
   (new assignee, new deadline, same `requested_at`); `pending|escalated -> failed_unreachable` when tiers are exhausted or every
   route to the current tier failed; `pending|escalated -> cancelled` (sender withdraws, patient discharged with reassignment
   rules, message deleted by policy). Terminal: `resolved`, `cancelled`. `failed_unreachable` is never terminal in effect: it
   creates a supervisor work item and an ops page and stays open until a human resolves or reassigns it.
3. **Acknowledgment is an explicit authenticated action.** `POST /escalations/:id/acknowledge` by a user who (a) holds an eligible
   role (item 5), (b) has current patient access (care team/caseload ABAC), and (c) is the assignee or a member of the required
   role/on-call set. Opening a message, a read receipt, a reaction, a push tap, or a deep-link open never acknowledges. The UI gives
   Ack a control that no reaction or read affordance shares.
4. **Receipts stay receipts.** `message_receipt` keeps `delivered` and `read` only. Retire `ack`: remove it from the TypeScript
   union now (nothing writes it). In Postgres an enum value cannot be dropped cleanly; add a CHECK `status <> 'ack'` on
   `message_receipt` (or rebuild the enum in a later migration if the team prefers). Document `ack` != clinical acknowledgment in
   the receipts module comment.
5. **Eligible roles** (from `05` §2, tenant may only narrow): the assigned clinician with a qualified role - acknowledges;
   team lead / clinical lead - if qualified for the required role; org admin - only if also clinically qualified (no implicit
   right); hospice aide - **receipt only**, may *raise* an urgent escalation but cannot acknowledge responsibility; compliance -
   cannot acknowledge. "Qualified" means the role set configured per `required_role`; the concrete role-to-qualification map is
   an open item for the clinical lead.
6. **Deadlines (D4).** Per-urgency platform defaults and maxima; a tenant may **shorten** any value but never exceed the platform
   maximum or disable Critical. Enforced by a database trigger and audited on every change (same mechanism and test style as
   migration 0334). Numbers are **proposed defaults pending clinical-lead sign-off**:

   | Urgency | Initial ack deadline (default) | Platform max | Next tiers | First delivery |
   |---|---|---|---|---|
   | Important | 60 min | 120 min | each tier gets half the previous window (30, 15 ...), floor 5 min | in-app + push |
   | Urgent | 15 min | 30 min | 7 -> 5 -> 5 min (floor 5) | in-app + push, SMS (no PHI) after 5 min with no open |
   | Critical symptom | 5 min | 10 min | 3 -> 2 -> 2 min | all configured channels at once, voice allowed per M36 rule, supervisor copied at tier 2 |

   Rules: quiet hours never delay Urgent or Critical; a reassign restarts the window for the new assignee but keeps the original
   `requested_at` for reporting; tier timing is read from M19's escalation configuration where it defines one (ADR-0057) and M36
   keeps no second copy; the tenant cannot disable Critical escalation.

   **Overlap with M19 (D6, decided 2026-10-11 by the product owner):** the two clocks have different scopes. D4 governs the
   **message** acknowledgment clock; M19 tier SLAs (`TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES`) stay as they are for **triage calls**
   and are not changed by this ADR. When a message escalates through M19, the **stricter (smaller) of the two deadlines applies**.
   Neither is ever loosened. See ADR-0057.
7. **Urgency vocabulary.** The plan's `message.urgency` enum is `routine | important | urgent` (`02` §4 Phase 1) but the policy
   table has a third *ack* class, "Critical symptom". Decision: model the ack class on the request (`ack_class`:
   `important | urgent | critical_symptom`) and let the composer's "Urgent clinical" mode with the *critical symptom* checkbox set
   it; do not add a fourth message urgency.

   **Critical class (D7, decided 2026-10-11 by the product owner):** `critical_symptom` **does ship**, as an `ack_class` value (not
   a message urgency). Critical uses all configured channels at once (table in item 6). The compose and thread UI carry a
   **permanent "not the emergency path" notice** wherever the Critical class can be chosen or is shown; the notice cannot be
   dismissed or disabled by a tenant. Which roles may raise or acknowledge Critical is **not decided**: the clinical lead signs
   off the eligible roles (Open questions).
8. **Timers are durable and idempotent.** BullMQ job per `(request_id, tier)` with a deduplication id; the handler re-reads the
   request under `FOR UPDATE` and does nothing if it is no longer `pending|escalated` at that tier (same pattern as the M19 SLA
   cron's lock-and-recheck in `apps/backend/src/modules/19-oncall/jobs/escalation-sla.ts`). Queue names must pass `arch:queue-names`
   (declared by exactly one module). A duplicate job or restart yields exactly one escalation.
9. **No order from chat.** The ack aggregate has no link to M11/M12 and no endpoint that creates or changes an order, medication,
   care-plan change or chart note. A request's `resolution_note_ref` may point to the outcome record in the owning module (a chart
   promotion result or task), created in that module's own authenticated workflow. UI copy states messaging is not the emergency path
   (plan invariant 9).
10. **Binding to content.** The request binds to a message **revision** (ADR-0055). **Edit lock (D8, decided 2026-10-11 by the
    product owner):** a message that is urgent or has an acknowledgment request cannot be edited from the moment it is sent. A
    correction is a **new linked amendment message** (visible as an amendment), never an overwrite; the old request is cancelled or
    reassigned explicitly, or stays open on the unchanged original.
11. **Events.** `m36.ack_request.created.v1`, `.acknowledged.v1`, `.overdue.v1`, `.failed_unreachable.v1` registered in the event catalog
    under the `m36.` convention; consumers are idempotent. These are not yet in `apps/backend/src/modules/36-messaging/events-by-m36.ts`
    (which today carries `m36.message.mentioned` and `m36.notification.delivery_failed`).

## Alternatives considered

- **Reuse `message_receipt.ack`.** One row per `(message, user)` cannot hold deadlines, tiers or reassignment history, and it keeps
  the open/ack conflation one code path away. Rejected.
- **Reuse M19 `triage_escalation` for chat.** It is keyed to a `triage_call` and its tier model; forcing chat escalations through it
  couples two aggregates with different lifecycles. Rejected (ADR-0057 covers the seam instead).
- **Reuse `alert` + `alert_receipt`.** Alerts are system-originated and role-fanned; a clinician-to-clinician request needs an
  accountable named assignee and reassignment. Rejected; alerts remain the *delivery* mechanism.
- **Single flat tenant-configurable deadline (option A in the D4 discussion).** Rejected by decision D4 (B + C): a tenant could
  loosen safety timing.
- **Auto-acknowledge on read after N seconds.** Rejected: it recreates the exact hazard H-01.

## Consequences

- One more aggregate with timers; the unacknowledged-urgent queue (WP 4.9) reads it directly.
- Reporting can separate delivered, read and acknowledged latency. Analytics (Phase 6) must not use per-individual ack latency
  without HR/compliance review.
- Retiring `ack` is only a type/CHECK change; there is no data to migrate.
- Tenant tailoring is limited; a tenant that wants slower deadlines must go through the platform maximum review.

## Migration / rollout

1. Phase 1: remove `ack` from `MessageReceiptStatus`, add the CHECK, add a test that no code path labels a message acknowledged
   from open/read (WP 1.6).
2. Phase 4: tables and trigger migration (check `arch:migration-numbering` against `main`; mirror enums/tables into
   `packages/db/src/enums.ts`, `packages/types` and both manifests); routes with permission keys composed via `requireAbac`
   (`arch:abac-composed`); outbox events registered; queue declared once.
3. Ship behind a per-tenant feature flag; production clinical rollout needs the Phase 4 gate, the fallback runbook and a drill.

## Verification

- The six Phase 4 acceptance tests in `04`: open does not acknowledge; overdue -> backup tier without duplicates; quiet hours cannot
  suppress a safety route; no PHI on the lock screen; unreachable -> fallback event; shift and time-zone correctness.
- Live: unqualified role gets 403 on acknowledge; aide acknowledge attempt is refused but receipt works; tighten-only trigger
  rejects a longer-than-max or Critical-disable write and audits accepted changes; kill the worker mid-timer -> exactly one
  escalation after recovery; duplicate job -> no duplicate event; restart preserves `requested_at` across reassign.
- Chaos run (queue, push vendor, DB failover) before clinical go-live (`04` Phase 4 gate).
- Gates: `arch:tenancy`, `check-fitness-gaps`, `arch:outbox-bindings`, `arch:queue-names`, `arch:abac-composed`,
  `arch:manifest-mirror`, `arch:live-suites`.

## Open questions

- Clinical lead to approve the numbers above and the "half the previous window, floor 5 min" rule for Important (D4 sign-off).
- Clinical lead to sign off the **eligible roles** for the Critical class (D7), and the role-to-qualification map per
  `required_role` (RN only? RN or MD? on-call physician?).
- M19 owner for the `EscalationRouter` seam is still to be named (ADR-0057); the stricter-wins rule (D6) does not depend on the name.
- Reassign limits (how many times, who may reassign) and what happens to a request when its assignee is offboarded (plan Workflow F).

Resolved (Decided 2026-10-11 by the product owner): tier-timing conflict with M19, stricter deadline wins on overlap, M19 triage
SLAs untouched (D6); Critical ships as an `ack_class` with a permanent "not the emergency path" notice (D7); ack-bound or urgent
messages are edit-locked, corrections are linked amendments (D8).
