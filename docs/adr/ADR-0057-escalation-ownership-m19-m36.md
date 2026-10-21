# ADR-0057 — M19 owns on-call, tiers and triage escalation; M36 owns only acknowledgment-request state and timers and reaches M19 through one `EscalationRouter` seam

- **Status:** **Proposed** — the contract and a fail-closed stub ship in WP 4.3 (2026-10-15); a tier-1-only M19 router is built but UNBOUND by default (item 12); **OWNER NOT NAMED** (the human decision is still open) and tiers 2 and above are not served; tier-timing policy is decided (D6, 2026-10-11). Drafted in Phase 0.
- **Date:** 2026-10-11
- **Phase:** Messaging Hub Phase 4 (WP 4.3, 4.4, 4.5); the seam contract is a Phase 0 deliverable (plan WP 0.5).
- **Extends:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (seam interfaces live in `packages/types`; consumption needs no
  import edge), M19 spec §4.3 (seams) and §4.8 (crons).
- **Related:** ADR-0056 (the aggregate this seam serves), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no direct
  cross-module table access), [ADR-0009](ADR-0009-phase-dr-int-tier-discipline.md).


## Context

What M19 exposes today (verified):

- Seam `OnCallProvider` in `packages/types/src/oncall.ts` (about line 956): `currentOnCallActors(orgId, providerEntityId, asOfIso)` and
  `activeShiftsAt(orgId, asOfIso)`. Implemented in `apps/backend/src/modules/19-oncall/seams/providers.ts`. Its file header states the
  fail posture that matters here: `OnCallProvider` **propagates** store failures, because `[]` is a real, load-bearing answer
  ("nobody is covering"); a failure must not look like a coverage gap and silently swallow a 2 a.m. page, and the consumer is
  expected to take a degraded path.
- Escalation lifecycle: `apps/backend/src/modules/19-oncall/lifecycle/escalation.ts` (`acknowledgeEscalation`,
  `resolveEscalation`, `autoResolveOnCallClose`) over `triage_escalation`, which hangs off a **triage call** with five tiers
  (`TriageEscalationTier` in `packages/types/src/oncall.ts`: `tier_1_rn_supervisor` ... `tier_5_external`).
- Tier SLAs: cron `apps/backend/src/modules/19-oncall/jobs/escalation-sla.ts` reads
  `tenant_oncall_policy.escalation_tiers[tier].slaMinutes`, else `TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES` (15/30/15/60/15 min), and
  publishes `m19.triage_call.escalation_sla_breached`; M36 turns that into a page in
  `apps/backend/src/modules/36-messaging/outbox-consumers/oncall-alerts.ts`.
- M36 today consumes M19 only for channel membership (on-call rooms/channels) and alert fan-out. It has **no** way to ask "who is the
  accountable person for role R at time T for patient P, and who is tier n+1?".

Audit finding F12: no message-facing seam exists; "the `EscalationRouter` seam is net-new work on M19's side; scope it in the ADR
before WP 4.3". Plan anti-duplication rule: no second on-call table; if a field is missing, change M19 through its seam.

Caveat on facts: whether `tenant_oncall_policy.escalation_tiers` carries recipient role mappings sufficient to resolve a tier to
people without a triage call context, and how M19 maps tier to actors today, was **not traced** in Phase 0. The seam below is a
proposal; the M19 owner confirms or amends it.

## Decision

1. **Ownership.**
   - **M19 owns:** rosters and shifts, tier definitions and ordering, tier-to-recipient resolution, per-tier timing configuration,
     coverage-gap detection, the `triage_call` and `triage_escalation` lifecycle, and time-zone semantics of schedules.
   - **M36 owns:** the acknowledgment request, its events, its durable timers, delivery of notices (existing alert fan-out), the
     unacknowledged-urgent queue, and the supervisor work item for `failed_unreachable`.
2. **One seam, `EscalationRouter`,** declared in `packages/types` (ADR-0005), implemented by M19 under `19-oncall/seams/`, resolved by
   M36 through the M1 seam registry. Positional `orgId` first, treated as an assertion not a selector (M19 convention,
   `assertCallerOrg` / `TRIAGE_SEAM_ORG_MISMATCH`). Proposed shape (names are working names; final contract is WP 0.5):

   ```ts
   interface EscalationRouter {
     // Who is accountable now for this role/patient, and what does the ladder look like from here?
     resolveTier(orgId, req: { patientId; requiredRole; tier: number; asOfIso }): Promise<EscalationTierResolution>;
   }
   type EscalationTierResolution =
     | { kind: "resolved"; actors: readonly OnCallActor[]; tierAckWindowMinutes: number | null; hasNextTier: boolean }
     | { kind: "coverage_gap"; tier: number; hasNextTier: boolean };   // a real answer: nobody covers this tier now
   // A store/registry failure THROWS. It is never mapped to coverage_gap.
   ```

   Rules: pure read; no side effects in M19; evaluated in the schedule's time zone, not the server's; same `asOfIso` gives the same
   answer (so a replayed timer is idempotent); returns no PHI beyond ids.
3. **Net-new on the M19 side (F12).** Today's `OnCallProvider` answers "who is on call for provider entity X"; the ladder
   (tier n -> n+1 for a role) exists only inside the triage-call flow. M19 must (a) expose tier ordering and recipient resolution
   independent of an open `triage_call`, (b) expose the per-tier window when it defines one, and (c) state explicitly whether a chat
   ack request creates a `triage_escalation` row. **Decision: it does not.** A chat request creates nothing in M19; if the concern is a
   telephone-triage matter, the clinician uses M19's triage flow. M19 may later consume `m36.ack_request.failed_unreachable.v1` as an
   input to its coverage-gap watchdog; that is not part of this ADR.
4. **Timers stay in M36** (plan 4.4): durable BullMQ job per `(request_id, tier)`. On deadline M36 marks the request overdue, asks
   `resolveTier(tier + 1)`, delivers through the existing fan-out, and records the event. M36 does not poll M19's `escalation-sla`
   output and does not reuse `m19.triage_call.escalation_sla_breached` for chat requests.
5. **Failure behaviour (no silent loss).**
   - `coverage_gap` at the current tier: skip to the next tier immediately; if none remains -> `failed_unreachable`.
   - Seam throws: retry with bounded backoff, then deliver to a **configured fallback recipient** (tenant's clinical supervisor role)
     through the existing alert path and record `delivery_failed` with the cause; if even that fails -> `failed_unreachable`.
   - All delivery routes to the current tier failed (existing `m36.notification.delivery_failed` event): advance without waiting for
     the deadline.
   - `failed_unreachable`: creates a supervisor work item and an ops page, appears in the unacknowledged-urgent queue, and stays open
     until a human resolves or reassigns. Every transition is an append-only event. A request must never end with no open owner.
6. **Tenant tightening only** applies to timing (ADR-0056), not to who is on call; M36 never overrides M19's roster.
7. **What M36 must not build:** an on-call schedule, roster or rotation table; tier definitions or a tier-to-person map; a copy of M19
   SLA numbers; its own time-zone or shift-boundary logic; any write into `triage_call` / `triage_escalation` / `on_call_shift`;
   a direct DB read of M19 tables (ADR-0011); a vendor paging integration for escalation (existing M36 delivery covers it).
8. **Events.** M36 emits `m36.ack_request.overdue.v1` and `m36.ack_request.failed_unreachable.v1` (ADR-0056). M36 consumes
   `m19.oncall_shift.activated` / `completed` / `coverage_gap` (already in `events-by-m19.ts`) only to re-evaluate pending requests
   whose current tier's roster changed; those bindings must pass `arch:outbox-bindings` and be wired in `apps/backend/src/index.ts`.

9. **Deadline overlap (D6, decided 2026-10-11 by the product owner).** The scopes differ: D4 (ADR-0056) governs the **message**
   acknowledgment clock; M19 tier SLAs stay as-is for **triage calls**, including their defaults
   (`TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES`). When a message escalates through M19, the **smaller (stricter) of the two applies**.
   Neither is ever loosened by the other; the seam's `tierAckWindowMinutes` is an upper bound for M36, never a way to extend a D4
   window.
10. **Critical class (D7, decided 2026-10-11 by the product owner).** Critical is modelled as `ack_class = critical_symptom`
    (ADR-0056 item 7) with a permanent "not the emergency path" UI notice. The router treats it like any other class; it adds no
    new M19 behaviour. The owner of the M19 side of this seam is still to be named.

11. **WP 4.3 delivery (2026-10-15): the contract and a deny-stub, not a router.** With no M19 owner, 4.3 ships only what M36 can own:
    - **Contract** in `packages/types/src/messaging-escalation.ts`, refining the working shape above. `resolveTier(orgId, { patientId,
      requiredRole, tier, asOf })` answers one of `resolved` (`userIds`, `nextTier` or null, the schedule's IANA `timeZone`), `coverage_gap`
      (the tier exists, nobody covers it at `asOf`; `nextTier`) or `unavailable` (`router_not_bound`, `no_route_configured`). Every answer
      echoes `tier` and `asOf` and carries `source` (`m19`, `deny_stub`, `in_memory_fake`). Ids only. `orgId` stays positional and first. The
      earlier `OnCallActor[]` and `tierAckWindowMinutes` are not in the contract: actors are ids (M36 resolves display data itself under
      its own authorization) and the per-tier window is deferred to the owner conversation (see "What M19 must provide").
    - **Seam `EscalationRouter`** (owner module 19, `phi: false`) in the M1 registry (`REQUIRED_SEAMS`, `SeamName`, `SeamContracts`). Its
      deny-stub does **not** throw (unlike `OnCallProvider`'s): it answers `unavailable` / `router_not_bound` / `source: "deny_stub"`, so a
      caller gets a typed "cannot route" to surface and can never read the stub as `coverage_gap`, an empty list or "nobody needed". A
      real store failure in a bound router still throws (item 5 is unchanged).
    - **M36 only resolves it**, through `getEscalationRouter()` in `36-messaging/seams.ts`; M36 never registers an implementation. A
      backend test fails the build if production code imports the in-memory router, registers one from M36, or resolves the seam any
      other way.
    - **Shift semantics, tested in `packages/messaging`** (`shift-window.ts`, reference for M19): windows are wall-clock in the
      schedule's zone, start inclusive and end exclusive, a window ending at or before its start crosses midnight and its weekday is the
      start day. Spring-forward: a start in the skipped hour begins at the first instant after the gap. Fall-back: the repeated hour is
      inside a window spanning it on both passes. Adjacent windows never gap or overlap. An unknown zone throws; there is no server-zone
      fallback. A test-only in-memory router (`source: "in_memory_fake"`) runs the contract over these rules to prove the shift-boundary
      and time-zone acceptance.
    - **Request validation (review fixes).** `asOf` must be a full ISO-8601 date-time with an explicit offset (`Z` or `+hh:mm`), at most
      40 characters; an offset-less or loose string is refused (never read in the server's zone). `tier` is a safe integer 1..99. A
      resolved answer's `userIds` is a non-empty tuple. A tier the role's ladder does not have is `unavailable` / `tier_not_configured`,
      never `coverage_gap` (a gap strictly means "the tier exists, nobody covers `asOf`"); `nextTier` is `tier + 1` when that tier exists,
      else null; the fake requires contiguous tiers from 1. The answer's `timeZone` is the covering rotation's zone (the tier's first
      rotation's zone for a gap). The whole schedule is validated up front (`validateShiftSchedule`).
    - **Fall-back double handoff.** Because the rule is wall-clock, a handoff at a time inside the repeated fall-back hour happens twice
      as elapsed time runs (A, B, A, B for a 01:30 handoff on 2026-11-01 in New York; a test documents it). WP 4.4 must not re-evaluate
      the router at later instants to decide who owns a request already routed: it records the resolved tier and assignee on the request
      and keys idempotency on the request, not on the clock.
    - **Org and patient checks are M19's.** The implementation MUST enforce `orgId` against the request context and MUST verify
      `patientId` belongs to `orgId`; the in-memory fake enforces only the org it was built for. `getEscalationRouter()` is the raw seam
      with no wrapper; WP 4.4 adds an org-checking wrapper (and a boot report that the router is still the stub; no such warning pattern
      exists for other stubs today) before any worker passes an org read from an event payload.
    - **Fake not on the barrel.** The in-memory router is reachable only at `@chartwarden/messaging/testing/in-memory-escalation-router`.
    - **No M36 timer, caller, table, route, event or flag change.** Wiring the router into timers is WP 4.4.
      **As built in WP 4.4 ([ADR-0070](ADR-0070-messaging-escalation-timers.md)):** the timers call the router through `guardEscalationRouter` (the org-checking wrapper above; `getEscalationRouter()` itself stays the raw registry entry), record the resolved tier and assignee on the request (migration 1114 lets the timer move the assignee) and key idempotency on the request, its tier and its window, never on the clock. The contract is unchanged. Today every answer is the deny-stub's `unavailable`, which the timer surfaces (a history row, an event and a generic in-app alert, the request left open) and retries each minute; the fallback recipient and `failed_unreachable` of item 5 are WP 4.5.

12. **Tier-1 M19 router, built UNBOUND (2026-10-19).** `apps/backend/src/modules/19-oncall/seams/escalation-router.ts` (`createEscalationRouter`) answers `resolveTier` from M19's own roster. **This is an implementation of the proposal, not an owner's acceptance: OWNER NOT NAMED.** Nobody has confirmed the ladder semantics below; that decision is still open and nothing in this item names or implies an owner.
    - **What it serves: tier 1 only.** The covering `on_call_shift` of the patient's provider entity (status `scheduled` or `active`, discipline from the role map, window `[start, end)` over absolute instants compared in epoch ms): `userIds` = per covering shift the primary membership's user id then the backup's (first occurrence wins; the order is for the escalation walk and carries no rank; M36's walk takes the first that is qualified AND can view the request's channel, ADR-0070 limit i, so a primary who is not in the channel is skipped to the backup), `ranks` = the explicit `primary` / `backup` of each `userIds[i]` taken from the shift columns (`primary_on_call_membership_id` / `backup_membership_id`; additive and optional on the seam, ADR-0081 decision 4: a user primary on any covering shift is `primary`, overlapping shifts keep each person's own rank, and a primary seat that does not resolve promotes nobody), `nextTier: null`, `source: "m19"`. Memberships whose user does not resolve, or whose membership is not `active` or is revoked (a departed person), are dropped (M36's `stillQualified` remains the consumer-side check); if every one is dropped (or no shift covers) the answer is `coverage_gap`, never an empty `resolved`. Vendor (`externalActorId`) shifts name no user id and never produce one.
    - **Tiers 2 and above are NOT served** (`unavailable / tier_not_configured`, `nextTier` null; M36 reads it as `ladder_exhausted`). `tenant_oncall_policy.escalation_tiers` is a free `jsonb` that the SLA cron reads only for `slaMinutes`; its recipient shape for a chat request was never defined, and the router does not invent one. Serving tier 2 needs an owner to define that shape (who, in which role, from which roster) and then an additive change here.
    - **Role map** (`ESCALATION_DISCIPLINE_BY_ROLE`, tested): `rn` -> shift discipline `clinical_rn` (the `oncall_shift_discipline` enum is `clinical_rn | clinical_lpn | medical_director | msw | chaplain | external`; M36 sends only `rn`). An unknown role is `no_route_configured` (fail closed, including prototype-key strings).
    - **Patient -> provider entity** through M5's `PatientReader.findById` (merge-redirect resolved there; `patient.provider_entity_id` is nullable). The patient must belong to `orgId`. A patient that is unknown, in another org, or not a uuid answers `no_route_configured`, the same as any other refusal. A patient found with no provider entity uses the org's provider entity only if the org has exactly one; otherwise `no_route_configured` (never a guess).
    - **`coverage_gap` only where M19 has promised coverage:** the provider entity needs a `tenant_oncall_policy` row with model `direct` or `hybrid` (the coverage-gap watchdog's rule: no policy means no promise to break; `centralized` is vendor-covered with no RN shifts by design) AND exactly one known IANA zone across its locations (`providerEntityTimezones`). Otherwise `unavailable / no_route_configured` rather than a gap or a wrong zone. `timeZone` is that location zone and is informational: shifts are absolute instants, so the zone never moves a boundary (the repeated New York hour of 2026-11-01 is two different instants, hence two different shifts, deterministically).
    - **Order of refusals leaks nothing:** role mapping and tier are decided before any patient read, so tier 2 and an unknown role answer identically for every patient; a patient from another org and a nonexistent patient answer identically (timing differs; the router reads no chart data, so a restricted patient reveals only the provider entity's roster).
    - **Org and failure rules:** `assertCallerOrg` first (it only protects non-system callers: on the M36 timer path the ambient org equals the passed org, so isolation rests on M36 taking `orgId` from the DB row plus RLS), plus an empty ambient org is refused (this seam resolves a patient by id, so it must be scoped). A malformed request (offset-less `asOf`, tier outside 1..99, empty patient or role) THROWS, like the in-memory fake. A store, reader or RLS failure THROWS and is never mapped to `coverage_gap` or `unavailable`. Pure read: no write, no outbox, no new table or migration.
    - **Binding is OFF by default.** `registerOncallSeams` does not register it. `ESCALATION_ROUTER_ORGS` (comma-separated organization uuids, OPTIONAL, empty in `.env.example`) registers a wrapper over the boot deny-stub: an org on the list gets the real router, every other org gets the deny-stub's exact answer (`unavailable / router_not_bound`, `source: "deny_stub"`). Entries that are not uuids are ignored and counted in a boot warning (values are never logged). A non-empty list logs one boot warning with the count of bound orgs and that every other org still gets the deny-stub (never org ids). The fallback is the boot deny-stub itself, because the registration runs before the registry is validated. With the variable empty or unset nothing is registered and behaviour, including the boot-probe warning, is identical to before.
    - **Proposals for the owner brief's open decisions (NOT decided, NOT built unless stated):**
      - *Decision 3, role-level lookup without a patient:* not offered. The contract requires `patientId`, and a patient is how the router finds the provider entity (the unit that holds shifts, policy and zone). A role-only lookup would need a provider-entity argument; propose adding it only if a caller without a patient appears.
      - *Decision 4, fallback recipient when the seam is down or cannot route:* PROPOSAL only, NOT built: `tenant_oncall_policy.emergency_contact_e164` (an existing M19 column), platform-fixed behaviour (not tenant-tunable), delivered through the existing alert path as ADR-0057 item 5 already describes. M36 does not read it today; WP 4.5's supervisor attention alert (ADR-0079) remains the only fallback in the build.
      - *Decision 5, `failed_unreachable` feeding the coverage-gap watchdog:* PROPOSAL: yes, as a read-only input to the watchdog's existing event, in a separate change that touches Tier-1 behaviour. NOT built here and M19 triage behaviour is untouched.
    - **Verified at build time:** the discipline enum, the nullable `patient.provider_entity_id`, `PatientReader.findById`, the site reader's zone read, and M19's `dependsOn` allowing the `@chartwarden/messaging` import for the shared strict-instant parser. Not verified: any real roster (no tenant is bound), the clinical meaning of tier 1 as "the on-call RN of the patient's provider entity" (an assumption an owner must confirm), and tier-2 recipients.

## What M19 must provide (when an owner is named)

- A real `EscalationRouter` registered over the stub from M19's own init (`registerSeam("EscalationRouter", ...)`), stamping
  `source: "m19"`, reading its own roster and tier config, with the `orgId` assertion (`assertCallerOrg`) and a store failure that throws.
- For each (org, role, tier): the user ids covering `asOf`, whether a tier n+1 exists, and the **IANA zone of the schedule** the shift
  was read in. Shift boundaries follow the rules in item 11 (it may reuse `shift-window.ts` or must pass the same cases).
- Answers for a role with no triage call and for a patient-scoped lookup; if M19 cannot resolve role-level tiers without a triage
  call, say so (open question below), because the contract then needs a field.
- Optional, deferred: the per-tier ack window (`tierAckWindowMinutes`). Adding it later is an additive contract change under this ADR.
- No new M19 table is expected; if a field is missing, extend M19's seam (this ADR), never a parallel roster in M36.

## Accepted limits (WP 4.3)

- Until an org is on the `ESCALATION_ROUTER_ORGS` allowlist (item 12; empty by default) every call answers `unavailable`; escalation cannot route and the flags `messaging.urgent_clinical` and
  `messaging.ack_requests` stay off.
- The shift rule is wall-clock based: in a fall-back hour a window ending inside the repeated hour covers both passes, and a window
  starting in the spring-forward gap starts after it. M19 may differ only by agreeing a documented alternative here.
- Patient-level overrides of the ladder are not modelled in the contract beyond carrying `patientId`; M19 decides what it does with it.
- The in-memory router is a test fixture, not a roster; it has its own subpath export (not the barrel) and a test scanning `apps/` and
  `packages/` guards production against using it.
- The deny-stub does not validate: a malformed request also gets `unavailable` from it.

## Alternatives considered

- **M36 reads M19 tables or keeps a roster copy.** Fastest, but a parallel roster drifts, violates ADR-0011 and the plan's
  anti-duplication rule. Rejected.
- **Route chat escalations through M19 `triage_escalation`.** Single escalation system, but its rows hang off a `triage_call`
  (different identity, cron and SLA semantics, `external_vendor` tier). Chat requests would need synthetic calls. Rejected.
- **M19 owns the timers too.** Cleaner conceptually, but ack state and deadlines live with the message and its delivery results;
  splitting timers from state creates a two-system race. Rejected for now; revisit if M19 gets a generic work-timer service.
- **M36 consumes only M19 events (no synchronous seam).** Cannot answer "who is tier n+1 right now" at deadline time, and
  roster state would be stale. Rejected.
- **Do nothing; reuse `OnCallProvider.currentOnCallActors` only.** Gives first-tier recipients but no ladder, so there is no
  backup routing, which is the safety core. Rejected.

## Consequences

- M19 gains a new public seam (a cross-team contract and a test burden on a Tier-1 module). Work in M19 precedes WP 4.3.
- Two timing sources can disagree (M19 per-tier SLAs vs D4's windows). The seam returns M19's window when it has one; M36 applies
  the stricter of the two (item 9, D6).
- M36 availability for escalation depends on the seam's fail posture; the explicit fallback keeps a seam outage from becoming silence.
- A chat request and a triage escalation about the same patient can coexist; no automatic merge exists.

## Migration / rollout

1. Phase 0: write the `EscalationRouter` contract (WP 0.5) with the M19 owner; add the interface to `packages/types` and a deny-stub
   that **throws** (not `[]`) in the registry until bound.
2. M19 implements the seam and its unit/live tests; manifest `dependsOn`/seams updated in `.ts` and `.cjs` mirrors.
3. M36 consumes it in Phase 4 behind the per-tenant flag; chaos test the seam outage before clinical go-live.

## Verification

- Seam contract tests (both sides): same-input same-output across a shift boundary and a time-zone boundary (schedule zone, not
  server zone); cross-org call refused; store failure throws and is **not** a coverage gap (mirrors the M19 provider tests).
- M36 live: coverage gap at tier 1 advances to tier 2; seam throw -> fallback recipient + event; all routes failed -> immediate
  advance; exhausted -> `failed_unreachable` with a supervisor item and an ops page; kill worker mid-timer -> one escalation.
- Architecture: no import from M36 into M19 internals; `arch:fitness` (dependency-cruiser, `arch:manifest-mirror`),
  `arch:outbox-bindings` for the consumed `m19.*` events, grep of `apps/backend/src/index.ts` for the consumer factory.
- Drill: quarterly tabletop and live drill per `docs/runbooks/messaging-escalation-fallback.md` (WP 4.11; file does not exist yet).

## Open questions

- **Named M19 owner** and the date M19 can deliver the seam. OPEN: the human decision is not made. A tier-1 router exists (item 12) but is unbound by default and no owner has accepted it.
- Does tier-to-recipient resolution in M19 work without a triage call and without a `patientId` (role-level only)?
- Fallback recipient when the seam is down: which role, and is it tenant-configured or platform-fixed? (Proposal in item 12, not built.)
- Should `failed_unreachable` feed M19's coverage-gap watchdog (cross-module, small, but touches Tier-1 behaviour)? Proposal in item 12, not built.
- What do tiers 2 and above mean for a chat request (who, which role, from which roster), and what shape does `tenant_oncall_policy.escalation_tiers` take? Until an owner answers, they are `tier_not_configured`.

Resolved (Decided 2026-10-11 by the product owner): whose timing wins, the stricter deadline on overlap with M19 triage SLAs
untouched (D6, item 9); Critical ships as an `ack_class` with a permanent "not the emergency path" notice (D7, item 10). The M19
owner name remains the one open ownership item.
