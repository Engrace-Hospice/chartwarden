# WardenX — Repository Guide

Multi-tenant hospice EHR SaaS. This repo is the **specification corpus + architecture-fitness
kit + staged implementation monorepo**: Phase 0 gates/scaffold are in place, and **all 40 modules
now have real implementation on `main`** — the clinical core (M1–M14, M17, M18, M22), the field/ops
tier (M15 Discipline Plans · M16 Bereavement · M19 On-Call Triage · M20 Field Safety · M21 Supplies/DME),
the **complete revenue cycle (M23 Billing-Medicare · M24 Billing-Medicaid · M25 Remittance & Denials ·
M26 Cap Management · M27 Cost Report)**, **M28 FHIR Gateway**, **M29 External Interfaces**,
**M30 HQRP & Quality**, **M31 Patient/Family Portal & Telehealth**, **M32 AI Platform**, M33 Reporting,
M34 SaaS Platform, **M35 Subscription Billing**, **M37 Inpatient Unit (IPU) Management**, plus the
platform services M36/M38/M39/M40. The generated **implementation-status matrix**
(`bun run status:matrix` → `audit/implementation-status/IMPLEMENTATION_STATUS.md`) is the per-module
truth — currently **🟢 40 · 🟡 0 · ⚪ 0** (the module set is complete; the last three placeholders —
M29, M35, and M37 — are now merged). Every module is enrichment-complete (matrix `Enriched`
full-ratio ✅; for the corpus-wide enriched-route count read
`audit/openapi-coverage/OPENAPI_COVERAGE.md`, which is generated and authoritative. **No number is
restated here on purpose** — the figure this line used to carry sat two sweeps stale and an external
audit repeated it back as a finding, which is exactly what a hand-maintained mirror of a generated
number does). The `Live` column (cross-tenant RLS proof) is also full-ratio ✅ across all 40 modules,
including the three newest — **M29 (11/11), M35 (21/21), M37 (26/26)** — whose live-RLS suites
completed in the Phase 0-2 remediation pass. **M30 is merged (PR #106)**: 18 frozen
`quality/` tables + migrations 0062–0068; the `@wardenx/quality` domain core + `@wardenx/cahps-vendors`;
60 routes in `apps/backend/src/modules/30-quality`; the `MEASURE_CATALOG`/measure registry (HCI 10
indicators + composite, HVLDL, HOPE-derived TFP, operational); and CAHPS/QAPI/SRA/incident/mortality/
infection surveillance — status matrix 🟢. A follow-up wiring batch (**issue #107, PRs #108–#118**) then
made M30's cross-module seams real: the M1-T10 transactional outbox-row emit (M30+M33 events emit), the
M40-free provider-entity resolver, the M33 `MetricsProvider` registration, the HOPE-rollup + HVLDL measure
inputs (computing end-to-end, incl. a new M6 `DeathDischargeReader` + a Drizzle-backed M8
`SignedEncountersReader`), per-job `withOrgContext` RLS on the recompute/outbreak workers, and the cron
allowlist + active-org enumerator. M23 and M27 are now **merged** (no longer placeholders); the M23/M26→M27
forward-seam binds for the CMS-1984-14 cap calc (`CapAccrualReader` et al.) and M27's own forward seam into
M30 (`CostReportFilingStatusReader`) are **live and tested**, not deny-stubs (`m30-forward-seam-binds.test.ts`,
`m26-cost-report-cap-seam.live.test.ts`, `m27-validation-context.live.test.ts`) — this un-suppresses the CoP
418.310 failure-to-file indicator. **The HCI is now resolved as far as a provider-side system can take it
(F-042, #102).** Seven of the ten indicators compute from data the agency itself records: 1 and 2 off M6's
election periods, 3 and 4 off its discharges, 8 and 9 off M6 level-of-care day spans intersected with a new
M8 per-day skilled-nursing read (`skilledNursingDayTotalsForOrg`), and 10 off the death census. **Three
never will**: 5, 6 and 7 are defined by CMS over the beneficiary's Medicare claims across EVERY provider —
the inpatient stay in the middle of a burdensome transition, and the non-hospice Part A/B spend — which no
single-tenant EHR holds. They are a DECLARED absence (`HCI_UNAVAILABLE_INDICATORS`) that computes a real
`quality_measure_value` row carrying its reason, not an unbound resolver that throws three DLQ entries per
provider entity per night, and the quality hub reads them as "Not computable here" rather than as
"Suppressed (low N)" — `unavailableReason` on the wire is what tells those two apart.
**`hci_composite` therefore SUPPRESSES rather than scoring**, and that is the fix, not a remaining gap: the
composite is a count out of ten, an un-computable indicator contributes a zero exactly like a MISSED one,
and the best a scoring composite could ever publish here is 7/10 — which is precisely
`compositeAboveAverageScore`, so every tenant would sit on the "above the national average" boundary as an
artefact of what the platform cannot measure. Getting there needed a defect one layer down first:
`election_period.effective_at`/`scheduled_end_at`/`actual_end_at` were read in seven places and **written
in none** (the `setActive` transition returns a `set_timestamp` effect the write path never ran), so
`ElectionPeriodReader` answered `[]` for every admission and HCI indicator 1 — nominally bound — selected
its denominator by `effective_at` and was permanently 0/0. Bound is not computing. All 10 of the
remaining operational measures are now bound, including `bereavement_coverage_rate` (M16) and the two
that needed an M15 producer-side fix first — `volunteer_compliance_gate_rate` /
`supervisory_visit_on_time` used to return a pre-divided rate (no denominator, so CMS small-N suppression
couldn't apply); M15's `DisciplineComplianceProvider` now exposes the count pair beside each rate method
(`supervisoryOnTimeCounts`/`volunteerGateComplianceCounts`), the same store round-trip, no new query.
`opioid_on_admission_rate` is **bound and computing** (`resolveOpioidOnAdmissionInput`): it walks M6's
admission-onset census, calls M12's existing per-admission medication-order read, and classifies inside
the admission's med-rec window. It needs **no** M38 capability — classification is by drug NAME, a
deliberate choice `isOpioidDrugName`'s own header argues for over RxCUI. This entry previously read
"genuinely blocked … needs an M38 RxCUI→therapeutic-class capability"; that was true before the measure
was bound and was still being cited as a launch blocker afterwards (#102).

**The FHIR gateway (M28) now actually serves (F-035, #95, 2026-08-28.)** It was listed as a merged
capability and read 🟢, and a partner connecting to it got a `404 not-found` for every single-resource
read — not "when absent", ALWAYS, including for a resource the tenant demonstrably held. Underneath sat
a defect nobody had logged and that made the 404 moot: `POST /fhir/oauth2/token` answered
`invalid_client` unconditionally, so no client could obtain a bearer at all and R4–R22 were unreachable
by construction. That was not a fail-closed posture, it was a **wall** — whether a partner had been
provisioned made no difference. A third followed: `resolveBearer` read `fhir_client_session` on the
tenant pool with no org context, where `current_setting('app.org_id', true)` is NULL, the policy
predicate is NULL, and the read matches nothing — so every bearer that would ever be presented resolved
to null. The whole surface was three independent dead ends deep, each one individually sufficient. Two
of the pure cores it needed had been complete and unit-tested since M28-T03 with **no caller at all**
(`verifyClientAssertion`, `verifyApiKey`) — the step-up-routes shape (F-029) one module over.
**Now bound**: R3 runs both §D2 auth paths for real (JWKS fetch + cache, `jti` replay burn — Valkey
cluster-wide when `REDIS_URL` is set, per-process otherwise — audience binding on
`FHIR_TOKEN_ENDPOINT_URL`, which is a required production env var because unset does not weaken the
gateway, it silently disables it); the tenant is resolved by two narrow `SECURITY DEFINER` functions
(migration 0233) that take one unguessable uuid and return one org uuid, chosen over the
`DATABASE_PLATFORM_URL` BYPASSRLS login precisely because that credential's grants live in deployment
config, so the gateway would have worked only on deployments that had also been granted these tables and
failed as "invalid credential" on the rest; and the read path projects through the M1 seam registry into
the pure `@wardenx/fhir` mappers and out through the D3 egress consent gate.
**`SERVED_RESOURCES` is now the single source of truth for both the CapabilityStatement and the router**,
so the conformance claim and the behaviour cannot drift. That matters because R1 `/fhir/r4/metadata` is
served **anonymously, before authentication** — the first artefact any partner's tooling reads — and it
declared `read` + `search-type` on TWELVE resource types plus `$export` and `$everything`, none of which
worked. It now declares four, with per-resource interactions: Patient (read + search by `_id`/
`identifier`), MedicationRequest and MedicationAdministration (read + search by patient), and **Encounter
as `search-type` ONLY** — M8 publishes `signedEncountersForPatientSince` and no read-by-id, so an instance
read has no data path and `CapabilityStatement.rest.resource.interaction` is exactly where a server says
so. A type this gateway does not serve now answers `not-supported`, never `not-found`: the first is a
statement about the SERVER, the second a statement about the TENANT'S DATA, and answering the second when
the first is true is how a partner concludes a patient has no medications. The eight dropped types each
need a named producer-side read that does not exist (Condition and Coverage have no reader seam at all;
`CarePlanReader`'s methods are an encounter-element picker, an overdue check and two org rollups — none
can load one plan by id). **M12's `asFhirMedicationRequest` and M13's `asFhirMedicationAdministration` —
both documented as "the M28 FHIR projection" — are deliberately NOT used**: neither payload carries a
42 CFR Part 2 SUD-class flag, and D3 makes SUD redaction default-ON at every egress, so projecting from
them would mean a second per-resource seam read or asserting `sudClass: false` for every medication,
which is not a shortcut but a Part 2 disclosure. The full DTOs carry `isSudTreatment`; adding it to those
two payloads is the producer-side fix that would let this switch over.
**The §164.528 accounting is real, and had to be.** The disclosure-audit port defaulted to a NO-OP and the
composition root never overrode it, which was defensible only while the surface served nothing — the
moment it serves PHI to a third party, a gateway whose accounting seam answers zero is publishing a false
compliance statement to M30's disclosure scorecard. Migration 0233 adds `fhir_read_disclosure`
(tenant-scoped RLS, **append-only by GRANT** — `wardenx_app` holds SELECT + INSERT and nothing else, so
the code that writes the evidence cannot edit it away, compliance retention, deliberately unpartitioned
because nothing is ever purged), the routes write it AFTER the body exists so `resultCount` is what
actually crossed, and a read that 403s, 404s or is consent-filtered is deliberately NOT accounted for —
§164.528 accounts for DISCLOSURES, not requests. `disclosureMetricsForOrg` reads that ledger instead of
returning its hard-coded zero. **Two of the issue's own claims were stale**: the three published seams
have been registered on every db boot for as long as the store has existed (`index.ts` passes it; only
the header comment still said "registers nothing", and the audit read the comment rather than the
argument), and the disclosure row the finding says the 404 was written after was never written at all.
Proven by `m28-fhir-gateway.live.test.ts` — mint at R3, read a real US Core Patient at R4, org A's bearer
refused org B's patient and vice versa, the ledger row visible to the disclosing tenant only, the
append-only grants, and a revoked client's still-in-TTL bearer dying on its next request.

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

**#248's two biggest `no-consumer-surface` groups were both misclassified, in opposite directions
(F-115).** `outbox-deferred-consumers.ts` held 509 declared-but-unbound pairs; M30 (93) and M28 (52) were
its two largest groups, both carrying a one-line "this module is a producer/gateway, not a subscriber; no
consumer directory exists" reason — the exact shape that already correctly described M33's 319 and M36's
269 pairs before those were moved wholesale to `seamConsumers`. Checked per event rather than assumed,
because F-099/F-101/F-108 each found a blanket reason wrong for a handful of members: **M28's reason was
right, completely** — the FHIR gateway resolves every seam it reads (M5/M6/M7/M8/M11/M12/M13) fresh at
REQUEST time (§164.528 D3, F-035) and holds no cached or derived state any push event would ever need to
invalidate, so all 52 declaredConsumers entries naming it were simply wrong; they are gone, with no
`seamConsumers` replacement, because there is no seam relationship either. **M30's reason was false on its
face**: `packages/quality/src/consumers/` is a real, unit-tested §4.10 consumer directory
(`handlers.ts`/`subscription-map.ts`, RULE 3(d) — pure + a topic map, no boot-wired binding, the same
shape M23/M25/M26/M27 already carry), and `outbox-subscription-exceptions.ts` had already recorded two of
its six subscribed topics as `handler-unbound` because the catalog didn't declare M30 on them. The other
four subscribed topics (`m10.hope.submission_accepted`, `m12.medication.error_reported`,
`m18.evv.visit_verified`, `m23.claim.adjudicated`) *were* declared and sat in this "no consumer directory"
group anyway — reclassified `handlers-unbound`, the mirror case. Of the remaining 89, 27 are the facts
M30's own nightly recompute already reads via seam for a currently-registered measure
(`AdmissionOnsetReader`/`DischargeReader`/`LevelOfCarePeriodReader` for M6, `CarePlanCycleCountsView` for
M7, `SignedEncountersReader` for M8, the live M10 HOPE rollup, `VerbalTimelinessCountsView` for M11,
PRN/missed-dose counts for M13, `IdgScheduleProvider` for M14, supervisory counts for M15,
`copOutreachCounts` for M16, `VisitMetricsProvider` for M17, `QualityCostReportConsumer` for M27) —
verified against the actual Drizzle query each seam runs, not inferred from module proximity, which is
what caught two plausible-looking false positives before they landed: `m16.bereavement.plan_closed_*`/
`plan_skipped_per_patient_opt_out` (M30's `copOutreachCounts` sums outreach-touchpoint status, not plan
closure reasons — a `planClosureCounts` method exists on the same seam interface and is simply unused by
any of the eleven measures `m30-jobs.ts` currently registers, "bound is not computing" a third time) and
`m13.administration.recorded`/`refused`/`corrected`/`voided` (the missed-dose/PRN measures scan
`scheduled_dose` and PRN-specific rows, not the general administration stream). Those 27 moved to
`seamConsumers` on their own `events-by-mNN.ts` entries and out of `declaredConsumers`. One more was a
different defect: `m30.infection.event_recorded` declared itself a "self-subscriber," but
`recordInfectionEvent` runs the §7.8 outbreak-window scan INLINE in the same transaction — nothing has
ever consumed that event via the outbox, so the declaration was dead and is now record-only. Net: 509 →
429 declared-but-unbound pairs; the honest remainder is 61 M30 facts with no current seam (M9/M20/M21/
M23-noe-notr/M25/M26/M37/M39, three M6 facts outside the four M6 readers' documented scope, and
`m8.hearthnote.layer2_enhanced`) plus everything else #248 hasn't triaged yet. Proven by the full
non-live suite (three tests pinned the old declaredConsumers/seamConsumers arrays and now pin the
corrected ones) and `arch:outbox-bindings`, which is the only gate that can see this class of drift at
all.

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

**#248's own quoted rationale for the m22 group was a per-MODULE claim about a per-EVENT fact, and it
was checked, not assumed (F-117).** The register said "for M11/M12/M13/M21/M23/M33 the request half IS
wired, so the source declaration is redundant" — true of exactly 4 of the roughly twenty events those
six modules contribute to the group, and false of the rest, which are separate order/claim/billing
lifecycle transitions on the same modules with no such sibling. Confirmed redundant by tracing the
actual emit sites to a `*.document_requested` co-emission in the SAME transaction: `m11.order.signed` /
`.standing_spawned` (`orders-route-service-db.ts`), `m12.medication_order.signed`
(`dosespot-route-service-db.ts`'s `emitDocumentRequest` helper), `m13.reconciliation.completed`
(`emar-route-service-db.ts`) — all four dropped from `declaredConsumers`, no `seamConsumers` added,
because the artifact is delivered by the other event and there is no seam relationship to record. Two
more were dropped for a DIFFERENT reason — not redundant, simply nothing to render:
`m37.body_release.completed`, whose own prior transition (`releaseBody`) REFUSES unless the M22
`body_release_authorization` document already exists, so completion produces no new artifact; and
`m27.cost_report.reopened`, which resets the report to `draft` with no job enqueued and nothing
requested. `m27.cost_report.submitted` follows the F-108 precedent directly — it enqueues the
`ecr-generation` job rather than requesting a render itself, and that job's own (already-bound)
`m27.artifact.render_requested` is the real handshake. `m37.body_release.funeral_home_identified` is the
ordinary case: `identifyFuneralHome` co-emits `m37.body_release.document_requested` in the same
transition. **Net: 8 of 66 m22 pairs resolved (429 → 421).** The other 58 divide three ways, verified
against the M22 spec's own §4.11 consumer table (`WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md`) rather than
assumed: events the spec explicitly names for a dedicated per-source consumer that was never built —
`packages/22-documents` has no `consumers/` directory at all, only the generic `outbox-consumers/`
document-request mirror, so EVERY spec-named dedicated consumer (`m11-order-results-received.ts`,
`m8-encounter-document-requested.ts`, `m5-patient-merged.ts`, and the rest) is unbuilt, not merely
unbound — these stay declared as real, spec-endorsed gaps (`m11.order.results_received`,
`m12.medication_order.{list_changed,draft_created_from_extraction}`, `m14.{packet.render_requested,
minutes.signed}`, `m15.plan.version_signed`, `m18.evv.aggregator_accepted`, `m5.patient.{merged,
draft_created_from_extraction}`, `m8.encounter.{signed,addendum_signed}`, `m39.consent.revoked`); events
named by no part of the spec with no redundant sibling, kept declared rather than dropped absent
stronger evidence (the F-101 sweep this needs has not been run on them); and one confirmed STALE
cross-reference worth its own line: `m9.assessment.summary_requested` is real, catalogued, request-
shaped, and already declares m22, while `M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS`' own comment calls the
same need `m9.assessment.document_requested` and asserts it is "declared by no catalog under any
spelling" — false, under this one, the F-100 `m37.body_release.document_requested` shape a second time,
where a wrong note in an anticipated-events list is what hid an already-bindable event. **A tooling
defect surfaced running `--update` on a module with two deferred-consumer groups** (M30, split by F-115
into `handlers-unbound` and `no-consumer-surface`), and is now fixed rather than merely reported.
`regenerate()`'s anchor lookup was `out.indexOf('module: "m30",')` with no search-from offset, so BOTH
groups' iterations resolved to the SAME first occurrence — the second iteration overwrote what the first
just wrote with its own (by then already-deleted) leftover, silently emptying one group's `events` array
while the other kept whatever was there. Caught immediately by the gate itself (4 pairs it could no
longer find in any registered deferral) and fixed by hand in that run rather than by re-running
`--update`, which would have repeated it identically. `regenerate()` now anchors on `module` + `kind`
TOGETHER, which is exact even when a module has several groups, and — the deeper half of the bug — never
lets one group's `--update` pass adopt an event a SIBLING group might actually own: a multi-group
module's existing groups only ever lose an event that resolved (no longer unbound), never gain one they
did not already list, and a genuinely new unbound pair for that module surfaces as its own fresh
`unclassified` stub rather than being guessed into whichever sibling group happened to run first.
Verified by running `--update` against the now-correct register: a no-op (byte-identical output), which
is the actual regression test — the exact case that used to corrupt M30's `handlers-unbound` group now
round-trips clean. Proven by `bun run scripts/check-outbox-bindings.ts` (0 disagreements post-fix), the
full non-live suite (one test pinned `m11.order.signed`'s exact consumer array and now asserts m22's
absence explicitly), and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced
disposable Postgres — `assertBindableAgainstCatalog` is the real boot-time proof that every dropped
declaration and untouched
gap still agrees with what is actually bound.

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
transition's entry effects are `dial_emergency_contact` / `surface_psap_number` / `page_wardenx_ops`, all
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

**#250's own scoping investigation was itself checked rather than trusted, and it was wrong about M25
and half-wrong about M23 (F-119).** A first-pass agent read `boot-assembly.ts`'s header and #250's issue
text and reported: M25's create route needs no fix (true — `internal.routes.ts`'s guard was already
retired from `systemPrincipal` to `actorKind` at commit `46414c60`, #75/#76, well before #250 — confirmed
by reading the route and the composition-root wiring directly, not by re-deriving the finding); and M23's
six seam areas are "5 of 6 wiring, 1 partial" with `macJurisdiction`/`cbsaCode` "a genuine missing fact —
no column, no derivation anywhere." **That second claim was false, checked against the schema rather
than assumed**: `mac_submitter_credential.mac_jurisdiction` is exactly that fact, admin-set per provider
entity during MAC portal onboarding, with a real repository already reading it
(`MacSubmitterCredentialRepository.findByProviderEntity`) — the investigation looked at `provider_entity`
alone and stopped. Bound for real, alongside `patientPayer` (M5, the M25 CARC/RARC precedent's mirror —
`activeCoverageOfKind` checked at BOTH the claim window's endpoints against the same coverage row, since
the seam answers one date and D15 needs the whole range) and two of `referenceData`'s four methods:
`wageIndexForCcn` and `activeSequestrationPolicy` both have real, already-migrated backing tables
(`wage_index_factor`, `sequestration_policy`) the investigation's "genuine new infrastructure" framing
had bundled together with `hippsRateTable`/`chcHourlyRateCents`, which really are unbuilt — no table
exists for either, confirmed by the `TODO(CMS-fixture)` already sitting in `packages/billing/src/hipps/
calculator.ts`'s own doc comment. Checked live rather than assumed empty a second time:
`wage_index_factor` is NOT actually empty — migration `0080_billing_m23_seed.sql` pre-seeds 5
REPRESENTATIVE placeholder rows for FY2026, explicitly marked "not authoritative," which the first draft
of this pass's own live test found the hard way (asserting `null` for CCN `999999` and getting back a
real placeholder row instead). **The other five of M23's eleven `ClaimAssemblySeams` methods turned out
to need more than "5 of 6 is wiring" implied, in the OPPOSITE direction from the M40 correction above**:
M6's published SeamRegistry readers (`ElectionPeriodReader`, etc.) are id- or single-date-keyed, never
"every period for this patient overlapping this range"; M8's `BillableEncounterReader` needs encounter
ids already in hand and its `SignedEncountersReader` digest carries no `cosignRequired`/`cosigned`/
`durationMinutes` — the exact three facts the SIA calculator needs; M18's `EvvComplianceReader` answers
one visit or a windowed rate, never a list of bracket snapshots; and M38's `TerminologyProvider` — the
seam this pass's own first draft cited as proof the M25 CARC/RARC adapter shape would transplant cleanly
— is a per-code lookup, while M23 wants a bulk pre-resolved value-set/ICD map with no codes given at
fetch time. Each is a real read-surface or contract gap in the OWNING module, not an M23-side wrapper,
and each is now named precisely in `boot-assembly.ts`'s header rather than folded back into one "6 seam
areas" estimate. **Net, stated without overclaiming**: 4 of 11 reader methods are bound to real data,
each individually live-tested against real rows under RLS
(`m23-claim-assembly-seams.live.test.ts`) — cross-tenant isolation proven on a genuinely RLS-enforced
`wardenx_app` connection (`_live-app-role.ts`), not the bare-superuser connection this repo's live-test
convention exists to catch. `POST /claims/assemble` remains unreachable end-to-end for every real caller
today: `assemble()`'s call order reaches `mdm.resolveProviderEntity` and the two bound `referenceData`
methods only AFTER `admission.resolveForRange` (M6), which is still unbound, so the live boundary moved
from the first read to the second — real, verified progress on exactly one seam step, stated as such
rather than as an unblock. `provider_entity` is M1-owned, so `resolveProviderEntity`'s CCN resolves
through the SAME `ProviderCcnPort` the write-service's control-number derivation already binds at the
composition root, not a second cross-module edge — `arch:tables` caught the first draft reading the
schema directly. Remains a follow-up: the M6/M8/M18 range/field-shape gaps above, M40's
`resolveClinicalParticipants` (physician/POS linking, genuinely unbuilt), and `hippsRateTable`/
`chcHourlyRateCents` (real CMS per-diem rate-file loading, no table exists).

**Five M11 catalogued signed events were computed and thrown away, and two of the two module boundaries
waiting on them are now bound (F-120, #248).** `packages/orders/src/catalog.ts`'s `downstreamSignedEvents`
has computed `hl7_orm_requested` / `supply_fulfillment_requested` / `level_of_care_change_signed` /
`recertification_signed` as a `transitionOrder` effect on every SIGN since the pure order machine
shipped — `orders-route-service-db.ts`'s `signInternal` called `transitionOrder` only for its guard/throw
and never read `.effects`, discarding all five. Two of the five catalog entries even asserted "M11 emits
the typed event today" for `supply_fulfillment_requested` and `hl7_orm_requested` — false, checked against
the actual write path rather than the comment, the F-119 shape again. A signed lab order never requested an
outbound HL7 ORM; a signed dme/supply/comfort_kit order never asked M21 to fulfill it; a signed
level-of-care-change/recertification order never told M6. **Fixed for the three kinds whose full
catalogued payload is derivable from data M11 already holds**: `emitDownstreamSignedEvent` builds each from
`order_record.data`, already validated at draft/request-signature time against the exact per-kind TypeBox
`packages/orders/src/kinds.ts` uses. `hl7_orm_requested` stays unbound — `OrmRequestedPayload` needs
patient demographics and a resolved M40 provider identity M11 does not hold, and M29's outbound ORM worker
is a from-scratch build (the pure wire builder, dispatch planner, ACK-correlation core, D9 retry/DLQ policy
and the operator list/retry routes all shipped at M29-T06/T08; the ingest sink that would call them is
still Wave H, per the module's own header). Writing the fix surfaced a second, independent defect:
`recertification`'s `periodEndDate` is `format: "date"` and `orders-typebox.ts` registered "uuid" and
"date-time" but never "date" — nine OTHER modules (M8/M9/M17/M19/M20/M23/M24/M27/M30/M35) register it
redundantly, so in the real app one of them always wins the race before a recertification is ever signed,
and the gap was invisible until a live test's narrower import graph hit it directly. Fixed with the same
idempotent `FormatRegistry.Has` guard the other nine already carry.
**M21's other two of the three `consumers/m11-orders.ts` deciders are now bound too** — the §7.7
cancellation cascade and the §2.2 DME monthly-rental close-out, both complete and unit-tested since
M21-T04, whose own file header said "the live outbox binding + the transactional insert land with the
§4.6 workers alongside the M21-T05 service layer": the service layer landed (`insertRequest`, D4 routing,
per-kind validation) and nothing was ever bound. Both consumed events were **already being emitted in
production** by the M11 discharge cascade (F-102) — every death/discharge on an admission with an open
`supply_request` has been cancelling the M11 order while leaving the DME rental or comfort-kit request
standing, the reciprocal of F-102's own finding one module downstream. `outbox-consumers/
m11-order-cascade.ts` runs the SAME `transitionSupplyRequest` + `runEffects` write path a route uses
(`patchSupplyRequest`, pulled out of `write-service-drizzle.ts`'s closure to module scope and exported, so
there is exactly one place that maps an `EffectPatch` onto the table — the F-100/F-103 "two write paths for
one table" lesson), with **no actor at all**: `routes/actor.ts`'s own doc comment says "the §4.5.1 inbound
cascades reach M21 through the outbox consumers, not through a route, and they attribute their rows to the
source event rather than to a human," and `writeActorOf` refuses a session with no membership — fabricating
one would misattribute a system cascade to a person who did nothing, on a DEA chain-of-custody-adjacent
table. **The THIRD decider, `decideSupplyFulfillmentIntake` (the §7.1 request that OPENS a `supply_request`
in the first place), stays unbound and is reported, not fixed**: its own IO resolver
(`consumers/order-context.ts`) already says why — "NO PLATFORM SEAM ANSWERS `resolveServingLocation`, and
that is a real gap rather than an oversight" — `supply_request.location_id` is NOT NULL and no fact (M2
Locations, M5 patient, M6 admission) says which Location serves a given patient. Binding it today would
mean either dead-lettering every delivery or inventing a Location-resolution heuristic the module's own
author explicitly declined to guess at, the `providerEntityFor` lesson one file over ("a guessed provider
entity is a mis-stated cost report") applied to Location instead. Proven live end to end over real
Postgres: `m11-downstream-signed-fanout.live.test.ts` (the real M11 write service signs each kind as
`wardenx_app`, asserts the exact catalogued payload, and confirms a signed lab order still emits neither
unbound event) and `m21-order-cascade.live.test.ts` (the real M6/M11 discharge cascade → the real
catalog-validating publisher → the real dispatcher → M21's two real consumers, under RLS: the pre-`ordered`
immediate cancel, the post-`ordered` two-phase `cancellation_pending`, `cancel_no_op` on an
already-terminal row, silent `no_match` when no request was ever opened, the monthly-rental completion via
a direct `discontinueOrder` call, and a one-shot kind correctly left alone). **Running total on #248: 509 →
419** declared-but-unbound pairs (this pass resolved the two `m21` entries; #248 remains open for the rest).

**M23's `POST /claims/assemble` boundary moved PAST the entire M6 block, and the gap was a missing
read-surface in the OWNING module, exactly as #251 scoped it (F-121).** #250 bound `patientPayer` (M5)
and left the wall at `admission.resolveForRange`; #251 named the five M6 `ClaimAssemblySeams` readers
(`admission`, `electionPeriods`, `certifications`, `faceToFace`, `levelOfCare`) as needing "a new
org-explicit M6 seam function… not an M23-side adapter" — M6's published §4.7 readers are id-keyed
(`listPeriodsForAdmission`) or single-date-keyed (`findActivePeriodForPatient`), and none answers "every
period/CTI/F2F/LOC-period for this PATIENT overlapping this RANGE". That function is now
`claimAssemblyRangeContextForOrg` (`06-admission/seams/drizzle-store.ts`), the
`admissionSchedulingContextForOrg`/`electionPeriodContextForOrg` org-explicit precedent extended to a
range query: it resolves the one admission whose episode overlaps the range, then every election period /
CTI / F2F / LOC period on it that overlaps the same window, in ONE `withOrgContext` transaction. **Three
projection decisions were checked against how `claim-assembly.ts` actually reads each field, not
assumed**: `electionPeriodSnapshot.effectiveTo` reads `actual_end_at` (null while open), never
`scheduled_end_at` (a forecast) — `_util.ts`'s own `effectivePeriodEnd` treats null as "open," so a
forecast value there would have closed every still-running period early; an open LOC period's `to` is
CLAMPED to the caller's `range.to` (the true end is unknown, but every day the HIPPS bucketer asks about
inside the claim window is already `<= range.to` by construction) while its `from` is left unclamped (real
start, `isWithinInclusive` only needs it `<=` a service date already inside the range); and
`attendingCosignRequired`/`attendingCosigned` derive from the CTI row's OWN `attending_md_id`/
`attending_md_signed_at`, not `admission.attending_physician_id` — the CTI is where §2.3.3's period-1
cosign requirement is actually tracked, and the write service's real `signCtiHospiceMd` path writes CTI
status straight to `signed` regardless of whether an attending was named, so `ctiSigned` (an overall-CTI
fact) and `attendingCosigned` (a specific one) are genuinely independent, not a derived pair. **Two fields
stay honestly `null`, not fabricated**: `chcDocumentedHours`/`gipAdmissionCriteriaDocumented` have no
producer anywhere in the schema — checked, not assumed, against both `level_of_care_period` and every M8
table — and the §4.5 `level_of_care_coherence` rule already treats `null` as "not satisfied" (CMS-correct:
silence is not compliance evidence), so returning it is honest rather than a new blocker.
`claim-assembly-seam-adapters.ts`'s `buildM23AdmissionRangeAdapters` wraps the one M6 read into the five
separate `ClaimAssemblySeams` shapes `assemble()` calls in sequence — each re-resolves the same range
independently rather than inventing cross-call memoization, since the seams are built once at BOOT with no
per-request handle to cache against and `POST /claims/assemble` is not a hot path. **Net reachability,
stated precisely**: `mdm.resolveProviderEntity` and `referenceData.{wageIndexForCcn,
activeSequestrationPolicy}` were already bound (#250) but sat BEHIND the M6 block in call order and were
therefore unreachable by a real request until now; binding M6 moves the live wall to
`referenceData.hippsRateTable` — still unbound (no CMS per-diem rate file has ever been loaded) — not to
an unblocked route. Proven by `m23-claim-assembly-seams.live.test.ts`: the real M6 admission→election→CTI→
activation chain through the production write service, a real LOC-period change, cross-tenant RLS
isolation (an admission in one org resolves to `null` from another org's read), the honest
`attendingCosignRequired: true, attendingCosigned: false` case, and the end-to-end `assemble()` boundary
now failing at `BillingReferenceDataReader` rather than `AdmissionContextReader`. #251's other items — M8's
two field/range gaps, M18's per-encounter-list gap, M38's bulk terminology gap, M40's clinical-participant
linking, the CMS rate-table load, and M25's X12-835 sidecar — remain open, each its own scoped item per the
issue's own "don't bundle these" instruction.

**M8's `billableEncounters`/`signedEncounters` bound for real, and tracing the ACTUAL caller found the
"field-shape gap" framing was half wrong (F-122, #251).** #251 recorded `signedEncounters` as needing
`cosignRequired`/`cosigned`/`durationMinutes` because `SignedEncounterSnapshot` declares them — checked
against `claim-assembly.ts`'s own `calculateSia` call, not assumed, only `durationMinutes` is actually
read; `cosignRequired`/`cosigned` are dead fields for this one caller, the `cbsaCode: null` shape from
#250's MDM adapter a second time. Both are still derived HONESTLY rather than omitted, because a future
consumer may read them, and the derivation reuses the platform's own authoritative source
(`COSIGN_REQUIRED_DISCIPLINES`, the same list `deriveBillability` keys on) rather than a join to the
`cosignature_request` workflow-tracking row. `durationMinutes` reuses the exact bracket-to-minutes rule
`skilledNursingDayTotalsForOrg` already established one function up in the same file: a row with no
`started_at`/`ended_at` bracket contributes `0`, never a fabricated value. Two new org-explicit M8 seam
functions (`billableEncountersInRangeForOrg`, `signedEncounterSnapshotsInRangeForOrg`,
`08-encounters/seams/drizzle-store.ts`) are the range read-surface `billableEncounters.forRange` needed —
the `admissionSchedulingContextForOrg` shape a third time, since M23's boot-time seam adapters have no
ambient request context. **Writing the range read surfaced a genuine, previously undocumented production
defect one layer down, the F-093/F-100/F-103 shape a fourth time**: `EncounterReaderStore.encounterFacts`
had been LIVE-REGISTERED since M8-T08 (`registerEncounterSeams` binds `BillableEncounterReader` at boot)
while `createDrizzleEncounterReaderStore` never overrode it — it fell through to the in-memory fallback's
empty default, seeded with nothing in production. So `BillableEncounterReader.billability(ids)` — the
seam CLAUDE.md itself, and #250/#251, had been citing as "real" — answered `[]` for ANY id, in every
deployment, for EVERY caller, not only M23's still-unbound `forRange`. Fixed alongside the new range read
by porting `encounterFacts` to the same real Drizzle query, reusing the existing pure `deriveBillability`
rule (`seams/readers.ts`) rather than re-deriving it a second time — the rule needs only DISCIPLINE +
`status` (no join to `cosignature_request` at all, since `deriveBillability` never reads the workflow row).
`billableEncountersInRangeForOrg` scopes to encounters that reached at least primary sign
(`signed`/`cosign_pending`/`cosigned`/`voided`) — a decision made at the NEW read's WHERE clause, not a
change to `deriveBillability` itself, since a pure `draft`/`finalized` note was never authored and has no
content a claim line could point at. **Net effect on `POST /claims/assemble` reachability: none, stated
precisely** — `billableEncounters`/`signedEncounters` sit LATER in the call order than
`referenceData.hippsRateTable` (still unbound on the CMS rate-table gap), so the live wall does not move;
this is real, individually-verified progress on two more seam steps, plus an independent production bug
fix, not a further unblock. Proven by `m23-claim-assembly-seams.live.test.ts`: real `billable`/
`awaiting_cosignature`/`not_billable` verdicts (a draft encounter absent from the result, not reported as
"not_billable"), cross-tenant RLS isolation, real duration-minutes math against a 90-minute bracket and a
0-minute no-bracket row, discipline-derived `cosignRequired` (`lpn` true, `rn` false), and
`encounterFacts` returning a real row for the first time under `runWithRequestContext`.

**`evvCompliance` needed a bridge across a module boundary neither side can cross alone (F-123, #251).**
M23's `bracketsForEncounters` is ENCOUNTER-keyed; M18's published `EvvComplianceReader.
bracketStateForVisit` is VISIT-keyed AND one-at-a-time (M23 has a LIST, from `billableEncounters.
forRange`); and the link between the two — `encounter.visit_id` — is M8-owned, so M18 cannot resolve it
itself: its manifest `dependsOn` is `[17]`, not `[8]`. Two new org-explicit seam functions, one per side —
M8's `encounterVisitIdsForOrg` and M18's bulk `complianceStatesForVisitsForOrg` (batching the same
`classify()` rule `bracketStateForVisit`/`bracketForVisit` already apply into two grouped scans instead of
one round trip per visit) — meet in a single M23 adapter (`buildM23EvvComplianceAdapter`), the one place
both facts are combined; neither M8 nor M18 imports the other. An encounter with NO visit (an ad-hoc note)
maps to `not_required` — the same default `classify()` uses for "no events, no resolution trail": no M17
visit means no EVV path exists to begin with, a different fact from "a visit exists but nothing was ever
captured." Net effect on `POST /claims/assemble` reachability: none, stated precisely — `evvCompliance`
sits later in call order than the still-unbound `referenceData.hippsRateTable`, so the live wall is
unmoved; real, individually-verified progress on a third M23 seam this pass, not a further unblock. Proven
by `m23-claim-assembly-seams.live.test.ts`: `compliant`/`unresolved_missing`/`documented_missing`/
`not_required` all resolved correctly over real `evv_event`/`evv_missing_resolution` rows, and cross-tenant
isolation (org A asking about org B's encounter gets `not_required`, never org B's real "compliant"
verdict, because M8's own org-scoped read finds no matching row to bridge from).

**`terminology` needed the RIGHT M38 method, not a new one, and binding it surfaced a value set that
had never existed (F-124, #251).** #250/#251's own scoping said M23's bulk `TerminologyResolution`
needed either "a bulk M38 method" or enumerating every value-set/ICD code the §11.A rule registry
references — a real design task, the header's framing implied, not a wrapper — because the M25 CARC/RARC
precedent this file used to cite reads M38 per-code (`lookup(system, code)`). Checked against
`TerminologyProvider`'s actual interface rather than assumed from that precedent: `expand(valueSetId)`
(§4.5) already IS the bulk method, published since M38-T05 with no caller anywhere for this purpose.
Checked against every rule file in `packages/billing/src/rules/`, not assumed: `modifier_codes_valid` is
the ONLY one of the 19 platform-default rules that reads `ctx.terminology.valueSetMembership`, and its own
`defaultParameters.valueSetId` is the only value set the platform boot ever asks this seam about (no
tenant/MAC rule-parameter overlay is read at assembly time today). `buildM23TerminologyAdapter`
(`claim-assembly-seam-adapters.ts`) needs no `boot-assembly.ts` port injection the way the M6/M8/M18
bridges did — M38's `TerminologyProvider` is already a registered M1-registry seam, so it resolves through
`getSeam` lazily per call, the exact `buildM23PatientPayerAdapter` shape. `includeTenantExtensions: true`
is load-bearing: a tenant may ADD a locally-valid modifier to the platform set (§7.6, add-only /
never-weaken), and omitting it would report that tenant's own approved code as invalid on every claim
carrying it. **Binding it surfaced a second, independent gap the M25 precedent had masked**: the value set
the rule references (renamed here from the pre-existing but never-realized `vs.cms-hospice-modifiers`
literal to the platform's own snake_case convention, `cms_hospice_modifiers`) had never been curated
anywhere — no migration, no seed row, nothing — so `expand()` would have answered an empty iterable
forever, the same shape F-057 already documented and degrades honestly for
(`hope_j_codes`/`hospice_terminal_diagnosis`). Two CMS-defined hospice modifiers, GV (attending physician
not employed/paid by the hospice) and GW (service unrelated to the terminal diagnosis), are now curated in
`@wardenx/terminology`'s seed alongside the platform's other small, fully-enumerated reference sets
(`level_of_care`, `place_of_service_q_codes`) — the same scale of fix, not the "no table exists" scale of
the CMS rate-table gap below. The constant is exported from `@wardenx/billing` (`CMS_HOSPICE_MODIFIER_
VALUE_SET`) so the rule and the M23 adapter share one literal rather than each carrying its own copy.
**`icd10Billable` is honestly `{}`, traced rather than assumed**: `icd10_sequencing` is the only reader of
that map, over `ctx.claim.icd10Sequence` — and `claim-assembly.ts`'s own line-assembly hardcodes
`icd10Sequence: []` on every claim it assembles today (no seam anywhere populates a diagnosis sequence at
assembly time; a separate, real M23-side gap this pass did not create and does not fix, reported here
rather than silently worked around). With no diagnosis code ever on the claim to ask about, there is
nothing to bulk-resolve. Net effect on `POST /claims/assemble` reachability: none, stated precisely —
`terminology` sits later in call order than the still-unbound `referenceData.hippsRateTable`, so the live
wall is unmoved; real, individually-verified progress on a fourth M23 seam this pass (patientPayer/M6/M8/
M18/terminology is now 10 of the 11 named ports), not a further unblock. Proven by
`m23-claim-assembly-seams.live.test.ts`: the platform value set resolves to exactly `["GV","GW"]`, an
org's own tenant extension (`value_set_tenant_extension`, seeded directly since hcpcs has no Phase-1
concept table and so no code on it could ever pass `addTenantExtension`'s own add-time validation — a
separate, real limit on who can extend an hcpcs-keyed set, reported and not fixed here) is included for
that org and NOT for a sibling org, and `icd10Billable` comes back empty.

**`mdm.resolveClinicalParticipants` was recorded as one "genuinely unbuilt" verdict, and it was two
independent facts with opposite answers (F-127, #251).** Physician IDENTITY is real, bound the M6/M8/M18/
M38 way: `admission.hospice_physician_id` and a SIGNED `election_statement.attending_physician_id` are
both M40 physician ids, and M6's F-121 range read (`claimAssemblyRangeContextForOrg`) now carries both —
extended in place, no new port — resolved through M40's already-registered `MdmEntityProvider.
resolvePhysician`. `NpiStatus` maps from M40's post-redirect `status` (`active`→`active`,
`deactivated`→`inactive`, `provisional`→`not_found` — a canonical row with no confirmed NPPES match yet);
`invalid` is never produced, since `external_physician.npi`'s own CHECK constraint guarantees any non-null
value is already 10 digits. **`licenseUnexpiredOnServiceDates` is honestly `false`, always, not a
fabricated pass**: M40's canonical physician record tracks which STATES a physician is licensed in
(`license_states`), never a per-state EXPIRY DATE — no table anywhere in this platform holds one. Checked
against `physician_credentials_active`'s own message before deciding this, not after: the rule used to say
"is expired on a service date", which asserts a confirmed fact this seam cannot back up, so the message is
now reworded (F-126) to "is not confirmed unexpired" — true whether the flag came from today's honest
default or a future real expiry check. **`placeOfService` stays genuinely unbound**, checked against the
whole schema rather than assumed: `patient_address.kind` distinguishes only `home`/`facility`/`mailing`/
`temporary`/`prior`, with no facility-type taxonomy underneath `facility`, and M40's
`CanonicalFacilityFields` carries `ccn`/`npi`/`sendingFacilityCodes` and no site-type field either — no
table anywhere records which of home/ALF/SNF/hospital/IPU a patient is currently receiving care in. That is
genuine new infrastructure, the `referenceData.hippsRateTable` shape, not a wiring gap, and is not guessed
at: a `patient_address.kind === 'facility'` heuristic could mean any of five different Q-code sites, the
"a guessed provider entity is a mis-stated cost report" mistake F-102 already named for a different module.
`place_of_service_consistency` therefore fails, honestly, for every claim until a real producer exists —
the rule's own `documentedPos === null` branch is the designed path for exactly this, the same shape F-121
established for `chcDocumentedHours`/`gipAdmissionCriteriaDocumented`.
**Binding the physician-identity half surfaced an independent, real Q-code defect (F-125, #251) that
predates this pass and had never executed**: `claim-assembly.ts`'s `qCodeForPlaceOfService` and
`@wardenx/billing`'s own `place_of_service_consistency` rule (`POS_BY_QCODE`) each carried an
independently-authored CMS Q5001–Q5010 mapping, and three of nine places disagreed between them — `snf`,
`ipu` and `hospital` each resolved to a DIFFERENT Q-code depending which side was asked — while an
unrecognized place silently defaulted to Q5006 ("inpatient hospice facility") under a doc comment that
called Q5006 "unspecified"; CMS's real catch-all is Q5009 ("place N.O.S."). The `m23_claim_line_q_code`
schema enum's own comments had the identical Q5005–Q5008 confusion, which is very likely where the wrong
mental model in `qCodeForPlaceOfService` came from. Never reachable in production before now — `assemble()`
only reaches this derivation after `mdm.resolveClinicalParticipants`, which has thrown `SEAM_UNBOUND` since
the route existed — so this was a live defect waiting for exactly the seam this pass binds. Fixed by making
`POS_BY_QCODE` (now exported) the one authoritative table and deriving `qCodeForPlaceOfService` from it
(inverted) rather than carrying a second copy, with the unknown-place default corrected to the honest
Q5009; the schema enum's comments were corrected to match. **Net effect on `POST /claims/assemble`
reachability: none, stated precisely** — the physician-identity bind sits later in call order than the
still-unbound `referenceData.hippsRateTable`, so the live wall is unmoved; real, individually-verified
progress on the fifth seam this pass (M6/M8/M18/M38/M40-physician-identity), not a further unblock. Proven
by `m23-claim-assembly-seams.live.test.ts`: a real admission's hospice physician (seeded `active` in a real
`external_physician` row) and attending (seeded `deactivated`) resolve to the correct `NpiStatus` and an
honest `licenseUnexpiredOnServiceDates: false`, `placeOfService` comes back `null`, no-admission and
cross-tenant cases both resolve every physician to `null` rather than leaking or fabricating one, and the
existing F-121 admission/election-period assertions were extended to the two new fields.

**M25's remaining #251 item genuinely is "real new infrastructure" — checked thoroughly rather than taken
on faith, and the checking itself found two things worth fixing (F-128, #251).** `#251` names it "X12-835
sidecar + clearinghouse-pull transport"; the module spec's own §10 implementation note (2026-08-05) already
says the same — the Python `x12-worker` sidecar is a SEPARATE service (ADR-0029: "not a TypeScript package
… a service declared in M1/services, out of the codePath model") that has never been deployed anywhere in
this repo or environment, and the 835-PULL half ("§10 Task #7's 835-pull worker was written as a literal
clearinghouse-polling worker, which this environment cannot build or test against real payer/SFTP
infrastructure") needs real per-provider-entity MAC-portal or clearinghouse credentials and a protocol
decision (SFTP? an API? many MACs, including Engrace's own NGS J6, are manual-portal-download only, not
programmatically pollable at all) — a data-source decision, the `referenceData.hippsRateTable` shape, not
application code. Nothing was built here for either reason, deliberately: a stub sidecar returning
fabricated parsed-835 data, or a guessed SFTP/API integration shape nothing in this codebase specifies,
would both be worse than the honest absence — financial remittance and denial data posted from invented
input is a materially different risk than the honest `null`s this session's other findings default to.
**What the checking DID find: the TypeScript side of the pipeline — everything on THIS side of "the raw
835 is already staged in MinIO" — is real, and one of its cross-module bridges had never been proven, plus
the whole file proving the rest of it had been running on a superuser connection.** `receiveAdvice` (route
32, real and mounted only when an ingest service is supplied), `postAdvice` (the live-dispatcher-bound
`m25.edi.835_received` consumer), and the sidecar HTTP transport (`m25X12WorkerConfigFromEnv` — a real
`fetch`-backed client, fail-closed only for want of `M25_X12_WORKER_URL`, exactly the deferred-not-broken
shape) are all genuinely built. The module spec's own 2026-08-05 correction note says the D3 auto-match /
PR-ledger patient-id bridge to M23 "remains unbound, same posture as M27's HCI/cap seams" — stale, checked
against the code rather than the note: `cost-report-seams.ts`'s `registerM23PublishedSeams` has registered
the real `ClaimSubmissionReader` seam at every boot with a db since WX-PR-012 landed, and
`buildM23BackedClaimMatchCandidateProvider` (`ingest/claim-match-adapter.ts`) already resolves through it.
**Nothing had ever proven that bridge reaches a real M23 claim, though** — `m25-835-ingestion.live.test.ts`
fed every match-dependent test a hand-rolled `fakeClaims()` double, which proves the M25-side `autoMatch`
ALGORITHM but not that `getSeam("ClaimSubmissionReader")` resolves to anything real. Two new cases seed an
actual M23 `claim` row (`repositories.ClaimRepository`, org-scoped) and drive `postAdvice` over the REAL
`buildM23BackedClaimMatchCandidateProvider()`: a same-org 835 line auto-matches by CLP01 to the real claim
id and resolves the real patient id for the PR-ledger, and a same-control-number claim seeded in a
DIFFERENT org is correctly invisible (`findMatchCandidates` scopes on `organization_id` AND
`provider_entity_id` together) rather than a cross-tenant false match. **Independently, the whole file was
a GAP-086 instance**: `handle.db` was built directly off the bare superuser `DB_URL` throughout — the exact
shape `_live-app-role.ts`'s own header describes ("a cross-tenant assertion made on a superuser connection
proves nothing at all") — so none of the file's seven pre-existing tests had ever proven the write path
(the envelope/line/service-line/adjustment/remark/denial_case/patient_responsibility_ledger inserts) is
RLS-clean; only one dedicated test at the very end role-switched, and only for a bare `SELECT`. Now
connects as the real NOBYPASSRLS `wardenx_app` role throughout. **The outcome is a genuine, not merely
hoped-for, clean bill of health**: all nine cases (seven pre-existing + two new) pass unchanged under real
RLS — this module's migrations already grant and policy the six tables the pipeline writes correctly; the
fix makes the file's own claim true rather than finding a defect it happened to have been hiding. Proven
live: `m25-835-ingestion.live.test.ts` (9/9, real RLS throughout), full non-live suite, all 38
`arch:fitness` gates, `db:migrate` + `db:provision-roles` + `check:boot:platform`.

  **The m14 group (51 pairs) was checked per-event against M14's OWN spec rather than trusted from six
  producing modules' `declaredConsumers`, and it disagreed at scale (F-129, #248).** Continuing #248's
  triage past the m22/m21/m14-D8 passes, the next-largest group was M14's remaining "M6 inclusion cache +
  M9/M10/M11/M12 'since last IDG' cache + M22 back-ref" bucket. F-101's own rule — the CONSUMING module's
  own spec table decides who consumes it, not the producing module's guess — applied at 8x the scale of
  its first use: M14's §4.5 table (mirrored exactly by `consumers/index.ts`'s `M14_OUTBOX_SUBSCRIPTIONS`,
  14 events) and `packages/idg/src/packet/builder.ts`'s typed build-input structs are the authoritative
  statement of what M14 actually reads, and 22 of the 51 declared pairs named neither. **All 22 were
  redundant with a documented build-time SEAM PULL, not merely unsupported by prose**: M7's 9 problem/
  goal/intervention/care-plan-version events and M39's 2 DPOA events are covered by `CarePlanSummaryInput`/
  `PacketCoverInput` reading M7's `CarePlanReader` and M5/M6/M7/M39 fresh per packet ("already projected to
  the packet cover shape" — never a push cache); M10's `timepoint_scheduled`/`timepoint_signed` are the
  same shape for `HopeContextInput`/`HopeTimepointProvider`; M6's `cti.drafted`/`.late_flagged`/`.voided`
  and `f2f.scheduled`/`.window_missed`/`.window_overridden` are the same shape for `PacketCoverInput`'s
  `nextRecertDueAt`/`f2fWindowState` (M6 owns CTI/F2F enforcement outright — M14 only ever reads it,
  per its own §1.1 dependency line); `m6.discharge.created` is redundant with `m6.admission.discharged`,
  M14's own real D9 inclusion-cache subscription on the SAME discharge transaction, carrying every fact
  D9's effect needs (`admissionId`/`dischargeDate`) while `discharge.created`'s richer fields serve M22/
  M23/M26 instead. Dropped `m14` from each event's `declaredConsumers` at the source
  (`events-by-m6.ts`/`events-by-m7.ts`/`events-by-m10.ts`/`events-by-m39.ts`), never here. **The reverse
  defect turned up in the same pass**: `m11.order.discontinued` is named by M14's own §4.5 table and
  `M14_OUTBOX_SUBSCRIPTIONS` for the projection cache, and M11's catalog had simply never declared `m14` —
  a real, spec-endorsed subscription that `assertBindableAgainstCatalog` would have refused the moment
  anyone tried to bind it live. Added at the source (`events-by-m11.ts`); the matching stale
  `outbox-subscription-exceptions.ts` entry (which had correctly diagnosed this as "NOT one of the D8
  auto-close sources… stays here with the rest of the unbuilt Valkey cache") is now redundant with the
  corrected catalog declaration and is deleted, per the gate's own message ("now both subscribed and
  declared — the exception has outlived its reason"). **The remaining 29 pairs split into two honest
  groups, not one**: the real, still-unbuilt "since last IDG"/inclusion-cache shape M14's own spec names
  (8 events — the two M6 inclusion-cache events, M9's `recorded`/`significant_change`, M10's
  `j2051_trigger_fired`/`sfv_created`, M11's `order.discontinued`, M12's `medication_order.discontinued`);
  and 22 events checked and found neither clearly redundant nor named anywhere in M14's spec (M6 admission
  on_hold/resumed + compliance-window open/overdue, M9's `assessment.amended`, M12's
  `medication_history_pulled`, all 12 of M13's eMAR events, all 3 of M15's discipline-care-plan events,
  M39's `consent.expiring_soon`) — kept declared rather than dropped absent stronger evidence, the F-101
  caution applied in the direction that avoids a false drop. Of those 22, `m13.scheduled_dose.missed` has
  the strongest surviving case to bind next: M14's own §1 packet description names "missed doses" as a
  `flaggedEvents` category and the payload (`missedDoseId`, `dueAt`, controlled/comfort-kit flags) maps
  directly onto `PacketFlaggedEventDigest`'s `missed_dose` kind, unlike the other 11 M13 events, the 3 M15
  events or M39's `expiring_soon`, none of which correlate to any documented packet field.
  **Net: 509 → 419 (prior passes) → 398** (22 dropped, 1 added, net −21). Verified: `bun run build` clean,
  `bun run typecheck` (the same 3 pre-existing, unrelated `m2-*.live.test.ts` TS2698 errors, confirmed via
  `git stash` predating this change), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements), full
  non-live suite 654 files / 9589 tests green, the four touched live suites
  (`m11-downstream-signed-fanout`, `m21-order-cascade`, `m6-cop-document-renders`, `m6-discharge-cascade`)
  passing individually against a fresh disposable Postgres, and a clean `check:boot:platform` run
  (the real `assertBindableAgainstCatalog` boot-time proof) against the same freshly migrated, RLS-enforced
  database. Leaving #248 open — 398 pairs across 32 modules remain.

  **The m27 group (23 pairs) was already scoped by its own prior-pass reason as needing exactly this
  per-event check, and it confirmed the reason was right about 21 of 23 and wrong about the last 2
  (F-130, #248).** M27's own §1.1 relationship inventory + manifest-patch `dependsOn` list
  (`[1,2,3,4,6,8,12,13,22,23,26,36,38,40]`) names every seam it actually reads BY METHOD — M6's
  `LevelOfCarePeriodReader`/`AdmissionCensusReader`, M8's `EncounterStatisticsProvider`, M23's
  `PatientDaysProvider`/`ClaimSettlementProvider` (forward-seam deny-stub), M26's
  `CapAccrualReader`/`CapPeriodReader` (forward-seam deny-stub) — and 21/24/37 are conspicuously absent
  from it. **21 of 23 pairs dropped**: all 5 M6 events (`admission.activated`/`.discharged`,
  `election.period_started`/`.period_ended`, `loc.changed` — the last IS the exact table
  `LevelOfCarePeriodReader` pulls), all 3 `m23.claim.*` events, all 6 `m26.cap.*` events — each
  redundant with a seam PULL M27's own spec names by method, triggered on-demand by the `statistics-
  refresh`/`Refresh Inputs` job, never a push subscription; all 3 `m24.medicaid_claim.*` events (M24
  is never named anywhere in M27's spec — Medicaid's billed-day contribution reaches M27 entirely
  through M23's `PatientDaysProvider`, which M27's own text says covers "by program (Medicare /
  Medicaid / other)"); all 3 `m37.*` events (M37 is named only in the OPPOSITE direction — M37 consumes
  M27's `CostReportProvider.getInpatientCapPositionAtFiscalDate`, and GIP/IPU level of care is already
  covered via M6's LOC-period pull regardless of physical site); and `m8.mileage.captured` (M27's spec
  never mentions mileage anywhere, and no worksheet or allocation-basis field in `packages/cost-report`
  reads it — the event's own "payroll/AP" phrasing is Gusto-side, pulled by M27's separate
  `wage-data-pull` job). Dropped at the source in each producing module's `events-by-mNN.ts`. **The
  remaining 2 are the opposite finding — a genuine, real, still-open forward seam, not a
  misdeclaration**: M21's own LOCKED spec (§1.1, D16 — "Does M21 own vendor invoice reconciliation?")
  explicitly commits M21 to emitting `m21.supply_request.invoice_accrued`/`.invoice_reconciled` for an
  M27-side accrual/GL-reconciliation consumer, citing "the M11 D6 / M13 D5 forward-seam precedent until
  M27 locks" — a real, cross-referenced decision on the PRODUCING side that M27's own spec simply never
  corroborates or builds a consumer for. Unlike M24/M37 (unsupported guesses with no decision behind
  them), this asymmetry is backed by an explicit committed decision, so it's kept declared as the
  honest open cross-module question it is rather than dropped on the strength of M27's silence alone —
  the F-101 caution against dropping without evidence, applied in the direction that avoids a false
  drop a second time in the same pass. **One incidental fix found while re-verifying the group stayed
  fully covered after the drop**: `m26.cap.settlement_proposed` had ONLY `declaredConsumers: ["m27"]`
  and no `seamConsumers` at all — dropping `m27` would have orphaned it entirely (0 consumers, caught
  by `m26-unit.test.ts`'s catalog-hygiene assertion). `cap_settlement` is one row per `cap_period`
  (proposed → finalized are two states of the SAME row), and its sibling `settlement_finalized` already
  declares `seamConsumers: ["m33"]` against it — added the same to `settlement_proposed`, the missing
  half of an existing pattern rather than a new one. **Net: 398 → 377** (21 dropped, 0 added). Verified:
  `bun run build` clean, `bun run typecheck` (same 3 pre-existing unrelated `m2-*.live.test.ts` errors),
  `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements), full non-live suite 654 files / 9589
  tests green, and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable
  Postgres. Leaving #248 open — 377 pairs across 32 modules remain.

  **The m26 group (22 pairs) checked the same way, against M26's own §4.4 consumer surface rather than
  the six producing modules' guesses, and it went 15/22 misdeclared — the opposite ratio from m27
  (F-131, #248).** `consumers/subscription-map.ts`'s `M26_SUBSCRIPTION_MAP` (the F-094/F-101 precedent:
  a consuming module's own constant is the authority) plus the module spec's exhaustive §3.1 file tree —
  which names exactly seven consumer files and no others — settled every event. **15 of 22 dropped.** All
  6 `m6.*` events (`admission.activated`/`.discharged`, `discharge.created`, `election.period_started`/
  `.period_ended`, `loc.changed`) are redundant with the documented `ElectionPeriodReader` PULL M26's own
  "Depends on" text names for benefit-period-anchored cap math — and `loc.changed` doubly so, since M26's
  own D13 names the INPATIENT (20%-rule) day source as M23 claim lines by revenue code (0655/0656), never
  M6 level-of-care periods, the identical "physical-site-independent" finding F-130 made for M27 one
  module over. `m23.claim.paid` is redundant with `m25.remittance.advice_posted`: M26's own text states
  "M25 is the authoritative paid-amount source — every cent traces to an 835-derived remittance line", so
  the claim-paid milestone itself carries no fact the subscription-map keys on (already correctly
  declared on `advice_posted` alone). `m23.claim.acknowledged` has no support anywhere in M26's consumer
  surface — an acknowledgment carries no paid amount, reversal, or inpatient-day fact. All 4
  `m24.medicaid_claim.*` events have no support of any kind: M26's own spec states outright "Medicaid
  payments are excluded from the Medicare aggregate cap (ADR-0017 D4)" and "M26's scope is strictly
  Medicare per 42 CFR §418.308" — a stronger, first-party exclusion than the m27 pass's M24 finding, which
  only lacked support rather than being expressly ruled out. All 3 `m37.*` events (`census.snapshot_taken`,
  `ipu_admission.discharged`/`.transferred`) have no support either — M37 is named nowhere in M26's
  "Depends on"/"Consumed by" text, the same unsupported-guess shape as m27's M37 cluster. All 15 dropped
  at the source in each producing module's `events-by-mNN.ts`. **7 of 22 kept, and they split two ways.**
  5 are the real, confirmed §4.4 subscriptions `M26_SUBSCRIPTION_MAP` names by action —
  `m23.claim.line_finalized` (`record-inpatient-day-line`), `.replaced`/`.voided`
  (`record-reversal-line`), `m25.remittance.advice_posted` (`record-accrual-line`),
  `m6.revocation.created`/`.transfer.created` (freeze / proportional-weight-init) — genuinely deferred
  behind the Drizzle `CapConsumerStore` bind (itself deferred behind the M5 MBI + M6 first-election
  readers), not misdeclared. The 7th, `m25.remittance.claim_recouped`, is the opposite finding from every
  drop above: M25's own locked §4.5 state-transition table names M26 outright — "`remittance_line`
  reversed (CLP02 = 22) | Emit `m25.remittance.claim_recouped` (M23 consumer + **M26 cap-reversal
  subscriber**)" — but `M26_SUBSCRIPTION_MAP` never built the consumer. Kept declared as the honest gap
  this is, rather than dropped on the strength of M26's silence alone — the F-101 caution applied in the
  keep-not-drop direction a second time in this same pass (5 dropped absent support, 1 kept despite
  absent support because the PRODUCING side's evidence here is a locked-spec transition-table entry, not
  a description gloss). **Checking it surfaced a genuine, pre-existing, unrelated defect, reported rather
  than fixed**: `handleClaimReversed` (`consumers/handlers.ts` — the already-built `record-reversal-line`
  handler backing the two confirmed `m23.claim.replaced`/`.voided` subscriptions) reads
  `p.patientId`/`p.claimId`/`p.priorPaidAmountCents` off the delivered payload, and NEITHER catalogued
  payload carries any of those fields (`{originalClaimId, replacementClaimId|voidClaimId, reason}` — no
  patient, no amount). Every real delivery would silently resolve `recorded: false` forever — invisible
  because no test exercises this action with a catalog-shaped payload, and the whole `CapConsumerStore`
  is unbound regardless so it has never run in anger. Wiring `claim_recouped` through the same handler
  would inherit the identical defect, since its payload carries no `patientId` either. Fixing it needs
  either richer M23/M24/M25 payloads or a by-claim accrual-line lookup `CapConsumerStore` does not
  expose — new design, not a catalog fix, left unbuilt. **Net: 377 → 362** (15 dropped, 0 added).
  Verified: `bun run build` clean, `bun run typecheck` (same 3 pre-existing unrelated
  `m2-*.live.test.ts` errors), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements), full
  non-live suite 654 files / 9589 tests green (one catalog-array assertion in
  `admission-outbox-jobs.test.ts` updated to match), and a clean `check:boot:platform` run against a
  freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 362 pairs across 32 modules
  remain.

  **The m34 group (21 pairs) went 21 of 21 misdeclared — every single one — the M28/F-115 shape a
  second time (F-132, #248).** M34's own spec is unusually exhaustive about the boundary: its "Depends
  on"/"Consumed by" header enumerates exactly `1,2,3,4,22,36` and `1,2,3,4,22,23,24,29,33,35`, its §3.1
  file tree lists exactly ONE consumer file (`consumers/m22-document-backref.ts`), and — the single most
  decisive line — its own D15 text COUNTS its M35 consumption: "the four seams M34 publishes plus **the
  ONE** M34 consumes from M35 (deny-stub today)," naming that one thing as
  `TenantSubscriptionEntitlementReader`. A quantified "ONE" is a much stronger contradiction than mere
  silence, and it directly refutes the 9 `m35.*` events (8 `subscription.*` + `tenant.billing_blocked`)
  that M35's OWN spec repeatedly (and specifically) describes as "M34 (when locked) consumes the event to
  gate feature access" — the producing side's aspirational guess, overridden by the consuming side's own
  more authoritative accounting, per F-101. **All 5 `m27.cost_report.*` events are the familiar
  push-declared/pull-actual shape**: M27's own §1.1 text names M34's real mechanism as a SEAM PULL —
  `CostReportFilingStatusReader.getOpenReportsForProvider`/`.getMostRecentSubmissionFor`, consulted
  on-demand at the tenant-offboarding gate and the compliance-posture dashboard summary, explicitly listed
  among M27's forward-seam-deny-stubs (never an outbox subscription). **Both M30 events are the identical
  shape**: M30's own §4.6 seam registry names `SecurityRiskAssessmentReader`'s only consumer as `['m34']`
  and `ComplianceStatusProvider`'s consumers as `['m28','m33','m34']`, consulted "at fiscal-year rollover"
  — a pull, not the `cop.status_changed`/`sra.cycle_closed` push these two events declared. **The
  `m23.mac_credential.updated`/`m24.medicaid_trading_partner.updated` pair looked like the strongest
  candidate for a genuine kept gap** — both producing modules describe it identically as "M34 (wizard
  completion signal)," and `mac_configured` IS one of M34's eleven canonical onboarding steps — but M34's
  own onboarding-step text settles it the other way: `ccn_registered → mac_configured`'s actual precondition
  is a seam pull (M29's `ExternalFeedReader`, with "Phase 1 uses platform-ops attestation," no automated
  credential check at all yet) evaluated on-demand by `precondition_dsl` at advance-attempt time, and the
  `tenant.onboarding_advance` worker's only documented trigger is M34's OWN self-emitted
  `m34.onboarding.task_completed` event — never a cross-module credential-upsert event. Dropped. **All 3
  `m20.safety.*` events had no support of any kind** — M20's own spec never names M34 anywhere, and M34's
  own text states plainly it "consumes no clinical predicates... M34's surface is platform-administrative
  not patient-clinical," the sharpest disclaimer in the corpus against exactly this cluster. All 21 dropped
  at the source in each producing module's `events-by-mNN.ts` (M20 ×3, M23 ×1, M24 ×1, M27 ×5, M30 ×2, M35
  ×9); the m34 group itself is now DELETED from `outbox-deferred-consumers.ts` rather than left empty,
  since a zero-event group is a group whose deferral has fully "outlived its reason." **Net: 362 → 341**
  (21 dropped, 0 added; 32 → 31 consumer modules). Verified: `bun run build` clean, `bun run typecheck`
  (same 3 pre-existing unrelated `m2-*.live.test.ts` errors), `arch:fitness` 38/38 (`arch:outbox-bindings`
  0 disagreements), full non-live suite 654 files / 9589 tests green with no pinned-array assertions to
  update this pass, and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced
  disposable Postgres. Leaving #248 open — 341 pairs across 31 modules remain.

  **The m17 group (14 pairs) went the opposite way from m34 — 12 of 14 were genuine, real, still-unbuilt
  subscriptions, and only 2 were misdeclared (F-133, #248).** `consumers/index.ts`'s own header already
  named the gap this pass confirmed at scale: M17's `M17_OUTBOX_SUBSCRIPTIONS` carries only 5 events
  (`m8.encounter.signed`, the 3 `m6.admission.*` lifecycle events, `m7.care_plan.version_signed`) despite
  the spec (D3/D14) naming EVV as the AUTHORITATIVE driver of the `published → en_route → in_visit →
  completed` visit lifecycle — the EVV-authoritative bracketing this module's own "done means" example
  walks through has never been wired. All 5 `m18.evv.*` events are explicit, decisive real subscriptions:
  M18's own catalog comments say outright "drive M17's visit-state transitions (D14)"
  (`check_in_recorded`/`check_out_recorded`), "the geofence-confirmation stream M17 Scheduling reads"
  (`at_patient_address`), "M8/M17 re-read the bracket" (`event_corrected`), and "flows to M17/M8/M23"
  (`late_check_resolved`). `m15.volunteer.assignment_inactivated` is M15's own catalog comment ("so M17
  must drop the volunteer from the schedule") feeding the `m17.reassignment_needed` day-view cascade M17's
  own D3 names — no reassignment-scan mechanism exists in M17 at all yet, for PTO, credential, or
  volunteer-gate reasons alike (the PTO half is "in-service" per a route comment; the other two have no
  cron or consumer anywhere). `m20.safety.high_risk_area_entered` and `.visit_cancellation_requested` are
  both explicit in M20's own "Consumed by 17" prose and §4.10 outbox table ("M17 also consumes... to
  surface a visit-row warning badge during scheduling"; "(M17 consumer cancels the visit)"). Both
  `m39.consent.delegated_access.granted`/`.revoked` are explicit in M39's own §4.10/§4.7 tables ("M17
  (portal-upcoming scope check)") — M17's `PortalVisitReader`/`ConsentEvaluator` caregiver-scope gate.
  `m8.encounter.orphan_recorded` is explicit in M17's own D2 decision row and §12 checklist ("consumer
  present in M17 (deny-stub until M8 publisher exists)"). **One, `m19.triage_call.visit_needed`, is kept
  on asymmetric evidence rather than dropped on M17's silence** — M17's own spec (locked first) never
  mentions the inbound direction, but M19's spec extensively and repeatedly documents it (§1, §2.2,
  acceptance criteria at §7.1/§7.9 with p95 performance targets) as the trigger for M17's D5
  proposal-worker path — the same "kept, not dropped" caution F-131 applied to `m25.remittance
  .claim_recouped`: a specific, cross-referenced, done-means-tested producing-side decision outweighs the
  consuming spec's mere silence. **2 of 14 were genuinely misdeclared and dropped at the source**:
  `m20.safety.check_in_recorded` — M20's own description says "info severity, no fan-out," and M20's own
  "Consumed by 17" text describes M17's day-view "last check-in" fact as a `SafetyDashboardProvider
  .clinicianStatusForLocation` seam PULL, never this push event (unlike the two kept M20 events, this
  row's §4.10 table entry also carries no "(M17 consumer...)" annotation); `m5.patient.address_changed` —
  M17's own spec (§7.10) states outright "M17 NEVER geocodes; geocoding requests are M5's geocode job
  which runs on `patient.address_changed` outbox" — M17 only ever reads the geocoded result afterward via
  the `PatientAddressReader` seam pull, and M5's own `jobs/index.ts` confirms the real (if still unbound)
  consumer is M5's own `m5.geocode_address` job, not M17. **Net: 341 → 339** (2 dropped, 0 added — the
  smallest net change of any group checked so far, and the first pass in this series where the group's
  original blanket reason turned out mostly right rather than mostly wrong). Verified: `bun run build`
  clean, `bun run typecheck` (same 3 pre-existing unrelated `m2-*.live.test.ts` errors), `arch:fitness`
  38/38 (`arch:outbox-bindings` 0 disagreements), full non-live suite 654 files / 9589 tests green with no
  pinned-array assertions to update this pass, and a clean `check:boot:platform` run against a freshly
  migrated, RLS-enforced disposable Postgres. Leaving #248 open — 339 pairs across 31 modules remain.

  **The m16 group (12 pairs) mostly confirmed the prior pass's own reason rather than overturning it —
  6 of 12 were real, still-blocked subscriptions and 6 were misdeclarations, all six variants of the
  same defect: a claim that some OTHER event "seeds the bereavement plan" (F-134, #248).** Checked
  per-event against M16's own §4.5 "Outbox Subscriptions (Consumers in M16)" table and
  `lifecycle/cascades.ts`'s three pure deciders, rather than trusting five producing modules'
  `declaredConsumers` guesses. **6 of 12 kept**: `m39.consent.revoked` (§2.6 opt-out cascade, backed by
  a real pure decider) and `m39.consent.signed` (§4.5's "post-death-grant handler", under the spec's
  stale name `consent.created` — M39's own catalog description says outright "the M16 post-mortem grant
  when bereavement"); `m5.patient.bereavement_opt_out_changed` (§4.5 + D9, backed by
  `decidePatientOptOutFlip`); `m6.admission.discharged` (filtered to `reason='death'`) — explicitly named
  in §4.5 as a deliberate "secondary verifier (redundant safety net)", not an oversight; `m6.discharge
  .cosigned` — the D18 gate-release decider, blocked producer-side (already documented by the prior
  pass's reason, unchanged here); `m37.ipu_admission.death_recorded` — named three times in M37's own
  spec as "M16 (bereavement onboarding)", kept on that asymmetric evidence despite M16's own spec being
  silent on M37 (the F-131 "kept, not dropped" caution). **6 of 12 dropped, all the same shape**:
  `m15.plan.discharged` and `m7.care_plan.discharged` each carried a producing-module description
  claiming to "seed the bereavement plan" — flatly false, since F-105 already established
  `m6.bereavement.eligible` is the ONLY creation path, and neither event is in M16's §4.5 table;
  `m6.admission.activated` — an ACTIVATION carries no fact a program that starts at DEATH needs, and was
  only ever part of that event's broad 15-consumer fan-out; `m6.discharge.death` — co-emitted from the
  SAME `runEffects` transition as `bereavement.eligible` (one `t.effects` map, one transition), and
  `bereavement.eligible`'s own description says it IS "the post-rule check on `m6.discharge.death`" —
  M16's real consumer reads only the derived event; `m5.patient.deceased` — a THIRD hop downstream of
  the same transaction (M5's own §7.8 death cascade reacting to `discharge.death`), carrying no fact
  M16's intake decider reads; `m39.consent.renewed` — unlike `.signed`/`.revoked`, no spec text or
  decider names a renewal-triggered action, reading as a mechanical carry-over from the sibling
  consent-lifecycle events' consumer lists. All 6 dropped at the source (M5, M6 ×2, M7, M15, M39), and
  `M16_SUBSCRIBED_EVENT_NAMES` (`packages/types/src/bereavement.ts`) — the F-095 rule-6 mirror of the
  catalog, checked both ways — updated to match, which the gate itself caught (`arch:outbox-bindings`
  failed with 6 fresh "does not declare 'm16'" disagreements until the list was corrected in the same
  change). **Net: 339 → 333** (6 dropped, 0 added). Verified: `bun run build` clean, `bun run typecheck`
  (same 3 pre-existing unrelated `m2-*.live.test.ts` errors), `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements after the subscription-list fix), full non-live suite 654
  files / 9589 tests green (two pinned-array assertions updated — `admission-outbox-jobs.test.ts`'s
  activation fan-out and `outbox-seam-consumers.test.ts`'s seam-split case, both to drop `m16`), and a
  clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving
  #248 open — 333 pairs across 31 modules remain.

  **The m25 group (11 pairs) went 9 of 11 misdeclared — the opposite ratio from m16, and the reason was
  the group's own claim taken at face value instead of checked (F-135, #248).** The group's original
  reason read "M25 binds one live consumer; the rest sit on its `consumers/` subscription-map surface,
  forward-declared and inert" — true of the mechanism, false about WHICH events sit on that surface.
  M25's own §4.4 spec text (the `boot.ts` subscribe-list pseudocode) and its real, frozen
  `consumers/subscription-map.ts` both name exactly THREE inbound topics: `m23.claim.rejected` (the
  277CA-derived pre-835 denial-worklist seed, D2/D3), `m18.evv.aggregator_rejected` (the EVV-aggregator
  denial seed, M18 §4.10), and `m22.document.rendered` (the appeal-packet/resolution-letter back-ref,
  already bound). **2 of 11 kept**: `m23.claim.rejected` and `m18.evv.aggregator_rejected` — both have
  written, unit-tested handlers (`handleClaimRejected`, `handleEvvAggregatorRejected`) sitting on that
  same subscription map, genuinely deferred pending the live relay bind, the same posture as M26/M27.
  **9 of 11 dropped, none of them present in M25's own subscribe list under any spelling**:
  `m23.claim.acknowledged`/`.acknowledgment_partial`/`.submitted` and all five
  `m24.medicaid_claim.{submitted,acknowledged,acknowledgment_partial,rejected,denied}` events carry no
  CARC/denial fact for M25 to act on — only a REJECTION (277CA or its EVV-aggregator sibling) seeds a
  worklist row before an 835 lands, and M25's own D9 states it pulls the Medicaid 835 itself over M24's
  per-state channel rather than subscribing to any M24 claim-lifecycle event at all. Two of the nine are
  a sharper defect than "unsupported": `m23.claim.denied` and `m24.medicaid_claim.denied` are each M25's
  OWN OUTPUT read backwards — both events' own descriptions say the DENIED transition only fires after
  "M25 posted a denial 835", so M25 is the PRODUCER of the fact behind each event, not a consumer of it.
  All 9 dropped at the source in each producing module's `events-by-mNN.ts` (M23 ×4, M24 ×5) — every one
  already carried a `seamConsumers` entry (`m33`/`m36`), so none were orphaned by the drop. Net:
  **333 → 324** (9 dropped, 0 added). Verified: `bun run build` clean, `bun run typecheck` (same 3
  pre-existing unrelated `m2-*.live.test.ts` errors), `arch:fitness` 38/38 (`arch:outbox-bindings` 0
  disagreements), full non-live suite 654 files / 9589 tests green with no pinned-array assertions to
  update this pass, and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced
  disposable Postgres. Leaving #248 open — 324 pairs across 31 modules remain.

  **The m23 group (20 pairs) went 12 of 20 misdeclared across seven producing modules, checked against
  M23's own §4.4 subscription surface rather than trusted (F-136, #248).** M23's own spec text (the full
  M6 outbox catalog, quoted by NAME in the dependsOn prose) and its real, frozen
  `consumers/subscription-map.ts` (seven live topics + two M25/M26 deny-stubs) are the authoritative
  statement of what M23 actually subscribes to. **8 of 20 kept** — genuine, real, still-unbound
  subscriptions: the six already on the map (`m6.cti.signed`, `m6.f2f.attested`, `m6.loc.changed`,
  `m8.encounter.cosigned`, `m5.patient.deceased`, `m18.evv.late_check_resolved`), plus two the map has
  not caught up to — `m6.election.period_ended` (the spec's own text names it beside the already-mapped
  `period_started` as "claim-period anchoring") and `m25.taxonomy.unmapped_code_observed`, kept on M25's
  own D13 text naming a specific, decided mechanism despite M23's spec being silent on it — the F-131
  "kept, not dropped" caution a third time. **12 of 20 dropped, spanning M5/M6/M11/M23(self)/M25/M37**:
  `m11.order.level_of_care_change_signed`/`.recertification_signed` are each redundant with M6's own
  resulting `loc.changed`/`cti.signed` (already bound) — the order-signed event is one hop upstream of
  the fact M23 actually reads, the F-120 co-emission shape applied a module over; `m23.claim.draft_created`
  is M23 consuming its OWN event, directly contradicted by the spec's own state-transition table ("M33,
  M22 — no render yet"); `m25.denial.resolved_favorable_via_appeal` is redundant with the already-bound
  `m25.remittance.claim_paid` — M23's own claim state machine says the PAID transition is driven by the
  835 RE-POST, not the appeal decision, which carries no payment fact of its own; all four `m37.*` events
  (`census.snapshot_taken`, `ipu_admission.bed_assigned`/`.discharged`/`.transferred`) have no support in
  M23's spec at all — the only M37↔M23 relationship runs the OPPOSITE direction (M37 reads M23's
  `ClaimReader`) — and `bed_assigned`'s specific claim that "M23 writes the place-of-service Q-code" is
  directly contradicted by F-127's already-established finding that `placeOfService` is genuinely unbound
  platform-wide, no site-type table exists anywhere; `m5.patient.payer_changed` is a seam-pull
  redundancy — M23's own spec states patient-payer status is CONSULTED fresh at every claim assembly,
  never pushed, so there is nothing for a push event to invalidate; `m6.admission.activated` and
  `m6.admission.discharged` were each part of that event's broad clinical fan-out with no billing-specific
  rationale (the F-134 shape already found for m16 on these SAME two events) and each is redundant with a
  narrower, already-bound sibling (`m6.discharge.created` carries the discharge_event id
  `admission.discharged` does not); `m6.nor.acknowledged` (Notice of Rights) is never mentioned anywhere
  in M23's spec — M22 remains its one real consumer. All 12 dropped at the source (M5 ×1, M6 ×3, M11 ×2,
  M23 ×1 self, M25 ×1, M37 ×4); every touched entry already carried other real consumers or a
  `seamConsumers` fallback except `m37.ipu_admission.transferred`, which had ONLY `["m23"]` and is now
  legitimately record-only, matching several sibling M37 events already in that state. **Also fixed in
  this pass, at the user's request**: the three pre-existing, unrelated `m2-*.live.test.ts` TS2698
  errors (`Spread types may only be created from object types`) that every prior pass in this series had
  carried forward as "same 3 pre-existing errors" — both files typed their outbox-publisher adapter's
  closure params as `(tx: never, input: never)` to force an assignment through an `as never` cast, then
  tried to spread the `never`-typed `input`, which TypeScript correctly refuses. Fixed by typing the
  adapter against the real port interface (`OrganizationLifecycleOutboxPort` /
  `Parameters<typeof createOrgScopedIdentityOutbox>[1]`) instead of casting past it — `bun run typecheck`
  is now fully clean, zero errors, for the first time in this series. Net on #248: **324 → 312**
  (12 dropped, 0 added). Verified: `bun run build`
  clean, `bun run typecheck` clean (0 errors — the 3 pre-existing fixed), full non-live suite 654 files /
  9589 tests green (two pinned-array assertions updated — `admission-outbox-jobs.test.ts`'s activation
  fan-out and `outbox-seam-consumers.test.ts`'s seam-split case, both to drop `m23`), `arch:fitness`
  38/38 (`arch:outbox-bindings` 0 disagreements), the two newly-typechecked `m2-*.live.test.ts` files run
  individually against a live disposable Postgres (9/9 passing, unchanged behavior), and a clean
  `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248
  open — 312 pairs across 31 modules remain.

  **The m11 group (10 pairs) went the opposite way from m23 — 9 of 10 were genuine, real, still-unbound
  subscriptions, and only 1 was misdeclared (F-137, #248).** Checked against M11's own spec's
  authoritative "Outbox events consumed" list, and — where M11's own text was silent — against the
  PRODUCING module's spec for a specific, decided, cross-referenced claim (the F-131/F-133 "kept, not
  dropped" caution, applied a fifth time). **9 of 10 kept**: `m9.assessment.significant_change` is on
  M11's own live subscription list (`consumers/index.ts`'s `M11_OUTBOX_SUBSCRIPTIONS`) with a written,
  unit-tested decider (`consumers/assessment-trigger.ts`) — deferred only because nothing binds it to the
  dispatcher yet, same as the already-registered `m10.hope.j2051_trigger_fired` gap one line above it.
  The three `m21.supply_request.*` events (`cancel_no_op`/`cancelled`/`status_changed`) are each
  individually named by M21's own catalog description as a real M11 relationship ("M11 auto-completes a
  one-shot order…", "M11 releases the source order", "Emitted so M11 learns the cascade ARRIVED… M11
  would hold the order open forever") and `status_changed` additionally matches M11's own spec text (§4.5,
  the "auto-complete one-shots" cron) — M11 carries no consumer file yet (`m21-fulfillment-status.ts`,
  named in the spec's own file tree, was never built). The two `m39.consent.dpoa.*` events are named for
  M11 twice over in M39's own spec — its outbox table ("M11 (attribution refresh)") and its
  `dpoa_healthcare` revocation-cascade table ("M11 (acting-consent revalidation on active orders)") — plus
  a checklist item stating outright "Event `m39.consent.dpoa.agent_appointed` → M7/M11/M14 backref
  consumers stubbed." The three `m7.intervention.*` events are named by M7's own mutation-consumer table
  ("M14, M11 (if linked)"), and M7's schema carries a `linked_order_id` column precisely for this handoff
  — M7's architecture note states the PULL direction runs the other way (M11 reads M7 when authoring a
  care-plan-driven order) but the same table still names M11 as a push consumer for the linked-order case,
  a genuinely different relationship from the pull. **1 of 10 dropped**: `m6.admission.activated` had no
  support anywhere — M11's own consumed-events list never names it, and no file, decider, or even a
  comment in `11-orders/` mentions admission activation at all — the same broad-fan-out-no-rationale shape
  F-134/F-136 already found for m16/m23 on this identical event. Dropped at the source
  (`events-by-m6.ts`). Net on #248: **312 → 311** (1 dropped, 0 added). Verified: `bun run build` clean,
  `bun run typecheck` clean (0 errors), full non-live suite 654 files / 9589 tests green (two pinned-array
  assertions updated — `admission-outbox-jobs.test.ts` and `outbox-seam-consumers.test.ts`, both to drop
  `m11` from `m6.admission.activated`'s clinical fan-out), `arch:fitness` 38/38 (`arch:outbox-bindings` 0
  disagreements), and a clean `check:boot:platform` run against a freshly migrated, RLS-enforced
  disposable Postgres. Leaving #248 open — 311 pairs across 31 modules remain.

  **The m5 group (10 pairs) confirmed the same "mostly real" pattern as m11 — 9 of 10 kept, 1 dropped
  (F-138, #248).** Checked against M5's own spec text and, where M5 was silent, against the producing
  module's spec for a specific, decided, cross-referenced claim. **9 of 10 kept**: all six
  `m39.consent.*` events (`expired`/`recipient_removed`/`renewed`/`revoked`/`signed`/`supersedes`) are
  named individually, by event, in M39's own outbox table (each row lists M5 among the consumers) and
  repeated in M39's D-M5-interaction prose — the `patient.privacy_flag_snapshot` recompute is a real
  mechanism with no consumer file built yet. `m17.visit.assigned`/`.unassigned` are named by M17's own
  catalog description and confirmed by M5's own §4.1 `CaseloadProvider` seam source comment, which
  describes the mechanism at code level: "Module 17 publishes `shift.visit_assigned` to a per-clinician
  Valkey set TTLed to the shift window" — a decided, still-unbuilt cache. `m6.admission.activated` is
  named by M5's own §3.3 tenancy-columns note (M05-F04/ARCH-011): `patient.provider_entity_id`/
  `location_id` are "populated (and denormalized onto every patient-scoped child table) when the
  admission activates" — confirmed no write path anywhere in the repository sets either column, so the
  consumer is genuinely unbuilt rather than misdeclared. **1 of 10 dropped**: `m24.medicaid_eligibility
  .checked` ran the relationship in the OPPOSITE direction — M5's own spec states its
  `patient.address_changed` triggers M24 to re-check eligibility (M24 reads M5, a seam pull at
  claim-assembly time per M24's own text), and no part of M5's spec names M24 or "medicaid_eligibility"
  as something M5 consumes. Dropped at the source (`events-by-m24.ts`); the event keeps its
  `seamConsumers: ["m33"]` so nothing is orphaned. Net on #248: **311 → 310** (1 dropped, 0 added).
  Verified: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654 files /
  9589 tests green with no pinned-array assertions to update this pass, `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements), and a clean `check:boot:platform` run against a freshly
  migrated, RLS-enforced disposable Postgres. Leaving #248 open — 310 pairs across 31 modules remain.

  **The m31 group (11 pairs) went 6 kept / 5 dropped on the forward check, and — uniquely among every
  group checked so far — the SAME per-event check surfaced 6 real declarations missing from the catalog
  entirely, because M31's own hand-maintained `M31_SUBSCRIBED_EVENT_NAMES` mirror
  (`packages/types/src/portal.ts`) had already flagged them as "subscribed and not routed here"
  (F-139, #248).** Checked against M31's own authoritative §4.10 "M31 consumes" table (13 named source
  events, each with a real consumer-file name) and, for the drops, against the same spec's §4.4
  "Depends on" text naming a seam PULL instead. **6 of 11 original pairs kept**: `m16.bereavement
  .contact_active` (M16's OWN outbox table names M31 explicitly — the F-131 "kept, not dropped"
  caution), `m17.visit.cancelled`/`.rescheduled` (telehealth-scoped, named consumer files that force-end
  or re-mint the vendor room), `m39.consent.delegated_access.granted`/`.revoked` (the real, decided D10
  mechanism for `family_caregiver_access` grant creation/cascade-revoke), and `m8.encounter.signed`
  (telehealth-attached, flips `telehealth_visit.lifecycle_state='reconciled'`). **5 of 11 dropped**: all
  three M12 events and `m13.administration.recorded` are each redundant with a documented seam pull M31's
  own §4.4 text names by method (`MedicationOrderProvider.getPortalMedicationSummary`,
  `MedicationAdministrationProvider.getPortalAdministrationSummary`) — M31's §4.10 table names no M12 or
  M13 event at all; `m17.caregiver_reminder_due` is disclaimed outright by M31's own text ("M22's domain
  … exposed in M31's preference UI"). All dropped at the source in each producing module's
  `events-by-mNN.ts`. **Checking the full §4.10 table surfaced the reverse defect too (F-102/F-106/F-129
  shape, at unusual scale): 6 events M31's own table names with a real consumer file had NO m31
  declaration anywhere in the catalog** — `m17.visit.published` (room-mint enqueue), `m6.admission
  .discharged` (both `reason` branches — bereaved transition / 30-day grace timer), `m22.document
  .rendered` (patient-facing kinds), `m16.bereavement.plan_opened`/`.plan_closed_completed` (plan-level
  bereaved-scope flip / grant revocation, distinct from the per-contact `contact_active` fact kept
  above), and `m39.consent.revoked` (the BROAD any-consent-type cascade — genuinely wider than
  `delegated_access.revoked`'s family-caregiver-only scope, so not redundant with it). All six now
  declared at the source. `buildOutboxRoutingPlan`'s own header line — "available bindings are live even
  when another declared module is not yet wired" — is what makes this safe: adding m31 to
  `m17.visit.published`/`m22.document.rendered` does not interrupt their existing live delivery to
  m8/m18/m20 or to M22's five other consumers, it only keeps those rows `pending` instead of `dispatched`
  until M31 also binds, confirmed by reading `outbox-dispatcher.ts`'s claim loop directly (bound
  consumers' handlers run BEFORE the `deferred` check, not gated by it). **Two of M31's own
  `M31_SUBSCRIBED_EVENT_NAMES` entries were checked and deliberately NOT added, on the producing module's
  more decisive say-so — the opposite of F-101's usual direction, and worth naming as its own pattern**:
  `m39.consent.created` — M39's own outbox table states its consumers as "(none — drafts are internal)",
  a first-party disclaimer stronger than M31's aspirational spec text, since a draft "carries no
  regulatory force" and gating a portal grant on one would be premature; and `m4.legal_hold.applied`/
  `.released` — M4's own module spec (§M04-F03) commits this fact to a registered `HoldApplier` SEAM per
  data-owning module (the same pattern as `DataEraser`), never an outbox subscription, and
  `events-by-m4.ts`'s own header says declaring a consumer here "would be a namespace lie." Both stay
  exactly as `outbox-subscription-exceptions.ts` already filed them; M31 registering a `HoldApplier` is
  real, unbuilt work, but it is not an outbox-catalog fix. `M31_SUBSCRIBED_EVENT_NAMES` itself was
  corrected to match — the 5 dropped names removed outright, the 6 added names moved from "not routed
  here" into the declaring bucket. Net on #248: **310 → 311** (5 dropped, 6 added — count unchanged
  because the reverse-direction discoveries offset the forward-direction drops almost exactly). Verified:
  `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654 files / 9589 tests
  green (two pinned-array assertions updated — `clinical-consumer-contracts.test.ts`'s M17
  visit-publication test now asserts `m31` deferred alongside m8/m18/m20's still-live delivery, and
  `document-backref-consumers.test.ts`'s declared-consumers pin), `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements both directions), and a clean `check:boot:platform` run against
  a freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 311 pairs across 31 modules
  remain.

  **Four groups checked in parallel by four independent research subagents (m19, m13, m24, m8 — all
  tied at 8 pairs), with the coordinator applying, cross-verifying and committing every finding centrally
  to avoid four agents racing to edit the same shared registry files (F-140, #248).** Each agent
  investigated one module against its own authoritative spec/subscription surface, exactly per this
  series' established method; every non-trivial claim (self-consumption verdicts, reverse-direction
  additions, seam-vs-push distinctions) was independently re-verified against the actual code before
  being applied. **m19 (On-Call Triage) — 1 kept, 7 dropped.** `m17.visit.assigned` is decisive and
  specific in M19's own locked spec (a named job, `m19.shift-sync.debounced`, and consumer file,
  `m17-roster-changed.consumer.ts`) despite M17's own stale "Phase 2" gloss on the event. The other 7 are
  each a seam pull M19's own spec describes at the point of use — PTO/reassignment eligibility via an M17
  reader, portal-caregiver consent via `ConsentEvaluator.isActive`, and (the reverse-direction trap
  avoided) M20's own LOCKED D14 decision that its after-hours recipient set PULLS M19's `OnCallProvider`
  seam "without M19 needing to know about safety alerts" — never a push to M19. **m8 (Encounters) — 0
  kept, all 8 dropped.** M8's own spec is unusually decisive: "Outbox publication is the only
  cross-module communication M8 performs AT THE BOUNDARY" — every upstream fact (the M18 EVV bracket, M6
  admission state, M7's care-plan overdue gate) is an in-process SEAM call, confirmed at the code level in
  `seams/index.ts`'s own comments ("M8 also CONSUMES M7's §7.8 CarePlanReader... a boot-validated seam,
  NOT a schema import"). The group is fully resolved and deleted from the registry outright (31 → 30
  modules), the F-132 precedent. **m13 (eMAR) — 7 kept, 1 dropped, plus 4 reverse additions.** M13's own
  live `M13_OUTBOX_SUBSCRIPTIONS` list (11 entries, each a real decider under `decideReconciliationTrigger`)
  settled most of it directly; `m21.comfort_kit.replenished`/`.return_reconciliation` are kept despite not
  yet being on that list, on M21's own decisive catalog text ("M13 tops the existing deployment up" /
  "M13 closes its drawdowns", the payload even carrying `m13DeploymentId`) — the F-131 caution.
  `m37.iv_safety_overlay.required` is dropped: both M37's and M13's own text agree this is a SEAM PULL
  (`IpuIvSafetyOverlayProvider.getOverlayForOrder`), and M13's subscription list names no M37 event at
  all — moved to `seamConsumers`. The reverse check found 4 real gaps already on M13's own subscription
  list with a named decider each — `m6.admission.activated`, `m6.discharge.created`,
  `m6.admission.discharged`, `m6.cti.signed` — all four also correctly pre-diagnosed by a stale
  `outbox-subscription-exceptions.ts` entry, now deleted since the catalog agrees. **m24
  (Billing-Medicaid) — 1 kept, 7 dropped, plus 5 reverse additions.** M24's own authoritative
  `M24_SUBSCRIPTION_MAP` (8 topics, each a real handler in `consumers/handlers.ts`) settled it: kept
  `m5.patient.address_changed`; dropped the three `m18.evv.aggregator_*` events (M24's own D9 decision
  explicitly REJECTS "M24 owns its own EVV gate without consuming M18's seam" as a boundary violation —
  the real mechanism is `EvvComplianceReader.bracketStateForVisit`, a seam pull), both self-declared
  `m24.medicaid_claim.submission_failed`/`.medicaid_eligibility.refresh_requested` (no handler exists for
  the first; the second is never emitted anywhere), `m5.patient.payer_changed` (redundant with a seam,
  the identical F-136 shape one module over), and `m8.encounter.cosigned` (absent from the subscription
  map, which names only `.signed`). The reverse check found 5 real gaps on the subscription map with a
  named handler each — `m23.claim.acknowledged` (`resolve-medicare-primary`, the COB precondition for
  billing Medicaid secondary once Medicare pays primary), `m5.patient.updated`, `m8.encounter.signed`
  (both `trigger-revalidate`), and `m25.remittance.claim_paid`/`.claim_denied` (`mark-claim-paid`/
  `mark-claim-denied`). The M25 pair's own stale exception entry assumed declaring `m24` would interrupt
  M23's live delivery to those two events — the same mistaken belief F-139/m31 already corrected
  (`buildOutboxRoutingPlan` delivers to every bound consumer regardless of what else is declared); deleted
  along with the entry for the other three. **Net on #248: 311 → 297** (23 dropped, 9 added, one group
  fully resolved — 31 → 30 modules). Verified centrally, once, after all four groups' edits landed
  together: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654 files /
  9589 tests green (four pinned-array assertions updated — `admission-outbox-jobs.test.ts`,
  `care-plan-outbox-jobs.test.ts`, `encounter-outbox.test.ts`, `outbox-seam-consumers.test.ts`, all to
  drop `m8` and/or `m24` from their respective fan-out lists), `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements both directions — this pass's own `M19_SUBSCRIBED_EVENT_NAMES`
  mirror needed the same correction the m31 pass made to `M31_SUBSCRIBED_EVENT_NAMES`), and a clean
  `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248
  open — 297 pairs across 30 modules remain.

  **A second round of four groups checked in parallel (m18, m21, m29, m1), continuing the F-140
  pattern — research-only forks, coordinator applies and verifies centrally (F-141, #248).** **m18
  (EVV) — 1 kept, 5 dropped, plus 1 reverse addition.** M18's own locked D14 is exhaustive about what
  it consumes ("M18 consumes `m17.visit.published` ... and `m17.visit.cancelled`") — only
  `m17.visit.cancelled` survives; `.completed`/`.rescheduled`/`.started` and both
  `m39.consent.delegated_access.*` events have no support in D14 or D16's dependsOn list (which never
  names M39). `m17.visit.late_check_out_suspected` was the sharpest case: M17's own spec glosses it as
  "consumed by M18," directly contradicted by M18's own D14/D6/job-catalog, which describe the
  identical late-checkout-detection mechanism as M18's OWN `late-check-sweep` cron (a listed M18
  BullMQ worker) — the F-101 rule (trust the consumer over the producer's guess) resolves the
  disagreement, and the event is now record-only. The reverse check found a real, decisive, previously
  undeclared subscription: `m8.encounter.signed`, named by M18's own D6, its job catalog
  (`m18.encounter-signed.consumer`, "on m8.encounter.signed outbox"), and its "Done means" walkthrough
  as the auto-close path for a `closed_documented_at_encounter` missing-checkout resolution — added.
  Writing that addition surfaced an independent, unfixed payload gap, reported rather than fixed: the
  locked `m8.encounter.signed` payload does not carry `evvMissingReason` (the field exists on the
  encounter route/schema, just not on this outbox contract), so M18's real consumer cannot yet read the
  fact it needs from this event. **m21 (Supplies/DME/Comfort Kits) — 7 kept, 0 dropped, 0 added.**
  Checked against M21's own authoritative `M21_SUBSCRIBED_EVENT_NAMES` mirror and spec text — every
  pair confirmed genuine: `m11.order.signed` and the four `m13.comfort_kit.*` events are directly on
  the subscription list with complete named deciders; `m11.order.supply_fulfillment_requested` is
  genuinely blocked (no platform seam answers "which Location serves this patient," the same finding
  F-102 recorded); `m12.medication_order.dispensed_at_pharmacy` is fully decisive in M21's own spec
  text though not yet on the subscription list — the F-131 "kept, not dropped" shape. **m29 (External
  Interfaces) — 1 kept, 6 dropped, plus 1 reverse addition.** M29's own locked "four-pillar scope" (D1:
  HL7 inbound/outbound, NPPES, Xero/Gusto) has no room for five of the six drops: `m20.safety.
  osha_reportable_incident_filed`/`workers_comp_claim_initiated` (M20's own text hedges the filing as
  "manual or M29's," an aspiration never decided in M29's scope), `m35.invoice.paid`/`refund.executed`
  (the real M29↔M35 relationship runs the OPPOSITE direction — a seam pull via
  `ExternalInterfaceMetricsProvider`, not a push), and `m5.patient.archived` (its own description
  claimed "M29 expires related HL7 inbound proposals" with zero corroboration anywhere in M29's spec,
  which names exactly one proposal-expiry mechanism — the 72h SLA timer). `m11.order.signed` is the
  sixth drop, redundant with the specific, decisive `m11.order.hl7_orm_requested` sibling — which is
  the one KEPT pair, named explicitly in M29's own spec ("M29 consumes the `m11.order.hl7_orm_requested`
  outbox event as a typed listener ... M29 wires the live consumer at lock"). The reverse check found a
  real, decisive, previously undeclared subscription: `m5.patient.deceased`, named explicitly in M29's
  own M5-dependency prose ("consumed via outbox to freeze inbound ADT processing for the decedent and
  to refuse any post-death A01/A04 events") — added. `m5.patient.merged` was checked and correctly NOT
  added: M29's own text describes that relationship as a seam pull ("resolved at every lookup"), never
  a push. **m1 (Foundation) — 6 kept, 0 dropped, 0 added.** All six are circuit-breaker/health-monitor
  signals from three independent producing modules (M23/M24/M33), and all three use the identical
  decisive phrasing — "M1 records/clears the degraded `system_status`" — naming a real, already-built
  mechanism (`system_status` table + `SystemStatusReader.upsert`, already live behind the admin route)
  that only lacks its automatic-consumer wiring. `m12.dosespot_degraded`/`.recovered` was checked as
  the obvious sibling candidate and correctly excluded: M12's own spec routes DoseSpot degradation
  through a per-tenant feature flag, not the platform-global `system_status` table (`system_status` is
  `NON_ORG_SCOPED`; DoseSpot connectivity is per-tenant, D5) — a principled scoping difference, not an
  oversight. **Net: 297 → 287** (16 dropped, 2 added; module count unchanged at 30, since all four
  groups still carry at least one entry). Verified centrally, once, after all four groups' edits
  landed together: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654
  files / 9589 tests green (two pinned-array assertions updated — `encounter-outbox.test.ts` to add
  `m18`, `orders-outbox-consumers.test.ts` to drop `m29`), `arch:fitness` 38/38 (`arch:outbox-bindings`
  0 disagreements both directions — no mirror-constant drift found this round), and a clean
  `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248
  open — 287 pairs across 30 modules remain.

  **A third round of four groups (m7, m35, m2, m32), and the cross-checking caught two genuine
  misdeclarations hiding IN the reverse-direction check itself, not just in the forward pairs
  (F-142, #248).** **m7 (Care Plan) — 0 kept, 5 dropped, all 5 resolved rather than orphaned.** Two of
  the five (`m39.consent.dpoa.agent_appointed`/`.agent_removed`) and two more
  (`m9.assessment.recorded`/`.significant_change`) are documented build-time SEAM PULLS per M7's own
  locked D7 (a single ABAC seam to M39 for DPOA attribution) and its own "Clinical assessments" text
  (the registered `LatestAssessmentProvider` seam for M9 scores) — dropped with no m7 replacement. The
  fifth, `m19.triage_call.care_plan_change_indicated`, was a genuine **misdeclaration**, not merely
  unsupported: M19's own §11 D8-cascade text is decisive — "M19 emits
  `m19.triage_call.care_plan_change_indicated` consumed by **M14's IDG packet builder**" — the real
  consumer was always M14, never M7. Corrected at the source (`events-by-m19.ts`, m7→m14) and the pair
  now lives in the m14 group rather than vanishing — the m7 group is fully resolved and deleted
  (the m8/m34/m32 precedent), not left empty. **m32 (AI Platform) — 0 kept, 3 dropped, all 3
  resolved.** `m16.bereavement.risk_score_computed` and `m8.hearthnote.layer2_enhanced` are the
  identical shape from the opposite direction: M32's own spec states each relationship runs the
  OPPOSITE way — M16 and M8 each call INTO M32's registered seam
  (`BereavementRiskNarrativeProvider.augment`/`NarrativeEnhancementProvider.enhance`) SYNCHRONOUSLY,
  and M32 already returns everything the corresponding event's payload carries during that call, so
  consuming its own announcement afterward would be redundant — dropped. The third,
  `m19.triage.summary_requested`, was the round's sharpest catch: `events-by-m19.ts`'s own inline
  comment claimed it was "reserved for an M32 AI call-summary request" — flatly contradicted, three
  separate ways, by this SAME module's own locked spec (the "Consumed by" table: "M19 emits
  `m19.triage.summary_requested` and **M22 renders the PDF**; M19 has no PDF code"; the §4.10 outbox
  table: "(M22 consumer)"; the Lock-status section: "M22 caregiver-summary consumer subscribes... at
  M22 lock") and by `packages/types/src/oncall.ts`'s own payload doc comment ("→ **M22** renders the
  caregiver/attending summary document"). A code comment asserting a relationship its own module's
  locked spec names differently, three times, is a documentation bug, not a design decision — corrected
  at the source (m32→m22) and the pair now lives in the m22 group, genuinely unbuilt on both sides.
  **m2 (Identity) — 1 kept, 2 dropped.** `m18.evv.device_approved`/`.device_suspended` were dropped: M18's
  own spec (§2.2.3) states the two rows — `evv_device` and M2's `device_attestation` — are
  INDEPENDENT, with M18 reading M2's row via a logical FK (a seam/FK pull), never the reverse.
  `m39.consent.revoked` is kept, decisively — M39's own locked D7 names "M2 portal-session terminate"
  explicitly, its per-type cascade table names M2 for both consent types, and a "Done means" walkthrough
  spells out the exact mechanism ("M2 consumer subscribes; iterates active sessions... terminates each
  session immediately") — the F-131 "kept, not dropped" asymmetry, since M2's own spec is silent only
  because M39 authored the cascade after M2's spec was written. **m35 (Subscription Billing) — the
  group's own reason was itself a seam-vs-push trap.** All 5 originally-declared events
  (`m32.capability.invoked`, `m32.tenant_opt_in.{recorded,revoked}`,
  `m34.tenant.{provisioned,offboarding_initiated}`) were dropped: M35's own D21 (locked) is exhaustive —
  "8 inbound subscriptions" — and names none of them; D24 states both relationships are SEAMS, not
  pushes (M32 calls `UsageMeteringIngest.ingest` directly INTO M35's own published seam; M35 consumes
  M34's `OnboardingStatusProvider` as a forward-seam deny-stub). The reverse check found the real gap —
  D21's exhaustive 8-event list (`m2.organization.{activated,suspended,closed}`, `m2.session.created`,
  `m5.patient.{created,status_changed,deceased,merged}`) had already been diagnosed, event-by-event, by
  `scripts/outbox-subscription-exceptions.ts`'s own rule-6 "no-handler" buckets — catalog agreement was
  the only thing missing. Six were corrected at the source (M2's four events, M5's `deceased`/`merged`)
  and the matching stale exception entries deleted; the other two
  (`m5.patient.{created,status_changed}`) stay untouched — M35's own D21 marks them
  `record-only-target`, a first-party M5 refusal ("would make M5's patient lifecycle a billing input, a
  coupling M5 has not agreed to") that this pass respects rather than overrides.
  `M35_SUBSCRIBED_EVENT_NAMES` (`packages/types/src/subscription-billing.ts`) rewritten to match — the
  5 wrong names removed, the list now exactly D21's 8. **Net: 287 → 280** (10 dropped, 8 added — 2
  reassigned across modules, not new gaps; module count 30 → 28, m7 and m32 fully resolved). Verified:
  `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654 files / 9589
  tests green with no pinned-array assertions to update this pass, `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements both directions), and a clean `check:boot:platform` run
  against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 280 pairs across 28
  modules remain.

  **A fourth round of six small groups (m6, m37, m9, m12, m10, m3) — every group with zero prior
  citation, checked in parallel by six forks — resolved three groups outright and caught the sharpest
  reverse-direction miss of the series so far on a fourth (F-143, #248).** **m6 — 4 kept, 2 dropped.**
  `m11.order.level_of_care_change_signed`/`.recertification_signed` are decisive on M11's side (its
  locked D9/D10, each with a rejected-alternatives table: "M11 emits ...; M6 subscribes and runs its LCP
  transition" / "...validates F2F + CTI then transitions the next period") despite M6's own spec being
  comparatively silent — the F-131 "kept, not dropped" asymmetry. `m23.noe.accepted`/`m23.notr.accepted`
  are equally decisive on M23's side: its own "Done means" walkthroughs state plainly "M6's consumer
  picks up the event and closes the M6 NOE compliance window" — a genuinely NEW fact (MAC acceptance)
  M6's own F-106/F-107 emissions (which trigger the filing, not its acceptance) cannot derive.
  `m19.triage_call.gip_admission_proposed` was dropped as a straightforward misdeclaration: M19's own
  locked spec names M37, never M6, as the real consumer (cited three separate ways), and `m37` already
  correctly carries this pair in its own group. `m37.ipu_admission.bed_assigned` is the seam-vs-push trap
  from the opposite side: M6's real `confirmLocBedAssignment` route verifies the bed via a SEAM READ
  (`ipuBedAssignmentReader.activeBedAssignmentForLevelOfCarePeriod`), never an outbox consumer. **m37 —
  2 kept, 1 dropped.** `m19.triage_call.gip_admission_proposed` and `m6.admission.discharged` are both
  named explicitly, with designated (unbuilt) consumer files, in M37's own §4.5 "Outbox Subscriptions"
  table. `m6.admission.activated` is not in that table at all — checking surfaced a genuine spec-vs-
  catalog naming mismatch worth flagging for a future pass rather than fixing here: M37's spec instead
  names two more granular events (`m6.level_of_care.requires_ipu_bed`/`.activated`) that M6's real
  catalog has never published, so M37's actual intended trigger is very likely M6's real
  `m6.loc.changed` — untouched by this pass. **m9 — 0 kept, all 3 dropped, group fully resolved and
  deleted** (the m8/m34/m7/m32/m10/m3 precedent): `m13.prn_administration_recorded` has no support
  anywhere in M9's relationship inventory; `m8.encounter.signed` and `m8.vitals.captured` both run the
  OPPOSITE direction from a push — M9's own spec states M8 calls INTO M9's `recordAssessment` API
  synchronously, and separately that M9 "may read the encounter vital series via M8's seam ... but does
  not own vital signs," moved to `seamConsumers` rather than dropped bare. **m10 — 0 kept, its one pair
  dropped, group deleted.** `m8.encounter.signed` is the identical shape one module over: M10's own spec,
  including a re-lock note explicitly correcting a prior encoding that "inverted the M8↔M10 dep
  direction," states M8 calls M10's `recordHopeTimepoint` API synchronously — M10's two real outbox
  consumers are both M6-only. **m3 — 0 kept, its one pair dropped, group deleted.**
  `m39.consent.supersedes` resolves through M3's own boot-registered `ConsentEvaluator` seam PULL,
  consulted fresh per ABAC evaluation; M3 has no `consumers/` directory and no consent-keyed cache to
  rebind (its one cache invalidates only on role/permission changes) — the event's own "cache rebind"
  phrasing reads as a mechanical carry-over from the sibling `consent.signed` consumer list rather than
  an independent M3 decision. **m12 — both catalogued pairs kept, and the reverse check found the
  sharpest miss of the series: 7 real, decisive, currently-undeclared subscriptions, one of which had
  survived FIVE prior targeted sweeps of the exact same event.** `m13.reconciliation.draft_order_requested`/
  `.discontinue_requested` are decisive on M13's own side (a separate reconciliation surface from M12's
  own D10 MedHx flow, confirmed to have no M13 involvement anywhere). Checking M12's own live
  `M12_OUTBOX_SUBSCRIPTIONS` list against the catalog — rather than trusting the group's stale
  three-live-consumers reason, which was itself off by one — found `m5.patient.created`/`.updated`/
  `.address_changed`/`.payer_changed` (D4's DoseSpot patient sync), `m6.cti.signed` (D10's MedHx pull),
  and `m11.order.verbal_expired_unsigned` (the group's own already-registered `M12_OUTBOX_SUBSCRIPTIONS`
  entry) all missing their `m12` declaration entirely — each backed by a shipped, unit-tested decider.
  `m6.admission.activated` is the one worth naming specifically: it had been individually re-scrutinized
  BY NAME in F-101, F-134, F-136, F-137 and F-140 — five separate passes, each checking it against a
  different candidate module and correctly dropping or keeping that module — and none of them checked it
  against M12, because each pass's fork was anchored to that round's own candidate list rather than to
  the full universe of modules M6 could conceivably feed. A per-event check is only as complete as the
  set of modules it's checked against; this is the first time in the series that a produced-and-declared
  event's OWN group needed the reverse check to have been thorough, not merely present, to catch a real
  gap. Two matching stale `outbox-subscription-exceptions.ts` rule-6 entries (`handler-unbound` and
  `record-only-target`, covering all 7 pairs between them) were deleted once the catalog agreed with
  M12's own subscription list. **Net: 280 → 279** (7 dropped, 7 added — a wash on the pair count that
  hides real movement: three groups fully resolved and three events reassigned to their correct module;
  28 → 25 modules, m9/m10/m3 fully resolved and deleted). Verified: `bun run build` clean, `bun run
  typecheck` clean (0 errors), full non-live suite 654 files / 9589 tests green (two pinned-array
  assertions updated — `encounter-outbox.test.ts` to drop m9/m10 from `m8.encounter.signed`'s expected
  subscriber set, `outbox-seam-consumers.test.ts` to drop m37 and add m12 to `m6.admission.activated`'s
  expected clinical fan-out), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements both
  directions after the two stale exception entries were deleted), and a clean `check:boot:platform` run
  against a freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 279 pairs across 25
  modules remain.

  **Round 5 stopped checking whole groups and instead finished the F-101 sweep a PRIOR round had
  explicitly left undone inside the single largest one (F-144, #248).** By Round 4 every group in the
  registry carried an F-number — except that m22's own reason text (59 pairs, the largest group) said so
  itself: "events named by NO part of the M22 spec's §4.11 table with no redundant sibling found, kept
  declared rather than dropped absent stronger evidence — the F-101 sweep this needs has not been run on
  them," naming 38 specific events across eleven producing modules. Six forks split that subset by
  producer cluster (M11/M8; M14/M7/M15; M16/M37; M17/M21/M39/M5; M23; M24/M25/M30), each checking M22's
  own §4.11 consumer table plus the producing module's own spec/code — the same F-101 rule at the scale
  F-140's four-fork batch first applied to whole groups, now applied inside one. **28 of 38 were genuinely
  misdeclared, all variants of shapes this series has already named**: redundant-sibling co-emission
  (`m11.order.supply_fulfillment_requested` alongside `.document_requested`; `m14.meeting.adjourned`
  alongside `.minutes.signed`; `m16.bereavement.plan_opened` alongside `.outreach_artifact_requested`;
  `m25.appeal.submitted` alongside the already-live-bound `.appeal_packet.render_requested`; five of six
  M23 billing events and three of four M24 events each redundant with their module's ONE real
  `*.billing.document_render_requested` handshake, confirmed against `consumers/document-render.ts`'s
  four builder functions and their exact payload shapes); the seam-vs-push trap restated as
  "on request" (`m30.incident.submitted`/`.qapi.project_chartered`/`.pip_closed` — M30's own spec names
  five dedicated `*.render_requested` events for this purpose, none ever catalogued or emitted, a
  producer-side gap reported not fixed); a structural impossibility (`m8.encounter.voided` — the
  `ENCOUNTER_GRAPH` legalizes `void` only from `draft`, so a voided encounter can never have had a PDF to
  suppress); the identical F-115/M28 seam-pull shape one module over (`m5.patient.privacy_flag_changed`);
  a live-resolver seam (`m5.patient.unmerged`, M5's own locked D8: merge "re-points all FK references
  through the `patient_resolver`" with no destructive UPDATE, so there is nothing for a push to correct);
  and a Lock-status table naming only a sibling event, not these (`m15.discipline_assessment.amended`/
  `.plan.discharged`, both excluded from M15's own exhaustive "M22 discipline-plan PDF rendering
  subscribes to `m15.plan.version_signed`" claim). **One drop needed its own verification pass to avoid
  reintroducing a defect a PRIOR round had already found and fixed**: the M11 fork flagged
  `m11.order.level_of_care_change_signed`'s own "M22 renders the LOC-change form" spec claim as a
  candidate for keeping (and for adding `m22` to the downstream `m6.loc.changed` it feeds) — checked
  directly against M22's real `PLATFORM_TEMPLATE_TABLE` and confirmed to name no such template anywhere,
  matching a standing F-101 comment already sitting on `m6.loc.changed`'s own catalog entry for the
  identical reason. Trusting the spec text here would have undone a correct prior finding; both stay
  dropped. **`m37.ipu_admission.death_recorded`** was the sharpest catch: M22's own spec never mentions a
  magic-link or external-collaborator surface anywhere (and elsewhere explicitly disclaims a related one
  — "M2 funeral magic-link is NOT how external reviewers authenticate"), and M37's OWN spec is internally
  inconsistent about which event even triggers the session — its "Consumed by" summary and §4.10 table
  both name `death_recorded`, but its detailed body-release workflow narrative says the session is
  created off the LATER `m37.body_release.funeral_home_identified` transition instead, after the funeral
  home is actually known. No consumer file exists on the M22 side under either reading, and the real
  owner of the underlying `magicLink` plugin is M2 (`packages/auth/src/identity/auth.ts`) — dropped, with
  the misattribution reported for its own future pass rather than guessed at. **10 of 38 confirmed
  genuine**, needing no catalog change: `m14.minutes.amended`/`m7.care_plan.version_signed` (each
  decisively named in the PRODUCING module's own outbox table — the F-131 "kept, not dropped" asymmetry
  a second time this round); `m17.caregiver_reminder_due`, `m21.supply_request.delivered`, and all three
  `m39.consent.{expired,recipient_added,recipient_removed}` events (same asymmetry — none appear in
  M22's own table either, all decisively named on the producing side); and the three
  `*.billing.document_render_requested`-shaped events that anchor the M23/M24/M25 redundant-sibling
  drops above, each independently confirmed genuinely unbuilt on the PRODUCER side too (no emit site
  anywhere for any of the three) — a real gap in M22's own document-request-list maintenance, distinct
  from and additional to the catalog-declaration question this sweep answers. **Net: 279 → 251** (28
  dropped, 0 added; module count unchanged at 25 — m22 still carries 31 events, none of this round's
  groups emptied). Verified: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live
  suite 654 files / 9589 tests green with **no pinned-array assertions to update this pass** — the first
  round in the series with zero test fallout — `arch:fitness` 38/38 (`arch:outbox-bindings` 0
  disagreements both directions), and a clean `check:boot:platform` run against a freshly migrated,
  RLS-enforced disposable Postgres. Leaving #248 open — 251 pairs across 25 modules remain.

  **Round 6 applied the exact same finish-the-sweep move to the SECOND-largest group, and it reversed
  the group's own prior "strongest candidate" call (F-145, #248).** m14's own reason text (30 pairs)
  carried the identical shape m22's did before Round 5: "22 pairs checked and found NEITHER clearly
  redundant NOR named anywhere in M14's own spec... kept declared rather than dropped absent stronger
  evidence." Five forks split those 22 by producer cluster and checked each against the PRODUCING
  module's own spec — the same reverse check that resolved m22. **17 of 22 were genuinely misdeclared,
  nearly all one shape at unusual scale: the seam-vs-push trap already named for M7/M9/M10 in F-129, now
  found to cover M6 and all twelve of M13's remaining eMAR events.** M13's own D16 publishes
  `MedicationAdministrationProvider`/`ReconciliationProvider` with M14 named as a read-path consumer for
  BOTH, and M13's own PRIMARY "Consumed by 14" line is exhaustive and decisive — "IDG packets show
  administrations since last IDG via M13's `getAdministrationsSince` seam and missed-dose count since
  last IDG via the SAME seam's aggregation projection" — directly contradicting M13's own looser §4.10
  per-event table, which lists M14 as a consumer on all twelve individual events. The F-101 rule applied
  to a module's own two self-contradicting statements, trusting the decisive one over the loose table
  row. **This reverses the group's own prior framing**: `m13.scheduled_dose.missed` had been called "the
  strongest candidate to eventually bind" on a payload-shape resemblance to `PacketFlaggedEventDigest`'s
  `missed_dose` kind — a weaker signal than M13's own decisive seam-publication text, now correctly
  moved to `seamConsumers` alongside its eleven siblings (all twelve moved, not dropped bare — the seam
  relationship is real, the outbox-push framing was the error). Four M6 events
  (`admission.on_hold`/`.resumed`, `compliance.window.opened`/`.overdue`) had no support in M14's own
  exhaustive build-description at all, and `compliance.window.overdue` was directly contradicted — M6's
  own text assigns the real consumer to M36's escalation chain, an affirmative counter-claim, not mere
  silence. `m9.assessment.amended` is a redundant sibling, emitted in the same transaction as the
  correcting row's `m9.assessment.recorded` — M14's own real, live-bound subscription; the corrected
  value arrives via `.recorded` regardless. **5 of 22 confirmed genuine**, no catalog change needed:
  `m12.medication_history_pulled` and `m39.consent.expiring_soon` (each named twice over in its
  producing module's own outbox table — the F-131 "kept, not dropped" asymmetry a third time this
  series), and all three M15 events (`idg_decision.applied`, `plan.bootstrapped`, `plan.version_signed`)
  — M15's own real outbox table names M14 decisively for all three. `m15.idg_decision.applied` was
  checked specifically for the wrong-direction trap (an echo of M14's own outbound `idg.decision_recorded`
  under a confusing near-identical name) and confirmed genuinely distinct — M15's own inbound
  acknowledgment that it applied an M14 decision, the identical shape M7's own `care_plan
  .idg_decision_applied` audit event already establishes for the M7/M14 pair one module over. **Net:
  251 → 234** (17 dropped — 12 moved to `seamConsumers` rather than dropped bare, 4 dropped clean, 1
  redundant sibling — 0 added; module count unchanged at 25). Verified: `bun run build` clean, `bun run
  typecheck` clean (0 errors), full non-live suite 654 files / 9589 tests green with no pinned-array
  assertions to update — the second consecutive round with zero test fallout — `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements both directions), and a clean `check:boot:platform` run against
  a freshly migrated, RLS-enforced disposable Postgres. Leaving #248 open — 234 pairs across 25 modules
  remain.

  **Round 7 stopped checking whole groups and instead ran down the loose ends already sitting inside
  two groups' own reason text — the "kept absent stronger evidence"/"flagged for a future pass" shape
  survives a group being otherwise fully swept (F-146/F-147, #248).** A registry-wide search for that
  exact phrasing found the pair-level flags Rounds 5/6 fix (F-101 sweeps never run) had already all been
  closed; what remained were two SMALLER loose ends inside groups the series had already resolved.
  **F-146 — M18's real `m8.encounter.signed` consumer was wired against a payload missing the one fact
  it needs.** F-141 added `m8.encounter.signed` to the m18 group as a genuine, decisive, undeclared
  subscription (M18's own D6/job-catalog/checklist all name it as the auto-close trigger for a
  `closed_documented_at_encounter` missing-checkout resolution) but flagged in the same breath that the
  LOCKED payload does not carry `evvMissingReason` — the exact fact `transitionMissingResolution`'s
  `document_at_encounter` event reads as `event.encounterEvvMissingReason`. Checked against the schema
  rather than left flagged: `encounter.evv_missing_reason` is a real, already-written column
  (`documentEvvMissing`, `encounters-route-service-db.ts`), present on the `loadEnc` row already read at
  both `sign()` emit sites, gated by the same ≥20-char CHECK constraint M18's own resolution machine
  enforces. Added to the payload schema (`Type.Optional(Type.Union([Type.String(), Type.Null()]))`,
  matching the column's own nullability — null except when `evvBracketState ===
  'evv_missing_documented'`) and both emit sites. M18's actual consumer BINDING stays unbuilt — that is
  composition-root wiring work outside a catalog/payload pass, unchanged from F-141 — but a future binding
  can now resolve the fact it needs instead of being wired against a field that does not exist, the F-104
  `linked_artifact_id` shape (bind alone would have looked green and matched nothing) avoided before it
  could happen a second time. **F-147 — two IPU loose ends, opposite outcomes.** M37's own group reason
  (F-143) flagged that its dropped `m6.admission.activated` pair pointed at a real spec-vs-catalog naming
  mismatch — M37's spec wants `m6.level_of_care.requires_ipu_bed`/`.activated`, M6 publishes neither — and
  guessed the real trigger was "very likely" M6's actual `m6.loc.changed`, left unaddressed. Checked
  against M6's own production code rather than left a guess: `m6.loc.changed` is NOT it — M6's
  `pending → assigning` transition (the moment a GIP/IRC LOC change needs an IPU bed) emits NO outbox event
  at all (`state-machines/level-of-care.ts`: "No outbox event while assigning — nothing downstream should
  treat an unconfirmed IPU request as a real period of care yet"), `m6.loc.changed` fires only later at
  CONFIRMATION (which M37 already learns about through its own `assign-bed` route, not a subscription,
  the F-143 `m6`-group seam-pull finding a second time), and M6's one published LOC seam
  (`LevelOfCareReader`) deliberately excludes `assigning`-status periods from both its methods. The D2
  bidirectional handshake M37's spec describes was simply never built on the M6 side — no event, no seam,
  nothing a catalog declaration could bind M37 to — so this is real, unbuilt M6-side infrastructure
  (a new outbox event or a seam exposing `assigning`-state periods), reported rather than fixed, since
  inventing a new production event/seam sits outside a catalog-declaration pass. Separately, F-144 had
  flagged M37's own spec as "internally inconsistent" about which event triggers the M22 funeral-home
  magic-link session — its summary table names `m37.ipu_admission.death_recorded`, its detailed workflow
  names the later `m37.body_release.funeral_home_identified` — and reported a "likely misattribution"
  between M2 and M22 as the consumer, left for its own pass rather than guessed at. Run down rather than
  left open: the summary-table row is the ONE imprecise citation against 15+ other places in M37's own
  spec (the D12 rationale, the §2.11 prose, the workflow walkthrough steps 4-7, the test plan, the
  acceptance checklist) that unanimously tie the session to `funeral_home_identified`, never to
  `death_recorded`, and unanimously name M22 — never M2 — as the consumer (architecture §7.8's
  external-collaborator pattern is M22's own surface; M2 owns only the underlying Better Auth `magicLink`
  plugin mechanism, confirmed by reading `packages/auth/src/identity/auth.ts` directly, which anticipates
  an "auditor / external-collaborator / funeral-home magic-link class" but has no M22-side caller
  anywhere). Both code comments corrected to state this decisively; no catalog change on either event,
  since the actual magic-link SESSION creation — distinct from the document RENDER F-117 already
  established is covered by the co-emitted `document_requested` sibling — remains genuinely unbuilt on
  every side (no M22 route, consumer, or external-collaborator surface exists in `22-documents/` at all),
  a real, reportable feature gap one layer deeper than a declaration fix. **Net: 234 → 234** (0 dropped, 0
  added — every fix this round was a payload widening and two prose corrections, not a declaration
  change). Verified: `bun run build` clean, `bun run typecheck` clean (0 errors), full non-live suite 654
  files / 9589 tests green with no pinned-array assertions to update, `arch:fitness` 38/38
  (`arch:outbox-bindings` 0 disagreements, pair count unchanged as expected), a clean `check:boot:platform`
  run against a freshly migrated, RLS-enforced disposable Postgres, and the `m8-encounters-write.live.test.ts`
  (50/50), `m8-encounters-read-service.live.test.ts` (4/4), and `m18-evv-write.live.test.ts` (16/16) live
  suites run individually to confirm the widened `m8.encounter.signed` payload round-trips through the real
  catalog-validating publisher with no regression. Leaving #248 open — 234 pairs across 25 modules remain.

  **Round 8 finally ran the F-101 per-event sweep on m30's own reason text — the largest remaining group,
  which F-115 had only ever checked from ONE side (F-148/F-149, #248).** F-115 (#248) had already checked
  61 of m30's declared events against M30's OWN nightly-recompute seam reads and moved 27 out that way, but
  never checked the OTHER direction — whether each PRODUCING module's own spec decisively named M30, the
  same F-101 rule this series applies everywhere else. **F-148 finished the smaller half first**: a
  follow-up pass on the six remaining M16 (Bereavement) events found five genuinely confirmed
  (`plan_closed_completed`/`.declined`/`.early`/`plan_skipped_per_patient_opt_out`/`risk_score_computed`,
  each backed by a real `BereavementComplianceProvider` seam method that exists but is DORMANT — unused by
  any of M30's eleven currently-registered measures, "bound is not computing" a further time) and one
  genuinely misdeclared: `contact_referred_external` had **no supporting comment at all**, the one event in
  the group nobody had actually checked. M30's own `M30_OUTBOX_SUBSCRIPTIONS` — its own header calls itself
  "the SINGLE SOURCE OF TRUTH" for M30's inbound topics — has exactly six keys and none is `m16.*`; M30's
  own §1.1 relationship-inventory text scopes its ENTIRE M16 relationship to the CoP-coverage measure ("M30
  emits no bereavement data and writes nothing to M16"); `IncidentKind` has no member a referral maps to;
  and M16's own worked "Done means" walkthrough for this exact transition narrates M36's alert and M22's
  letter render in full and names no M30 action at all — the event's terse table-cell citation ("M30
  incident potential") unsupported everywhere that would have to carry it if real. Dropped, no
  `seamConsumers` replacement. **F-149 then split the remaining 60 events across six parallel
  producer-clustered forks** (M11's 8 order events; M13's 12 eMAR events; M6's 9 admission/compliance/F2F
  events; M15's 4 + M16's residual 6; M20's 3 + M21's 5; and nine smaller producers spanning M14/M23/M25/
  M26/M37/M39/M12/M8/M9), each checked against M30's own §1.1 relationship inventory
  (`docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md`) and its own blanket architectural principle
  ("Outbox publication is the only cross-module communication M30 performs at the boundary … M30 *calls*
  … reader seams as in-process function calls," never a subscription) plus each PRODUCING module's own
  spec. **11 moved to `seamConsumers` rather than dropped bare** — all 8 M11 order events (M11's own §D14
  names a real `OrderProvider` seam whose completion/transmission/results methods M30 has not built yet),
  M21's 5 comfort-kit/controlled-substance/par events (a real, already-registered `SupplyFulfillmentProvider`/
  `ComfortKitDispatchProvider` seam M30 hasn't called yet), M14's 2 IDG review-clock events (confirmed
  ACTIVE — `m30-jobs.ts` calls `getSeam("IdgScheduleProvider")` today, feeding a currently-registered
  measure), and `m39.consent.signed` (M30's `ConsentEvaluator.evaluate` is likewise live, per-actor, at
  read time — a signing push has nothing to invalidate). **18 dropped clean, unsupported on both sides** —
  all 12 remaining M13 eMAR events (zero `m13.*` keys anywhere in `M30_OUTBOX_SUBSCRIPTIONS`, and the
  "reconciliation-completed-in-time" measure M13's own spec claims feeds M30 does not exist anywhere in
  M30's registered measure set), all 3 M20 field-safety events (M30's own spec is a flat denial — "Field
  safety. Module 20. No M30 consumption path"), `m37.ipu_admission.discharged` (redundant sibling — the
  death case is carved out to the already-declared `death_recorded`), and `m8.hearthnote.layer2_enhanced`
  (M30's own D16 ten-event recompute-trigger list excludes it; only the different, already-declared
  `m8.encounter.signed` is on that list). **2 corrected from an initial MOVE-TO-SEAM recommendation to
  DROP on independent re-verification, the exact discipline this series exists to enforce**: the M25/M26
  forks first read `m25.denial.opened` and both `m26.cap.*` events as real forward seams, citing M25's/
  M26's own aspirational spec text ("M30's denial-rate HQRP measure … reads M25's `DenialMetricsProvider`,"
  "forward-seam … will add M26 to M30.dependsOn") — but M30's own §1.1 inventory FLATLY denies both:
  "Remittance posting. Module 25. No M30 consumption path" and "Cap management. Module 26. No direct M30
  consumption … cap status … feeds M27 cost reports, not quality measures" — unconditional statements, not
  the genuinely conditional "may consume … when the seam lands" phrasing M30's spec uses for M19/M21's
  real forward seams. The consuming module's own decisive text wins over the producing module's
  aspirational one (F-101), so both were corrected to DROP before being applied. **Net: 234 → 197** (37
  dropped/moved — 1 from F-148, 36 from F-149; 0 added; module count unchanged at 25, m30's own two groups
  shrink from 65 to 28 combined). Verified: `bun run build` clean, `bun run typecheck` clean (0 errors),
  full non-live suite 654 files / 9589 tests green (one pinned-array assertion updated —
  `orders-outbox-consumers.test.ts`'s `m11.order.signed` fan-out, to drop `m30` from `declaredConsumers`
  and add it to `seamConsumers`), `arch:fitness` 38/38 (`arch:outbox-bindings` 0 disagreements), and a
  clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable Postgres. Leaving
  #248 open — 197 pairs across 25 modules remain.

  **#248 shifted from catalog triage to building the first real binding — and the scoping investigation
  found genuinely different reasons three of the four candidate targets weren't buildable yet
  (F-150, #248).** Every declared-but-unbound pair in the registry had by now been individually verified
  at least once (25/25 groups carry an F-number from a real per-event check); the remaining 195 pairs are
  confirmed genuine, currently-unbuilt relationships, not catalog mistakes — so the next request was to
  start building them. M30's own `handlers-unbound` group (4 events) was the obvious first target:
  `packages/quality/src/consumers/handlers.ts` had shipped pure, port-injected and fully unit-tested since
  the package landed, with **no implementation of `M30ConsumerPorts` anywhere in this repository** —
  RULE 3(d)'s "the live inbound dispatcher is a later platform phase" had simply never come due. Checking
  each of the four before building found three different blockers, not one: `m10.hope.submission_accepted`
  needed only a payload widening (`providerEntityId` — the fact `enqueueRecompute` needs, absent from the
  catalog schema though `hope_submission.provider_entity_id` is NOT NULL and already on the row the emit
  site returns); `m23.claim.adjudicated` needed nothing at all, its real production emitter
  (`claim-state-service.ts`) already carries a complete payload; `m12.medication.error_reported` is
  genuinely blocked — its handler's `createIncidentDraft` needs a resolvable "M30 service membership" for
  `incident_report.reported_by_membership_id` (NOT NULL), and no system-actor-membership convention exists
  ANYWHERE in this codebase to attribute an auto-created draft to (the F-102 `actorMembershipId: NULL for
  system-actor cascades` carve-out does not apply here — this column has no such nullable escape); and
  `m18.evv.visit_verified`, checked while scoping this pass, turned out not to be an M30-side gap at all —
  M18's own `domain/event-lifecycle.ts` `recordEvent` pure decider declares the outbox effect, but the
  REAL production check-in/check-out write path (`evv-route-service-db.ts`) never calls that decider and
  emits its four other EVV events inline instead; `visit_verified` has never been published by any
  production code path, so binding an M30 consumer for it would wire a line to a house that was never
  built. **Bound the two that were genuinely ready.** `buildM30UpstreamConsumerPorts`
  (`apps/backend/src/modules/30-quality/outbox-consumers/upstream-consumer-ports.ts`) implements
  `enqueueRecompute` for real — per-measure-code FY-boundary period resolution
  (`resolvePeriodRule`/`resolvePeriodWindow`, mirroring `m30-jobs.ts`'s own private `resolveFyBoundary`,
  not exported) feeding the real `MeasureRecomputeQueueRepository.enqueue`, RLS-scoped via
  `withOrgContext` — while the other three `M30ConsumerPorts` methods stay LAZY fail-closed
  `unboundWorkerPort` thunks (the exact mechanism `m30-jobs.ts`'s own worker deps already use for the
  identical posture), never invoked by the two consumers this pass actually binds. **Deliberately did NOT
  half-bind `m6.discharge.death`**: its handler calls `createMortalityReviewDraft` (real, buildable) AND
  `addCahpsSampleCandidate` (blocked on the M1 envelope-DEK caregiver-contact encrypt PLUS a
  caregiver-contact fact the death event's payload does not carry — the identical gap `m30-jobs.ts`'s own
  `cahpsMonthlySample.samples.insertSampled` port already reports) in ONE invocation — binding it now
  would make the mortality-review insert throw and roll back on every single delivery because of the
  CAHPS half, which is worse than leaving it unbound entirely. `buildM30HopeSubmissionAcceptedConsumer`/
  `buildM30ClaimAdjudicatedConsumer` (`outbox-consumers/upstream-events.ts`) wire the two ready handlers
  into real `OutboxConsumerBinding`s, registered in the composition root's consumer array for the first
  time. **This is the first genuinely-bound relationship this registry has produced, not a catalog
  correction** — the two pairs are removed from `outbox-deferred-consumers.ts` outright (a live binding
  now reaches them), and the group's reason text is rewritten to state the two remaining events' two
  DIFFERENT blockers precisely rather than repeating the old blanket note. Net: **197 → 195** pairs (2
  bound). Verified: `bun run build`/`typecheck` clean, full non-live suite 654 files / 9589 tests green,
  `arch:fitness` 38/38 (`arch:outbox-bindings` confirms 57 live bindings now cover 77 catalogued events,
  up from 55/75), a clean `check:boot:platform` run against a freshly migrated, RLS-enforced disposable
  Postgres, and a new live suite (`m30-upstream-consumers.live.test.ts`, `test:m30:upstream-consumers:live`,
  wired into the CI `lifecycle-live` M30 job) proving both bindings for real: the correct `hope_derived`
  (the two HOPE-derived TFP measure codes) and `hci` (all eleven indicator + composite codes) measure sets enqueue with the
  right provider/org/triggering-event fields, a redelivery debounces onto the same pending row rather than
  duplicating it (the `uq_measure_recompute_pending` partial-unique), and cross-tenant isolation holds.
  Leaving #248 open — 195 pairs across 25 modules remain, one of which (`m12.medication.error_reported`)
  needs new platform infrastructure (a system-actor membership convention) and the rest need their own
  scoped builds the same way this pass scoped M30's.

**#248's second genuinely-bound relationship — M16's §2.6 / D6 M39 consent-revocation cascade — and the
build surfaced a real, previously-invisible decider/machine mismatch along the way (F-151, #248).**
`decideConsentRevocationCascade` (`lifecycle/cascades.ts`) has been a complete, pure, unit-tested decider
since M16-T03, and `bereavement_opt_out.source_kind`'s own schema comment already named the mechanism
this pass built: "when M39 emits `m39.consent.revoked` for a `bereavement_outreach_consent` record, M16
CASCADES (§2.6) — it does not gate-keep. M39 is the truth." Nothing had ever bound it — the pair sat in
the m16 `handlers-unbound` group F-134 had already scoped as "backed by a real pure decider." Scoping it
against M24's `handlers-unbound` group first (a parallel candidate with real, named pure handlers in
`consumers/handlers.ts`) found that group genuinely blocked on two DIFFERENT infrastructure gaps — no
claim-lifecycle write path exists to back `handleClaimPaid`/`handleClaimDenied`/`handleMedicarePrimaryAck`
at all, and `medicaid_claim.updatedByMembershipId`/`createdByMembershipId` are NOT NULL with no
system-actor escape hatch the way `order_discontinuation.actor_membership_id` has (F-102) — so M24 stays
deferred, its reason updated to name both blockers precisely rather than repeating the old blanket
"forward-declared, pending the relay" note. **M16's build, by contrast, had full precedent already sitting
in the codebase.** `bereavement_opt_out.recorded_by_user_id` and `bereavement_plan_closure.closed_by_user_id`
are both nullable with a documented system-write precedent in their own schema comments ("NULL when the
portal self-service path recorded it" / "NULL for the 13-month auto-close cron"), and `optOutContact`'s
existing HTTP-route implementation (`routes/write-service-drizzle.ts`, route 14) already accepts a
null-membership `M16MutatingActor` for the identical reason. The new consumer
(`outbox-consumers/m39-consent-revoked.ts`) mirrors that route's write exactly — the same
`transitionBereavedContact` machine call, the same effect-runner + `bereavement_opt_out` insert shape, the
same future-outreach cancellation — with `recordedByUserId: null` / `sourceKind: "m39_revocation_cascade"`
in place of a staff membership, the F-102 `CONSUMER_USER_ID` convention (`""` for `app.user_id`) F-150's
M30 consumer already established one module over. **Building it surfaced a narrow, latent bug nobody had
exercised**: `decideConsentRevocationCascade` returns `cascade_opt_out` for a contact whose status is
EITHER `active` OR `proposed`, but `BEREAVED_CONTACT_GRAPH` (`lifecycle/contact.ts`) accepts the `optOut`
event only from `active` — `proposed` accepts only `confirmContact`. The decider's own unit test
(`bereavement-lifecycle.test.ts`) exercises `active`/`opted_out`/`null`, never `proposed`, so this was
invisible until a real delivery against an unconfirmed contact was driven end to end. Not fixed here,
deliberately — whether an unconfirmed contact's consent revocation should be a no-op (matching
`opted_out`/`deceased`) or drive some other transition is a product decision this pass does not guess at,
the identical restraint F-150 applied to `m12.medication.error_reported`'s missing system-actor
convention. The consumer instead lets the machine's own typed `ILLEGAL_TRANSITION` throw and dead-letter
for a human, mirroring the "refuse rather than guess" posture `outbox-consumers/m6-bereavement-eligible.ts`
already takes on its own unresolvable death-fact cases — documented at the top of the new file rather than
silently swallowed, and proven as its own live-test case rather than left untested. Net: **195 → 194**
pairs (1 bound). Verified: `bun run build`/`typecheck` clean, full non-live suite 654 files / 9589 tests
green with no pinned-array assertions to update, `arch:fitness` 38/38 (`arch:outbox-bindings` confirms 58
live bindings now cover 78 catalogued events, up from 57/77 — `arch:live-suites` required the new script
wired into the CI `lifecycle-live` M16 job before it would pass), a clean `check:boot:platform` run against
a freshly migrated, RLS-enforced disposable Postgres, and a new live suite
(`m16-consent-revoked.live.test.ts`, `test:m16:consent-revoked:live`) proving the binding for real: an
active contact cascades to `opted_out` with the correct `bereavement_opt_out` row and a cancelled future
outreach touchpoint, a redelivery against an already-opted-out contact is a true no-op (no second opt-out
row, `version` unchanged), a consent id no contact in the org tracks is a no-op, a `proposed` contact
throws the documented `ILLEGAL_TRANSITION`, and cross-tenant isolation holds. Leaving #248 open — 194
pairs across 25 modules remain.

The **2026-06-27 security/compliance audit remediation is merged** (PRs #103/#104):
production ABAC-evaluator + `step_up_recent` boot wiring; PHI-safe Fastify logging + no PHI in
browser storage; chromed-route auth guard with fail-closed nav; a fail-closed **PHI read-audit
coverage gate** (`apps/backend/src/bootstrap/plugins/read-audit.ts`) + request-time emission;
fail-closed **production env validation** (`apps/backend/src/bootstrap/env.ts`); the real M34
`platform.bypass_invoked` auditor; **durable break-glass persistence** (Drizzle store + live §2.2
branch); and dependency-vuln bumps (`bun audit` 7→1, drizzle-orm SQL-injection fix).
Use this guide to locate authoritative documents.

> **Building/extending the code?** Start at [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)
> (runbook + "how to add a module") and [`docs/PHASE_0_SCAFFOLD_PLAN.md`](./docs/PHASE_0_SCAFFOLD_PLAN.md).
> One-time: `bun install && bun run build && bun run arch:fitness && bun run test` (all green).
> The `apps/`+`packages/` tree is **generated from the manifest** via `bun run scaffold`; the
> `arch:parity` gate keeps tree↔manifest 1:1. See [ADR-0027](./docs/adr/ADR-0027-phase-0-toolchain-and-scaffold.md).

## Document map

> **Single entry point:** [`docs/README.md`](./docs/README.md) is the master index of every
> document under `docs/` — architecture, module specs, design/UI corpus, ADRs, the AI capability
> catalog, roadmap, wave plans, and reference sources — each linked to its canonical location.
> The sections below call out the load-bearing directories.

### Module specifications → `docs/modules/`

**All 40 module specs live in [`docs/modules/`](./docs/modules/).** Start at the index:
[`docs/modules/README.md`](./docs/modules/README.md) — every module, its version, and a link.
The Module 29 forward-engineering sub-tasks are in
[`docs/modules/module-29-tasks/`](./docs/modules/module-29-tasks/) — 12 files spanning
T-29.01–T-29.13 (tasks 12 and 13 share one file, `WARDENX_T-29.12_13_FRONTEND.md`).

> When you need a module spec, **resolve it under `docs/modules/`**, not the repo root.

### UI screen specifications → `docs/design/`

The UI screen specs (core/app-shell, clinical, revenue, admin, portal, platform/ops) live under
[`docs/design/screens/`](./docs/design/screens/), indexed by
[`docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md`](./docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md).
Every spec declares a named layout pattern (`Use <name>.`) defined in
[`docs/design/WARDENX_UI_LAYOUT_PATTERNS.md`](./docs/design/WARDENX_UI_LAYOUT_PATTERNS.md) — the
authoritative glossary of layout patterns, shared regions, and composition rules. Like module
specs, **UI screen specs are implementation proposals** (architecture wins on conflict).
Run `bun run docs:ui` (`scripts/check-ui-screens.ts`) to verify corpus consistency —
index parity, layout-heading hygiene, pattern resolution against the glossary, and (2026-08-14)
corpus-wide ADR-citation + relative-link integrity including the root docs.

### Authoritative architecture documents → `docs/architecture/`

These **win over module specs** in any conflict (module specs are implementation proposals).
All live in [`docs/architecture/`](./docs/architecture/):

- `WARDENX_ARCHITECTURE_v0_11.md` — system architecture (authoritative)
- `WARDENX_SYSTEM_DESIGN_v0.3.md`
- `WARDENX_SECURITY_HARDENING_v0_2.md`
- `WARDENX_AI_GOVERNANCE_v0.2.md`
- `WARDENX_DR_BCP_v0.1.md`, `WARDENX_OPS_RUNBOOK_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`
- `ARCHITECTURE_25_15_FITNESS.md` — architecture-fitness rules

> When you need an architecture document, **resolve it under `docs/architecture/`**, not the repo
> root. (Older docs reference these by bare filename or version — same files, new location.)

### Architecture-fitness kit (enforcement code under the repo-root `architecture/`)

Note: the `architecture/` directory at the repo root holds the *enforcement code*, distinct from
the prose docs in `docs/architecture/`.

- `architecture/module-manifest.ts` (+ `.cjs`) — single source of truth for each module's
  `codePaths`, `dependsOn`, and `ownedTables` (461 tables across 40 modules).
- `architecture/.dependency-cruiser.cjs` — import-boundary rules.
- `scripts/check-table-ownership.ts`, `check-ddl-legality.ts`,
  `check-fitness-gaps.ts` (event-catalog `mN.` convention, seam-registry completeness, PHI
  RLS/audit-trigger presence — armed-inert until app source lands), `check-ui-screens.ts` —
  enforced via `package.json` scripts (`bun run arch:fitness`; UI-corpus check also standalone
  as `bun run docs:ui`).
- `scripts/check-tenancy.ts` — **tenancy & RLS invariants** (`bun run arch:tenancy`, in
  `arch:fitness`): the three-column rule, the canonical `app.org_id` session variable, the
  dangerous policy shapes ADR-0010 D3 bans, and (F-087) **RLS enabled ⇒ RLS FORCEd**. Its Rule 2 exemptions — M4 audit attribution, the M34
  key-ring SECURITY DEFINER GUCs — are scoped to the **statement** they were written for and never
  reach a policy predicate. They used to be tested against the whole FILE, and the repo's own
  convention puts a module's RLS policies in the same migration as its audit triggers
  (`*_rls_audit_triggers.sql`), so one `INSERT INTO audit_event` exempted every `app.user_id` in the
  file — policy bodies included. That is how `user_notif_pref_self` (#21: an org-unscoped `FOR ALL`
  policy on an org-scoped table, a confirmed cross-tenant read AND write) sat green in `0017` while
  the gate reported only the two migrations that happened not to contain a trigger. Policy
  predicates are now judged on the migrations' **net effect** — the files replayed in apply order,
  so a violation a later migration drops and replaces stops counting, which is what lets a
  remediated policy go green without the offending text ever leaving its original file. Deliberately
  a static replay and not a `pg_policies` read: `arch:fitness` runs where there is no database (the
  same reason the live suites are `skipIf`-guarded), so a catalog-reading gate would skip in CI —
  `m1-rls-isolation.live.test.ts` is the catalog-side complement and runs in `rls-live`. A policy
  created through dynamic SQL inside a `DO` block is the known limit, and the plain text scan still
  sees the session variables inside it.
  **Rule 4** (F-087) applies the same net-effect replay to `ENABLE`/`FORCE ROW LEVEL SECURITY`.
  ENABLE does not apply to a table's OWNER; every policy here is `TO wardenx_app` and
  `scripts/db/migrate.ts` connects as `DATABASE_ADMIN_URL ?? DATABASE_URL`, so a deployment that
  migrates with only `DATABASE_URL` set makes `wardenx_app` the owner and every policy on an
  unFORCEd table stops applying to it — and there is no flag to catch it, since the boot guard
  checks BYPASSRLS and **ownership is not BYPASSRLS**. Migration 0118 documents all of this and
  swept 370 tables; 0159 re-swept the 66 M28/M29/M35/M37 added after it; 0203 hand-patched two M24
  tables; F-087 found `fhir_read_disclosure` (0233, the M28 §164.528 disclosure ledger — the one
  table whose whole purpose is to answer "which patients did this partner read", so an unFORCEd copy
  answers a *different* tenant's disclosures to whoever asks). **Four manual re-sweeps, each found
  by querying a live schema, none of which prevented the next** — the only thing that had ever asked
  is `rls-isolation.live.test.ts`'s catalog assertion, in `rls-live`, which has no runner assigned.
  The rule MODELS the two catalog sweeps rather than hardcoding them (a statement that reads
  `relforcerowsecurity` and issues `FORCE` forces everything enabled before it), so a fifth needs no
  edit here. Its known limit is Rule 2a's mirrored: RLS enabled by dynamic SQL is invisible, which is
  a MISS and never a false alarm — partition leaves are the deliberate case (0118's event trigger
  enables and forces them at CREATE time, asserted against the catalog in the live suite).
- `scripts/check-migration-numbering.ts` — **migration ordinal uniqueness** (F-026,
  `bun run arch:migration-numbering`, in `arch:fitness`). The four-digit prefix in
  `packages/db/migrations/NNNN_name.sql` IS the migration's position in the apply order, and
  `scripts/db/migrate.ts` applies files in plain lexicographic `.sort()` order — yet nothing
  enforced that two files do not claim the same number. With a duplicate, which one runs first is
  decided by the rest of the filename (`0216_admission_…` before `0216_m36_…` because "a" < "m"),
  a coin flip nobody chose; two independent migrations survive it, a backfill and the migration
  adding the column it backfills do not. It is a WHEN on a branch-per-change workflow: every branch
  picks "the next number" against `main`, so two opened the same afternoon pick the same one — four
  audit branches had already collided in pairs on 0215 and 0216 with every gate green on all four.
  Duplicates are a hard error naming **every** claimant (the fix is a rename, and which file to
  rename is the reader's judgement); **gaps are reported, never fatal**, because a branch that
  leaves 0215 for a sibling PR and takes 0216 is doing the right thing.
- `scripts/check-test-typecheck-coverage.ts` — **test-tree typecheck coverage gate** (F-098,
  `bun run arch:test-typecheck`, in `arch:fitness`; `bun run typecheck` now runs `tsc -b` PLUS
  `typecheck:tests`). **Every test file vitest runs must be in a typecheck program. None of them were.**
  All four apps and all 51 packages set `"include": ["src"]`, and the convention here puts a suite in a
  sibling `__tests__/`, so `tsc -b` compiled the source of every project and **631 files vitest runs were
  compiled by nothing** — 346 of them in `apps/backend/__tests__` alone. Only `scripts/` (its own tsconfig
  globs everything under it) and `e2e/` were covered. A test file is the only executable statement of what
  a production signature is supposed to be, and when it is not compiled, changing a signature does not
  break its callers — it silently makes them WRONG, and a suite that no longer matches the code it covers
  still reports green for whatever it does instead. **F-096 (#209) is the worked example**: it made
  `PatientRouteService.list`'s caseload-narrowing argument REQUIRED, a two-argument caller survived in
  `auth.live.test.ts`, and a full `typecheck && test` was green on both — invisible on two axes at once,
  since a live suite also self-skips without a database. The census-narrowing control shipped with its own
  proof passing an undefined scope. The gate does not check that the configs EXIST, it checks that they
  RESOLVE to the same file set the runner does: it imports `vitest.config.ts` itself (rather than
  restating its globs — the copy-of-a-list shape F-094/F-095 were about), expands each project's
  include/exclude over the tracked tree, and requires every file to appear in the `fileNames` of the
  `tsc -b` project graph, `tsconfig.tests.json` or `tsconfig.tests.dom.json`. Its glob matcher REFUSES a
  pattern it cannot represent rather than approximating it — an under-matching matcher reports a covered
  file as unchecked, or an unchecked one as covered, both with a green build. It also checks the SPLIT:
  the DOM program is the only one carrying `lib: DOM` + `jsx`, and a jsdom suite compiled without them
  reports itself, while a NODE suite drifting into the DOM program compiles happily and throws at runtime
  on a `document` jsdom was never asked for — so the two programs must be **disjoint**. The test programs
  set `noUncheckedIndexedAccess: false` and nothing else: that one flag accounts for **720 of the 944**
  errors turning this on surfaced, all of them `possibly undefined` on test-local scaffolding where a
  dereference throws and fails the test loudly, which is the correct outcome and not the silent-undefined
  propagation the flag exists to prevent. The **224 that remain are the interface-agreement class**, and
  fixing them found live defects in the corpus: fabricated enum values a database would reject
  (`verbal_threat`/`animal_hazard` for `safety_incident_category`, `rn` for `OncallShiftDiscipline`,
  `scheduled` for `VisitStatus`, `home` for `VisitSetting`, `closed` for `DisciplinePlanStatus`,
  `patient` for `ConsentGrantorKind`, `cloud`/`capability_default` for the two `ai_routing_*` enums,
  `cms.section_i.missing` for a HOPE rule id); `discipline-plans-authz`'s `__resetAbacForTest?.()`, a
  no-op because nothing exports that name, so the registry it clears was never cleared; M14's
  `createInMemoryIdgBackend` returning `drainEvents`/`currentQuorum` through an untyped `Object.assign`
  under an annotation that widened them away (now `IdgBackendInspect`, the M22 `DocumentBackendInspect`
  shape); every `recordDecision` call in the M14 acceptance suite omitting the REQUIRED §2.6 D4 `payload`,
  so the adjournment burst it asserts carried nothing to M7/M11/M12; the M13 comfort-kit suite handing a
  `KitDrawdownInit` (the deployment plan) to `applyKitDrawdown` (which decrements the persisted
  `KitDrawdownState`), running every drawdown with an undefined deployment id and drug name; `SeedIds` in
  the M9 read suite naming two of the five ids `seedOrg` returns; a `json(): never` inject-helper
  declaration that made every response-body read in `hope-routes`/`admission-routes` an error; and ~20
  `SessionContextRecord` fixtures still on the pre-F-030 shape, which is why `identity-seams.test.ts`
  asserted `sessionClass`/`portalAccountId`/`sessionPatientId` as `undefined` — a shape the real store
  cannot return — directly under a comment claiming it pinned the FULL actor.
- `scripts/check-manifest-mirror.ts` — **manifest-mirror agreement gate** (`bun run arch:manifest-mirror`,
  in `arch:fitness`, ordered BEFORE `arch:boundaries`). The manifest exists twice: `module-manifest.ts` is
  what every fitness script imports, and `module-manifest.cjs` is the CommonJS mirror
  `.dependency-cruiser.cjs` requires, because a dependency-cruiser config is plain CJS with no TypeScript
  in the loop. The `.cjs` began as `tsc`'s emit of the `.ts` — the `Object.defineProperty(exports,
  "__esModule", …)` preamble is the giveaway — but its header prose was later condensed by hand, so it is
  no longer byte-reproducible from a transpile and regenerating it would delete writing someone did
  deliberately. Nothing kept the two in agreement after that: every table added to a module since had to
  be written into both files from memory, and two were not — `membership_elevated_approval` (0204) and
  `device_attestation` (0222), the first for the whole of its life. That drift changed no behaviour,
  because dependency-cruiser reads only `codePaths`/`dependsOn` and `ownedTables` is consumed by
  `check-table-ownership.ts` off the `.ts`. **That is the problem, not the mitigation**: a mirror that can
  be wrong in a way nothing notices will eventually be wrong in a way something does, and a missing
  `codePaths`/`dependsOn` entry silently RELAXES an import boundary — the one failure the boundary gate
  exists to prevent and the one shape it cannot detect in itself. The gate compares the DATA (the files
  may and should differ in prose) plus the two FUNCTIONS dependency-cruiser actually calls,
  `allowedImportPaths`/`allowedTables`, evaluated for every module id: agreeing on every input while
  disagreeing on the resolved output would be the worst possible pass.
- `scripts/check-merge-artifacts.ts` — **unresolved-merge-artifact gate** (`bun run
  arch:merge-artifacts`, first in `arch:fitness`). A conflicted file that is `git add`-ed without
  being resolved commits its CONFLICT MARKERS: `add` marks a path resolved whatever is in it, so the
  markers land in the tree and the merge commit looks ordinary. Source files are safe by accident —
  `tsc` will not parse `<<<<<<< HEAD` — but the load-bearing NON-source files have no reader in the
  build. That is how a half-resolved `.github/workflows/ci.yml` sat on `main` across seven merges:
  GitHub parses that file, not the toolchain, and `arch:live-suites` reads it as TEXT (it greps for
  script names), so it found every job name and stayed green while the workflow was syntactically
  dead. A broken workflow does not fail a build, it fails to RUN one. The gate scans every
  `git ls-files` path — YAML, JSON, Markdown and SQL included — for a line-initial `<<<<<<< ` /
  `>>>>>>> `, or a whole-line `=======` (matched exactly, since seven equals signs are also a
  Markdown setext heading; a real conflict always brings a `<<<<<<<` with it).
- `scripts/check-abac-predicates.ts` — **ABAC named-predicate resolution** (`bun run arch:abac-predicates`). Every `requireAbac(_, "<name>")` — including through each module's
  local `guards.ts` factory — must name a predicate some module declares. M3's registry fails
  closed on an unknown name, so a typo'd or never-registered name is a permanently dead endpoint
  (403 for every caller) with the whole build green; that is exactly how M30's 15 `inOrg` guards
  sat unreachable across 7 route files. There is **no deferral allowlist**: a predicate whose
  inputs do not exist yet is expressed as a *registered* predicate that denies and says why
  (`deviceAttestationValid` in `packages/auth/src/abac/registry.ts`), never as an unregistered
  name — both refuse identically, only the first is distinguishable from a mistake.
  **The UNASKED DIRECTION is a standing finding (F-092)**, the F-025/F-043 shape a third time. This
  gate goes guard → declaration, so it cannot see a control that is DECLARED and gated by nothing.
  Every `PermissionDef` carries an `abac` field — "the default ABAC predicate that guards the key, or
  `'none'`" — and **545 catalog keys name a non-`none` predicate while only 113 are named by any
  `requireAbac` guard**. `requirePermission` resolves the actor's grant set and asks `granted.has(key)`;
  it never reads `defaultAbac`, which exists only to mirror into the `permission` table for the admin
  UI. So the field is a declaration with no mechanism behind it, and several route files' own headers
  say the opposite — M13's eMAR routes state their key "maps to the shared `caseload_or_scope`
  predicate … **bound by the §4.6 default ABAC on each clinical route**", a binding that does not exist.
  Most of the 466 unguarded keys are defensible (a module composing its own `admission.scope` /
  `encounter.scope` / `hope.scope` is doing the same job under another name, and `inOrg` at 116 keys is
  RLS's job), which is why no gate is proposed yet: a 466-entry deferral registry written without
  verifying each one would manufacture a passing state, the failure `outbox:deferrals:update` is
  explicitly built to refuse. **M5 was the instance that mattered and is fixed**: it was the only
  clinical module on the platform composing NO `requireAbac` at all, while nine of its keys declared
  `caseload_or_scope` and six of its route comments claimed a "§7.5 non-leak · non-caseload → 404" that
  `service.getPatient(organizationId, id)` has no caseload input to perform — any holder of
  `patient.read` read any chart in the tenant. The per-chart routes now compose the predicate the
  catalog names, with `notFoundOnDeny` so a refusal does not itself confirm the chart exists.
  Fixing M5 surfaced a second live defect in the four modules that DO enforce it (M7/M9/M20/M23):
  `ORG_WIDE_SCOPE_ROLES` listed `medical_director`, `compliance_officer` and `survey_coordinator` and
  **omitted `director_of_nursing`**, whose `SYSTEM_LOCKED_FLOORS` entry locks on `patient.read` AND
  `patient.assign` — a permission to put clinicians on caseloads that cannot be exercised against
  patients the holder may not see. A DON has been refused every care plan, assessment and safety row
  outside their own caseload. The list is now DERIVED from the floors that lock `patient.read` rather
  than maintained by hand. `org_admin` is deliberately NOT included even though ~10 predicates treat it
  as the tenant's top authority: it carries no `patient.read` floor, so the platform has never asserted
  that role reads charts.
  **§7.5's other half — the CENSUS list — is now narrowed too (F-096, #209), and the derivation is
  shared rather than copied.** F-092 delivered the per-chart 404 and named the list half as open because
  "a preHandler can refuse a list but cannot filter one". That was the LARGER of the two disclosures: a
  chart read leaks one patient to someone who guessed an id, a census leaks the identity of every patient
  the agency serves to everyone who can log in, and any holder of `patient.read` listed all 5,000.
  `PatientRouteService.list` now takes the narrowing set as a REQUIRED third argument — `null` for an
  org-wide reader, otherwise the ids, resolved through M5's own `caseloadPatientIds`, whose doc comment
  has called it "the `patient_id = ANY(:ids)` list filter" since M5-T07 while having exactly one consumer
  platform-wide (M12's refill inbox, which is not this list). **An EMPTY set returns NOTHING**: the
  fail-open shape is `if (ids.length > 0) narrow(ids)`, which reads as a harmless guard against an empty
  `IN ()` and hands the entire tenant to precisely the actor who should see least. The narrowing is in the
  WHERE clause, not a post-read `rows.filter` — the M12 `refillInboxWhere` lesson, and the two are
  indistinguishable until a LIMIT is involved, which is why `m5-census-caseload-scope.live.test.ts` pages
  through a caseload that sorts LAST: a post-read filter returns a short page and a wrong cursor having
  already read every patient into memory. Three of its seven fail against the two failure shapes.
  Fixing it needed the org-wide determination callable from outside the predicate registry, which
  surfaced that `ORG_WIDE_SCOPE_ROLES` existed **five times** — M7, M8, M9, M10 and M15 — and that F-092
  had derived exactly one of them. **M8, M9 and M10 still carried the three-name literal**, so a DON went
  on being refused every encounter, assessment and HOPE record outside their own caseload, and M8's copy
  claimed in its own comment to "mirror M7's". There is now one `hasOrgWideScope` in `@wardenx/auth`,
  beside the `SYSTEM_LOCKED_FLOORS` it derives from, and `org-wide-scope.test.ts` pins the DERIVATION
  rather than the four names — asserting the output would rebuild the thing that failed.
**Every invitation the platform ever issued produced a membership with NO role grants (F-097, #210).**
M2 §D3 is recorded as **Decided** — "Membership→role assignment is Module 3. M2 carries
`proposedRoleKeys` … and creates the membership; M3 attaches roles on accept" — and its §11 "Done means"
repeats it. Nothing performed it. `POST /api/v1/invitations/accept` consumed the token, created the
membership, and returned, carrying the comment "proposedRoleKeys are carried to M3 on accept (role attach
is M3-owned, §7.1)" — a line naming the mechanism as someone else's while nobody had it. There is no event
path either: at the time this was found, **M2 contributed no outbox catalog at all** (the absence #205
later recorded as the blocker for M35's four `m2.*` subscriptions), so `m2.membership.accepted` was an
AUDIT action and nothing could subscribe to it. **M2 now catalogues it** (`events-by-m2.ts`, #205), and it
stays deliberately record-only (`declaredConsumers: []`) — its own catalog comment says why: the §D3 role
attach this finding fixes below is "the real, synchronous mechanism for downstream role-grant effects;
this event has no consumer." An admin invites an RN as `clinical_rn`, the RN accepts, the RN holds nothing — no error,
no warning, and the `organization_invitation` row still lists the roles that were requested, so the admin
surface reports access the user does not have. The handshake is now performed by
`03-authorization/proposed-role-attacher.ts`, bound at the composition root because M2 is `dependsOn: [1]`
and cannot import M3 (the `emailTransport` precedent). It resolves keys to THIS org's enabled roles and
grants them in one RLS-scoped transaction, idempotent by the UNIQUE `(membership_id, role_id)` index
rather than by a pre-read (a replayed accept is expected — the invitation `consume` already races
atomically). **The `organization_id` predicate on the role lookup is load-bearing and not redundant with
RLS**: migration 0025 widened the role READ policy to admit org-NULL platform TEMPLATE rows, so RLS alone
lets a template resolve and be granted into a tenant that never created it —
`m3-proposed-role-attach.live.test.ts` fails on exactly that case when the predicate is removed.
**An unresolvable key is REPORTED, never dropped** (`rolesAttached: { attached, unresolved }` on the wire,
audited as `m3.role.assigned` with outcome `failure` when nothing attached): silence would reproduce the
defect one layer down, and it is the state a freshly provisioned tenant is in for EVERY key —
**M34's provisioning worker seeds a key ring, storage prefixes, an organization, onboarding tasks and the
first-admin invitation, and NO `role` rows.** `ROLE_TEMPLATES` still has no materializer (the `permission`
catalog has `db:sync:permissions`; roles have no sibling), so outside the dev seed scripts the table starts
empty — and the M34 onboarding template `first_admin_invited` gates on
`orgAdminAcceptedMembershipCount > 0`, an `org_admin` grant that cannot exist. **That half is reported, not
fixed**: which roles a new tenant gets by default is a product decision, and only 13 of the spec's ≈60
Appendix-A templates are coded (F-093), so seeding "the 7 tenant ones" would quietly make that mismatch
normative. `packages/saas-tenant-platform/src/onboarding/context.ts` also has no production builder, so the
precondition DSL evaluates nowhere.
**The regression that proves the standing test-corpus finding.** F-096 made
`PatientRouteService.list`'s narrowing argument REQUIRED, and a two-argument caller in
`auth.live.test.ts` survived a full green `typecheck` + `test` run: `apps/backend/tsconfig.json` is
`"include": ["src"]`, so **all 136 backend suite files are never typechecked**, and a live suite
additionally self-skips without a database — invisible on two axes at once. Measured today: ~730 real
type errors across `apps/backend/__tests__` (plus 1208 TS6307 project-config artifacts). Fixing that is
its own change; the broken caller and the census-narrowing fallout in that suite are fixed here, and
TEST-003 now seeds a real `patient_assignment` and registers the real `CaseloadProvider`, so it proves
the §7.5 narrowing end-to-end under a genuine session cookie rather than a header shim.

**The §3.4.1 CoP role floor was enforced in the test double and nowhere else (F-093).** Two files each
named the other as the enforcer: `role-store.ts` — the Drizzle `RoleStore` the composition root mounts —
said "the route layer enforces the `system_locked` CoP floor before calling the store", while
`authz-routes.ts` says "the §3.4.1 floor check IN THE STORE is what refuses it" and only TRANSLATES a
`RoleLockedError` into a 409. The store that raises it is `createInMemoryRoleStore`, the slice every
route test runs against; the production one deleted and re-inserted `role_permission` unconditionally and
deleted any role row handed to it. So `PATCH /api/v1/roles/:id { permissionKeys: [] }` stripped the
Medical Director's CoP floor and `DELETE` removed the Compliance Officer role — M03-F06, the control CoP
418.102 / 418.64(a) / 418.52 rest on. **Two more defects sat under it.** (1) The pre-read ran on the bare
pool — `db.select().where(eq(roles.id, id))` with no `withOrgContext`, so `app.org_id` was unset, the
policy predicate was NULL and it matched nothing: under real RLS every role edit was a raw 500 and every
delete a silent no-op. It looked fine in development because `db:migrate` grants `wardenx_app` BYPASSRLS
there, which is exactly the gap the live-suite convention exists to cross. (2) **Eight of the
twenty-seven floor keys named permissions no module registers** — `cti.sign` where M6 registers
`cti.sign_hospice_md`, `order.cosign` where M11 registers `orders.cosign`, `security_event.read` for a
resource with no table, no route and no key anywhere. `role_permission.permission_key` REFERENCES
`permission.key`, so those floors were UNGRANTABLE, and `floorViolations` reports an ungrantable key as
stripped on every edit — enforcing §3.4.1 without fixing them would have made locked roles permanently
uneditable. The floors now name catalog keys, `permission-catalog.test.ts` pins the resolution invariant
in both directions (floors and template `grants`), and `role-templates.test.ts` no longer pins the spec's
§3.4.1 table verbatim: pinning the spec is what preserved the eight dangling names, and `catalog.ts`'s own
rule — "the permission catalog is CODE, the single source of truth" — plus the authority rule (a module
spec is an implementation proposal) settle which side is normative. `m3-role-catalog-floor.live.test.ts`
is the proof and is LIVE by necessity: a test against the double proves the double, which is what every
suite had been doing while the deployed control was absent. All 10 of its cases fail against the
pre-fix store. **Two related absences are reported, not fixed**: nothing materializes `ROLE_TEMPLATES`
into the `role` table (the `permission` catalog has `db:sync:permissions`; roles have no sibling), so
every row in every database is org-owned with `system_default`/`system_locked` FALSE and migration 0025's
org-NULL read widening admits template rows nothing creates — which is why the lock check keys on the
role KEY and treats the column as a second arm; and this file ships 13 templates where the spec's
Appendix A enumerates ≈60.

- `scripts/check-request-header-auth.ts` — **request-header authorization gate** (F-028,
  `bun run arch:request-header-auth`, in `arch:fitness`). A request header is whatever the caller
  typed; deciding an AUTHORIZATION question from one, unverified, hands the decision to the party
  being gated. Four commit-point routes did exactly that — M14's IDG adjourn (the D13 commit point),
  M17's self-attested visit start, and M18's retroactive correction-of-record + D6 supervisor
  override each gated their fresh-step-up requirement on `request.headers["x-step-up"] === "fresh"`,
  so anyone who could reach the route could satisfy the re-authentication ceremony by typing the
  header. Eight other modules gated the same requirement correctly the whole time, through
  `requireStepUp(opKey)` → M3's `step_up_recent` predicate → M2's `SessionContextResolver` seam.
  Nothing caught it because every gate was self-consistent about it: the routes carried
  request/response contracts, so `arch:openapi-coverage` counted them enriched; `openapi:check`
  proves the contract was *regenerated*, not that it is *true*; and `client:gen` was clean because a
  header nothing declares is simply one the client cannot send — the published API and the code
  agreed with each other and both were wrong about what the route required. It surfaced only when
  F-012 type-checked `scripts/` and broke a seed that had been passing the header as a typed
  parameter. The gate requires every `request.headers[...]` read in `apps/backend/src` to name a
  header REGISTERED as either `verified` (the server checks the value against state it holds — a
  signature, a constant-time secret compare, a server-minted single-use token, a double-submit
  cookie) or `not-authorization` (concurrency control, telemetry; a forged value earns a 412 or a bad
  log line, never access). There is deliberately **no third classification** for "trusted because the
  caller is nice" — a header that would need one is the bug. Response headers and comments are not
  inputs and are skipped; test files are excluded (a harness legitimately drives its own fake
  authenticate hook off headers); a name reached through a module constant is resolved to the real
  header, and the one generic accessor whose name arrives as a parameter is declared in
  `DYNAMIC_READERS` with the constants its callers pass, each of which must itself be registered.
  The resolution the four routes now use is `stepUpFreshFor` /`requestStepUpFresh`
  (`apps/backend/src/bootstrap/step-up.ts`), shared with M3's predicate so the guard form and the
  boolean form cannot drift.
- `scripts/check-context-attributes.ts` — **request-context attribute producer gate** (F-030,
  `bun run arch:context-attributes`, in `arch:fitness`). `request.context.attributes` is the untyped
  bag the authenticate hook fills with server-assembled facts about the caller and that ABAC
  predicates and route actors read back out. It is `Record<string, unknown>`, so a read of a key
  nothing writes compiles, evaluates, and yields `undefined` — and every reader treats that as deny,
  which makes the failure silent, permanent, and indistinguishable from working code. Four instances
  had already been found and fixed one at a time before anyone looked for the pattern:
  `membershipId` (7 modules' §4.x ownership predicates saw null and denied), `providerEntityIds` /
  `locationIds` (every PE/location predicate denied unconditionally, ARCH-008/009), `stepUpRecent`
  (15 modules — M23/M27/M37 mount `requireStepUp`, which PASSES, then refuse in the DOMAIN on the
  always-false flag, so the guard allowed and the machine refused, F-029), and `systemPrincipal`
  (one fact under two names: `actorKind` was stamped and checked by M15/M23's
  `requireSystemPrincipal()`, while M23's seam predicate and M25's `/internal` guard checked a name
  nothing wrote — those service-to-service endpoints refused every caller, a diagnosis
  `seed-scenario-billing.ts`'s header had already written down and worked around by skipping M25).
  `arch:abac-predicates` cannot see any of this: it proves a predicate NAME resolves, not that the
  FACTS the predicate reads are ever produced. The gate requires every key read off the bag to be
  declared as either `{ producer }` — and it verifies a write actually EXISTS, since a declared
  producer that stops writing is the exact regression — or `{ blocked }`, carrying the reason and
  what it needs (the `deviceAttestationValid` rule again: a fact whose source does not exist yet is
  a *declared* absence, never an undeclared one). A blocked key that gains a writer fails, so an
  entry cannot outlive its reason; a declared key nothing reads fails, so the registry cannot go
  stale. Tests are excluded from the scan on purpose — every historical instance was invisible
  precisely BECAUSE each suite wrote the attribute in its own fake authenticate hook, so counting
  those as producers would make the gate agree with the bug. The scanner resolves string constants
  **across** files (`attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE]` is read in M14's routes and
  declared in its predicate file), the SCREAMING_CASE identifier-index write form (how both
  in-request producers actually write), and whole-bag aliases (`const attrs = ctx.attributes ?? {}`,
  which is the only way two of the unproduced keys are read at all). **4 keys are currently
  declared blocked** and the gate prints them on every run — they are the standing finding, not a
  passing state. The largest is `sessionClass`: M16/M31/M39 read it and default to `"staff"`, and
  M31's portal predicates gate on it being one of `patient_portal`/`caregiver_portal`/
  `bereaved_portal`, none of which the M1 `session_class` enum contains — so the whole portal ABAC
  surface denies. **Resolved (2026-08-26):** migration 0219 extends `session_class` with the three
  portal classes + M19's two vendor classes, 0220 teaches `session_scope_chk` what scope each
  requires, and M2 publishes a `PortalSessionBinder` seam so M31 can hand it the account/patient
  binding its `select-patient` route always claimed to. Blocked keys: **13 → 10**. Writing 0220
  against a real database also surfaced a **pre-existing** hole in the same constraint: `scope ?
  'patientId'` on a NULL `scope` is NULL, `NULL OR false` is NULL, and a CHECK **passes** on NULL —
  so the collaborator/funeral branch never bound on a row with no scope, and a one-time magic-link
  session whose whole purpose is to be pinned to ONE patient could be written unpinned. The
  app-layer mirror (`isSessionScopeValid`) never had the hole, so the defense-in-depth layer was the
  strict one and the DB floor was the loose one — which is why nothing going through the auth layer
  ever hit it. Both are proven by `session_scope_chk (F-030) — live` in `auth.live.test.ts`, which
  is that constraint's only executable coverage. **Resolved next (2026-08-26):** the session's
  pinned patient, which was read under THREE names and written under none — M31/M19 as
  `portalPatientId`, M19's portal-triage guard as `portalPatientId ?? patientId` (a `??` chain of
  two undefineds, shaped like a safety net), and M7's `caseload_or_scope` as a `scopePatientIds`
  ARRAY, so a collaborator session's scope grant never fired and every collaborator fell through to
  a caseload they are not in. One key now, `sessionPatientId`, named for the fact rather than for
  one of its three readers — M7's readers are `external_collaborator` sessions, so a `portal…` name
  would have become the fourth rather than the last. It resolves through `sessionPinnedPatientId`,
  so the CLASS decides and a staff session carrying a stray `scope.patientId` pins nothing (reading
  the jsonb key directly, as the store did, would have widened the one predicate whose job is to
  narrow). Blocked keys: **10 → 8**. Then `organizationName`, the one entry that was never an
  authorization control: M2's invitation routes read it and fell back to the literal `Organization`,
  so with nothing writing it the fallback was not a fallback but the only branch — every invitation
  row stored that string, the pre-auth `GET /invitations/:token` preview served it back to the
  invitee's browser, and the email said "invited to join your organization". It now resolves from
  the INVITER's own active membership in the org they are inviting into (`findActive`, the same read
  `/auth/context` already projects the name through), which is org-scoped by construction and adds
  no dependency. Blocked keys: **8 → 7**. Then `permissions`, whose blocked entry had assumed a COST
  decision — whether to stamp the actor's whole grant set on every request — when there was none to
  make: `resolveActorPermissions` is the check-don't-gate seam, its doc comment names this exact case
  ("consumers that must *check* a permission rather than gate on it") and states an assembled
  `AbacContext` is a valid argument, and the resolver behind it is TTL-cached per (org, user) with
  the TTL capped by the soonest grant expiry — so by the time M27/M30's predicates ask, the route's
  own `requirePermission` preHandler has already resolved the same set and it is a cache hit. Nothing
  is stamped; the two `actorHoldsPermission` helpers resolve through the seam. Blocked keys:
  **7 → 6**. Then `phiFullRead`, where the entry was not merely mis-reasoned but wrong on the facts:
  it recorded the role-token arm as working, so the attribute was "the dead half". BOTH arms were
  dead. `context.roles.includes("phi.full_read")` asks a list of ROLE keys (`compliance_officer`,
  `medical_director`, …) for a `resource.action` PERMISSION key — a namespace error nothing can make
  true — and `phi.full_read` was in no permission catalog either, so it could not be granted to
  anyone. M32's §164.528 disclosure ledger (R16/R17) therefore masked the patient identity for every
  caller, always, including the compliance officer the ledger exists for. Masking fails SAFE, which
  is why nothing surfaced it: a permanently masked ledger and a correctly masked one are
  indistinguishable. The key is now registered in M5's `phi.*` family (`abac: "none"`, a
  check-don't-gate key like `cost_report.edit_any_provider`) and resolved through the same seam, and
  it is deliberately assigned to NO default role template — who reads unmasked PHI by default is a
  tenant policy decision, and choosing one here would have granted it silently on every existing org.
  Blocked keys: **6 → 5**. Then `licensure`, the third entry in a row whose stated blocker was wrong:
  it said no column or seam existed for the clinical licence M22's §4.7 high-risk-field review gate
  needs. M17's `membership_credential` + the `CredentialReader` seam are that fact under another
  name, already applying the status/effective/expiry logic and deliberately orthogonal to the RBAC
  role grant (a clinician can hold the `rn` ROLE while the LICENCE has lapsed). Only the vocabulary
  was short, and only by one value: **`md` already means PHYSICIAN — MD *or* DO**, which
  `VISIT_PURPOSE_DISCIPLINES` has documented as "MD/DO or NP" all along, so giving DO its own enum
  value would have stopped four CoP-relevant visit purposes (`f2f`/`recert`/`loc_change`/
  `pronouncement`) accepting osteopathic physicians — a regression bought with a distinction no
  consumer makes. `pa` was genuinely absent (a physician assistant could not be recorded as licensed
  at all) and migration 0221 adds it, in NO `VISIT_PURPOSE_DISCIPLINES` list: holding a licence is
  not visit authority, and the Medicare hospice face-to-face encounter is physician-or-NP only
  (42 CFR 418.22(a)(4)). Blocked keys: **5 → 4**. Then `isPlatformOperator`, the fourth entry running
whose recorded blocker had expired: it quoted M29's own read site ("Until a platform-operator caller is
provisioned this reads false and the predicate denies (W-XI-12)") and filed it as correct-by-design. A
platform-operator caller HAS been provisioned since ADMIN-T02 registered the six `platform_staff`
templates, and M35's `platform_billing_scope` has gated its whole cross-tenant `/api/admin` surface on
exactly that role set the entire time — so M29's `nppes_platform_job_caller` was asking the same question
under a second name, and refusing the platform operators it exists to admit. It now re-derives from
`PLATFORM_OPS_ROLE_KEYS`, the same single source M35 re-derives from, so the codebase's two platform-only
gates cannot drift on who counts as an operator. Both tests that covered it supplied the attribute
themselves — the unit test set `isPlatformOperator: true` on the context and the inject suite stamped it
off an `x-test-platform-operator` header — so each demonstrated the shim, not the gate; the allow arms are
now real catalog roles, and the inject suite's platform session differs from its tenant session by that
role alone, so the 403→202 flip can only be the predicate. Blocked keys: **4 → 3**. Then `disciplines`,
which needed a DECISION rather than a diagnosis: seven modules (M7–M13) each assembled the caller's
clinical discipline set by unioning `attributes.disciplines` with the session role keys, so the union was
with the empty set on every request the codebase has ever served and the role arm was the whole answer in
all seven. Unlike every other F-030 key, NO test ever supplied this one — it did not need faking, because
the derivation degraded instead of dying. The reads are gone rather than the fact produced, because the
platform already has one derivation and two modules had written down why: M19's
`TRIAGE_DISCIPLINE_FOR_ROLE_KEY` states the rule ("M3's `RoleGrant.roleKey` is the platform's one
authority-derivation input") and **M17 — which owns both the discipline vocabulary and
`membership_credential` — resolves its own D8 pre-schedule gate exactly this way** (`resolveDisciplinesTx`:
active role grants ∩ the scheduling vocabulary), reading the credential only for the deliberately
orthogonal question of whether the licence is currently active. Producing an eighth answer to a question
three modules already answer identically would have been the drift, not the fix. `discipline-derivation.
test.ts` pins both halves — each module answers from role keys, and a stray `disciplines` attribute cannot
change the answer, so a future producer of that key cannot silently widen seven clinical floors
(controlled-substance prescribing, medication administration, order authoring, scale recording) without a
deliberate edit; 8 of its 21 cases fail against the pre-change code. Blocked keys: **3 → 2**, and both
survivors are genuine declared absences of the `deviceAttestationValid` kind: `deviceAttestation` (M2 owns
no attestation table per ADR-0023 D2 and the mobile client doing the §12.4 posture check is unbuilt per
ADR-0035 — widening it would disable a SecHardening control) and `externalActorId` (M19's binding Phase
boundary ships the Hybrid/Centralized models feature-flagged-OFF; producing it means building the §7.5
vendor SSO binding and the `packages/triage-vendors` adapter, i.e. M19 Phase 2). Then
`deviceAttestation` — the one entry the registry itself held up as its own model, and the only one that
needed a SURFACE built rather than a name rewired. **ADR-0023 D2 named exactly this and offered two exits:
add it to M2 with a real manifest `ownedTables` edit (the `tenant_step_up_policy_override` precedent) or
declare it vapor and delete the consuming specs.** It is added, because it had two consumers and one of
them already wrote to it — M18's `evv_device.m2_device_attestation_id`, documented in that table as "M2 row
(app-validated; no FK)", a logical foreign key to a table that did not exist and which M18's own
registration path satisfies with `randomUUID()`. Migration 0222 adds `device_attestation` (org-scoped RLS,
audit trigger, one LIVE row per device via a partial unique index, revoked/failed rows retained as the
trail) plus `session.device_attestation_id`; the authenticate hook stamps the fact from
`ResolvedActor.deviceAttestation`, which is RE-CHECKED off the row (`liveDeviceAttestation`: verdict,
revocation, expiry) rather than trusted from the pointer — so a revoked handset stops satisfying the gate
on its NEXT request. The write path is real, not a stub: M2's `managed_enrollment` verifier recomputes an
HMAC over a **server-minted, single-use** nonce keyed by a per-org derivation of the platform enrolment
secret, and the MAC covers the reported §12.2 posture, so the assertion is unforgeable, unreplayable and
unmalleable — the device reports its own posture (§12.4's detector runs on the handset, so it must) but
the server will not believe the report unless it arrives authenticated, and then applies the §12.2 policy
itself, where an UNREPORTED requirement counts as unmet. The two hardware providers (App Attest / Play
Integrity) report `unavailable` rather than denying, and an unconfigured deployment answers 501, so "this
deployment does not do device enrolment" never looks like "this fleet is compromised". This un-closes M33's
`report.drilldown.bulk_export`, which had been refused to every caller since it was written. Blocked keys:
**2 → 1**. Then `externalActorId`, the last one — M19's `external_triage_actor` compares the SHIFT's
vendor against the SESSION's, and nothing ever wrote the session's, so the comparison ran against
`undefined` and no vendor-scoped call could be recognised as one. It survived because it LOOKED like the
phase plan: M19 ships the Hybrid/Centralized models feature-flagged-OFF in Phase 1 and promises a Phase-2
tenant is "a configuration flip + vendor-adapter package install, not a schema change" — a promise that
did not hold, since both would have landed on a session layer that cannot express a vendor. Migration 0223
makes `scope.externalActorId` a `session_scope_chk` requirement of both vendor classes (0220 had given
them none, reasoning they are org-scoped rather than patient-scoped — true, and it does not follow that
they are unscoped WITHIN the org; the descriptor's `scopeKind` is now `external_vendor` rather than
`organization`, which is the reading that produced the gap); M2 publishes a `VendorSessionBinder` seam,
the `PortalSessionBinder` shape one module over; and M19 gains a bind route that checks four separate
things first — the vendor is in this org, the tenant's D3 model is actually outsourced, the BAA is in
effect and unexpired, and RN coverage is attested (D13 / CoP 418.64(b)). It does NOT turn the models on.
The fact resolves through `sessionExternalActorId`, so the CLASS decides and a staff session carrying a
stray `scope.externalActorId` stamps nothing — M19's own predicate header names that exact risk. Blocked
keys: **1 → 0**. **The F-030 registry is now fully produced: 12 keys, 12 producers, 0 blocked.**

**The step-up FACT had the same defect one layer down (2026-08-26).** F-029 fixed
`attributes.stepUpRecent` so the fact reaches the fifteen modules that read it, and `stepUpFreshFor`
resolves it correctly from `session.last_step_up_at` — a column **nothing in production ever wrote**.
`registerSessionStepUpRoutes` shipped with slice adapters and exactly one caller (its own test), and
`onLoginMfaCompleted`, the only other writer, was exported and called by nobody. The routes even appeared
in the published OpenAPI contract, because `scan-routes.ts` reads SOURCE and cannot tell a mounted route
from an unmounted one. So every step-up gate on the platform answered "not fresh" for every caller,
forever — fail-closed and therefore invisible, and worse than inert on the four write paths (M23 claim
submit/replace/void, M27 cost-report submit, M37 IRC cap override + restraint apply) whose guard PASSES
and whose domain then refuses on the flag. The routes are now mounted with production adapters:
`createContextSessionResolver` (server-assembled, never the body), the D8 paired-write over `session`, an
enrolment reader that requires `two_factor.verified` (Better Auth writes that row at the START of
enrolment, so treating it as enrolled would offer a challenge against a secret the user may never have
scanned — three failures from the lockout that terminates their session), and a real `MfaVerifier`. The
WebAuthn half already existed and was wired to nothing; the TOTP half did not exist at all, and
`totp-verifier.ts` now unwraps BOTH encryption layers over the secret — Better Auth's own
`symmetricEncrypt` envelope and the repo's ADR-0034 at-rest seal over it — composing the vendor's
published primitives rather than reimplementing them, and refusing rather than throwing on every failure
so the route's contract can turn a false into the 401 the lockout counter is built on. `resolvePasskeyRpId`
/`resolvePasskeyOrigin` are now shared with enrolment, because a step-up that resolved its own RP identity
would refuse every passkey this instance ever issued and report it as "assertion invalid". **The gap this
left open is now closed (F-090):** a route could still be in the published contract and mounted by
nothing, and `scripts/check-route-reachability.ts` is the call graph from the composition root that
F-029 said it would take. See its entry below — it found two more surfaces in exactly that state.
- `scripts/check-route-reachability.ts` — **route reachability from the composition root** (F-090,
  `bun run arch:route-reachability`, in `arch:fitness`). Every function that registers an HTTP route
  must be REACHED from `apps/backend/src/index.ts`. `scan-routes.ts` reads SOURCE, so an unmounted
  registrar is published in `docs/api/openapi.json` exactly like a mounted one and answers **404** —
  the contract advertises a surface that does not exist. F-029 was the instance that made the point
  (`registerSessionStepUpRoutes` had production-shaped adapters and exactly one caller, its own test,
  so `session.last_step_up_at` was written by nobody and every step-up gate on the platform answered
  "not fresh" forever) and it named both the gate needed and the trap in the cheap version: **a
  barrel's `export { registerFooRoutes } from "./foo"` is a reference, not an execution**, so "is it
  referenced anywhere?" answers yes for a registrar nothing calls. Grep cannot separate those; the
  AST can, because a re-export is an `ExportDeclaration` whose names are `ExportSpecifier` nodes — a
  kind that never appears in executable code — and skipping exactly that kind is the whole difference.
  Syntax-only (`ts.createSourceFile`, no type checker) so it runs in ~0.7s like the other gates. It
  found **two** surfaces in that state, both re-exported and called by nothing: **M22's DocLens
  extraction** (`POST /api/v1/intake/uploads/{id}/extraction/run` + `/jobs/{id}/extraction/commit`)
  and **M36's three inbound vendor webhooks**. DocLens is now mounted — everything it needs existed,
  and the module spends a paragraph specifying `503 EXTRACTION_DISABLED` + `Retry-After: 0` as the
  Phase-1 answer, which is a different statement from 404 (the capability is off for this tenant vs.
  the endpoint does not exist); it also meant `documents.doclens`, the capability flag whose whole job
  is to turn the surface on when M32 lands, was **an activation switch wired to nothing**. That entry
  originally recorded "no flag reader is threaded" as the accurate state and filed the reason as a
  standing finding — **now resolved, and it was worse than the note said (F-091)**. `feature_flag` had
  no reader AND no writer in the running system: `createDefaultFeatureFlagReader` answered `{}` for
  every org because the composition root never passed a reader, and M34's admin surface, which the note
  credited with WRITING flags, was bound to a stub that threw `M34InfraPortUnbound` on all three §4.7
  methods. Both halves dead is what hid it — a flag that cannot be set and a flag that reads off are
  indistinguishable from a Phase-1 capability that is correctly off, so the table, its four governance
  kinds, the five-key permission family, `feature_flag_write_authority`, the admin screen and the kill
  switch were all inert with nothing to say so. **And the writer could not have worked anyway**:
  `feature_flag_key_org_idx` is `UNIQUE (flag_key, organization_id)` and `organization_id` is NULL for a
  platform-global flag, so Postgres's NULL-distinctness left the global scope unconstrained *and* made
  `ON CONFLICT (flag_key, organization_id)` unable to match a global row — the create-or-update contract
  degraded to create-only for exactly the flags a platform operator sets, appending a rival row per
  edit. Migration 0237 adds `NULLS NOT DISTINCT` (migration 0110's `sss_active_pair_uniq` precedent).
  `apps/backend/src/bootstrap/feature-flag-store.ts` now binds both ends: the tenant-pool reader
  (`withOrgContext`, so migration 0002's own-org-OR-global policy is the isolation floor) threaded into
  the three surfaces that consume the fact — `GET /api/v1/system/feature-flags`, M22's
  `documents.doclens` gate and M38's §7.7 `ai.full` gate — and the platform-pool admin seam injected
  into `buildDrizzlePlatformService`. Resolution is a pure function with fail-CLOSED rules, because each
  has an easy fail-open sibling: a kill switch forces false ahead of everything, an expired flag stops
  applying, a non-`bool` value type is ABSENT rather than coerced (a non-empty string is truthy), and a
  `rollout_percent`/`targeting` flag is ABSENT because `forOrg(orgId)` carries no subject and bucketing
  a rollout by org would resolve every percentage to 0% or 100%. A tenant row wins over the global row
  **outright** — no fallback — so a lapsing tenant override can never read as the platform re-enabling
  the key there. **`setKillSwitch` still refuses, deliberately**: §4.7 specifies it as an AUDITED
  emergency control and both carriers for its alert fail on a global flag (the catalogued outbox payload
  requires a non-null `actorMembershipId` that a platform-ops actor toggling an org-NULL flag has not;
  M36's seam is `AlertEmitter.emit(orgId, …)` and a global flag has no org), so writing it silently
  would be an emergency disable whose security owner is never told — strictly worse than refusing, and
  `upsert` remains a working disable path. Proven by `m1-feature-flags.live.test.ts`, LIVE by necessity
  (NULL-distinctness, `ON CONFLICT` inference, and the RLS read policy are all statements about
  Postgres); three of its ten fail against the pre-0237 schema. M36's webhooks are a
  registered `DEFERRED` entry, the `deviceAttestationValid` rule at route-surface granularity: the
  routes and both §4.9 verification layers are built but `MessagingWebhookService` — the
  delivery-reconcile port every handler ends in — has **no implementation anywhere in the repo**, the
  Twilio/Postmark secrets have no resolver, and `@fastify/formbody`, which that file's own header says
  production registers so the urlencoded body parses into the map the HMAC is computed over, is
  registered nowhere and is not a dependency. Mounting it would answer Twilio with a signature check
  over an empty body and then call a service that does not exist. An entry that gains a mount fails
  ("outlived its reason"), one whose registrar disappears fails, and an empty reason fails.
- `scripts/check-live-suite-coverage.ts` — **live-suite CI coverage** (`bun run arch:live-suites`).
  Every live-database / live-Redis / browser suite in `package.json` must be invoked by a job in
  `.github/workflows/ci.yml`. A live suite is `describe.skipIf(!WARDENX_TEST_DATABASE_URL)`, so
  with no database it reports SKIPPED rather than failed and `bun run test` stays green either
  way; a script in `package.json` looks wired but nothing distinguishes one CI runs from one
  nothing has ever run. That pairing (GAP-086) left the 25 clinical-core **lifecycle** suites —
  205 assertions over the real Drizzle write paths — unexecuted outside their authors' laptops,
  and 23 of 25 were red once run. Two CI jobs now cover them: `rls-live` (table-level policy
  proof) and `lifecycle-live` (the production route services as the NOBYPASSRLS `wardenx_app`
  role, grouped per module). Detection derives from what a script **runs**, not what it is
  **called** — a command naming a `*.live.test.ts` file or invoking `playwright` is a live suite
  whatever its name. It used to match on the NAME, with a middle segment that allowed hyphens but
  not colons, so `test:m6:t3:write:live` and eight others were invisible to it and six ran in no
  job at all (F-015/#41) — GAP-086's failure mode reintroduced through the gate written to prevent
  it. A suite that genuinely cannot run yet is a **registered** entry in `DEFERRED` carrying its
  blocker, never an unmatched name (the `deviceAttestationValid` rule), and the gate fails the
  moment CI starts running a deferred script so the entry cannot outlive its reason; `DEFERRED` is
  empty today. All **122** suites run in CI, `test:e2e` included — the `e2e` job drives a real
  Chromium over a migrated, `db:seed:all`-seeded full stack (20 browser specs — 13 critical-workflow + the seven
  axe-core WCAG 2A/AA scans that are the repo's only automated accessibility coverage). The gate
  now checks **both directions** (F-025/#59): script → CI, and **file → script**. The second was
  never asked, so 29 suite files (112 tests) were named by no script and therefore run by nothing —
  not CI, not a hook, not `bun run test`, which never sets the live env vars. Several were the only
  live proof of a seam this document cites by filename (`m26-cost-report-cap-seam`,
  `m27-validation-context`, `m25-835-ingestion`, `m31-portal-eraser`). Twenty-eight passed when run;
  the one that did not — `m6-abac-scope-resolver` (GAP-011), green on `main` and red on the F-017
  stack once that branch's fail-closed provider-entity check landed — is why this is a gate and not
  a note. All 29 now have `test:…:live` scripts and `lifecycle-live` runners, and that job gained a
  Valkey service because four of them gate on `WARDENX_TEST_REDIS_URL` too and would otherwise have
  reported SKIPPED. Exclusions on either side are **named** — `DEFERRED` and `NOT_A_SUITE_FILE` —
  never a file or script that quietly fails to be found.
- `scripts/check-outbox-bindings.ts` — **outbox binding ↔ event-catalog agreement**
  (`bun run arch:outbox-bindings`, in `arch:fitness`). Every live `OutboxConsumerBinding` must bind a
  catalogued event, must not bind one catalogued record-only (`declaredConsumers: []`), and its module
  must be named in that event's `declaredConsumers`. The dispatcher asserts exactly this already — by
  THROWING before `server.listen()` — but it is only constructed when `DATABASE_PLATFORM_URL` is set,
  so no test, local run or CI job ever reached the check. Two mismatches accumulated in two modules
  (`m23.claim.submission_failed` omitted M23's own retry consumer; `m25.edi.835_received` was
  catalogued record-only while M25 bound it live), and the only symptom was a backend that refused to
  start in the documented production configuration (F-020, issue #49). Unlike the other static gates
  this one EVALUATES rather than parses: it imports each consumer module and calls its
  `build…Consumer` factory with an absorbing stub, so the six different indirections the bindings use
  to express their event lists resolve to their real values. A binding file that yields no binding is
  an error, never a skip. The runtime half is the `outbox-boot` CI job
  (`bun run check:boot:platform`), which boots the backend with a real provisioned platform login and
  proves the relay starts. **F-043 (#103) adds the direction none of them ran**: all three
  rules above go binding → catalog, so an event declaring `["m33","m36"]` with no consumer anywhere
  satisfied every one of them — the catalog read as if all 599 of its consumer-declaring entries were
  wired when **570** were not, and at (module, event) granularity **1165 of 1203** pairs were unbound.
  Same unasked-direction shape as F-025/#59 (the live-suite gate checked `package.json` → CI and never
  the reverse, hiding 29 suite files). Rule 4 now requires every module named in `declaredConsumers` to
  have a live binding **or** to be named in `scripts/outbox-deferred-consumers.ts` with a reason — the
  `deviceAttestationValid` rule again, at (module, event) granularity so the count cannot drift: a new
  unbound pair fails, a listed pair that gains a binding fails ("outlived its reason"), an entry whose
  event or declaration disappears fails, and an empty reason fails. `--update`
  (`bun run outbox:deferrals:update`) regenerates the event lists but never the reasons, and writes a
  brand-new consumer module as `kind: "unclassified"` with an EMPTY reason — so updating cannot
  manufacture a passing state. `unclassified` groups print on every run as the standing finding (today:
  **0**). The absence is **not silent at runtime**: `resolveRouting` marks such an event `deferred` and
  the relay finalizes each row `pending` with `attemptCount - 1`, so it never reaches `maxAttempts`,
  never dead-letters, and is never purged (retention touches only `dispatched` rows) — every emission
  becomes a row re-claimed every 30 minutes for the life of the deployment, which
  `outbox-dispatcher.live.test.ts` already proves. The two largest groups are one decision each, not
  hundreds of forgotten consumers: **m36** (272) routes alerts through the `AlertEmitter` **seam**, and
  **m33** (319) pulls metrics from `report_mv.*` materialized views.
  **M20 is the first module bound out of the registry entirely** (542 → 538 pairs, 33 → 32 modules), and it
  is the shape the `handlers-unbound` list was named for. Six deciders — the §7.1 cadence materializer, the
  reassignment re-point, the completion retirement, the §4.8 no-show inquiry and both EVV bracket
  re-anchors — were complete, exported and unit-tested since M20-T04 with **no factory yielding a
  binding**, so their only caller was their own test file. One layer down that meant **no INSERT into
  `safety_check_in_schedule` existed anywhere in the repository**: the only write was the fulfilment UPDATE,
  which can close a row but not make one, so the §4.2 supervisor board, the §4.3 badge trio, the §4.8
  overdue detector and the clinician's own `/me/today` had always read an EMPTY SET. A safety board that
  answers "nobody is overdue" because nobody was ever OBLIGED is indistinguishable from one where everyone
  is fine. **Both halves had to land together**, because the catalog declared `m20` on neither
  `m17.visit.published` / `.completed` / `.no_show_detected` nor `m18.evv.check_in_recorded` /
  `.check_out_recorded` — a binding without the declaration is routed nothing — and two declarations it DID
  carry (`m18.evv.geofence_breach_recorded`, `m19.oncall_shift.activated`) name a consumer M20's own
  `consumers/index.ts` explains it will never write, so they deferred every emission forever. Three things
  only running it found. `seam-context`'s `readVisitAnchors` — written FOR these consumers — returns `null`
  on both "no such visit" and "the seam threw", correct for the §4.2 board and wrong for a consumer, and
  M17's seam store opens `withOrgContextFromRequest`, which throws outside a request scope: a binding that
  used the helper would have caught that on every single delivery and no-op'd forever, green. Each handler
  opens `runWithRequestContext` and reads the seam directly. And `wardenx_app` **had no DELETE grant on the
  table** while `consumers/schedule-plan.ts` defines retirement AS a delete and argues no member of
  `safety_check_in_state` can truthfully say "invalidated" — migration 0111's header says the app role gets
  DELETE on nothing in M20 and both statements were written before anything executed one. Migration 0238
  grants it on that one table: a `proposed` row is a plan the system MADE, not evidence of anything that
  happened, and 0111's own M4 trigger fires on DELETE so the retirement stays on the record.

  **A second M20 mechanism sits entirely outside the outbox and is invisible to every gate above it
  (F-111, #249).** `lifecycle/sos-escalator.ts` (§4.8 `m20.sos-sla-watchdog.cron`, D7, M20-F05/S13/
  INT-031) is a complete, pure, unit-tested per-alert decider for the SOS escalation ladder — the
  5-second stale-cancel-window sweep, tier-1/2/3 SLA-dwell escalation via `escalateSos`, and the
  `emergency_terminus` re-page loop via `repageTerminus`. **Nothing calls it.** No file under
  `20-field-safety/` matches `*cron*`/`*worker*`/`*job*`; no queue name or BullMQ registration
  mentions `sos-sla-watchdog` anywhere outside the decider's own header comment; the composition root
  wires M20's outbox consumers (F-043/#103) but registers no cron worker for this module at all. A
  field clinician's SOS alert that nobody acknowledges within its tier-1 SLA sits in `acknowledging`
  forever — not an error path, the absence of a background process, so nothing logs it. The ladder
  fires today only on a supervisor's manual escalate or when an M36 delivery failure happens to
  trigger it (`consumers/m36-delivery-failed.ts`, capped short of the terminus, #205's M36
  follow-up). **Why neither outbox gate caught it**: `check-outbox-bindings.ts` and
  `check-live-suite-coverage.ts` both reason about the outbox — catalog↔binding agreement, live
  suites wired to CI — and this is a scheduled decider with no producer event to wait on, invisible
  to both gate classes this repo has built. **Reported, not fixed**: a from-scratch build (a BullMQ
  worker under the reserved `m20.sos-sla-watchdog.cron` name, per-org/per-alert scanning via the
  active-org enumerator pattern M30's wiring batch established, locking against double-escalation,
  composition-root wiring) — comparable in scope to the M36 out-of-band dispatch pipeline and M27
  async cost-report processing, both reported and deferred elsewhere in this document rather than
  built inline.

  **M19 followed M20 out of the registry's launch-critical tier (F-043, #103).** Its two D10 inbound
  triggers — `consumers/m17-no-show.ts` and `m18-late-checkout.ts` over the shared `inbound-trigger.ts`
  core — were complete deciders whose only caller was their own test, so the relay deferred both. What that
  cost: `triage_call.source` has six enum values and the module's two live insert paths hardcode `manual`
  and `paper_origin`, so `no_show`, `late_checkout`, `m36_delivery_failure` and `geofence_anomaly` were
  unreachable and `source_outbox_event_id` — the column D10's redelivery guard
  `triage_call_source_dedupe_uq` is built on — had **never been written by anything**. No proactive triage
  call had ever been opened: a clinician who never arrived at a dying patient's home, and one who never
  checked out of it, each raised an event delivered to nobody. Binding them also gives
  `m19.oncall_shift.coverage_gap` its first producer, which `events-by-m19.ts`'s own header records as
  "declared … but never actually published anywhere in this codebase yet". **The defect the live run found
  is worth keeping**: the ports read M19's OWN tables, so the first draft ran them on the bare pool. That
  does not fail closed to "no rows". Once ANY transaction on a pooled connection has run
  `set_config('app.org_id', …, true)`, the GUC reverts after commit to the SESSION value — which for a
  custom GUC never set at session level is the **empty string, not NULL** — so the RLS predicate's
  `current_setting('app.org_id', true)::uuid` becomes `''::uuid` and the read throws `22P02`. On an idle
  connection it would instead have matched nothing silently, and a `findCallBySourceEvent` that answers
  null for a call that exists is a duplicate welfare call on every redelivery, which is exactly what D10's
  guard exists to prevent. Loud on a busy connection, silent on a fresh one, wrong on both.

  **The m22 group's REASON was wrong about six of its members (F-099, #103).** The registry groups by
  (module, kind) "so the reason lives once — m22 is declared on 85 events for one reason, not 85 reasons",
  and m22's read: M22 renders on REQUEST, a module that wants a document emits a render request, and
  "these declarations name M22 as a consumer of the SOURCE clinical/billing event instead — the same
  handshake spelled a second way, and only the request spelling is wired." True of ~70. **False of six,
  which ARE the request spelling and were being emitted from production write paths with nothing draining
  them**: `m10.hope.summary_requested` (`POST /hope/assessments/:id/summary-pdf`),
  `m16.bereavement.outreach_artifact_requested` (the D14 welcome packet at plan open),
  `m20.safety.incident_report_requested` (whose catalog entry says "M22's renderer consumes it; M20 ships
  no PDF code"), `m25.appeal_packet.render_requested`, `m27.artifact.render_requested` and
  `m37.body_release.document_requested`. Each declares `["m22"]` and nothing else, so no other module was
  covering for the absence, and each emit site's own comment says M22 renders it. Every one of those rows
  has sat `pending` since its producer landed — re-claimed every thirty minutes, never dead-lettered,
  never purged. **This is the grouping's own failure mode**: a reason that fits most of a group reads as a
  decision covering all of it, and the entry is then the LAST place anyone re-derives, because it looks
  like the question was already asked. `M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS` compounded it from the
  other side — its header called `m37.body_release.document_requested` "declared but has no emitter and no
  published template" when M37's body-release machine emits it on `identifyFuneralHome` and
  `ipu_body_release.release_document_id` is the column waiting for it, **named in that column's own schema
  comment**. Binding them needed migration 0239 (seven `document_aggregate_type` values; M16's packet
  files against the existing `bereavement_letter`, one aggregate type with several template keys) plus
  eight template descriptors and six `REQUEST_SHAPES` rows — the infrastructure was entirely general, the
  0196/0197 precedent a third time. **The second defect underneath, which only writing the adapters
  surfaced: four of the six payloads carry no patient.** `DocumentRequestPayload.patientId` is what
  `document.patient_id` is written from, M22 `dependsOn [1, 5]` and cannot read M10/M16/M20/M37's tables
  to resolve one, and every emit site already had it in hand (`hope_assessment.patient_id`,
  `bereavement_plan.patient_id`, `ipu_body_release.patient_id` — all NOT NULL — and
  `safety_incident.patient_id`, nullable for a reason). So binding alone would have rendered a HOPE
  summary, a bereavement packet and a decedent's release authorization onto NO chart, which is a
  strictly worse outcome than not rendering them: an unrendered request is a visible `pending` row, an
  off-chart clinical document is a filed one nobody can find. The producers now publish it, declared in
  their catalogs; M20 sends an explicit `null` because a vehicle accident has no patient and filing that
  report on someone's chart is worse than filing it on none, and **M25 is patient-independent by
  construction** — `appeal_case` reaches a chart only through a nullable `claim_id` into M23, so
  asserting one would mean inventing a link M25 does not hold. Proven live end-to-end (real publisher →
  real dispatcher → real renderer → real `document` row under RLS): 7 of `gap-023-024-038-render-handshake
  .live.test.ts`'s 14 fail against the pre-fix consumer, and 11 of the two unit suites' cases do.
  538 → 533 pairs, 36 → 42 catalogued events covered. **What remains in the m22 group now divides again**,
  and the registry says so: for M11/M12/M13/M21/M23/M33 the source-event declaration is redundant because
  the request half IS wired; for M6/M7/M8/M9/M14/M15/M18/M24/M30/M39 the module has **no request event at
  all**. M6 is the one that matters — seven `document_id` columns on `certification`, `election_statement`,
  `f2f_encounter`, `nor_acknowledgment`, `revocation_event`, `discharge_event` and `transfer_event`, each
  commented "M22 document", all NULL forever, with all six templates (`cti`, `election_statement`, `f2f`,
  `nor`, `revocation`, `discharge_summary`) already published in `PLATFORM_TEMPLATE_TABLE` and
  `m6.document_requested` catalogued by nothing. Those are the CoP compliance documents.
  **Reported, not fixed**: `m13.administration_record.document_requested` is catalogued and its pure
  machine pushes the outbox effect on `perAdministrationPdfRequired`, but M13's backend effect interpreter
  has **no `outbox` arm at all**, so the request never becomes a row — producer-side, and it stays on the
  anticipated list rather than being subscribed, because a consumer bound to a name nothing emits is
  indistinguishable from working.

  **M6's six CoP compliance documents were never rendered, and neither half of the handshake existed
  (F-100, #103).** The Medicare Conditions of Participation artifacts a survey asks for — the
  certification of terminal illness, the election statement, the face-to-face encounter, the notice of
  rights, the revocation, the discharge summary. `PLATFORM_TEMPLATE_TABLE` has published a template for
  every one since it landed; SIX `document_id` columns on `certification`, `election_statement`,
  `f2f_encounter`, `nor_acknowledgment`, `revocation_event` and `discharge_event` have carried the comment
  "M22 document (app-validated)" since M6's schema landed. **Both ends were missing at once, which is why
  neither looked broken**: M22 subscribed to none of M6's six source events, so no request was ever
  drained, and M6 subscribed to `m22.document.rendered`, so there was nothing to stamp even if one had
  been. Six columns, NULL in every database that has ever existed. **No new event was invented**: the
  deferral registry's own note said M6 needed an `m6.document_requested` and the anticipated-events list
  named one, but the M22 spec's §4.11 consumer table routes M6's SOURCE events to the renderer one
  template each — the `m23.abn.required` shape — and M6's catalog has declared `m22` on exactly those six
  the whole time. The catalog was right and only the subscription was absent. **The `patientId` defect
  from F-099 recurred at larger scale and with no defensible exception**: none of the six payloads carried
  a chart target, M22 `dependsOn [1, 5]` and cannot resolve one, and every emit site already had the value
  in hand — so binding alone would have filed six CoP artifacts on no chart, which is worse than not
  rendering them (an unrendered request is a visible `pending` row; an off-chart signed certification is a
  filed document nobody can find).
  **The render call's spread order was a live defect of exactly that kind and only the live run found it.**
  `render.content` was spread AFTER the resolved `aggregateId`/`patientId`, so a payload carrying its own
  `aggregateId` overwrote the identity the normalizer had just decided — and M6's `runEffects` puts the
  TRANSITION's aggregate in the body, so every NOR rendered under its ADMISSION's id. The document
  existed, addressed to the wrong row, and the back-ref could never match: the one failure mode a back-ref
  cannot recover from, because there IS a document and it looks fine. The resolved routing now wins.
  **Six production routes 500'd, and the reason no test could see it is the F-093 shape exactly.**
  `createDbAdmissionRouteService(db)` defaults its outbox to `NOOP_OUTBOX`, which accepts anything, and
  **every M6 live suite took that default — nine constructions across eight files** — so the module drove
  its entire production write surface against a publisher that validates nothing, while production binds
  one that `Value.Check`s and REFUSES. `runEffects`' base envelope is `{aggregateId, admissionId}` and
  every M6 event declares more, so an effect emitted without its own `extraPayloadByEvent` entry does not
  degrade, it rolls the write back. Found by binding the real publisher in the live suites (now
  `__tests__/_m6-outbox.ts`): `POST /f2f/:id/complete`, `/f2f/:id/window-override`, `/f2f/:id/attest`,
  `/admissions/:id/hold`, `/admissions/:id/resume` and **`POST /election-periods`**. Two of those are
  structural rather than clerical. The completion transition emitted **`m6.f2f.scheduled`** — the wrong
  event, announcing to every consumer that the encounter had been *scheduled* at the moment it was
  completed, and a name whose schema the completion path cannot satisfy; attestation is only reachable
  from `completed`, so the whole CMS-418.22(a)(4) face-to-face chain was dead one step past scheduling
  (`m6.f2f.completed` is now catalogued, record-only, because no module acts on completion and inventing a
  consumer would put a permanently-pending row on every one). And `createElectionPeriod` omitted
  `sequence`, so **no admission could open a benefit period past the one its activation seeds** — 42 CFR
  418.21(a) recertification, refused for every tenant. The typed `M6OutboxEventName` union did not help
  with either: it pins NAMES, and a real name emitted from the wrong transition with the wrong payload is
  still a real name. Proven by `m6-cop-document-renders.live.test.ts` — the real admission write service,
  the real catalog-validating publisher, the real dispatcher, the real renderer, into real `document` rows
  and the six stamped columns, under RLS, with org B seeing none of it.
  **Nine m6 events still declare `m22` and they are two different things, recorded in the registry
  reason rather than smoothed over.** `m6.discharge.cosigned` and `m6.transfer.created` are named by the
  M22 spec and are genuinely deferred — the cosign fires on the SAME `discharge_event` id, so it is a new
  VERSION of an existing document and the decider answers `idempotent_skip` until the W2 append path
  exists; the transfer wants a `discharge_summary` TRANSFER VARIANT M22 does not publish, and rendering
  the base template would file a document titled Discharge Summary for a patient who was transferred. The
  other seven — `referral.accepted`, `admission.draft_created`, `admission.activated`,
  `admission.discharged`, `election.drafted`, `election.period_started`, `loc.changed` — are named by no
  part of the M22 spec and by no M22 consumer, so they are **mis-declared rather than deferred**, and each
  is a high-volume clinical event whose every emission is re-claimed every thirty minutes for the life of
  the deployment. **Now fixed (F-101).** The two specs disagreed and only one of them owns the answer:
  `declaredConsumers` is a ROUTING input, not a record of interest, so M22's own §4.11 consumer table
  decides who consumes M22, and M6 §4.4's table — which names M22 on all seven, glossing
  `admission.draft_created` as "(election form prep)" — was the wrong side to follow. Each of the seven
  has a SIBLING event that carries the renderable artifact and IS bound: the election statement renders
  from `election.signed` not `.drafted`, the discharge summary from `discharge.created` (which carries the
  `discharge_event` id M22 back-refs) not `admission.discharged`, the recert CTI from `cti.signed` not
  `election.period_started`. **Three of the seven named `m22` and nothing else**, so each was a
  permanently-pending row on a path with no consumer at all — a referral acceptance, a draft admission, a
  drafted election statement — and all three are now **record-only**, which `buildOutboxRoutingPlan` puts
  in `recordOnly` and the relay finalizes `dispatched` and the retention purge can finally collect. The
  other four still defer, on their other unbound consumers, and that is the point rather than a
  shortfall: **the reason they defer is now the true one**, and a deferral list that names a consumer
  which will never bind cannot be worked off. The precedent is #204, which dropped `m20` from
  `m19.oncall_shift.activated` for the same reason and recorded it in `packages/types/src/safety.ts`
  rather than by editing the spec. The tests assert the ROUTING OUTCOME, not the membership of a list —
  `not.toContain("m22")` passes equally on a catalog where the event was deleted — and two of them are
  controls that pass in both directions, pinning that the six F-100 renders and the two genuinely
  deferred entries kept their declaration: a blanket sweep would have un-rendered the CoP documents the
  previous PR had just wired. Deferred pairs 527 → **520**.

**A discharged patient's orders stayed in flight forever, and the fix was blocked from BOTH sides
  (F-102, #103).** M11 and M12 each ship a complete, exported, unit-tested discharge-cascade decider —
  `decideDischargeCascade` (§2.6 D13 / W-DC-02) and `decideMedicationDischargeCascade` (§2.2 D13) — and the
  only caller either has ever had is its own test file. Both modules' `consumers/index.ts` explain the
  absence as "the live boot wiring, when the backend is mounted"; the backend has been mounted for a long
  time. **Nobody could have written that wiring**: `m6.admission.discharged` named neither module in its
  `declaredConsumers`, and `assertBindableAgainstCatalog` refuses a binding whose module the catalog does
  not declare — so a decider with no binding and a catalog with no declaration each made the other look
  like someone else's half. It is the F-101 shape inverted: that one was a declaration with no consumer,
  this is a consumer with no declaration, and only the second is invisible to `arch:outbox-bindings`'
  rules 1–4. Rule 6 saw it and could only file it: `outbox-subscription-exceptions.ts` held both as
  `handler-unbound`, which is accurate and is not a fix. Every order still in flight when a patient was
  discharged stayed in flight — a pending-signature lab, a verbal-pending comfort kit, an active DME
  rental, and a `queued_for_transmission` medication order, which is one waiting to reach the
  e-prescribing vendor. **The cascade deliberately does NOT go through `discontinueOrder`**, which both
  deciders' headers named as its executor: that path writes `actorMembershipId: userId` — the CALLER — so
  a system cascade would put a clinician's name on an act they did not perform, on a chart a surveyor
  reads; it never writes `source_outbox_event_id`; and it runs the machine's `discontinue` event, which is
  legal only from `active`, while `cascadeDiscontinue` is legal from `pending_signature` and
  `verbal_pending` too — so the orders that most need stopping are exactly the ones it would have refused
  with ILLEGAL_ORDER_TRANSITION. `order_discontinuation.actor_membership_id` has been nullable since M11's
  schema landed, commented "NULL for system-actor cascades", and `source_outbox_event_id` has existed for
  this provenance; **nothing in the repository had ever written either**. **A third defect was one layer
  down**: `emitSupplyCancellation` was gated on an `supplyFulfillmentInFlight` fact M11 CANNOT PRODUCE —
  `order_record` holds no supply-request reference, and `SupplyFulfillmentProvider.isTerminal`, the seam
  whose doc says "M11 asks this before issuing a cancellation", takes a `SupplyRequestId` M11 never sees.
  The only value a live consumer could honestly pass was `false`, and `false` meant M21 was never told:
  the cascade would discontinue a DME rental and leave the vendor order standing. The gate is gone rather
  than the fact invented, because **M21 already answers this and says so** — its payload doc reads "M21
  keys on `orderId` regardless, because M11's ref can be stale", and `decideSupplyCancellationCascade`
  returns `no_match`, emitting nothing, for an order with no request. Asking about an order that was never
  fulfilled is a no-op M21 is built for; not asking about one that was is a live vendor order on a
  discharged patient. Proven by `m6-discharge-cascade.live.test.ts` — the real M6 write service discharges
  as `wardenx_app`, the real catalog-validating publisher writes the row, the real dispatcher delivers it,
  and both real consumers read their own tables under RLS; 5 of its 6 cases fail with the bindings removed,
  and the sixth is the terminal-orders control that must pass either way. **M13 and M15 are NOT the same
  finding and are not fixed here**: both are registered `no-handler`, meaning no decider exists — M13's
  four M6 lifecycle subscriptions are §4.5 eMAR-context inputs nobody has written, and M15's is larger
  and reported separately below.

  **M15's entire write surface hung off a table nothing inserted into (F-103, #103).**
  `bootstrapDisciplinePlan` is the §2.2.1 `[*] → draft` factory whose own doc says it is "called by the
  `m6.admission.activated` consumer"; **that consumer did not exist**, M15's `consumers/` was a
  seam-reading layer with no outbox binding in it, m15 was not in that event's `declaredConsumers`, and
  there was **no INSERT into `discipline_care_plan` anywhere in the repository** — not the write service,
  not a seed, not a test. Nor is there a route that creates one: every M15 write route is
  `/discipline-plans/:planId/…`, so the bootstrap consumer is the ONLY creation path by design. The aide
  plan of care (CoP 418.76), the MSW plan (418.64(c)), the spiritual plan (418.64(d)) and every goal,
  intervention, discipline assessment and 14-day aide supervisory visit — all of which hang off `plan_id`
  rather than a version — were unreachable in every deployment that has ever run, and the §7.1/§7.2/§7.3
  initial-assessment clocks that count from `initial_assessment_clock_started_at` never started because
  nothing set it. The M20 `safety_check_in_schedule` finding one module over: an empty compliance surface
  and a compliant one are indistinguishable. **A SECOND defect sat under it and only running the live
  suite found it.** M15's `OutboxEmission` had no `organizationId` field and none of its six emit sites
  supplied one; `outbox_event.organization_id` has no default, so every `m15.*` emission wrote NULL and
  the RLS WITH CHECK refused it with **42501, rolling back the whole mutation** — signing a plan version,
  amending a discipline assessment, completing an aide supervisory visit and all three
  volunteer-assignment inactivations 500 in production. Invisible because **M15 had no live suite at
  all**: every existing M15 test drives the write service with a no-op outbox, which accepts anything —
  the F-093/F-100 shape a third time. `organizationId`, `aggregateKind` and `aggregateId` are now REQUIRED
  on the emission rather than optional; optional made the port assignable to the real publisher only by
  method bivariance, which is exactly the check that let the omission through. **The version half is
  reported, not fixed**: `discipline_care_plan_version` has no writer and no create route either
  (`/versions` is a GET; only `finalize` and `sign` are POSTs), so a plan still cannot be authored to v1 —
  and §7.1 assigns v1 to a person ("the supervising RN … creates Aide POC v1 with the task list"), so a
  stub version authored by the relay would put a draft on the record nobody wrote. Proven by
  `m15-plan-bootstrap.live.test.ts`: the real M6 write service activates an admission, the real dispatcher
  delivers, M15's real consumer sites the plans through M6's org-explicit `admissionSchedulingContextForOrg`
  (the §4.7 seam cannot be used — it pins the tenant from the ambient REQUEST scope and a relay tick is not
  a request) and inserts under RLS. All 7 fail without the binding. **The suite also found the harness
  lying to itself twice**: three cases were `for (const p of await plansFor(…))` over an empty list, which
  asserts nothing and passed while the consumer was refusing every delivery.

  **M14's D8 action-item auto-close: three absences stacked, and the deepest one would have made the
  fix look like it worked (F-104, #103).** §4.5 says an action item linked to a downstream artifact closes
  itself when that artifact reaches its absorbing state — "action item flips to `auto_closed`;
  `linked_artifact_id` confirmed; `closed_at = now()`". Everything for it shipped with M14-T06 except what
  makes it run: `transitionActionItem(_, {type:'autoClose'})` complete and unit-tested, `auto_closed` in
  the status enum, `close_reason` on the table, `m14.action_item.auto_closed` catalogued,
  `planActionItemAutoClose` mapping each source event to its linked kind — and **no binding**, plus three
  of the six sources (`m11.order.signed`, `m11.order.completed`, `m12.medication_order.signed`) not
  declaring m14 at all, so `assertBindableAgainstCatalog` would have refused half of it. **Underneath both:
  `idg_action_item.linked_artifact_id`, the column the whole engine matches on, was written by NOTHING** —
  the create route took `linkedArtifactKind` and not the id, the INSERT wrote the kind and not the id, the
  view returned the kind and not the id, and `m14.action_item.created` announced the kind and not the id.
  The `election_period.effective_at` shape (read in seven places, written in none) one module over, and
  the reason binding alone would have been WORSE than not binding: a live handler matching NULL forever,
  green, with a `close_reason` value and an outbox event to make it look wired. Both link fields now travel
  together or not at all (422), because a kind with no id can never close and an id with no kind is matched
  by nothing — either alone is an item that LOOKS linked and stays open. **The M8 case is deliberately not
  the same rule**: §2 and §4.5 both say `m8.encounter.signed` closes an `encounter`-linked item MATCHING THE
  ASSIGNEE, not the artifact, because the encounter did not exist when the item was written. Collapsing the
  two is the obvious simplification and it is wrong in the expensive direction either way round — keyed on
  the artifact no encounter item would ever close, keyed on the assignee a signed care plan would close that
  clinician's unrelated order items. Proven by `m14-action-item-autoclose.live.test.ts`, which publishes
  each real upstream event through the real catalog-validating publisher (four of the six payloads this
  suite first invented were REFUSED by it, which is the guard working) and drives the real dispatcher into
  the real consumer under RLS; 6 of its 8 fail with the binding removed. What remains in the m14 group is
  the other three shapes M14 describes and has not built — the M6 inclusion cache, the M9/M10/M11/M12
  "since last IDG" Valkey projection cache, and the M22 packet back-ref, which additionally has no producer
  since `m14.packet.document_requested` is catalogued by nobody.

  **No bereavement plan has ever existed, and three more defects sat between the event and the row
  (F-105, #103).** CoP 418.64(d) obliges a hospice to serve the decedent's family for THIRTEEN MONTHS, and
  `bereavement_plan` is the root carrying that single clock — the contact roster, the D4 outreach schedule,
  the anniversary reminders, the risk scores and the closure record all hang off `plan_id`.
  `decideEligibilityIntake` is M16's complete §4.3.1 intake decider and its own header says "the live
  outbox binding + the transactional insert land with the §4.9 workers in M16-T06"; there was no binding,
  and **no INSERT INTO `bereavement_plan` anywhere in the repository** — not the write service, not a seed,
  not a test. Nor a route: `POST /api/v1/bereavement/plans` does not exist (the collection path is a GET
  worklist) and all fifteen plan writes are `/plans/:planId/…`, so the consumer is the only creation path
  BY DESIGN and it was absent. The M15 `discipline_care_plan` and M20 `safety_check_in_schedule` finding a
  third time, and M30's `bereavement_coverage_rate` has been computing off the empty table. M6's side was
  never missing — `m6.bereavement.eligible` is catalogued, emitted from the death-discharge transition, and
  declares exactly one consumer, so every death has left a `pending` row re-claimed every thirty minutes.
  **Three defects underneath, none of which any test could see** (every M16 suite drives the write service
  through `NOOP_OUTBOX`, the F-093/F-100/F-103 shape). (1) M16's `OutboxEmission` had **no
  `organizationId`** and none of its five emit sites supplied one, so every `m16.*` row wrote NULL, RLS
  refused it with 42501 and — the publish running on the CALLER's transaction being the whole point of a
  transactional outbox — the mutation rolled back with it: seeding a roster, assigning a volunteer,
  completing an outreach and initiating contact were all 500s. It was already on the effect context, used
  by the `alert` arm one case below. Required now, not optional: optional is what let the port stay
  assignable to the real publisher by method bivariance. (2) `resolveDeathFact` called M6's §4.7
  `AdmissionStatusReader`, whose id-keyed reads open `withOrgContextFromRequest` — a relay tick is not a
  request, so every delivery would have dead-lettered. (3) **The census window's upper bound excluded the
  row it was looking for.** `DeathDischargeReader`'s period is half-open (`death_at < to`, right for the
  reporting-period scans it was written for), M16 asked for `to = eligibleAt`, and on M6's emit path those
  are THE SAME VALUE — `discharge_event.death_at` and the event's `eligibleAt` are both set from one
  `dischargeDate` field in one statement. So `resolveDeathFact` returned null for every death ever
  recorded, and the intake reported it as "M6's census has no row for this admission", which is the
  opposite of true. Fixed in M16 rather than the seam: making the period inclusive would change a published
  contract under M5, M21 and M30 to fix M16's off-by-one-instant, and M5's own death consumer already pads
  the same bound. **A fourth was PARAM-004 pointing the wrong way.** It replaced a UTC slice of
  `death_at` with an org-timezone conversion because "a death at 11:45pm Pacific is 06:45 UTC the FOLLOWING
  day" — correct about instants, and `discharge_event.death_at` is not one: its only writer is
  `new Date(input.dischargeDate)` where `dischargeDate` is `Type.String({ format: "date" })`, and M6's own
  state machine types the field `deathAt: LocalDate`. M6 models no time of death. Every value in that
  column is midnight UTC of a typed date, so converting it through a US timezone lands on the previous
  evening — dating every death ONE DAY EARLY in every organization west of UTC, which is every US hospice,
  on the column D4's 13-month clock counts from. PARAM-004 fixed a failure this data cannot exhibit and
  introduced one it always will; its own fixture is an instant with a time component M6 cannot produce.
  `localDateOf` is kept and still tested, because it is right the day M6 records a real instant.
  **A fifth is reported, not fixed**: `checkDeathDateMatchesAdmission`'s second parameter is named
  `admissionDeathDate` and wants `discharge_event.effective_at`; it was being passed
  `admission.discharged_at`, which the discharge transition writes `now()` — so the §2.5 check compared the
  death date to the FILING instant for equality and rejected precisely the late filing W-DC-01 permits and
  the 180-day lookback exists for. It now passes `null` (the decider's own documented branch) and starts
  performing the day `DeathDischargeRow` carries `effectiveAt` — though it is vacuous even then, since
  M6 sets both fields from one input. `decideCosignReceipt`, M16's other written decider, stays registered
  as deferred with the true reason: `discharge_event` models no external source, so every death reads
  `internal_clinician_recorded`, no plan can carry the `external_source_metadata` a D18 receipt would
  release, and the payloads do not meet either. Proven by `m16-bereavement-intake.live.test.ts` — the real
  M6 write service discharges by death as `wardenx_app`, the real catalog-validating publisher writes the
  row, the real dispatcher delivers it, and M16's real consumer reads M6's real census seam and inserts
  under RLS; 7 of its 8 fail with the binding removed, and the eighth is the non-death control that must
  pass either way.

  **No Notice of Election has ever been filed, and the trigger the spec names cannot work (F-106, #103).**
  The NOE tells Medicare a beneficiary has elected the hospice benefit. CMS requires it within FIVE
  CALENDAR DAYS of the election effective date; miss the window and the hospice forfeits payment for every
  day from the election start until the notice is accepted (42 CFR 418.24(b), CR 8877) — one of the most
  expensive timing rules in hospice billing. **`NoeRepository.create` had no caller anywhere in the
  repository** — not production code, not one test — and `schema.noeRecord` is touched only by M23's ABAC
  resolver and its eraser. No route either: `/api/v1/noe-records` is a GET list and the only POSTs are
  `/:id/submit` and `/:id/cancel`, both of which load an existing row. So the 5-day clock was never started
  for any election, the `noe_window_watch_idx` watchdog cron has always scanned an empty table, and the NOE
  worklist screen has always been empty. `consumers/index.ts` explains the absence as "the live inbound
  dispatcher is a later platform phase" — that dispatcher landed, the `isPlatformOperator` shape.
  **The trigger M23's §4.4 map names cannot carry the fact.** It routes `create_noe_draft` off
  `m6.election.signed`, and `noe_record.election_effective_date` and `window_target_at` are both NOT NULL —
  the second one IS the CMS deadline. The election's effective date exists in exactly one place,
  `election_period.effective_at`, which the `setActive` transition writes at admission ACTIVATION and
  nothing else does (F-042's column); `election_statement` carries only `signed_at`. In M6's own flow the
  statement is signed BEFORE the admission activates, so at that event the anchor is NULL and a federal
  filing could not be dated. `m6.election.period_started` is emitted from the transaction that writes the
  column, already declared `m23`, and its own payload schema says a consumer needing the window "can read
  it from `electionPeriodId` via the M6 seam once the seed path actually stores it" — a precondition F-042
  met. The sibling event carries the fact, which is the F-101 shape, so **`m23` is dropped from
  `m6.election.signed`'s `declaredConsumers`** (leaving `["m22"]`, bound) rather than left to defer a topic
  M23 does not consume. Gated on `sequenceNumber === 1`: an NOE is filed once per ELECTION, not per benefit
  period, and a recert continues the same election — `noe_record_admission_uq` is the structural backstop,
  the sequence check is what stops a second insert being attempted at all. The facts arrive through
  `electionPeriodContextForOrg`, a new org-explicit M6 reader (the `admissionSchedulingContextForOrg`
  sibling — the §4.7 seam pins the tenant from the ambient request scope and a relay tick is not a
  request), and the CCN through the same `ProviderCcnPort` shape the claim write service already binds.
  Proven by `m23-noe-draft.live.test.ts`: the real M6 write service runs the §418.24 chain to an active
  admission as `wardenx_app`, the real publisher writes the row, the real dispatcher delivers it, and M23's
  real consumer inserts through the real `NoeRepository` under RLS — all 8 fail with the binding removed.
  **What remains in the m23 group is now stated per-effect rather than as a phase**: `createNotrDraft` (the
  NOTR half — `notr_record` has no writer either, and its three trigger topics need the transfer-direction
  and discharge-reason mapping decided first), `enqueueRevalidation`, `freezeNewClaims` and
  `recordDocumentBackReference`. **M26's stated blocker was CHECKED and is real, not expired**: its
  `CapConsumerStore` needs `cap_beneficiary_accrual.mbi_normalized` and `first_election_in_period`, both
  NOT NULL, and M5 publishes no MBI reader seam — so the Medicare aggregate-cap accrual ledger has no
  writer and a tenant's cap liability computes as zero. Reported, not fixed: the facts exist in the
  database and only the seams are missing, which is a producer-side M5 change.

  **The NOTR was the same absence with a second table, and two of its three triggers needed a decision
  (F-107, #103).** The Notice of Termination/Revocation tells Medicare a hospice election has ENDED; 42 CFR
  418.26 requires it within five calendar days of the discharge or revocation effective date, and the M23
  spec's own regulatory table says exactly that. `NotrRepository.create` had no caller anywhere,
  `schema.notrRecord` is touched only by the ABAC resolver and the eraser, and `/api/v1/billing/
  notr-records` is a GET whose only POST is `:id:submit` — so no notice of an election ending has ever been
  drafted and the `notr_window_watch_idx` watchdog has always scanned an empty table. **TRANSFER** was the
  producer-side half: `notr_record.effective_end_date` is NOT NULL and `m6.transfer.created` published
  `{transferEventId, admissionId, direction, otherHospiceCcn}` and no date at all — not derivable
  downstream either, because `transferOut` discharges through `dischargeAdmissionTx`, which stamps
  `admission.discharged_at = now()`, the day the paperwork was filed rather than the day the transfer took
  effect. `transfer_event.effective_at` is NOT NULL and both emit sites had `input.effectiveDate` in hand,
  so the payload is widened (the F-099/F-100 shape); direction `in` is a deliberate no-op, since a transfer
  IN starts a benefit rather than ending one. **DISCHARGE** turned on `requiresMedicalDirectorCosign`, which
  is the right discriminator rather than a proxy for one: W-DC-02 says filing a for-cause discharge does NOT
  discharge the admission — the row is `pending_cosign` and the patient stays on service — so a NOTR then
  would tell CMS the benefit ended while the agency is still being paid to provide it. `discharge()`'s
  pending branch emits `true`; `dischargeAdmissionTx`, which runs on the immediate path AND again from
  `cosignDischarge`, always emits `false`. So the for-cause notice fires at COSIGN off the second emission
  with the same `dischargeEventId`, and nothing needs to subscribe to `m6.discharge.cosigned` (whose payload
  carries no admission, patient or date anyway). A DEATH discharge drafts one like any other — the spec's
  trigger list carves out no reason, 418.26 is written about the benefit ending rather than about why, and
  the two mistakes are not symmetric: an unnecessary NOTR is cancelled at the MAC, a missing one forfeits
  payment. The `notr_record` CHECK constraints make trigger and event id ONE fact (`trigger_kind =
  'revocation' AND revocation_event_id IS NOT NULL`, exactly one of three id columns set), so the mapping is
  enforced by the schema rather than only by the consumer. Proven by `m23-notr-draft.live.test.ts` — the
  real M6 write service runs each termination as `wardenx_app`, the real publisher writes the row, the real
  dispatcher delivers it, and M23's real consumer inserts through the real `NotrRepository` under RLS; all
  8 fail with the binding removed, including the two "drafts nothing" cases, which assert the consumer MADE
  the decision rather than merely that no row appeared. What remains in the m23 group is now three named
  ports rather than a phase: `enqueueRevalidation`, `freezeNewClaims` and `recordDocumentBackReference`.

  **The cost report CMS receives pointed at nothing, and the request half was asking for the wrong file
  (F-108, #103).** `ecr_submission.ecr_file_document_id`, `.pi_file_document_id` and
  `.supporting_documents_document_ids` are where M27 holds the Electronic Cost Report, the Print Image and
  the supporting bundle — "M22 ref" in the schema, D11's "M27 holds back-references; no MinIO code".
  `EcrSubmissionRepository.update` has accepted exactly those three since M27-T05 and **nothing has ever
  called it with one**; `handleDocumentRendered`, the pure decider for them, shipped with M27-T09 with **no
  caller anywhere and no test anywhere** — not even its own, unlike every prior instance of this shape.
  `consumers/index.ts` files the absence as "the live inbound transactional-outbox dispatcher accessor
  lands (RULE 3(d))", the phase F-106 already found had landed. F-099 bound the REQUEST half, so since then
  every submitted report has rendered a real document into MinIO and the submission that produced it has
  gone on serving `ecrFileDocumentId: null`. **The pure handler's declared payload named two fields the wire
  does not carry.** `DocumentRenderedEvent` wanted `submissionId` and `artifactKind`; M27 fans three
  artifacts out under ONE request event name, so M22 routes each to its own template and its own
  `aggregate_type` and echoes back `aggregateType` + `aggregateId`. A binding written to the declared shape
  would have read `undefined` for both and no-op'd on every delivery — the F-030 attribute failure at
  payload granularity, silent and indistinguishable from "no M27 document was rendered". The discriminator
  is now `aggregateType`, which is the shared vocabulary rather than M22's private routing map: the three
  values are `DocumentAggregateType` members in the leaf `packages/types`, so reading them is reading a
  published contract and not copying a list. **The producer-side defect only surfaced from tracing the same
  handshake, and it was the more expensive half.** `submitCostReport` emitted its OWN
  `m27.artifact.render_requested` for `ecr` carrying `payloadRef: snapshot.id`, one line after enqueueing
  the `ecr-generation` job that emits BOTH artifacts carrying the real `buildEcrArtifacts` text. M22's D14
  idempotency is keyed `(sourceEvent, aggregateType, aggregateId)` and the submit row is written FIRST, so
  it won — the rendered Electronic Cost Report was a serialization of the request envelope with a snapshot
  UUID where the file's contents belong, and the job's request, the one holding the actual filing, was an
  `idempotent_skip`. The emit is gone from submit: the job owns it because the job is what has the
  artifacts. **The group reason was wrong about every member, the F-099 shape at full scale.** It read that
  M27's `consumers/subscription-map.ts` + `handlers.ts` are the M25/M26 mirror and the topics are
  forward-declared pending the relay; that map names THREE topics and **not one of the 23 events in the
  group is among them** — they were never forward-declared, they were never declared at all. What is
  actually true is that M27's input model is a seam PULL: `statistics-refresh` re-aggregates the S-3
  patient-day census from M6's `LevelOfCarePeriodReader`/`AdmissionCensusReader` and the visits-by-discipline
  from M8's `EncounterStatisticsProvider`, `refresh-inputs` materializes the trial balance, and the M23/M26
  revenue and cap facts arrive through M27's own forward-seam readers. So all 23 name as a PUSH consumer a
  module that resolves the same fact by PULL — nine of them (`m21.supply_request.invoice_*`,
  `m26.cap.accrual_recorded`/`.settlement_*`/`.year_*`, `m8.mileage.captured`) naming m27 and nobody else,
  so every emission is a row re-claimed every thirty minutes with no consumer anywhere. **Reported, not
  fixed**: the correction is the F-101 sweep and it needs the same per-event verification F-101 gave m6's
  seven, not a blanket edit. Two smaller absences recorded with it — the supporting-doc REQUEST has no
  producer at all (`runEcrGeneration` emits `ecr` and `pi`, and nothing else emits the event), so the
  handler's append branch is reachable only from the test; and M40 publishes no provider-entity offboard
  topic under any spelling, so M27's third subscription stays `no-such-event` rather than deferred. Proven
  by `m27-ecr-backref.live.test.ts` — the real `runEcrGeneration`, the real catalog-validating publisher,
  the real dispatcher, M22's real render consumer and renderer, into real `document` rows and the stamped
  columns, under RLS, with org A's artifact refused against org B's submission; 3 of its 7 fail with the
  binding removed, and the producer-side half fails `m27-cost-report-workflow-slice.live.test.ts` when the
  submit emission is put back.

  **Every alert the platform has ever emitted claimed it was delivered, and nothing has ever been
  delivered by any channel (F-109, #103).** `alert.outcome` was `NOT NULL DEFAULT 'delivered'` and
  **written by nothing**: `computeOutcome`, the §2.4.3 roll-up, has existed since M36-T04 with no caller,
  and `notification_delivery.status` has **no `UPDATE` anywhere in the repository**, so the §2.4.4 state
  machine had exactly one reachable state and every delivery row ever written is still `pending`. The
  user-visible end of it is that `aggregateDeliveryStatus` — a SECOND roll-up, called but writing nothing
  — has returned `"pending"` for every line of every user's Notifications tab, always. **The enum could
  not say otherwise.** §2.4.3's machine OPENS in `pending` ("alert row written; notification_delivery rows
  enqueued") and `alert_outcome` had three values, none of them that one — so the column could not express
  "not settled yet" and asserted the most flattering value available instead. Migration 0240 adds it, 0241
  moves the DEFAULT and corrects the historical rows, guarded on **not one** delivery having reached a
  §2.4.4 terminal state, which is the definition of "nothing settled" and is what makes the rewrite a
  correction rather than a blanket relabel. **The settlement path is the inbox READ, and ADR-0036 is why.**
  §2.4.4 settles an in-app row on "socket acked"; ADR-0036 (Accepted, and it wins over a module spec)
  records that `socket.io` is installed nowhere, no realtime transport was ever built, and "UI freshness is
  REST refetch/poll". `GET /api/v1/alerts/inbox` IS that poll — `notifications-inbox.tsx` is its only
  caller — so the fetch is the moment the alert reaches the client and there is no second event to wait
  for. It goes straight to `delivered`: `sent` is the accepted-by-dispatcher step of a dispatcher tier that
  does not exist, and parking rows in a state nothing advances is the defect being fixed. Scoped three ways
  and narrowed to `pending` so a poll can only settle the caller's own undelivered in-app rows — the
  parent-join RLS policy, the explicit `alert.organization_id` predicate beside it, and
  `recipient_user_id` — and the parent re-roll is skipped when the outcome is unchanged, because the M4
  trigger fires on every UPDATE and a still-pending alert would otherwise log a row per poll per recipient
  forever. **The single most misleading value the column carried is now `failed`**: `emit()` writes a
  no-op alert when no `alert_rule` fires, so an event that matched nothing recorded itself as successfully
  delivered to the zero people it reached — `rollUpAlertOutcome([])` is `computeOutcome`'s own documented
  answer, "nobody was reached", and the emitter now writes the initial outcome rather than defaulting it.
  **Out-of-band rows are deliberately untouched, and an alert holding one now stays `pending` forever.**
  That is not a new defect, it is the missing tier becoming visible: `planFanOut` plans push/sms/email/voice
  deliveries and **no dispatcher exists for any of them** — `packages/messaging/src` has no `dispatchers/`
  directory, and the twelve §4.4 queue names in `jobs/queues.ts` are pure data referenced by nothing but
  their own test, so no `Queue`, no `Worker` and no producer has ever been constructed. Calling a push
  nobody sent `delivered` would move the lie rather than remove it. **Reported, not fixed**: that whole
  out-of-band tier, and the standing #205 absence it sat inside — at the time, M36 contributed NO event
  catalog, so `m36.notification.delivery_failed` had no producer and the three written deciders that
  subscribe to it (M19's `consumers/m36-delivery-failed.ts`, M20's `delivery_failed` SOS escalation reason,
  M26's) could not run. **M36 now catalogues the event (`events-by-m36.ts`, #205) and M19/M20 are real,
  live-bound consumers** — M19 escalates an open call, opens an operational call, or reports a coverage
  gap; M20 advances the SOS ladder, capped at `escalation_tier_3` since its dial/page/PSAP terminus
  effects have no implementation anywhere (M26's stays `no-handler`: its own handler is a no-op stub and
  its whole consumer relay is unbound, `outbox-subscription-exceptions.ts`). The gap this paragraph is
  actually about still stands: **no producer exists** — nothing publishes the event, because the
  out-of-band dispatch/reconciliation pipeline (Twilio/push/email/voice) that would detect a delivery
  failure and emit it is unbuilt, the separate project named above. M19's file already names itself as the
  one place to reconcile when that pipeline lands and publishes the real payload.
  Proven by `m36-alert-outcome.live.test.ts` — the real Drizzle `AlertEmitter` over a real platform-default
  `alert_rule`, the real route service, real RLS, org B's poll unable to settle org A's row; 3 of its 7
  fail with the two production changes reverted, and the migration case fails on a schema without
  0240/0241.

  **A sibling table in the same subsystem shipped with no RLS and no grant at all (F-110, #247),
  found re-verifying this fix live.** `alert_receipt` (migration 0243 — per-user read-receipt state
  for the alert inbox, distinct from `notification_delivery`'s transport-lifecycle rows) has no
  `GRANT` to `wardenx_app` and no RLS policy anywhere, unlike `notification_delivery` — its exact
  structural sibling, also a pure child of `alert` — which has carried a parent-join policy + grant
  since migration 0017. Every real request touching it (`listAlertInbox`'s left-join,
  `markAlertRead`'s insert, both in `messaging-route-service-db.ts`) threw Postgres 42501 "permission
  denied for table alert_receipt" — confirmed live, 4 of 7 cases in `m36-alert-outcome.live.test.ts`
  failed before the fix. Migration 0247 mirrors `notification_delivery`'s parent-join RLS shape,
  adding the NULLIF empty-GUC guard from migration 0246's `device_attestation` precedent (this table
  is only ever touched inside `withOrgContext` today, unlike that guard's original bare-pool case,
  but the guard is free insurance against the identical failure mode). **A gate blind spot sits
  underneath and is reported, not fixed**: `check-tenancy.ts`'s Rule 1 three-column check never
  flagged the missing `organization_id` handling either, because its schema-scanning regex assumes a
  two-argument `pgTable(name, columns)` call ending in a bare `\n})` — `alert_receipt`'s three-argument
  form (`pgTable(name, columns, (t) => ({ indexes… }))`) never matches it, so the table was invisible
  to Rule 1 regardless of the `NON_ORG_SCOPED` allowlist. A MISS, not a false alarm, and it applies to
  any other three-argument `pgTable()` table in the schema — filed as its own issue (#247) rather than
  attempting a regex fix with repo-wide blast radius in the same pass. `alert_receipt` is now
  explicitly added to `NON_ORG_SCOPED`'s M36 entry regardless, so the exemption is documented intent
  rather than an accident of what the regex happens to match.

  **Rule 6 (F-094, #205) is the direction rule 4 still did not run.** Six modules publish an
  `M*_SUBSCRIBED_EVENT_NAMES` constant, and each carries the same doc comment — it exists "so an upstream
  rename breaks the build rather than silently orphaning a handler". **Nothing compared any of them to
  anything.** They are string-literal tuples, and the tests that reference them assert the list's SHAPE
  (three dot-separated segments, no self-consumption, contains one particular corrected name) and never
  that a name EXISTS; two of the six also claimed to be "verified as live by `validateSeams()` at boot",
  which validates the SEAM registry and has no knowledge of event names. The six and the catalog disagreed
  on **65 facts**. Rule 6 asks both directions and the halves are not symmetric: a name the catalog does
  not declare is an event the relay delivers to NOBODY in that module, and writing a binding does not help
  — `assertBindableAgainstCatalog` refuses a binding whose module is undeclared, which is the wall #204
  hit; a declaration the list omits is just the list being wrong, since the catalog is what the relay
  reads. So **32 were reconciled INTO the lists**, including `idg.decision_recorded` — the one event M16
  binds live, which M16's own subscription list did not name. **Three were real routing bugs**: M21 has
  had deciders for `m13.comfort_kit.deployed` and `.controlled_substance_discrepancy` since M21-T04 and
  the catalog named m14 and m30, so a kit deployment routed past the only module that stocks one; M16's
  `decideCosignReceipt` is the D18 gate-release decider for `m6.discharge.cosigned`, declared to m22
  alone. **Three were deleted** — M16's `m17.shift_changed` (M17 emits no shift topic under any name) and
  M20's two `m19.oncall_shift.*` (its own `consumers/index.ts` says there is nothing to consume: they
  were the re-sync trigger for a cached on-call resolution and M20 caches none). The remaining **28 are
  `scripts/outbox-subscription-exceptions.ts`**, grouped by (module, kind) so the reason lives once and
  the event lists stay exact, with four kinds that each state a checkable fact rather than an intention:
  `no-producer` (6), `no-handler` (11), `record-only-target` (8), `would-defer-a-bound-event` (3). The
  last is the one that stops a well-meant fix: `m22.document.rendered` and `m17.visit.published` are
  delivered TODAY to every consumer they declare, so adding an unbound one would convert a working
  delivery into a row re-claimed every thirty minutes — **for the other consumers too**. The gate deletes
  each entry's own excuse when it expires: a pair that comes to agree both ways fails, one no longer
  named by either side fails, a `no-producer` entry whose event gets catalogued fails, and any other kind
  naming an uncatalogued event fails. **`no-producer` was the standing finding, printed on every run, and
  is now resolved (#205) — the group has zero members.** M2 and M36 used to contribute NO event catalog to
  the boot dispatcher at all — no `M2_OUTBOX_EVENTS`, no `M36_OUTBOX_EVENTS` — so `m36.notification.
  delivery_failed` (named by M19, M20 and M26) and M35's four `m2.*` organization/session topics, half of
  its entire subscription list and the trigger for its §4.12 per-seat billing, had no producer at all.
  **M2 now catalogues and publishes 16 identity-lifecycle events** (`events-by-m2.ts`), including the real
  §11 D19 org activate/suspend/close capability (`organization-lifecycle.ts`) and the `select-organization`
  producer for `m2.session.created` — the exact four events M35 needed. **M36 now catalogues
  `m36.notification.delivery_failed`** (`events-by-m36.ts`), with M19's written decider and M20's SOS
  escalation reason both live-bound to it for the first time. Neither is `no-producer` any more: M35's four
  topics moved to `no-handler` (M35 has no `consumers/` directory yet), and M26's moved to `no-handler` too
  (its handler is a no-op stub, its relay is unbound) — both filed in `outbox-subscription-exceptions.ts`.
  `m36.notification.delivery_failed` itself still has no PRODUCER emitting it in practice, but for a
  different reason now: the out-of-band dispatch/reconciliation pipeline that would detect a failed
  delivery and raise the event is unbuilt (see the alert-outcome finding above) — a gap in what M36 does,
  not in what it declares.

  **Rule 6 saw six modules of nineteen, and its own comment said otherwise (F-095, #208).** It enumerated
  `M<N>_SUBSCRIBED_EVENT_NAMES` off the `@wardenx/types` barrel and claimed "a seventh module publishing one
  is checked the day it lands with no edit here" — false on the day it was written, because THIRTEEN more
  modules already declared their subscriptions under three other spellings and in another directory
  (`M<N>_OUTBOX_SUBSCRIPTIONS` / `M<N>_UPSTREAM_SUBSCRIPTIONS` and the `_TOPICS` splits in each module's own
  `consumers` directory, the frozen `_SUBSCRIPTION_MAP`s, two lone `{ eventName, consumerName }` objects).
  **The gate written to end "a list compared to nothing" left thirteen lists compared to nothing**, and they
  disagreed with the catalog on **132 further facts**. Discovery is now the whole point: the NAME pattern is
  deliberately wide (any `M<N>_…SUBSCRI…` export, anywhere in `apps/` or `packages/`) and the narrowing
  happens on the VALUE, where it can be checked — a matching name whose value is not one of the four
  recognised shapes is an **error, not a skip**, so a fifth spelling breaks the build on the commit that
  introduces it. The one exemption is a `*_DEFERRED` boolean, recognised by `typeof value === "boolean"`
  rather than by name. **Nothing is double-registered**: 255 of the "catalog declares it, the list omits it"
  pairs are the same absence `outbox-deferred-consumers.ts` already holds with a reason, so rule 6 skips a
  pair rule 4 has accepted — and when that deferral is lifted by binding the event, rule 6 starts requiring
  the list to name it, which is how the list gets corrected on the commit that binds.
  **Eight names were dead** — in no catalog under any spelling, so the handler behind each could never run.
  Two are the literal failure these constants' own headers promise to prevent: M14 subscribed to
  `hope.j2051_trigger_fired` and `hope.sfv_created` while M10 catalogues them `m10.`-prefixed, so the J2051
  and SFV consumers named nothing. Three more are M33 MV-invalidation topics (`m17.visit.no_show`,
  `m18.evv.check_in`/`check_out` against the catalogued `…_detected`/`…_recorded`), and three are placeholder
  spellings M23/M24 carried with a written instruction to rebind "when M40's `events-by-m40.ts` lands" —
  it landed, and nothing came back (`mdm.canonical_updated` → `m40.canonical.updated`,
  `m26.cap.*.v1` → the unversioned names, `m23.medicare_claim.acknowledged` → `m23.claim.acknowledged`).
  A placeholder that names a module's own spelling of an event is indistinguishable from a real subscription
  at a glance, which is why all eight survived. **M11 was the live one**: it BINDS `m22.document.rendered`
  (the §7.2 W2 back-ref that stamps `order_record.document_id`) and its own list never named it for the whole
  of that binding's life — the F-094 `idg.decision_recorded` shape again — while the only test on that list
  pinned its contents verbatim, which a list and a copy of the same list always satisfy.
  The remaining **132 are grouped by (module, kind)** in `outbox-subscription-exceptions.ts` with three kinds
  added for facts the six simple lists never presented: `self-consumption` (a module's own event, correctly
  absent from an inbound-only map — the one kind that excuses the OPPOSITE direction, so the freshness check
  inverts for it), `no-such-event` (the owning module has a landed catalog and this is not in it, so waiting
  will not fix it), and `handler-unbound` (the decider is written and bound by nothing — #103's
  `handlers-unbound` set seen from the list side, which `outbox-deferred-consumers.ts` cannot hold because it
  can only carry pairs the catalog DECLARES). The gate DECIDES `no-producer` vs `no-such-event` itself off
  whether the owning module contributes a catalog, rather than trusting the entry — getting those the wrong
  way round is how a permanent defect gets filed as a staging gap. **The standing finding had grown to a
  third module — M28 contributed no event catalog either**, alongside M2 and M36, so the FHIR gateway
  published nothing and M33's `mv_fhir_bulk_export_org_month` had no invalidation source. **Resolved with
  the same #205 pass**: M28 now catalogues 13 events (`events-by-m28.ts`) on real write paths — client
  lifecycle, bulk-export, inbound proposals, including the revocation cascade that cancels an inflight job
  — and `m28.fhir.bulk_export.completed` is the one `mv_fhir_bulk_export_org_month` keys off. It is filed
  `handler-unbound` rather than closed outright: M33's consumer-side mechanism
  (`handleUpstreamInvalidation`) is written and unit-tested but still has no live `OutboxConsumerBinding`,
  deferred with the rest of M33's ~60 MV-refresh topics under `M33_MV_REFRESH_SUBSCRIPTIONS_DEFERRED` —
  a separate M33 composition-root task, not an M28 one. **The catalog entry's own comment records a second,
  producer-side gap the consumer-binding framing doesn't capture**: no worker anywhere transitions a bulk-
  export job to `completed`, because §2.3's async job processing is unbuilt — the same absence F-035
  records as why `$export`/`$everything` were dropped from `SERVED_RESOURCES`/the CapabilityStatement
  rather than left advertising an operation the gateway cannot perform. So even once M33 binds, the event
  has no live producer yet either; the catalog entry exists to pin the payload contract for when one does.
  Re-verified live against a fresh disposable Postgres (2026-09-27): `test:m28:outbox-catalog:live` (4/4),
  `test:m28:fhir-gateway:live` (9/9) and `test:rls:live:m28` (11/11) all pass unchanged since #205 landed.


- `scripts/check-architecture-docs.ts` — **architecture-corpus freshness gate**
  (`bun run arch:architecture-docs`, in `arch:fitness` since 2026-08-14). The authority rule makes
  `docs/architecture/` binding, yet it was the only ungated documentation body and drifted for two
  months (63 dead cited paths, stale companion citations — see
  `audit/ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md`). Enforces: cited repo paths exist
  (paths on a line that says they don't exist are exempt — documented absence is correct), version
  headers parse (filename-version drift needs the "FILENAME still reads" note), `Companion to:`
  citations match on-disk header versions, and four-digit `ADR-NNNN` citations resolve
  (ARCHITECTURE §21's short `ADR-00N` open-decision register is a separate, deliberately ungated
  namespace). Warn-only `<!-- verified-against: sha · date -->` staleness stamps. The six build
  divergences the 2026-08-13 audit surfaced are recorded as ADR-0036…0040 (+ ADR-0030/0032/0035
  for the frontend stack).
- `scripts/check-module-docs.ts` — **module-spec corpus gate** (`bun run arch:module-docs`, in
  `arch:fitness`). Different contract from the architecture gate because specs are PROPOSALS:
  no cited-path rule (planned paths are legal); enforces index parity (40 rows ↔ 40 files),
  the **re-lock-in-place versioning convention** (filename version is pinned; the HEADER is
  authoritative and the index "Spec ver" column must track it — it sat 1–2 re-locks stale for
  26 of 40 modules before this gate), four-digit ADR-citation resolution (audit-era
  "ADR-NNNN / ARCH-nnn" composite citations exempt as a historical namespace), relative-link
  integrity, and the "implementation proposal" authority marker every spec now carries.
- `scripts/check-adr-docs.ts` — **ADR corpus gate** (`bun run arch:adr-docs`, in `arch:fitness`).
  ADRs are immutable once Accepted, so this never checks prose freshness — it checks the corpus as
  a decision REGISTER: contiguous unique numbering 0001…max, index parity, a parseable Status line
  (Accepted/Proposed/Superseded/Rejected/Deprecated; Superseded must cite its successor), the
  index row's status cell AGREEING with the file (a decision must not sit formally Proposed while
  the register calls it Accepted), cross-citations and links resolving. Code-vs-Decision
  compliance is the audit layer (audit/ADR_COMPLIANCE_AUDIT_*.md), not this gate.
- `scripts/audit-fitness.ts` — point-in-time enforcement audit (module matrix, table
  ownership, dependency graph/cycles); writes `audit/FITNESS_ENFORCEMENT_AUDIT.md`.
- `scripts/report-implementation-status.ts` — per-module **implementation-status matrix**
  (spec/schema/migration/routes/screens/tests/adapter per module). A green `arch:fitness`
  proves architecture coherence, NOT feature-completeness — this advisory report shows build
  progress. Regenerate with `bun run status:matrix`; `arch:fitness` runs it in `--check` mode
  (`arch:status-matrix`) to keep `audit/implementation-status/` fresh and to hard-fail on orphan
  (unowned) schema/migration tables. Writes `audit/implementation-status/IMPLEMENTATION_STATUS.md` (+ `.json`).
  The **`Enriched` column is a ratio** (`n/m`), joined route-by-route against the enrichment
  registry — it used to be a per-module boolean that flipped ✅ on a single entry anywhere in the
  module (M06 once sat at 6-of-46 showing ✅). As of the **2026-08-01 enrichment sweep every 🟢
  *feature* module reads a full-ratio ✅** (0 unenriched routes; M01 Foundation reads ❌ because it
  owns tables but no feature routes). The **`Live` column** (owned tables named in a
  `*.live.test.ts`) is likewise full-ratio ✅ for every 🟢 module now — **20 modules carry executed
  cross-tenant RLS suites** (M1–M14, M17, M18, M22, M27, M34, M36, M38, M39, M40, plus M4/M5/M7/
  M15/M16/M19–M21/M23–M26/M30/M32/M33). Both columns are advisory; `arch:openapi-coverage` is what
  fails the build.
- `scripts/check-openapi-provenance.ts` — **OpenAPI schema-provenance gate** (`bun run
  arch:openapi-provenance`, in `arch:fitness`). Three rules over `scripts/openapi/enrichments.ts`.
  **Rule 1** — no local name bound by two imports (#31: `TenantExportJobListResponseSchema` is
  exported by both the platform and tenant typebox files, the second binding won, and a CROSS-TENANT
  ops list published the tenant-scoped shape). **Rule 2** — a route's schema must come from its own
  directory or an ancestor, never a sibling surface. **Rule 3 (F-061/#156)** — one entry per
  `METHOD /path` key. That is rule 1 one level up and it went unasked for the registry's whole life:
  the file is a base literal plus 47 `Object.assign(ROUTE_ENRICHMENTS, {...})` blocks, so a second
  entry REPLACES the first wholesale rather than extending it. **441 keys were declared twice, 422 of
  the pairs disagreeing, and 62% of the base literal was unreachable text.** No gate could see it:
  `openapi:check` regenerates from the map `Object.assign` left behind, `arch:openapi-coverage`
  counts routes with *no* entry, `client:check` runs downstream of resolution, and rule 2 itself read
  the same collapsed `Map` — every gate ran on what survived and none asked what was discarded. It is
  not merely dead text. A superseded schema is worse than a wrong one — wrong somewhere a reader will
  still find it, right nowhere anything checks: M7's shadowed care-plan DTO declared
  `requiredSignerSet: Type.Array(Type.String())` while the wire had always sent `{ role, count }`,
  and two screens were written from it (#155). And the shadowing quietly DEGRADED the published
  contract 123 times, where a later block re-summarised a route it did not know was already
  documented — those summaries were restored onto the surviving entries rather than deleted with the
  duplicates. There is **no allowlist**, and the one shape that could argue for one is banned with
  it: an entry that extends an earlier one via `...ROUTE_ENRICHMENTS["<its own key>"]` (17 M32 routes
  did, and they published correctly) makes a key's value depend on block ORDER — the property that
  failed — and is indistinguishable at a glance from the 424 that were silently clobbered. With one
  entry per key, extending it means editing it.
- `scripts/report-openapi-coverage.ts` — **OpenAPI enrichment-coverage report + ratchet**
  (`bun run openapi:coverage`; `arch:openapi-coverage` runs `--check`). `openapi:check` proves
  openapi.json was *regenerated* and that no enrichment targets a dead route — it says nothing
  about the reverse, so an **unenriched route is legal** and a routes task can ship 30+ routes
  carrying zero request contracts with every gate green (this is what M20-T06 did). The emitted
  contract does not look absent, it looks *satisfied*: `emit.ts` still writes those routes with
  `parameters: []`, no `requestBody`, and a bare `200: OK`, and `client:gen` types their bodies
  as `never`. This gate ratchets, per module, the count of routes with **no** enrichment entry
  against `audit/openapi-coverage/baseline.json`: the deficit may never **rise** (new routes must
  ship their contracts), and when it **falls** the baseline must be re-tightened
  (`bun run openapi:coverage --update`) so progress is locked in. A module absent from the
  baseline has an implied floor of **0** — a brand-new module's first unenriched route fails.
  The 2026-08-01 sweep retro-enriched the corpus from **478 unenriched → 6** (only bootstrap's
  health/infra routes remain unenriched; the current ratio is in the generated report, not here) and
  re-tightened the baseline — the gate never *required* that backfill, but the progress is now
  locked in. Writes
  `audit/openapi-coverage/OPENAPI_COVERAGE.md` (+ `.json`).
  `client:check` (generated typed client ↔ openapi.json) is now in `arch:fitness` too.
- `scripts/report-ui-parity.ts` — **UI implementation-parity report**: bridges the documented
  screen-spec corpus (`docs/design`) and the implemented web surface (registered `screens.ts`), so a
  green `docs:ui` is not mistaken for "the UI is built". Regenerate with `bun run ui:parity`;
  `arch:fitness` runs it in `--check` mode (`arch:ui-parity`) to keep `audit/ui-parity/` fresh and
  to hard-fail on duplicate screen id/path, an unknown `requiredPermission`, or a `screens.ts` not
  wired into `main.tsx`. Writes `audit/ui-parity/UI_PARITY.md` (+ `.json`).
- `scripts/report-frame-fidelity.ts` — **frame-fidelity report**: tracks how far each *built* screen
  has been visually matched to its Pencil frame — the layout-fidelity gap the R0/R1 Lantern
  reconciliation left open (it matched the design *language*, not each screen's *composition*). The
  hand-maintained `scripts/frame-fidelity/registry.ts` maps a built screen → its `SCREENS.md` frame
  node → status (`pending`/`partial`/`matched`); the process is in
  `docs/design/FRAME_FIDELITY_PLAYBOOK.md`. Regenerate with `bun run frame:fidelity`; `arch:fitness`
  runs `--check` mode (`arch:frame-fidelity`) to keep `audit/frame-fidelity/` fresh and to hard-fail
  on an unknown frame node, a duplicate mapping, or a dangling screen id. Writes
  `audit/frame-fidelity/FRAME_FIDELITY.md` (+ `.json`).

### Governance & history

- `docs/adr/` — Architecture Decision Records (ADR-0001…).
- `docs/reviews/` — audit/review prompt templates.
- `audit/` — point-in-time audit reports. These reference module specs **by filename**; resolve
  those filenames under `docs/modules/`.

## Authority rule

Architecture documents are authoritative. Module and UI screen specifications are
implementation proposals.
**If a module or screen spec conflicts with architecture, architecture wins.**

## Agent skills

### Issue tracker

GitHub Issues on `Engrace-Hospice/wardenx`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one repo-root `CONTEXT.md` (not yet created) plus the existing `docs/adr/`.
See `docs/agents/domain.md`.
