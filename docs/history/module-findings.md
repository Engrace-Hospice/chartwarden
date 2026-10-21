# Module findings: M8 gate, E2E/axe coverage, M33 system dashboards, M20 SOS watchdog

> F-112 (M8 Layer-3 gate), F-114 (#106 E2E/a11y), F-116 (M33 seeded dashboards), F-118 (M20 SOS escalation caller). Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

**M8's §2.6 Layer-3 gate shipped with two of its twelve checks permanently deferred, and the reason was
data, not code (F-112, #125).** `gate/checks.ts` registered `required_vitals` (check 2) and
`required_scales` (check 3) as `deferred` from the day the gate went real (#121): the spec states a
vitals roster for exactly two of the fourteen encounter types in prose (`routine_visit`: BP/HR/RR/T/
SpO2/pain; `telephonic`: none) and a scales roster for one (`recert_visit`: PPS/ESAS), and nowhere else
— so a clinician could finalize and sign a `routine_visit` note that never captured a blood pressure,
and `clinically_not_indicated_fields` + its ≥20-char reason (the escape hatch §2.2 specifies) was built
and unreachable, because nothing enforced the requirement it escapes. **Both checks are now evaluated.**
The scales half is a small literal map (`REQUIRED_SCALES`, `packages/hearthnote/templates/
requirements.ts`) — thirteen of fourteen types are a deliberate `[]`, because the spec never names a
roster for them and check 3's own gloss is "if mandated by the type." The vitals half is NOT a second
hand-authored list: `registry.ts`'s `baseSectionIds` had already decided, per DISCIPLINE, which
(encounterType × discipline) pairs carry a required `vitals_review` narrative section — rn/lpn/md/np get
one (stripped only for `telephonic`); chha/msw/chaplain/volunteer never do — and `requiredVitalsFor`
reads that section's presence rather than re-deciding the same question a second way, so the two cannot
drift. That resolves every type the spec's prose left silent (`admission_visit`, `recert_visit`,
`face_to_face`, `lpn_visit`, `idg_followup` — the last genuinely discipline-dependent: an RN's IDG
follow-up requires vitals, an MSW's does not, because the template does) the same way the template
author already decided it. **One deliberate departure from the obvious per-type reading**: `chha_visit`
is NOT given the CHHA-scoped roster (BP/weight/pain) the §4.5 role table's capture-SCOPE note might
suggest, because `baseSectionIds("chha")` carries no `vitals_review` section at all — the template's own
design is that a CHHA visit does not narratively review vitals, and requiring the numbers while the
template requires no discussion of them would have been the exact drift this fix exists to prevent.
Wiring it live surfaced the same "the suite invented the fact its own production path cannot produce"
shape this document has seen repeatedly: **every `draft()` helper across the M8 live write suite
documented sections but captured no vitals**, so the moment check 2 went live every finalize/sign case
for a vitals-requiring pair would have failed identically — fixed in the suite's own shared fixture
(`requiredVitalsCapture`, mirroring the existing `requiredSectionSelections`), never by weakening the
gate. `db:seed:scenario-clinical-core.ts`'s M8 section had already been capturing the full roster before
finalize (written against #121, coincidentally complete for #125 too) and needed no change. M8's manifest
`dependsOn` gains `9` (M9, for the `LatestAssessmentProvider` seam check 3 reads) alongside the M7
`CarePlanReader` it already consumed. Proven live in `m8-encounters-write.live.test.ts`: a routine_visit
missing BP refuses at finalize naming the field, `clinically_not_indicated` reaches it for the first time
and lets the same note sign, and a recert_visit with PPS present but ESAS missing blocks specifically at
SIGN (the M9 fact, unlike M7's, is faked per-test the same way `carePlanOverdue` is, so the gap between
finalize and sign is real and not an artifact of the harness).

**#106's own premise had partly gone stale, and the part that hadn't pointed at two real bugs
(F-114, #106/#250).** It read "18 E2E tests and 12 axe assertions cover 290 registered screens" and
"none of the repo's `scripts/db/seed*.ts` scripts insert any claim data" — both true when filed, both
false by the time this pass re-verified them: the corpus had grown to 19 spec files / 301 screens, and
`seed-scenario-billing.ts` (added since) assembles, validates, and submits one real Medicaid (M24)
claim per `db:seed:all` run. That is NOT the M23 Medicare lifecycle the issue asked for, though — the
same seed file's own header names why, in more detail than #106 had: `POST /billing/claims/assemble`
is unconditionally unreachable (M23's whole §4.4 reader-seam bundle sits behind fail-closed deny-stubs
at boot), and 835/remittance posting (M25) has no reachable creation route for EITHER payer (its one
route gates on `systemPrincipal`, a fact nothing in the codebase writes — the F-030 naming-collision
shape one module over, `actorKind` under a second, unwired name). Both are real, independent production
defects, not test-coverage gaps, and are now filed as their own issue (**#250**) rather than fixed
inline — un-stubbing a six-seam bundle across five modules is its own project. `billing.spec.ts` now
proves the REACHABLE half of #106's first acceptance criterion end to end (Medicaid: a seeded claim
shows `SUBMITTED`, not the empty-claims state its old "reachability + empty-state" framing settled
for) and keeps the Medicare empty-state tests, now correctly attributed to #250 rather than to a
seeding gap. **The other three acceptance criteria are addressed in proportion, not in full.**
Failure/rollback-path coverage was added where it was genuinely absent — `assessments.spec.ts` had
none at all (every other critical-workflow spec already carried some, per a text survey of this
session, so the honest scope was the one file at zero, not a rewrite of all sixteen) — plus a
Medicaid-billing failure case (an invalid filter value degrades to a visible non-crash rather than the
uncaught-exception overlay). The accessibility strategy is now genuinely proportional to the registry
rather than to which sixteen specs happen to call `expectNoAxeViolations`: `e2e/specs/
axe-route-walk.spec.ts` walks every statically-routable, post-auth `web` screen (157 of them) under the
admin persona and WCAG-2A/AA-scans each — structural coverage, explicitly NOT a substitute for the
keyboard/focus/zoom/contrast/screen-reader review #106 itself says needs scheduling by a human.
`admin`/`portal` (47 screens, two Vite dev servers this suite's single `baseURL` does not reach) and
dynamic routes (116 screens needing a real resource id per screen) are out of its scope, stated rather
than silently absent. And the coverage is now MEASURED rather than counted by hand: `bun run
scripts/report-e2e-axe-coverage.ts` (`arch:e2e-coverage`, in `arch:fitness`) cross-references the
`ui:parity` registry against `e2e/specs/` source text and writes `audit/e2e-coverage/E2E_COVERAGE.md` —
19/157 statically-routable web screens were E2E-reached and 151/157 axe-reached at the time this
landed, both numbers the report itself will keep current rather than this paragraph.

**A newly provisioned org's `/reports` is no longer empty (F-116, #138).** M33 §1 names "the
catalog-of-platform-shipped dashboards that lets an agency go live on day one … without the agency
authoring a single definition" as the reason the module exists at all; `find . -name
"system-definitions-seed*"` found nothing, and no migration, provisioning step, boot hook or worker
created a `system`-authored `report_definition` for an org — a fresh tenant's `/reports` was empty
until someone authored a report, which the M33 spec's own file tree names as a missing artifact.
**Not fixed at M34's `tenant.provision` job**, which is where the spec's file tree places it and where
this finding was first scoped to land: `report_view.owner_membership_id` is NOT NULL — a saved view is
always owned by a real membership — and that job runs before any membership exists (it creates the org,
the key ring, storage prefixes, onboarding tasks, and the first-admin INVITATION, not a membership). The
earliest point an owner membership exists is `POST /api/v1/invitations/accept`, which is also where
F-097's M2→M3 role-attach handshake runs for the identical reason; `createDbSystemDashboardSeeder`
(`33-reporting/system-dashboard-seeder.ts`) binds there, threaded into `mountIdentityRoutes` exactly the
way `roleAttacher` is (M2 is `dependsOn: [1]` and cannot import M33, so the port is declared locally in
`identity-ports.ts` and bound by structural typing at the composition root). **Scoped honestly, not to
the spec's full claim**: only `report_base_catalog.status = 'active'` bases get a dashboard — 3 of ~36
registered MV keys today (`census_org_daily`, `encounter_productivity_membership_day`,
`evv_compliance_org_week`; migration 0061) — read from the catalog rather than hardcoded, so a base
going `active` later needs no code change here, only a re-run of the idempotent backfill. The HQRP/HOPE/
cap/bereavement half of the spec's claim remains unmet until those bases land; this does not restate the
spec, because the code now genuinely delivers as much of it as is real. Each dashboard's
dimensions/measures are the base's OWN full catalog arrays, not a hand-picked subset — reading the
existing decision instead of re-deciding it, the same rule F-112 applied to HearthNote's `vitals_review`
sections. **Idempotency is a database constraint, not a pre-read**: `ensureSystemDashboards` runs on
EVERY accepted invitation for an org (cheap after the first), and `report_definition_system_org_base_uq`
(migration 0248 — a partial unique index on `(organization_id, base_key) WHERE authorship = 'system'`)
is what makes two admins racing to accept the first two invitations for a brand-new org create each
dashboard exactly once, via `.onConflictDoNothing()` (the `elevated-approvals.ts` `grant()` precedent)
rather than a duplicate row. `scripts/backfill-system-dashboards.ts` (`db:backfill-system-dashboards`)
covers orgs provisioned before this landed — one non-revoked membership per org picked deterministically
as the nominal owner — and is safe to re-run against every org whenever a new base goes active. Proven
by `m33-system-dashboards.live.test.ts`: a fresh org gets all 3 dashboards with the correct owner and
`share_scope='org'`, a second accept is a full no-op, org B's own tenant-scoped connection cannot read
org A's rows (the isolation claim, made from a genuinely org-B-scoped read rather than a bare pooled
read that could pass vacuously on a reverted `app.org_id` GUC — the exact hazard the F-030
`session_scope_chk` finding documents), and two concurrent seeder calls for the same brand-new org
create each base exactly once, never six.

**M20's SOS emergency-alert escalation ladder finally has a production caller (F-118, #249).**
`lifecycle/sos-escalator.ts`'s `decideSosWatchdog` — §4.8 `m20.sos-sla-watchdog.cron`, D7 / M20-F05 / S13
/ INT-031 — has been a complete, pure, unit-tested per-alert decision since M20-T03: the 5-second
stale-cancel-window sweep, the tier-1/2/3 SLA-dwell escalation, the `emergency_terminus` re-page loop.
**Nothing called it.** No file under `20-field-safety` matched `*cron*`/`*worker*`/`*job*`; the
composition root wired M20's outbox consumers (F-043/#103) but registered no cron worker for this module
at all — invisible to both `check-outbox-bindings.ts` and `check-live-suite-coverage.ts`, since this is a
SCHEDULED decider with no producer event to wait on, not an outbox consumer. A field clinician's SOS
alert that nobody acknowledged within its tier-1 SLA sat in `acknowledging` (or any later tier) forever,
silently, because this is the absence of a background process rather than an error path anything logs.
**Now bound**: `jobs/cron-workers.ts`'s `runSosSlaWatchdogCron` fans out over active orgs (the M9/M25/M33
`buildActiveOrgEnumerator` + `withPlatformContext` template, `wireM20Tenancy`'s new
`m20.platform_crons` allowlist entry), opens one `withOrgContext` tx per open alert (the
`ssa_org_active_idx` predicate — deliberately wider than `ssa_sla_scan_idx`, since the cancel-window
sweep needs `raised`/`cancel_window_open` too), resolves the pinned policy through the real
`SafetyPolicyProvider.policyAtTime(orgId, alert.postedAt)`, and applies the decision through the SAME
§2.5 version-guarded `UPDATE ... WHERE version = ?` the route layer and `consumers/
m36-delivery-failed.ts` already use for the identical race — two ticks (or two workers) can never both
win against one alert, because Postgres holds the row lock across the first UPDATE until it commits and
the second's WHERE clause then matches zero rows; a lost race is logged and skipped, not retried within
the same pass, since the next 15-second tick reads the alert's current state correctly either way. Every
alert gets its OWN transaction, so one alert's lost race never aborts the rest of an org's tick.
**The tier-3 → `emergency_terminus` rung is deliberately refused rather than completed, reusing
`m36-delivery-failed.ts`'s own reasoning for the identical edge rather than re-deciding it**: that
transition's entry effects are `dial_emergency_contact` / `surface_psap_number` / `page_chartwarden_ops`, all
three `CALLER_OWNED_EFFECT_KINDS` `runEffects` deliberately does not execute, and confirmed — no caller
anywhere in this codebase implements a real telephony dial, an M40 jurisdiction lookup, or a platform
page (the "manual escalate" path the decider's own header names as the ladder's other trigger has no
live route either). Writing `lifecycleState = 'emergency_terminus'` and firing `sos_terminus_reached`
while none of the three mandated actions actually happened would say the life-safety chain reached its
mandated end when nothing dialed anyone — worse than not escalating. A breached tier-3 alert is instead
logged loudly (`sosTerminusUnsupported: true`) and left visible at its current tier on the §4.2/§4.3
board, a real (if incomplete) signal, rather than a misleading one. The re-page LOOP is still wired for
an alert that reaches the terminus by some future path — its effects are all outbox/alert, no
caller-owned kinds, so applying them is safe even though nothing can currently put an alert into that
state. **A genuine, separate defect surfaced writing the live proof**: `sos_terminus_reached`'s catalog
schema requires `emergencyContactCallInitiated`/`psapJurisdictionId`/`wardenxOpsPaged`, and the natural
first draft reported the ALERT'S CONSENT STATUS as whether the call was "initiated" — which it never is,
since the dial itself is one of the three unimplemented caller-owned effects. Fixed to always report
`false`/`null`/`false`, honestly, rather than letting an active consent read as a call that was placed.
Proven by `m20-sos-sla-watchdog.live.test.ts` against a real disposable Postgres: the cancel-window
sweep, all three tier escalations, the tier-3 refusal (state/history/outbox all provably unchanged), the
terminus re-page (loop iteration counted correctly, no spurious history row — `m20_ssash_no_self` would
refuse one), the two-concurrent-ticks race (escalates exactly once, version 2 never 3), and a two-org fan
out under each org's own tenant scope.

## F-217 — M6 F2F/CTI adequacy predicate and the recert activation gate (M11 D10)

**Correction of the F-159/F-167 record.** Both said `m11.order.recertification_signed` was blocked because
"no callable F2F/CTI adequacy check exists" and that `createElectionPeriod` "performs no F2F/CTI check". The
second half was the wrong place to look. `createElectionPeriod` inserts a `pending` shell and cannot carry
the gate: `certification_of_terminal_illness.election_period_id` and `face_to_face_encounter.election_period_id`
are NOT NULL, so neither record can exist before the period does. The spec puts the gate where a period
becomes `active` (M6 §2.3.2 `setActive`, R-F2F-04, §2.3.3), and `signCtiHospiceMd` — the only path that
advances a period >= 2 — already enforced the F2F half of it (`hasAttestedF2f`, "is there an attested row").
The real gaps were (a) no shared predicate, (b) nothing on the CTI side beyond the signer-equals-admission-
physician check, (c) nothing on the F2F side beyond "attested".

**Built.** `06-admission/certification/adequacy.ts` — `evaluatePeriodAdequacy`, pure and deterministic, returns
`adequate | inadequate` + machine-readable reason codes + non-blocking flags (no PHI: codes only).
`signCtiHospiceMd` now runs it fail-closed after the legacy R-F2F-04 machine guard: typed 409
`ELECTION_PERIOD_ADEQUACY_FAILED` with the codes in `details`, whole tx rolled back (CTI stays unsigned, period
stays `pending`). The decision is published additively as `adequacy` on the recert-activation
`m6.election.period_started` (catalog schema extended, optional). The M23 range reader
(`claimAssemblyRangeContextForOrg`) now selects its CTI/F2F row with the predicate's own `pickCertification` /
`pickFaceToFace`, so the claim-assembly facts and the gate cannot disagree about which row represents a period.
Proven by `m6-adequacy.test.ts` (pure, window/deadline boundaries on exact instants incl. a DST case) and
`m6-adequacy-gate.live.test.ts` (real `wardenx_app` role, real catalog-validating publisher, real M6 rows).

**Semantics (spec citations in the file header).** CTI: present for this period; non-voided/superseded;
hospice-MD signature on file and status `signed` (period 1: MD signature alone suffices and the attending
co-sign is a flag only — D3 amended v0.6); signer = `admission.hospice_physician_id`; narrative >= 200 chars
(§2.3.3 / `TEXT_MINIMUMS.ctiNarrative`). Late is a FLAG, never a block (R-CTI-01, D4): `CTI_SIGNED_LATE`,
`CTI_LATE_REASON_MISSING`, `CTI_WRITTEN_CERT_DEADLINE_MISSED` (org-TZ calendar days, D8). F2F (sequence >= 3
only, R-F2F-04; D9: the inherited sequence counts): attested with a signature instant; performer hospice MD/NP
(R-F2F-01); in `[start-30, start-1]` (R-F2F-02) or a valid override (reason >= 20 chars + overriding user,
R-F2F-03/D5), flagged `F2F_WINDOW_OVERRIDDEN`. Period 1 is NOT routed through the gate — R-AC-01
(`evaluateAdmissionReadiness`) governs the initial CTI and its verbal-cert grace.

**What the spec left ambiguous, and what was chosen.** (1) Override authority: D5 says compliance officer only,
R-F2F-03/§2.3.4 say Medical Director — the predicate does not re-decide WHO (route permission does), it accepts
the facts the DB CHECK requires. (2) How "in window" is established: the predicate has `windowBasis: 'recorded'`
(trust the persisted `within_window`, NULL = unverified, fail-closed) and `'dates'` (recompute from
`encounter_date` + period start). The gate uses `'recorded'` because the production `completeF2f` does not
capture the real encounter/period dates: it ignores the validated `encounterDate` body field, stamps "today",
and computes the window against a hard-coded `period start = today + 7d`, so `within_window` is always true on
that path and recomputing from those dates would refuse every same-day flow. **A compliance officer should know
this: today the F2F window check on the production write path is structurally always satisfied.** Fixing
`completeF2f` to take the real dates (and the real period start, which is unknown for a `pending` recert period
— activation stamps "today") is a separate, decision-bearing change. (3) `attestF2f` does not persist the
attestation narrative (`attestation_narrative` stays NULL), so its 100-char minimum (§2.3.4) cannot be checked
from stored facts and is not part of the predicate.

**Operational consequence to note.** `transferIn` (and the period-1 seed) draft a SKELETON CTI with no
narrative and no route edits a CTI's narrative; `draftCti` refuses while a non-voided CTI exists. A transferred-in
next period's CTI therefore now fails `CTI_NARRATIVE_MISSING` until it is voided and re-drafted with a narrative
(`m6-discharge-f2f-loc-write.live.test.ts` exercises exactly that path). That is the CMS-correct outcome
(42 CFR 418.22(b)(3) requires the narrative) but it is a new step for operators.

**Outbox pair.** `m6 <- m11.order.recertification_signed` stays deferred, with a corrected reason in
`scripts/outbox-deferred-consumers.ts`: with the gate at activation, a consumer that opens the next pending
period can no longer bypass the CoP check, so the old blocker is gone; the remaining blocker is the product
decision whether a signed recert order should auto-open the next pending election period at all (M11 D10 / §1.3
name M6 as subscriber; M6's own spec never names the event; there is no F2F/CTI to validate before the period
exists).

## F-223 — M6 binds `m11.order.recertification_signed`: a signed recert order opens the next PENDING period

**Decision (user-approved, closing F-217's open question).** A signed `recertification` order (M11 D10 / §1.3)
auto-opens the next election period, PENDING only. `outbox-consumers/m11-recertification-signed.ts`; migration
0297 adds `election_period.source_order_id` (logical uuid, M6's `dependsOn` excludes M11) + plain
`UNIQUE(organization_id, source_order_id)` (NULLS DISTINCT — the F-159 / 0250 / M25 0249 precedent).

**Gate intact.** The consumer never activates, signs or touches CTI/F2F rows; adequacy stays enforced at
activation (`signCtiHospiceMd` → `evaluatePeriodAdequacy`, F-217). The live suite proves an auto-opened period
with an inadequate CTI still refuses activation (409 `ELECTION_PERIOD_ADEQUACY_FAILED`).

**No duplicated insert logic.** `createElectionPeriod` now delegates to the exported `openNextElectionPeriodInTx`
(next sequence, `electionPeriodKindForSequence` 90/90/60, row, `m6.election.period_started` on the same tx); the
consumer passes `sourceOrderId`, which switches the insert to `ON CONFLICT DO NOTHING` so a racing manual open
or redelivery loses quietly instead of aborting the tx with 23505.

**Matching.** `periodEndDate` is the CURRENT period's end (M11 spec: `<curr period end>`); the consumer selects
the highest-sequence `active` period whose `scheduled_end_at` equals it. Highest-sequence because activating
period N+1 does not flip period N off `active`, and (pre-existing behaviour) period windows are stamped from the
activation day, so two periods can share an end date.

**Settle vs retry.** Settled (return, never throw): malformed payload, already applied (source_order_id),
admission unknown / cross-tenant (RLS), admission not `active`/`on_hold`, no active period matching
`periodEndDate`, a later period already exists (no duplicate pending period when staff opened it manually).
Only db/publisher errors propagate for dispatcher retry (proven: the period rolls back).

**Outbox pair.** `m6 <- m11.order.recertification_signed` removed from `scripts/outbox-deferred-consumers.ts`
(group deleted). No `*_SUBSCRIBED_EVENT_NAMES` list exists for M6. Wired at `apps/backend/src/index.ts`
(`buildM6RecertificationSignedConsumer`). Proof: `m6-recertification-signed.test.ts` (unit) and
`m6-recertification-signed.live.test.ts` (`test:m6:recertification-signed:live`, CI row added).

## F-226 — M6: the F2F window is computed from the REAL encounter date vs the period's EXPECTED start (closes F-217's `windowBasis: 'recorded'` caveat)

**The bug (verified).** F-217's activation gate trusted the persisted `face_to_face_encounter.within_window`, but
the production `completeF2f` ignored the route's validated `encounterDate` (the route did not even pass it),
stamped today, and computed the window against a hard-coded `today + 7`: `within_window` was true on EVERY
production write. A pending period has no `effective_at` until activation, so the real window
[start-30, start-1] (R-F2F-02) had no anchor at completion time.

**Product decision (delegated, recommended design).** A pending period's EXPECTED START = the preceding period's
`scheduled_end_at` + 1 calendar day (benefit periods are contiguous, 42 CFR 418.21(a); M6 §2.3.2 `setActive`;
the F-178b window-missed scan and the M14 recert-window seam already derive the same day). Persisted as
`election_period.expected_start` (migration 0299) by `openNextElectionPeriodInTx` (route `createElectionPeriod`
AND the F-223 consumer) and by `transferIn` (next pending period = inherited end + 1). NULL when the preceding
period has no scheduled end yet (never guessed).

**`completeF2f(org, id, ifVersion, encounterDate)`.** Validates the date (calendar date, not after org-local
today, not more than 365 days back: 422 `F2F_ENCOUNTER_DATE_INVALID`), resolves the start (`expected_start`, else
preceding end + 1, else `effective_at` for an already-activated period; `certification/f2f-window.ts`),
runs R-F2F-02 on the real date, persists the real `encounter_date` and the honest `within_window`. Outside the
window without an override: 409 `F2F_OUTSIDE_WINDOW`, row stays `scheduled`. Same-day (encounter == start) is
outside (R-F2F-02 "strict prior"). Start not derivable: 409 `F2F_PERIOD_START_UNKNOWN`; with an override the row
completes with `within_window = NULL` (unverified). `m6.f2f.completed.withinWindow` stays a required boolean
(NULL is reported `false`). **Override reachability:** the spec's graph allowed `requestWindowOverride` only from
`completed`, while completion refuses an outside date without one (circular: an outside-window F2F could never be
overridden). `requestWindowOverride` is now also legal from `scheduled` (self-loop; it previously always returned
`completed`, now returns the current state). Authority is untouched: the route permission decides who overrides.

**Which start the activation gate uses.** `signCtiHospiceMd` now evaluates F2F with `windowBasis: 'strict'`:
the window is recomputed from `encounter_date` against the EXPECTED START (`expected_start`, else preceding
`scheduled_end_at` + 1; undeterminable = fail closed `F2F_WINDOW_UNVERIFIED`), AND the persisted flag must be
exactly `true` (false/NULL vs an inside recompute = disagreement = `F2F_WINDOW_UNVERIFIED`; inside-vs-outside
= `F2F_OUTSIDE_WINDOW`). A valid override still passes flagged. The CTI late/written-cert math still uses the
activation day as before (only the F2F window moved to the expected start). **Not changed, reported:** activation
still stamps `effective_at` = the activation day, not prior end + 1 as §2.3.2 `setActive` states (pre-existing);
a late activation therefore shifts the billed period start relative to the window anchor. Compliance/billing to
decide whether `effective_at` should become the expected start.

**Backfill (0299, idempotent, no deletes).** (1) `expected_start` derived for `pending`/`signed` periods with
sequence >= 2 from the preceding period's `scheduled_end_at` + 1. (2) `within_window` recomputed for F2F rows
(`completed`/`attested`) of those not-yet-activated periods from `encounter_date` vs `expected_start`
(1 <= days before <= 30); NULL (fail closed) where either is missing. Activated/completed periods and their F2F
rows are NOT touched. Caveat for compliance: legacy `encounter_date` is the day `completeF2f` ran, not a
clinician-reported date, so a recomputed `true` on a legacy row is only as good as that.

**Open for compliance.** (a) Same-day F2F is refused per R-F2F-02 as written (CMS 418.22 allows a longer prior
window plus 30 days after; the spec's [start-30, start-1] is authoritative here). (b) Override authority: D5 says
compliance officer only, R-F2F-03 / §2.3.4 say Medical Director; still unresolved, enforced by the route ABAC.
(c) The F2F attestation narrative is validated at attest but not persisted to `attestation_narrative` by the
current write path. (d) M23 `f2f_attested_for_recert` and `claimAssemblyRangeContextForOrg` only assert
"attested"; consistent with the gate (an activated period passed it) but not window-aware themselves.

**Proof.** `m6-f2f-real-dates.test.ts` (pure boundaries start-31/-30/-1/0/+1, leap day, DST weeks, 90/90/60
chain, strict basis) and `m6-f2f-real-dates.live.test.ts` (`test:m6:f2f-real-dates:live`, CI row added; real
`wardenx_app` role + real publisher; migration repair; cross-tenant). Existing raw-INSERT fixtures that set
`within_window = true` on rows with no real start now carry a realistic `expected_start` and encounter date.

## GAP-037 / GAP-060 / GAP-063 (batch 12) — M12 queue deferral, M20 DEK cipher, M21 vendor-invoice accrual

**GAP-037 (M12) — superseded by the close-out round: all ten §4.8 queues are now BUILT.** The first pass could only record the seven vendor-gated queues as deferred; the close-out built the live HTTP adapter (fail-closed, per-tenant config, written from the public v2 swagger), the seven crons, the sign-time enqueue and the ack/nack/refill/prescriber webhook handlers. What cannot be known without a DoseSpot sandbox (token form, patient/prescription body field names, no endpoint for RxBenefit / refill-respond / revoke / EPCS) is isolated and listed in [`m12-dosespot-adapter.md`](./m12-dosespot-adapter.md).

**GAP-060 (M20).** `mountM20Routes` now receives a real `cipher`, `decipher` and `recipientCountFor` (previously unbound, so the SOS coordinate was always dropped and `POST /safety/incidents` always 503). `20-field-safety/safety-crypto.ts` is an AES-256-GCM envelope over `getTenantKeyProvider()` (resolved lazily; the M8 `hearthnote-crypto.ts` shape: DEK version in the envelope, AAD binds module + tenant, decrypt throws on the M20-F16 no-coordinate sentinel). The same decipher backs the §8.6 `SafetyIncidentReader` coordinate decipher. `sos-recipient-count.ts` counts distinct supervisor delivery targets (vacation forwarding applied) and answers `null`, never `0`, when none is confirmed, so the client keeps the D15 `tel:` fallback; the D14 on-call parallel set is NOT added (the count is a floor).

**GAP-063 (M21).** `invoice_accrued` / `invoice_reconciled` had no emit site and the invoice columns were never written. `mark-ordered` now accepts an optional `vendorQuotedTotalCents` (integer cents); when present it writes `invoice_total_cents` + `invoice_accrued_at` and emits `m21.supply_request.invoice_accrued` in the same transaction (no quote means no accrual, never a fabricated zero). New `POST /supplies/supply-requests/:id/vendor-invoice` (permission `supplies.request.invoice_reconcile`, migration 0410 mirror row + grant to holders of `mark_ordered`) matches the vendor invoice against the accrual, stores the signed variance and emits `invoice_reconciled` once (409 `M21_INVOICE_NOT_ACCRUED` / `M21_INVOICE_ALREADY_RECONCILED`). Rules live in `21-supplies/lifecycle/invoice.ts`. Phase-1 intake is manual; the EDI 810 path stays Phase 2.

**Already fixed on main before batch 12 (verified against code, not re-done):** GAP-038/039/040 (M13 `extend-schedule`, `missed-dose-sweep`, `prn-reassessment-overdue` and the other three crons, wired via `registerM13CronWorkers`), GAP-044 (M15 five crons), GAP-048 (M16 four §4.9 crons), GAP-061 (M20 overdue detector + coverage-gap watchdog), GAP-062 (M21 par / unreturned-kit / supply-request monitors) — all landed in batch 9 (#324).

## Batch 17 — GAP-151..164 (M28–M34, all P2) from `docs/audits/GAP_ANALYSIS_20261004.md` (file removed from the tree; see git history)

**Closed.**
- GAP-151 (M28): already fixed on `main` — export poll and cancel both 404 unless `job.clientId === ctx.clientId`.
- GAP-152 (M29, migration 0461): acknowledge-abnormal is persisted on `lab_observation`
  (`acknowledged_at` / `acknowledged_by_membership_id`, stamped once, repeat is a no-op) and publishes
  `m29.lab_observation.abnormal_acknowledged` for M36's badge clear.
- GAP-153 (M29, migration 0460): feed-revoke dual approval is held server-side. The first approver is stored on
  `external_feed`; only a DIFFERENT membership completes the revoke (self-approval is 403), which cascades the
  feed's active credentials to `retired`. The body `primaryApproverId` is gone; the ABAC predicate
  `external_feed_compliance_co_approver_distinct` now reads the stored approver through the resolver.
- GAP-154 (M30): incident and infection-event writes derive `provider_entity_id` from the subject's active
  admission (M6 siting seam injected at the composition root); the primary entity stays the fallback for
  subject-less writes and unsited patients. CAHPS result ingest and QAPI program creation stay on the primary
  entity (no patient subject).
- GAP-155 (M30): `m30.sra_reminders` has a bound open-cycle scan and an M36 `AlertEmitter` dispatch; the five
  platform-default `alert_rule` rows (`m30.alerts.sra_due_90/60/30`, `sra_overdue`, `m30.incident.cap_overdue`) are
  seeded in `PLATFORM_DEFAULT_ALERT_RULES`; and `m30.cap_overdue_scan` (daily 08:00 UTC) is the producer of
  `m30.incident.cap_overdue` over `incident_report.kind_data._m30.capPlan`, publishing the event and raising the alert
  (every-2-days dedupe bucket).
- GAP-156 (M30): SRA finding/remediation mutations enforce `ownsSraCycle` (owner or an `sra.admin` role) in the
  write service.
- GAP-157 / GAP-160: recorded as explicit deferrals in `docs/design/DEFERRED_SCREENS.md` (footnote ³¹).
- GAP-159 (M31): `AdmissionStatusReader.isDischargedReadOnly` is implemented (the post-discharge read-only gate is
  no longer dead code). Follow-up round: all 22 events are catalogued and 19 have emit sites, the late-join watchdog
  queue is built, and the other five queues are closed as drift or covered (see `m31-portal-deferrals.md`, batch 17).
  **Open:** `invited` / `activated` / `recording_completed` have no M31 write site (M2 invitation layer and the vendor
  webhook mapping are unbuilt).
- GAP-163 (M34): `tenant.bundle_expiry_sweep`, `tenant.baa_expiry_sweep` (daily), `tenant.support_session_close_sweep`
  (every 5 min) and `tenant.onboarding_advance` (per-tenant job + daily 06:00 fan-out) have workers and schedules;
  the bundle reaper logs a boot warning when MINIO_* is absent. **Open (blocker):** the onboarding worker does not
  auto-activate a tenant: the lifecycle `activate` effect-runner and a system actor for its audit do not exist, so on
  completion it publishes `m34.tenant.onboarding_completed` + the alert and logs that activation is left to platform
  ops. `macFeedConfigured` / `dosespotKickoffRecorded` / `xeroConnected` / `gustoConnected` default to false until
  M29 / M12 / M27 readers are injected (a step stays honestly blocked).

**Close-out round (GAP-158 / 161 / 162 / 164).**
- GAP-158 (M31/M5/M16/M40, migrations 0462 + 0463): `caregiver.user_id` (M5 `linkCaregiverToUserInTx`: first writer
  wins, idempotent, a different user conflicts) is stamped in the SAME transaction that consumes a portal invitation
  issued for a roster caregiver (a conflict or missing caregiver refuses the accept and rolls the token back). The
  `PatientCaregiverReader` seam resolves the PRIMARY current caregiver's user. M40 owns `external_grief_resource`
  (tenant-curated, RLS-forced, `mdm.grief_resource.{read,manage}`, routes under `/api/v1/mdm/grief-resources`) behind
  the `ExternalGriefResourceReader` seam. Live proof: `gap-158-*`, `gap-173-*` suites.
- GAP-161 (M32): all 21 events are published from real same-tx emit sites (`emitInTx`; null-org events through
  `report_writer_insert_platform_outbox_event`). Workers built: `m32.triage_followup` and the token-ledger rollup
  (+ schedule). `recordHitlOutcome` used to be a silent no-op on a missing row; it now asserts the row count.
  **Blockers named exactly:** `m32.drift.detected` has no producer (needs the MLflow / ml-worker drift job);
  the `m32.embeddings` / ml-worker queues need that same external service; the M32 governance stores run on the
  TENANT pool because they need a privileged platform credential for `ai_capability` writes (`wardenx_app` has no
  INSERT there), so platform-scoped writes are exercised live with a privileged handle.
- GAP-162 (M33): `platform_admin_scope` / `compliance_officer_scope` predicates are registered AND composed on the
  admin routes (arch:abac-composed green) with allow/deny tests.
- GAP-164 (M34): the six routes exist with ABAC, step-up/idempotency, OpenAPI enrichments and the typed client; the
  spec's `:orgId` is corrected to `:orgSlug`; `feature_flag.value_type` is `bool|string|number|json` in the typebox
  (the DB enum is `bool`, not `boolean` - found by the live suite). `wardenx_platform` gained the missing
  `feature_flag` / `support_session_event` / `onboarding_task` / `support_session` grants.
- Pre-existing bugs the live suites found: M31 `uploads.stage` threw INSIDE the transaction, so the `expired` /
  `rejected` status writes were rolled back (fixed: refusal is returned and thrown after commit); M32 prompt-template
  activation emitted a numeric `version` against a string payload schema (fixed).
- Live coverage added (own throwaway cluster, fresh DB per suite): gap-155 (CAP-overdue SQL), gap-031 (M31 prefs +
  uploads), gap-087 (CAHPS export job + auditor magic link), gap-158 x2, gap-161, gap-164, gap-173. The
  implementation-status matrix now reads 100% live-table coverage for M31, M40 and M30 (M31's Screens tick now
  recognises `apps/portal`).
- Still not proven live: M29 feed revoke / acknowledge-abnormal SQL, the M31 cron jobs (late-join watchdog,
  post-discharge sweep), the M34 sweep workers, and the M32 BullMQ workers (unit-tested; no Redis in the live run).

## GAP-133 (M18) — EVV GPS coordinates are really encrypted at rest (§D10)

`evv_event.coords_cipher` / `evv_geofence_evaluation.device_coords_cipher` held `base64("lat,lng")` stamped
`coords_dek_version = 1`: encoding under a version stamp that claimed a DEK. `apps/backend/src/modules/18-evv/coords.ts`
is now the §D10 envelope, mirroring M20's `safety-crypto.ts`: AES-256-GCM under the tenant's M34 DEK (injected key
provider; the composition root binds `getTenantKeyProvider()` lazily), AAD `m18:evv:coords:<orgId>`, envelope
`v1.<dekVersion>.<nonce>.<tag>.<ct>`, and `coords_dek_version` (text since migration **0491**) is the version the key
ring sealed under. The capture seals before its tx opens; the route read, the `EvvLocationProvider` seam store and the
spoof detector open through the same cipher.
- **Fail closed:** no key bound (`UNBOUND_EVV_COORDS_CIPHER`, or M34's unbound-KEK stub) ⇒ the capture is refused
  and nothing is written; there is no base64 fallback. A missing/destroyed key, an unknown version, a blob sealed for
  another tenant or a tampered blob THROWS on read (§3.4 fail-loud).
- **Legacy rows:** no backfill (prod is demo data, reseeded). 0491 re-stamps every pre-existing row
  `'legacy-unencrypted'`; the reader recognises them by format (base64 has no `.`) and answers `null` ("coordinate
  unavailable") without decoding them or consulting a key.
- Proof: `coords.test.ts` (round-trip, rotation, wrong-tenant/wrong-key/tamper failure, fail-closed, legacy); the
  `m18-evv-write` live suite asserts the at-rest value is the envelope with the real DEK version, an unbound capture
  writes nothing, and a cross-tenant blob fails loud through the route read; the workers suite seals its fixtures.
- **Rotation re-seal (§4.8 `m18.dek-rotation`), follow-up:** previously NOT built — a rotated tenant's rows stayed
  sealed under the old DEK. Now `apps/backend/src/modules/18-evv/jobs/dek-rotation.ts`: an outbox consumer of
  `m34.tenant.dek_rotation_completed` (on demand) + a daily M18 cron sweep (backstop) re-seal every non-legacy row
  whose `coords_dek_version` is not current, in bounded per-org `withOrgContext` batches. The append-only trigger
  blocked the UPDATE by design, so migration **0494** adds the sanctioned path: NOLOGIN `evv_coords_rekeyer` owning the
  SECURITY DEFINER compare-and-swap `evv_reseal_coords` (moves the event and its geofence snapshot together; the
  trigger exempts only that role and only the two coordinate columns; RLS on `app.org_id`). Legacy rows stay
  unsealed. Proof: `m18-evv-dek-rotation.test.ts` (selection, batching/resume, idempotency, lost CAS, failure
  isolation, consumer envelope check) and `test:m18:dek-rotation:live` (v1 rows readable under v2, other tenant and
  legacy untouched, re-run no-op, direct app-role UPDATE still refused, cross-tenant id is a no-op, audit scrubbed).
