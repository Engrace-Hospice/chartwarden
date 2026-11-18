# ADR-0113 — A clinical note is closed within a per-tenant number of hours of arrival: one computed documentation clock, a per-tenant policy (off, warn, block), a request-time gate that confines an overdue clinician to a safety allowlist, and a supervisor override

- **Status:** **Accepted** (2026-11-17). The product decisions below were made by the owner on 2026-11-17 (visit-note closure, slice 1).
- **Date:** 2026-11-17
- **Phase:** post-launch clinical documentation; builds on M8 (encounters), M17 (visits), M18 (EVV) and M36 (alerts).
- **Related:** [ADR-0007](ADR-0007-m8-m9-m10-read-direction.md) (M8 reaches other modules by outbox event and seam, not by import), [ADR-0043](ADR-0043-m8-completeness-seam-inversion.md) (the M8 completeness seams), [ADR-0090](ADR-0090-administrator-and-org-admin-org-wide-patient-scope.md) (the org-wide roles), Module 8 spec section 2.5 (D4, late-entry tiers), Security Hardening section 5.1 (step-up).
- **Amends:** nothing. The calendar-day late-entry tiers (`late_entry`, `significant_late_entry`, `administrative_override`) are unchanged and coexist with this clock: they classify a note when it is finalized, this clock asks for the note while it is still open.

## Context

Facts read from the repo on 2026-11-17:

- An encounter is `draft`, `finalized`, `signed`, `cosign_pending`, `cosigned` or `voided`. Nothing in the product ages an open note by hours. The only age-based signals are the two alert-rule seeds `m8.encounter.unsigned` and `m8.encounter.documentation_late` (a cron sweep every 15 minutes) and the calendar-day late-entry tiers, which fire at finalize, after the fact.
- A clinician who walks out of a visit without closing the note leaves an open draft that nobody is asked about. Compliance wants a number of hours, a per-tenant setting, and a hard stop for the tenants that choose one.
- Main auto-deploys to production, so any new refusal must ship off by default and be switched on per tenant, and must never lock a clinician out of the things that keep a patient safe.
- The not-yet-live organization already has a request-time confinement (`bootstrap/onboarding-org-gate.ts`, a stage in `bootstrap/plugins/authenticate.ts`): an exact `METHOD + route template` allowlist matched on `request.routeOptions.url`, an injected required reader, fail closed, a typed error. A second confinement of the same shape is a known pattern.
- `encounter` already stores `started_at` (clinician-entered or EVV) but nothing says when the duty to document began, and the visit, EVV and ad-hoc paths all disagree about what "arrival" is.

## Decision

**D1. One clock, started at arrival, stored on the encounter.** `encounter.clock_started_at` plus `encounter.clock_start_source` (`evv_check_in`, `visit_started`, `draft_opened`, `draft_created`; both set or both null). The first signal wins and a later one never moves it: the EVV check-in `capturedAt`; else the visit's `actual_started_at` (the M17 `m17.visit.started` event, which M8 now consumes); else the first clinician authoring write on a seeded draft; else the creation of an ad-hoc note. The M8 consumer clamps the value to the visit's service day and to the event's delivery time, so a skewed device clock cannot back-date or post-date a deadline. If M17 already left `published` (a self-attested visit) the consumer returns early and the late EVV instant is lost; self-attest wins, deliberately.

**D2. Closed means signed.** A note is closed when its status is `signed`, `cosign_pending` or `cosigned`. `voided` is excluded. For an LPN or CHHA the author's duty ends at the primary signature: `cosign_pending` is closed for the author (the cosigner has their own clock, `cosignature_request`).

**D3. Compute, do not materialise.** The deadline, the stage and the verdict are never stored. A pure function in M8 takes the clock, the tenant policy, the override and "now" and returns `ok`, `at_risk`, `overdue` or `escalated` plus the instant blocking may begin. SQL only finds "the member's oldest clocked open note" (`ORDER BY clock_started_at LIMIT 1`, served by the partial index `encounter_open_clock_idx`); the function decides. So the two cannot drift, and changing the threshold re-times every open note at once. The clock is absolute elapsed hours: no daylight-saving arithmetic, no calendar.

**D4. A per-tenant policy, default warn.** `documentation_obligation_policy`: one row per (organization, obligation kind) holding `mode` (`off`, `warn`, `block`), `threshold_hours` (1 to 168, default 24) and `enforce_from`. An absent row means `warn` and 24 hours, applied in code. Moving a tenant to `block` is an explicit act by a holder of `encounter.closure_policy_admin`, and the service sets `enforce_from = now()` at that moment: a note that is already overdue when blocking starts gets a fresh window (`blockFrom = max(clock, enforce_from) + threshold`) instead of locking clinicians out on the switch. Alerts use the true stage; only blocking uses `blockFrom`.

**D5. Alerts replace the old sweep, in place.** The `encounter.attention` cron keeps its queue name and `*/15` schedule; its body now reports closure stages: `at_risk` six hours before the deadline, `overdue` at it, `escalated` twelve hours after (to the author, then to the supervisors of the note's provider entity). Alert types `m8.encounter.closure_at_risk`, `closure_overdue`, `closure_escalated`, severities info, warn, warn (never critical), payloads of ids and instants only. The two superseded seed rules are removed. The sweep emits only the notes whose stage boundary was crossed inside a two-hour lookback, because the alert emitter resolves rules and recipients before it de-duplicates; a worker outage longer than the lookback skips a crossing (the upgrade is a larger lookback at the cost of duplicates). A note with no clock raises nothing.

**D6. The block is a request-time gate, fail closed.** A stage in `bootstrap/plugins/authenticate.ts`, after the not-live-organization confinement, applies only to `staff` sessions. When the organization's mode is `block` and the caller's oldest clocked open note is past `blockFrom` with no active override, every route outside an allowlist answers 403 `NOTE_CLOSURE_REQUIRED` (details: the encounter id, the deadline, the count). The allowlist is an exact `METHOD + route template` list, tested against the real route table the way the onboarding allowlist is. It keeps reachable everything that closes the note (the encounter's own routes: selections, finalize, sign, vitals, addenda, cosignature, the late-entry override routes), everything that protects a patient (eMAR, orders and verbal orders, triage calls and on-call, field-safety SOS, incidents and check-ins, emergency messaging and its acknowledgement, the alert inbox), creating an ad-hoc note (which starts its own clock), and the read-only chart and shell calls the app chrome needs. It does not include voiding a note or writing the policy: a blocked administrator must not release themselves. A read failure in `block` mode on a non-allowlisted route answers 503 `NOTE_CLOSURE_UNAVAILABLE`, not a pass. Only `clear` verdicts are cached (five seconds per organization and member); a block is never cached, so a signature or an override takes effect at once on every replica. In `off` and `warn` the gate refuses nothing.

**D7. A supervisor can lift the block, briefly.** `documentation_obligation_override`: a supervisor (the four supervisor role keys: `clinical_supervisor`, `director_of_nursing`, `don`, `clinical_lead`) with `encounter.closure_override` grants one clinician one obligation kind for at most 24 hours (default 4), with a reason of at least 40 characters, behind step-up. The table is append-only for the application role: it inserts, it can only stamp the two revocation columns, it has no DELETE. A person cannot override themselves. The override lifts only the block: alerts, deadlines and the policy are unchanged, and it does not satisfy the late-entry override routes. The reason is scrubbed from the audit row; the grant also writes an explicit `encounter.closure_override_granted` audit event.

**D8. The engine is generic; slice 1 is visit notes.** `obligation_kind` is `visit_note`, `hope_window`, `cti` or `face_to_face` in the enum, the policy and the override, but the API accepts only `visit_note` in slice 1. HOPE windows, certifications of terminal illness and face-to-face encounters already have their own deadlines and alerts (M10, M6); moving them onto this engine is a later slice, each with its own clock source and its own decision about whether it may block.

**D9. No backfill.** An existing unsigned draft has no clock. My notes labels it "Legacy"; it raises no alert and never blocks. Only notes started after the deploy are clocked.

**D10. The supervisor role-key set is one set.** The alert recipients, the cosignature alert seeds and M8's `isSupervisor` all use the same four keys. `director_of_nursing` was missing from the M8 and alert sets; that correction ships as its own change.

## Consequences

- Migration 1510 (`-- compat: expand`) adds two nullable columns, one partial index and two tables; a previous release never writes the new columns, so it keeps working on the new schema. Both tables are org-level (organization_id only, no patient, no PHI), FORCEd RLS, audited, with a destruction grant.
- Every tenant starts in `warn`: clinicians see a banner and alerts, nothing is refused. A tenant opts in to `block`. Nothing changes for a tenant that does nothing except the new alerts replacing the old two.
- A confined clinician can always close the note, answer an emergency, give a medication, take a triage call or raise a safety alert. The allowlist is the part that needs a human each time a chart route is added: a test fails until a new chart GET is classified allowed or denied.
- The clock is as good as its start signal. A clinician can still delay the signal that starts it (the first authoring write on a seeded draft); the other three signals are not the clinician's to delay.
- Blocking is per clinician, not per patient or per organization; one overdue note confines its author only.
- Cost: one indexed read per non-allowlisted request in `block` mode (none in `off` and `warn`, none for allowlisted routes), plus one cached policy read per organization.

## Slice plan

1. **Slice 1 (this ADR):** the visit-note clock, stamping on the three start paths, the replacement alerts, the tenant policy (default warn), the gate and its allowlist, the supervisor override, My notes and the supervisor overdue board.
2. **Later:** HOPE windows, certifications of terminal illness and face-to-face encounters onto the same engine, each as its own `obligation_kind` with its own clock source and its own mode; a backfill only if the owner asks for one.

## Alternatives considered

- **Materialise a `due_at` column on the encounter.** Rejected: it drifts from the policy (a threshold change would need a backfill of every open note) and from the SQL that reads it; computing from the clock keeps one definition.
- **A cron that flips a "locked" flag.** Rejected: the lock would lag the clock by up to a tick and would need unlocking on sign, on override and on a mode change, on every replica; the request-time check reads the source of truth.
- **Block everything except the note.** Rejected: it would stop a clinician from giving a medication, answering a triage call or raising a safety alert. Safety routes are always reachable.
- **Reuse the calendar-day late-entry tiers.** Rejected: they classify at finalize in calendar days; they cannot ask for a note that is still open, and changing them would re-classify historic notes.
