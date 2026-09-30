# M23 claim-assembly seams (#250 / #251)

> F-119, F-121–F-128 and F-210: binding the `ClaimAssemblySeams` readers across M6/M8/M18/M38/M40, the Q-code defect, M25's 835 pipeline scoping, and the tenant-entered hospice rate table (F-210). Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

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
**`icd10Billable` was honestly `{}` AT F-124 time (superseded by F-209 below), traced rather than
assumed**: `icd10_sequencing` is the only reader of that map, over `ctx.claim.icd10Sequence` — and
`claim-assembly.ts`'s own line-assembly then hardcoded `icd10Sequence: []` on every claim it assembled (no
seam populated a diagnosis sequence at assembly time; reported here rather than silently worked around, and
fixed by F-209). With no diagnosis code on the claim to ask about, there was nothing to bulk-resolve. Net effect on `POST /claims/assemble` reachability: none, stated precisely —
`terminology` sits later in call order than the still-unbound `referenceData.hippsRateTable`, so the live
wall is unmoved; real, individually-verified progress on a fourth M23 seam this pass (patientPayer/M6/M8/
M18/terminology is now 10 of the 11 named ports), not a further unblock. Proven by
`m23-claim-assembly-seams.live.test.ts`: the platform value set resolves to exactly `["GV","GW"]`, an
org's own tenant extension (`value_set_tenant_extension`, seeded directly since hcpcs has no Phase-1
concept table and so no code on it could ever pass `addTenantExtension`'s own add-time validation — a
separate, real limit on who can extend an hcpcs-keyed set, reported and not fixed here) is included for
that org and NOT for a sibling org, and (at F-124 time) `icd10Billable` came back empty.

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

**`icd10Sequence: []` was hardcoded on every assembled claim, so `icd10_sequencing` could never pass and
`icd10Billable` resolved to `{}` (F-209, #251).** The F-124 paragraph above traced this and left it: no seam
anywhere produced a claim's diagnosis sequence. The owner is M7 (`problem`: `kind` terminal/related/
unrelated, nullable `icd10_code`, `status`, `onset_at`/`resolved_at`), and M23 may not import it (manifest
`dependsOn` is `[1,6,8,22,38,40]`). Bound the F-121/F-122 way:
`claimDiagnosesForOrg(db, orgId, patientId, {from,to})` (`07-care-plan/seams/drizzle-store.ts`, exported
through `seams/index.ts` and the module barrel) is org-explicit and patient-keyed — `withOrgContext` plus an
explicit `organization_id` predicate on both `problem` and its `care_plan` — and projects code +
relationship ONLY (never the free-text `description`). M23 declares a local structural port
(`M7ClaimDiagnosesReader`), an optional `ports.m7ClaimDiagnoses` on `buildM23BootAssemblyService` (absent =>
`buildM23BootDiagnosesSeam` returns a fail-closed `SEAM_UNBOUND` stub, NEVER an empty sequence — an unbound
read must not masquerade as "no diagnoses"), and `index.ts` injects it beside `m6ClaimRange`. `diagnoses`
joins `ClaimAssemblySeams`.

*Selection (documented approximation).* `status = 'active'`, non-blank `icd10_code`, overlapping the service
range (`onset_at` null or before the END of `to`; `resolved_at` null or after the START of `from`). `problem`
keeps NO status history, so a problem since flipped to `resolved`/`inactive` is excluded even if it was
active during the range — the read never fabricates a past status; an as-of-exact read needs a history
table (out of scope). Ordered terminal, related, unrelated, then `created_at`, `id`; positions 1..12 (the
X12 ceiling); a repeated code keeps its highest-ranked occurrence. Multiple `terminal` problems are NOT
collapsed here: the sequence is passed through and the `icd10_sequencing` rule reports "a second terminal
diagnosis" — a data defect the biller must see, not one the seam should hide.

*Wiring in `claim-assembly.ts`.* The sequence is read BEFORE `terminology.resolveForClaim`, whose optional
third parameter now carries the codes; the same sequence is the ctx `icd10Sequence`. Line pointer policy
(deliberately simple): every line points at the TERMINAL position(s) only (hospice per-diem lines bill the
terminal illness; related/unrelated conditions are claim-level context); no terminal => no pointer. The
sequence is NOT persisted to a claim column (none exists; out of scope) — it is re-read at each
(re)validation from M7's current state.

*`icd10Billable`.* `buildM23TerminologyAdapter` now resolves the asked codes through M38's bulk
`lookupBatch("icd10cm", codes, asOf)`: `true` iff the concept exists, is `active`, and
`properties.isBillableLeaf === true`; unknown, deprecated/retired-at-the-service-date, or non-leaf header
codes are `false`. As-of is the claim's service-from, so a since-retired code still resolves at its service
date. No codes => no M38 round trip (`{}`).

*Behaviour change to expect.* Claims with real, billable diagnoses can now PASS `icd10_sequencing`; claims
whose patient has no active coded problem in the window still fail it ("no ICD-10 diagnosis sequence"),
now for a true reason. The end-to-end `POST /claims/assemble` wall is unmoved (`hippsRateTable`, earlier in
call order). Proven by `m23-claim-assembly-seams.live.test.ts` on the real NOBYPASSRLS `wardenx_app` role:
ordering, terminal first, resolved/inactive/null/blank-code exclusion, range overlap edges, the 12 cap,
cross-org and cross-patient isolation, and M38 billability (leaf/non-leaf/retired/unknown/as-of) over real
`concept_icd10cm` rows; unit coverage in `assembly.test.ts` and `diagnoses-seam.test.ts`.

**The CMS rate-table wall is removed by CODE + TENANT DATA, not by a bundled CMS file (F-210).** Every earlier
paragraph above that calls `referenceData.hippsRateTable`/`chcHourlyRateCents` "genuine new infrastructure" or the
live `SEAM_UNBOUND` wall is point-in-time and now superseded: the decision is that the per-diem rates are
**tenant-entered** (a bundled file would be a financial input that silently goes stale each October). Migration
`0279_m23_hospice_rate_table.sql` adds the M23-owned, org-scoped (RLS enabled + FORCED), effective-dated,
**append-only** `hospice_rate_table`: one row is one *version* of one provider entity's rates over
`[effective_from, effective_to]` — exactly the six numbers the calculators read, all PRE-wage-index whole cents
(`rhc_days_1_60`, `rhc_days_61_plus`, `chc_per_diem`, `irc`, `gip`, plus `chc_hourly_rate_cents` for the SIA add-on;
no invented fields — the quality-reporting reduction and labor share are NOT modelled because no calculator reads
them). A correction **supersedes** a row (`superseded_at`/`superseded_by_id`, the only app-updatable columns, by
column-level GRANT plus a guard trigger; the app role can neither edit a rate nor delete a row; only the
destruction role deletes, for org erasure). A btree_gist `EXCLUDE` constraint makes two *live* versions for one
provider entity with overlapping dates impossible at the database, so the service's overlap pre-check (a 409 that
names the clashing version) is a courtesy over a race-safe backstop. CHECKs guard the hand-keyed money: positive
whole cents inside a plausibility band that catches dollars-keyed-as-cents (`215` for `$215.00`), RHC day 1-60
>= day 61+ (ADR-0001), CHC hourly x 24 within 24 cents of the CHC per-diem, and the window inside its federal
fiscal year (an omitted `effectiveTo` defaults to Sep 30, so a rate set never silently rolls into the next year).
API: `GET/POST /api/v1/billing/rate-tables`, `GET .../effective?providerEntityId&onDate`, `GET .../:id`,
`POST .../:id/supersede`, gated by the new `billing.rate_table.read` / `billing.rate_table.admin` keys
(`provider_entity_billing_scope`; the migration and the catalog sync grant them to `administrator`/`org_admin`
only, deliberately), AI-block + `Idempotency-Key` on writes, audit rows written by the M4 write trigger. TypeBox
`Value.Convert` **truncates** a fractional number into an `Integer` field (215.5 became 215), so the route rejects a
fractional `*Cents` on the raw body first. The binding needed no injected port (the table is M23's own):
`buildM23ReferenceDataAdapter(db)` reads the live version covering the claim's **service-from** date through the
org-explicit `hospiceRateTableEffectiveForOrg` (own `withOrgContext`, the F-121 pattern), which required widening
the two port methods with a `RateLookupScope { orgId, providerEntityId, serviceFrom }` (the CMS-file design keyed on
MAC + fiscal year only, which cannot address a tenant table). No covering version fails closed with
`RATE_TABLE_MISSING` (422) naming the date, the provider entity, and the endpoint to enter rates — never
`SEAM_UNBOUND`, never a guess. The CHC hourly is wage-adjusted with the same factor the per-diems get.

**What this does NOT unblock, checked against the code (not assumed).** `POST /claims/assemble` no longer stops at
`SEAM_UNBOUND`, and with a rate table + sequestration policy + wage-index row the live suite proves the call order
moves past `hippsRateTable`/`activeSequestrationPolicy` (to the next stub only where a port is not injected). It
can still be refused by DATA, each with a typed 4xx: `WAGE_INDEX_UNAVAILABLE` (`wage_index_factor` is
platform-shared and has **no loader** — only the five non-authoritative migration-0080 placeholder CCNs, FY
starting 2026, exist; a real provider CCN will not resolve — this is now the larger practical wall),
`RATE_TABLE_MISSING`, `SEQUESTRATION_POLICY_UNAVAILABLE`, and the clinical preconditions. `placeOfService` is not a
wall (null falls back to Q5009 "place N.O.S."), but the earlier claim that no producer exists is stale: M24's
follow-up #2 built one (`PatientAddressReader.residenceAt`, `facility.kind`, migration 0183) that M23 does not use
yet, so real claims carry the imprecise Q5009. Two pre-existing payment-math gaps from `audit/AUDIT_M23.md` M23-F02
are untouched and matter once real rates flow: the wage index is applied to the **whole** per-diem (CMS applies it
to the labor share only), and CHC is priced as per-diem days. Tenant-entered rates mean a wrong entry prices claims
wrong; the guards above catch order-of-magnitude and internal-consistency slips, not a plausible-but-wrong number.
A rate change never reprices an already-assembled claim (lines and `hipps_calculation.segments` snapshot the
per-diem); it does affect a DRAFT that is re-assembled afterwards. Proven live: `m23-rate-table.live.test.ts` (real
NOBYPASSRLS role, cross-tenant, overlap incl. the EXCLUDE backstop, append-only, lookup boundaries, adapter),
`m23-claim-assembly-seams.live.test.ts` (wall now `RATE_TABLE_MISSING`, and moves past it with data), and the route
smoke `m23-rate-table-routes.test.ts`.

**The wage-index wall is removed by a TENANT-ENTERED, org-scoped value, and the payment math is corrected to CMS's labor-share and hourly-CHC rules (F-211, #252, audit M23-F02).** After F-210 `POST /claims/assemble` stopped at `WAGE_INDEX_UNAVAILABLE`: `wage_index_factor` is platform-shared (D12: no `organization_id`, `wardenx_app` SELECT-only), has no loader, and holds only the five migration-0080 placeholder CCNs. Migration `0280_m23_wage_index_labor_share.sql` adds (1) the org-scoped, append-only `tenant_wage_index` (FORCEd RLS, superseded-columns-only UPDATE grant + guard trigger, M4 audit trigger, destruction-role erase, one LIVE row per (org, CCN, fiscal year) by partial unique index, `numeric(6,4)` factor CHECKed 0.5..2.5, required `source_reference`); (2) `wage_index_factor.is_authoritative` (default true; the five 0080 rows flipped to false); (3) four nullable `labor_share_*` `numeric(5,4)` columns on `hospice_rate_table` (band 0.30..0.90, all-or-none, frozen by the guard). **Decision, stated because the task preferred reuse: a tenant write path into the shared `wage_index_factor` was rejected** — it would let one tenant's hand-keyed value silently reprice every tenant, contradicting the table's own platform-read-only design; the entry surface is a separate org-scoped table instead. API `GET/POST /api/v1/billing/wage-indexes` (+ `/effective`, `/:id`, `/:id/supersede`), keys `billing.wage_index.read/admin` (admin roles only), AI-block + `Idempotency-Key`, a non-string `factorDecimal` rejected on the raw body (`Value.Convert` would coerce a JSON number). `wageIndexForCcn(ccn, fy, orgId)` resolves the tenant's live row, then a platform row **only if authoritative**, else null -> `WAGE_INDEX_UNAVAILABLE` naming the endpoint; **a placeholder never prices a claim** (behaviour change: the dev CCNs 010001/050002/380001/450003/999999 no longer assemble without a tenant entry). Pure rules: `packages/billing/src/wage-index`.

**Payment math (M23-F02 b and d), CMS rules relied on.** (b) The wage index adjusts only the LABOR SHARE: `adjusted = base x (labor x WI + (1 - labor))`, rounded half-up to whole cents once (`applyWageIndexToLaborShare`; ADR-0016 D1 states the formula). CMS publishes a labor share per level of care per fiscal year and they differ; **no repository document states a value**, so the four shares are tenant-entered with the rate set (a wrong entry prices wrong, as with the rates; the band catches percent-keyed and order-of-magnitude slips only). Rate versions entered under 0279 have NULL shares and **fail closed** `RATE_TABLE_LABOR_SHARE_MISSING` until superseded with shares. Hand check: RHC 20,000 at WI 0.9234, labor 0.66 -> 18,989 (the old whole-rate multiply gave 18,468). (d) CHC is paid HOURLY (ADR-0016 D2): each CHC day = adjusted hourly rate x that day's documented hours (M6 `chcDocumentedHours`, read per day like the `level_of_care_coherence` rule), one single-day segment per CHC day, `HippsRateTable` now carries `chcHourlyRateCents` instead of `chcPerDiemCents`. The calculator throws `ChcHoursError` (-> `CHC_HOURS_UNPRICEABLE` 422) for undocumented, < 8 h, > 24 h, or non-quarter-hour days rather than guessing or silently repricing a sub-8-hour day as RHC. **Today M6 always reports `chcDocumentedHours = null`, so every CHC claim fails closed** (as the coherence rule already failed it). Still open, unchanged: M23-F02(c) the wage index is keyed by provider CCN, not the site-of-service CBSA (value codes 61/G8); 837I CHC unit reporting in 15-minute units (M23-F04); the SIA add-on's hourly rate now uses the CHC labor share. Also noticed, not changed: migration 0080 seeds `fiscal_year_starting = 2026` labelled "FY2026", but the repo convention (`hospiceFiscalYearStarting`) makes 2026 = FY2027 (Oct 2026 - Sep 2027); moot now that placeholders never price. Proven: `m23-wage-index.live.test.ts` (real NOBYPASSRLS role: cross-tenant, one-live-per-key incl. the unique-index backstop, append-only, precedence), `m23-rate-table.live.test.ts` (labor-share adapter, CHECKs, legacy-NULL fail-closed), `m23-claim-assembly-seams.live.test.ts`, route smoke `m23-wage-index-routes.test.ts`, and pure `hipps.test.ts` / `wage-index.test.ts` / `rate-table.test.ts`.
