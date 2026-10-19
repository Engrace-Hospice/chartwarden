# ADR-0080 — A read-only on-call "who is covering now" directory over the EscalationRouter seam; role-based send is an open decision and is not built

- **Status:** **Proposed** (2026-10-19). The read-only directory is built behind a tenant flag that is off for every tenant. **OPEN for the clinical lead: who may see the directory, and the wording. OPEN and not built: addressing a role ("message the on-call RN"), see decision 6.** The real M19 router and a named M19 owner are still missing ([ADR-0057](ADR-0057-escalation-ownership-m19-m36.md), `docs/messaging-hub/brief-m19-owner.md`), so on `main` the directory answers "roster not connected" until M19 binds one.
- **Date:** 2026-10-19
- **Phase:** Messaging Hub Phase 4, WP 4.12 (proposed row of `docs/messaging-hub/10-ui-spec-phases-4-to-6.md`), the read-only half only.
- **Implements:** the "who do I call right now" half of 4.12: `GET /api/v1/messaging/oncall/coverage` and the `/messaging/on-call` screen.
- **Extends:** [ADR-0057](ADR-0057-escalation-ownership-m19-m36.md) (the `EscalationRouter` seam; M19 owns rosters, tiers and time-zone rules), [ADR-0070](ADR-0070-messaging-escalation-timers.md) (the org-checking guard around the raw seam).
- **Related:** [ADR-0069](ADR-0069-messaging-acknowledgment-request-aggregate.md), [ADR-0010](ADR-0010-tenancy-rls-invariants.md).
- **Numbering note:** 0079 is used by the in-flight `feat/m36-gaps-b-watch` branch; this ADR takes the next free number, 0080.

## Context

Checked in the code, not assumed:

- M36 reaches M19 only through `getEscalationRouter()` (`EscalationRouter.resolveTier(orgId, { patientId, requiredRole, tier, asOf })`). The registered default is the fail-closed **deny-stub**, which answers `unavailable` / `router_not_bound` with `source: "deny_stub"`. No M19 router is bound in `apps/backend/src/index.ts`; M19's `OnCallProvider` (actors for a provider entity, active shifts) is a different seam that M36 does not consume for escalation.
- The seam answers **user ids only**, the roster's IANA time zone, and `nextTier`. It has no shift end and no display name. It is patient-scoped: a roster is asked about "this patient's team".
- An org member's display name is available through the existing org-scoped lookup `createMentionActorNameResolver`.
- `source: "in_memory_fake"` is test-only and a guard test forbids production code from naming it.

## Decisions

1. **One read route.** `GET /api/v1/messaging/oncall/coverage?role&patient_id`, permissions `messaging.read` and the **new** `messaging.oncall.read`, **plus the chart-read gate on `patient_id`** (decision 8). The org and the caller come from the request context. `role` is a closed list (`rn`, `physician`), `patient_id` a uuid, any other key a 422. The tenant flag `messaging.oncall_directory` off is the uniform 404, decided in the service before the router is asked. Responses are `Cache-Control: no-store`.
2. **It asks the existing seam, through the existing guard.** Tier 1, then `nextTier` while it is non-null, at most 4 tiers, as of the server clock, through `guardEscalationRouter` (which refuses a test source or a malformed answer). A router failure **propagates**; it is never turned into a gap. M19 remains the only owner of rosters; no roster is copied and no table is added.
3. **Four honest statuses, never an empty list.** `covered`; `coverage_gap` (the ladder has the tier and nobody covers it now); `roster_not_connected` (the deny-stub answered: coverage is **unknown**, and the screen says to use the telephone procedure); `not_configured` (M19 has no ladder for the role).
4. **Names and roles only.** The response carries display names (null when a name cannot be found), enums, instants and the roster's zone. It carries no user id, no contact detail and no patient data; the patient id only selects the team and is not echoed. The response itself holds no patient data, but the call discloses a patient-to-clinician association, so it is read-audited against `patient_id` (see decision 8).
5. **Time-zone-correct times.** The screen renders `as_of` and the shift end in the **roster's** zone (`time_zone` from the router's answer), with the zone abbreviation, never the viewer's or the server's. An unknown zone is said in words, not guessed. A shift end is shown only when the roster supplied one: the contract gains an **optional** `shiftEndsAt` on `EscalationResolved` (an additive field); the service drops a value that is not a real instant after `asOf`. Until M19 supplies it the screen says "Shift end not provided"; it never infers one.
6. **Role-based send is NOT part of this ADR and is an open decision; it is proposed and built flag-off in [ADR-0081](ADR-0081-messaging-role-send.md), which carries the open clinical-lead questions.** The rest of this decision is the reasoning that ADR answers. Letting a sender address a role ("on-call RN"), resolved by the server at send time, changes **who is paged** and who is accountable for a clinical message. It needs (a) a clinical-lead decision on who may be addressed by role and how the sender confirms the resolved person (hazard H-02), (b) a decision on mid-compose shift changes and the stored request (role plus resolved person), (c) a real M19 router, and (d) its own ADR superseding this one on that point. This slice has no Message, Page or Urgent control.
7. **Permission.** `messaging.oncall.read` (resource `oncall_directory`, action `read`, category `clinical`, no ABAC), registered in `M36_CONTRIBUTED_PERMISSIONS` and mirrored by migration `1128_m36_oncall_directory_permission.sql`, which grants it to every tenant role that already holds `messaging.read` (a directory of who to call is an everyday clinical-staff need, and the route requires both keys). It is not in `FULL_CATALOG_EXCLUDED_KEYS`, so the full-catalog admin roles receive it. PROVISIONAL until the clinical lead signs the role map; a tenant tightens by removing the grant from a role it owns.

8. **Patient visibility gate and audit (security review).** `patient_id` selects a patient's care team, so the route applies the same gate as the chart `care_team` tile: `patient.read` plus the `caseload_or_scope` ABAC predicate on `patient_id` (no break-glass). A patient the caller cannot see, or one outside the organisation, is the uniform 404 and the router is never asked; a malformed query is a 422 before the gate. The read is audited against the patient (`patientIdQueryParam`, resource kind `oncall_coverage`), and a route test asserts the audit row lands. This supersedes the earlier waiver and closes the org-scope finding; the real M19 router must still refuse a cross-org patient (defence in depth).

9. **Existence check after the scope gate (live finding).** Verified against a real database: `caseload_or_scope` returns true for ANY well-formed uuid when the caller holds an org-wide scope role (for example `medical_director` or `compliance_officer`), so a nonexistent or other-organisation `patient_id` answered 200 and wrote a read-audit row against a non-patient id. The route now also runs an org-scoped existence check (`patientExists`, over M5's `PatientReader` seam, under RLS) as the last preHandler. A missing or other-organisation patient throws the identical `NotFoundError("resource")` the scope gate throws, so the two cannot be told apart. Because every check is a preHandler, a refusal never reaches the router and never writes an audit row (the read audit runs only on a successful response). Proven by a route test over the REAL `caseload_or_scope` predicate and by a live run on a private database.

## Open items

- **Patient scope.** The seam is patient-scoped, so the screen is entered with `?patient=<uuid>` from a patient's care team and shows an explanation without one. An organisation-wide "who is on call" view needs a router contract change (a patient-less query) owned by M19.
- **Real router.** Until a named M19 owner binds one, the directory reports "roster not connected". The M19 side must enforce the org check and that the patient belongs to the org (ADR-0057).
- **Patient-in-organisation check (review finding, MEDIUM) - closed by decision 8.** The real router must still answer `unavailable` / `no_route_configured` for another organisation's patient, as defence in depth (ADR-0057).
- **Truncated backup tiers (review finding, LOW).** The list stops at 4 tiers or at the first unavailable tier without saying so; add a `more_tiers` flag when that matters.
- **Shift end** from M19 (decision 5).
- **Availability status** ("on a visit", "not paged yet") in the spec mockup has no source and is not shown.
- **Clinical lead:** the role list, who may read the directory, the wording.

## Known ceilings

- One router call per tier per request (at most 4); there is no cache beyond the flag read. A burst of staff polling every 15 s is bounded by the global rate limiter.
- A fall-back hour is told apart only by the zone abbreviation (PDT / PST); the seam's wall-clock rule (see `shift-window.ts`) is unchanged.
