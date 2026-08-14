# Code-review P0 remediation — 2026-08-14

Closes the remaining P0 findings from the 2026-08-14 six-slice `/code-review` (the backlog recorded in
`code-review-2026-08-14-ad-diff`), plus one nested-transaction defect handed over by the peer session
that fixed the M36/M17 instances of the same class.

Three P0s from that review were already merged by peer sessions before this pass:
`1f953230` (M36 `syncCareTeamChannel` pool deadlock), `6a6eb454` (M17 nested seam transactions +
`connectionTimeoutMillis`), `5cbc4c0b` (the slice-B five).

Every finding below was **re-verified against the code at `b813e19e` before being touched** — the
review is 44 findings deep and its confidence labels are not uniform. One did not reproduce.

---

## 1. SEC-052 — the two-person control that checked one person

`approveOversizedExport` verified job status and the oversized hold, and never compared the approving
actor to the requester. The route file's own header promised "a DISTINCT platform-ops actor from
whoever requested the export", and the M34 spec §3.7 requires it in as many words. One platform-ops
membership satisfies **both** `tenant_export.request` and `tenant_export.approve_oversized`, so one
person could request and release a whole-tenant PHI bundle alone.

`job.requestingMembershipId` was loaded on the same row the whole time and simply never read.

**Fixed** in both the Drizzle service and the in-memory slice (which had discarded the actor entirely
with `void actorMembershipId` and whose seed type had no requester field at all — it could not have
performed the check even if asked): a `TENANT_EXPORT_SELF_APPROVAL` 403 before any state change.

**The test is the real deliverable here.** The existing live suite passed a distinct approver on every
call, so it proved the happy path and the not-held 409 while the control itself was untested. The new
case asserts the refusal, that the refusal does not consume the hold, and that a genuinely distinct
approver still succeeds afterwards. Same lesson as the break-glass self-cosign (AC-01) and GAP-097
itself: *the property, not the path*.

That suite also still used the `\`.replace("://postgres@", ...)\`` role-switch idiom, which no-ops on a
passworded URL and silently runs as superuser (GAP-086). Both handles now parse the URL.

## 2. 42 CFR Part 2 — narrowing a recipient list to zero granted MORE access

`evaluateForInternalAccess` filtered to *active* named workforce recipients and treated an empty result
as `release_covers_program` — disclose to everyone. So when the last named recipient was removed or
expired, SUD redaction switched **off org-wide**. A patient's restriction evaporated with the departure
of the clinician they had named, and narrowing a list to zero granted strictly more access than leaving
one name on it.

The §2.12(c)(3) reasoning behind the branch is sound but was applied to two different situations at
once. Now they are separated:

- a release that **never** named a workforce member still authorizes the treating program as a whole
  (unchanged — the legal case the branch was written for);
- a release that named workforce members and now has **none active** stays `release_names_others` for
  everybody. The restriction outlives the named parties. Re-widening is a consent decision the patient
  makes, never a side effect of staff turnover.

The store already returned removed/expired recipient rows, so the two cases were distinguishable
without a schema or query change.

Both tests that asserted the old behavior — one unit, one live — asserted it in the *disclose*
direction and are inverted, with the reasoning recorded in place.

## 3. M10 `hope.scope` — an optional filter is not a scope

The predicate returned unconditional `true` when the target named no id, and three routes
(`/hope/schedules`, `/hope/submissions`, `/hope/dashboard/compliance`) built that target from an
**optional** query parameter. Omitting `?providerEntityId` therefore returned every provider entity's
submissions to any org member; omitting `?patientId` returned every patient's schedules. The services
apply no narrowing of their own when the filter is absent (`!providerEntityId || …`), and RLS is
org-level, so nothing downstream re-scoped the read. A test asserted the permissive behavior as
intended.

The fallthrough now requires an org-wide scope role (`medical_director` / `compliance_officer` /
`survey_coordinator`) — an unfiltered read *is* an org-wide read. Everyone else must name the patient
or provider entity they claim, which the existing branches then verify. This also brings the empty
target in line with M8/M9's `assessment.scope` and `encounter.scope`, which both `return false` there.

An empty-string parameter (`?providerEntityId=`) is the same empty target and is covered by the test.

**Follow-up, not done here:** an RN's "my schedules" view has to name a patient now. Restoring an
unfiltered-but-caseload-narrowed list needs a list-my-patients capability on the M5 seam
(`CaseloadProvider` exposes only `isInCaseload`, a membership test). Worth building; not a security
fix, and denying is the correct posture until it exists.

## 4. M34 workers — a shared port bag, and a job-long transaction around seam calls

Two defects in the same function, fixed together.

**The shared bag.** `registerM34Workers` built ONE port bag and shared it across all seven workers,
including DSAR export at concurrency 4 and tenant export at concurrency 2. Both bags carry per-job
state — the DSAR bundle buffer, and a mutable `tenantExportOrgId` that `markGenerating` captured for
every later port to read. Concurrent jobs interleaved through it: org B's FHIR resources into org A's
bundle, ledger rows under the wrong organization. The composition root had used the per-job registrars
since GAP-048/GAP-094, so the function was already dead — but it stayed exported from the module
barrel, which is all it takes for someone to wire the unsafe path back in. It is deleted, with the
reasoning left in its place.

**The nested transactions** (handed over by the peer session that fixed the M36 and M17 instances).
Both org-scoped registrars opened one `withOrgContext` around the *whole* job and then called
cross-module seams from inside it — M5 `PatientReader` and M22 `DocumentRenderer` in DSAR, M36
`AlertEmitter` and the M22 renderer in tenant export. Those seams' stores open their own
`withOrgContext` on the same pool, so each in-flight job pinned two connections. Four DSAR jobs plus
two export jobs is up to 12 against `max: 10` — the pool deadlocks, and being workers they starve the
request path with it.

The in-code justification for the nesting ("the same accepted shape as GAP-030's CaseloadProvider seam
call", "proven live-tested") was wrong in an instructive way: a live test proves the *query*, never the
*pool arithmetic*.

Both are now one fix. The port bag is bound to the job's organization explicitly
(`M34WorkerDeps.orgScope`, set by each registrar from the job payload), and every DB-touching port
opens its own short `withOrgContext` around its own write — the shape `inProvisionOrg` already used in
the same file. The worker holds no transaction. Nothing is lost in consistency: the seams always ran
on their own connections and their own snapshots, so the outer transaction bought the *look* of
atomicity, not the fact of it; per-hop durability is what the job's event ledger and BullMQ retries are
built on. The DSAR bundle buffer is keyed by object key rather than held in a closure variable, so
even a shared bag could no longer interleave two bundles.

## 5. M6 CTI — no admission could be certified, in any tenant

The two CTI signing guards compare `context.userId` (a Better Auth user id) against `hospice_md_id` /
`attending_md_id`, which are **M40 physician-directory UUIDs**. Those columns carry no FK to `users`,
and there is no user↔physician join anywhere in the schema — the comparison cannot be true in
production. That left the role escape as the only live path, and both escapes it named,
`acting_medical_director` and `attending_physician_collaborator`, exist in **no** role template, seed,
or tenant row — the only two occurrences in the repo are the predicate lines themselves.

Both halves dead means no CTI can be signed, so no admission can be certified, in any organization.
The contrasting F2F guard works precisely because `performed_by_user_id` really does reference
`users.id` and its escape (`medical_director`) is a real role key.

**Fixed** by making the escapes name role keys that exist: `medical_director` / `hospice_physician` for
the hospice side (§418.22(c) — the medical director or the physician designee; NPs may never certify
terminal illness), `md` / `hospice_physician` for the attending side.

**Recorded, not fixed:** the id-space mismatch itself. Matching a signing user to the specific
physician named on the CTI needs a user↔M40-physician link that does not exist. Until it does, the
identity half is inert and the role escape is the whole gate. That is a schema-scale change and
belongs in the ADR backlog, not in a P0 batch.

The one test that covers these guards passes by conflating the two id spaces — it uses the same
constant as both the `x-test-user` header and the CTI's `hospiceMedicalDirectorId`, which is exactly
why the production breakage was invisible.

## 6. M6 referral — every referral 404'd for every location-scoped user

`referral.scope` denied whenever the caller had any location scope and the referral's `location_id` was
null. No code path anywhere writes `location_id` on a referral — it is only ever read — and the schema
header documents null as the intended steady state ("org-level until an admission activates them"). So
for any user with a location restriction (which the dev persona seed gives every clinical persona),
every referral was invisible.

Null now reads as org-level and is visible to every org member; the location test bites only once a
location is actually assigned. No test covered this predicate, and the one suite that drives referral
routes never populates `locationIds`, so the deny branch was never reached.

## 7. M13 witness discipline — **NOT REPRODUCED, no change made**

The claim was that witness eligibility matches `["rn","lpn","md","np","pa"]` against M3 role keys and
that no role key in the catalog is one of those, so no witness is ever eligible.

The premise holds only for `ROLE_TEMPLATES`, which is explicitly a floor-bearing subset ("the ≈60
default templates are normatively enumerated in the spec's Appendix A"). Role keys are free-text
per-org rows, and `rn` / `lpn` / `md` / `np` are all real seeded keys — `seed-staff-personas.ts` states
that the clinical write routes across M7–M17 check `context.roles` for exactly these tokens. Witness
eligibility works for RN, LPN, MD and NP.

The only genuinely unreachable token is `pa`: no seed creates that role key, and it is absent from
`credential_discipline` and `encounter_discipline` too. There is no PA persona anywhere in the
platform, so this is a vocabulary gap, not a broken gate — recorded, not patched.

Flagged as PLAUSIBLE rather than CONFIRMED by the reviewing session, and the flag was right.

---

## What this batch did not touch

The remaining review findings are P1/P2 and stay on the backlog: M23 recoupment events routing
nowhere, the M30 filing-status seam taking no period, M40's missing alert-rule seed and non-atomic
deactivation applier, the UTC-sliced death date, the live-suite-coverage regex, and the P2 group.

Two structural items surfaced here are worth their own work:

1. **Nothing enforces "a seam impl that opens its own `withOrgContext` may not be called from inside a
   transaction."** This is now the fourth occurrence of that defect (M11, M18, M36/M17, M34). It is
   mechanically checkable and belongs in `arch:fitness`.
2. **The user↔M40-physician link** (item 5) blocks the CTI identity gate and would be needed by any
   other "is this user the physician named on this record" check.
