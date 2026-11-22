# Module 8 (Encounters & Visit Notes) — DR Tier + Integration Inventory + STRIDE

M8-T12 (spec §3.6, §4.4, §4.7, §5, §8). Companion to the module code; cross-references
`docs/architecture/CHARTWARDEN_DR_BCP_v0.1.md` and `CHARTWARDEN_INTEGRATIONS_v0_1.md`.

## DR posture — **Tier 1** (the clinical-record signature surface; documentation-path module)

M8 owns the encounter — the signed visit note that IS the patient's permanent clinical record entry
and the substrate downstream billing (M23/M24), IDG (M14), and the family portal (M31) read from. A
degradation must not block patient-care documentation or visit signing.

| Attribute | Value |
|---|---|
| **DR Tier** | **1** — the primary clinical-record write/sign path |
| **RTO** | **2 hours** to full write+sign capability |
| **RPO** | **5 minutes** — synchronous WAL streaming to the DR replica + the M1 outbox (durable to commit) |
| **Backup** | Continuous WAL streaming; daily logical snapshot to cold storage (6-year `compliance` retention from the final encounter lifecycle event) |
| **Warm standby** | Required; reads may be served from the replica during recovery; signing gated until primary confirmed writable (a signature is a legal attestation — never written against a stale replica) |

### Signing during dependency degradation (§2.8 / §4.8)

- **M7 care-plan-review gate fails OPEN with a `degraded` marker.** The encounter-sign gate calls M7's
  `careplan.isReviewOverdue`. If M7 is unreachable / 5xx, M8 **allows** the sign and stamps
  `gate_check: { status: 'degraded', reason: 'M7_UNREACHABLE', checkedAt }` — the review-overdue gate must
  not withhold a clinical signature on M7's account. Only a live M7 200 with `encounterSignBlocked: true`
  enforces the block; M7's retroactive sweep re-audits `degraded` signs on `m7.service.restored`.
  **One deliberate exception, the visit-note draft below, fails CLOSED.**
- **Exception (ADR-0114): the visit-note draft fails CLOSED, and so can withhold a signature.** With a
  tenant's draft switch ON (absent row = off) and an encounter whose template drafts a section (today the RN
  routine visit, the RN recertification visit and the face-to-face visit by a physician or nurse practitioner;
  every other template behaves as with the switch off: no draft read, no check 13, no
  sealed rows), finalize and sign recompute the draft for the signer from M7 `relevantElementsAsOf`, M9
  scale series, M12 medication changes and the M39 Part 2 verdict (the recertification and face-to-face visits
  also read M6's benefit periods, level of care, attested face-to-face and certification, and the patient's
  weights from M8's own `vitals`; see "Recertification and face-to-face drafts" below) (an addendum's finalize does the same when a
  confirmed amended section is its sole content: see the addendum paragraph below). If any of those reads fails, or does not
  answer within `DRAFT_SOURCE_READ_TIMEOUT_MS` (5 s), sign and finalize answer **503
  `COMPLIANCE_GATE_UNAVAILABLE`** for that tenant and never pass: a section cannot be confirmed or signed
  against sources that could not be read, and a note must not be signed against a draft computed from
  fewer sources than its author saw. The trade-off is accepted and bounded by the 5 s timeout and by the
  switch; a tenant that needs to sign through such an outage switches the draft off
  (`PUT /api/v1/encounters/draft-policy`, step-up), which restores today's behaviour exactly.
- **HearthNote Layer 2 (M32/AI) fails CLOSED to Layer 1.** Layer 2 is flag-gated OFF in Phase 1
  (`hearthnote.layer2=false`); even when on, an AI outage simply leaves the deterministic Layer-1
  assembly as the final note (`final === layer1`). Signing is never blocked on AI availability.
- **EVV (M18) absence is documented, not blocking.** When M18 has no check-in for the visit, the author
  documents an EVV-missing reason (route 10, D9 fallback) — the EVV bracket seam is an inert forward-seam
  in Phase 1 (deny-stub), so signing proceeds regardless.

### Connections held while a source is asked (ADR-0114, S3): limit recorded

The pool is 10 connections with a 10 s acquire timeout (`packages/db/src/client.ts`), and every seam the draft reads (M7, M9, M12, M39, and the tenant
DEK of a sealed narrative) opens a pooled transaction of its own. A request that held its own connection across those reads could therefore
deadlock the pool: ten concurrent ones would hold ten connections and each wait for an eleventh.

- **The reads hold none.** `GET /encounters/:id/draft` and the amendment draft read the encounter and every store read in one short transaction that
  CLOSES, ask the sources with no connection held, then read the confirmations in a second short transaction. `GET /encounters/:id` reads its rows in a
  transaction, closes it, and opens the pinned narrative (tenant DEK) and asks the M39 Part 2 verdict afterwards, once for the view, the history and the
  addenda's section ids together; the M18 bracket is resolved after it as before.
- **The writes cannot.** Sign, the draft section PUTs, the amendment's section PUT and the amendment's sign MUST hold the encounter row lock (`FOR NO KEY
  UPDATE`) while they read the draft they decide over, so they hold their transaction across the seam reads. The limit: a burst of those on one
  pool can wait on the pool. The bound is `DRAFT_SOURCE_READ_TIMEOUT_MS` (5 s) per source read, and a request that cannot acquire a connection within
  the 10 s acquire timeout fails with 503 (never a pass, never a partial write: the transaction rolls back). A tenant that signs through such a
  burst retries; a burst that long is an operations signal, not a data one.
- **A draft read does not run on after the answer, on either path (S5).** The store reads run on the request's transaction beside the seam reads. A draft
  computation used to reject at the first failure (`Promise.all`) while a multi-query store read (`loadSelection`: the selection, the fall, the ADLs, the
  nutrition) was still issuing queries; on a section PUT, whose transaction holds the row lock, the transaction then rolled back and its connection returned
  to the pool, and the leftover queries ran on a connection that by then belonged to the next request, where one (an `encounter` select with no tenant
  setting) aborted that request's transaction (`25P02`, a `500` for an unrelated caller; the leftover queries are reads with their own tenant predicate
  under row-level security, and the harm observed is the aborted transaction). Two guards close it:
  - A read that **fails fast**: `settleAll` (`drafting/unavailable.ts`) waits for every read and throws the first failure in the order the reads are
    listed, at every place the drafting module joins reads that touch the store (`computeDraft`, `snapshotStorePorts`, `readDraftInputs`, the care-plan
    pair, the scale series, the section PUT's two store reads). The cost is that a failing request waits for its slowest read.
  - A read **abandoned at its time bound**: `guarded` stops waiting after `DRAFT_SOURCE_READ_TIMEOUT_MS` (5 s) but cannot cancel the read, so it may
    still be mid-way. `transaction-lease.ts` lends the draft the transaction's client for the length of the unit of work only (the draft routes' unit in
    `db-draft-unit.ts`, finalize and sign in `note-draft-flow.ts`, an addendum's recompute in `amendment-flow.ts`); once the unit ends, every call on it
    throws, so the abandoned read ends at its next query instead of running it on a pooled connection.
  - The limit: a query already sent when the unit ends is not cancelled. It finishes on its connection ahead of the transaction's commit or rollback, which
    queue behind it, and its result is discarded. The lease cuts off a query started through the leased client; a query builder made before the close and
    run after it would not be, and none of the draft's reads does that.

### LPN and aide drafts (ADR-0114 slice S3, design §3.5): limits recorded

- **Fewer reads, by template.** `draftSourceNeeds` decides which of the care plan, vitals, medication changes and scales a draft reads (`inputs.ts`,
  `compute.ts` `snapshotStorePorts`): an aide's draft is one care-plan read and its removed links; an LPN's adds the vitals and the medication changes.
  No new seam, no new write, no migration. The face-to-face visit no longer reads the care plan, vitals or medication changes it never drafted from.
- **Keys by template.** The three source-domain keys are asked by the service (`source-reads.ts`, `draft-service.ts`), no longer by static route
  preHandlers: the same four routes, after the switch and the tenant are known. A tenant with no default aide or LPN role must grant the keys before it
  enables the draft. Finalize, sign and an addendum's recompute still ask only the admission facts' keys (S1: the signer's draft is the same full draft).
- **Cosign of a drafted note.** A cosigner without Part 2 disclosure cosigns the redacted view (VN-D13, VN-D43): the register (CW-AC-50, CW-AC-51,
  CW-AC-52) records that they attest a note whose Part 2 sections they cannot read, with the same attestation text, no record on the signature or in
  the `m8.encounter.cosigned` event that the view was redacted, and the same for an addendum's cosignature through the API. An amendment by such a
  viewer is refused as before (VN-D30).
- **"Performed" is the clinician's, and the list is the plan's.** The aide's `adl` states an intervention performed for EVERY active care-plan
  intervention tagged for the aide on an active problem of the plan in effect at the visit (M7's relevant elements), except those the author removed
  from the visit. Nothing is linked before the confirmation (the confirmation links them), so the aide cannot leave an item out beforehand: they read
  the whole text, then confirm it, or deselect the section, or unlink an item they did not perform and confirm again. The control is that
  per-section, hash-bound confirmation, as for the RN routine visit's interventions; a per-item exclusion before the confirmation is not built.
- **Provenance.** The recorded ADLs lead the drafted `adl` text and are its first origin (`recorded_adl`, one ADL record per visit, so the source ref's id is
  the kind: `recorded-adl`); the section's origins read "the activities of daily living recorded at this visit; care plan interventions".
- **Status codes say a little.** A caller without a source key gets 404 while the switch is off and 403 while it is on, so the switch state shows to
  them (documented, CW-AC-49). Finalize and sign recompute the draft without the source keys (S1): a signer without `care_plan.read` or
  `prescribing.read` who is refused 422 or 409 for `adl`, `interventions` or `plan` learns that care-plan goals or interventions, or medication changes, exist for the patient (the 409 detail names the section id).
- **The wounds read is not by template.** `computeDraft` reads M9's recorded wounds for every drafted template (the aide and LPN included), through
  no key; no drafted section states one, so none reaches a draft. "Only the sources its template drafts from" means the four S1 sources.
- **Rollout.** The switch is tenant-wide, with no per-template flag: a tenant already switched on at deploy would get the LPN and aide drafts, their
  keys requirement and the unreviewed 2026.12.2 tags at once. Enabling is refused (409 `CORPUS_REVIEW_PENDING`) while the review is pending, so none
  should be on; the operator confirms that before the deploy.

### Face-to-face (physician, nurse practitioner) and IDG follow-up drafts (ADR-0114 slice S5, design §3.7): limits recorded

- **No new seam, route or migration.** The face-to-face visit reads the visit's recorded vitals (M8's own), the orders in effect as of the visit time (M12
  `getMedicationsAsOf`, the read S2b built), and S2's benefit period and scales; the IDG follow-up reads what the discipline's own visit reads (a social
  worker's and a chaplain's from M15, as S4). A physician's or nurse practitioner's draft reads no care plan, no medication change and no discipline plan.
- **A new key for the face-to-face draft.** `prescribing.read` is asked by encounter type (`admission-reads.ts`) at the draft routes, finalize, sign and an
  addendum's recompute, beside `election.read`. Only `medical_director` has a role template, so a tenant grants `prescribing.read`, `election.read` and the
  scale key to its physician and nurse practitioner roles before it enables the switch. The IDG follow-up of a physician or nurse practitioner asks no source
  key. A signer without `prescribing.read` is refused outright (403 naming the key) before any source is read, so nothing of the orders is disclosed.
- **Finalize and sign do not ask the source-domain keys of the IDG templates (S3's limit, extended).** They ask the admission-fact keys by encounter type
  (`election.read`, `prescribing.read`) and not the scale key, `care_plan.read` or `discipline_plan.read`, which only the draft routes ask. A signer without
  one of those still has that source read, and learns, from the section names in a `DRAFT_SECTION_STALE` 409 or the finalize 422 list, that the plan,
  interventions or scale sections are non-empty. Nothing of the source's content is returned.
- **The Part 2 verdict is asked only when an order could be Part 2 (S1 and S2b's rule).** During an M39 outage a viewer without disclosure gets 503
  `DRAFT_UNAVAILABLE` only for a patient who has a SUD or unflagged order, and a success means none does. It needs the outage, and asking the verdict of
  every face-to-face draft would make each one depend on M39. Left as it is, on purpose.
- **Drafted facts in a certifying visit.** The vitals and the orders in effect are what is on record; the physician confirms the section, and the draft
  states no reconciliation, no judgement and no attestation (VN-D32, VN-D53). The note is still readable by every holder of `encounter.read`.
- **Part 2.** An order flagged `isSudTreatment` is left out of the draft for a viewer without disclosure and fails closed (only the literal `false` is "not
  SUD"); a signed note's orders section holding one is withheld whole from a reader without it, as in S2b. The M12 order read is the one S2b and S1 use.
- **The IDG follow-up names no decision.** Nothing links the visit to the decision that prompted it (M14 closes an action item by the signer, and the M17
  proposal that names the decision carries a denylisted payload that may hold narrative), so the `idg_followup` section is the clinician's own words (S5b).
- **An LPN's IDG follow-up is cosigned.** The case manager reads the redacted view and cosigns it (VN-D13), as for any LPN note.
- **Not proven live.** An amendment of a signed face-to-face or IDG follow-up note (S1's path, unchanged), the real M12 and M39 on these routes (fakes in
  the live suite, as in S2b), and a physician who also authored a note as a cosigner. The IDG packet's import of these notes is M14's and was not run.
- **Rollout.** The switch is tenant-wide: a tenant already switched on at deploy would get these drafts, the new key requirement and the unreviewed
  2026.12.4 tags at once. Enabling is refused (409 `CORPUS_REVIEW_PENDING`) while the review is pending, so none should be on; the operator confirms that
  before the deploy.

### Social-work and chaplain drafts (ADR-0114 slice S4, design §3.6): limits recorded

- **One new read, M15's plan as of the visit.** `DisciplinePlanReader.planElementsAsOf` (M15 `seams/`), asked through `disciplinePlanAsOf` of the draft ports,
  takes its turn with the other seam reads (`serial-seams.ts`), is bounded and fails closed like them. It reads the SEALED `state_snapshot` of the signed
  plan version in effect at the visit (M15 supersedes only at discharge, so the latest signed version at or before the visit is the one in effect; the
  system-built `discharge` version is never read, because the discharge consumer makes it from every current working row, unsigned edits included). No
  write, no migration, no M7 read: a social-work or chaplain draft reads the discipline plan and nothing else.
- **Part 2 through M15's rule, with the draft's cross-check.** M15 resolves the verdict itself from the session identity (`resolveSudAllowed`), asks M39 only
  when the sealed version holds a goal that is, or may be, Part 2, and redacts on an M39 failure. The draft then refuses (503, `DRAFT_UNAVAILABLE`) a plan M15
  says it withheld from a viewer the draft's own verdict clears, so an outage never hands an entitled viewer a reduced plan as if it were whole.
- **Key by template, not by plan kind.** The draft routes ask `discipline_plan.read` for these four templates (`source-reads.ts`). M15 does not scope that
  key by kind, so a holder reads the social-work and the spiritual plan alike by M15's own routes; it is granted by default to `rn` and `rn_case_manager`
  only, so a tenant grants it to its social-work and chaplain roles before it enables the switch. Finalize, sign and an addendum's recompute do not ask it (S1).
- **A wider audience than the plan's.** A drafted section becomes note text readable by every holder of `encounter.read`, wider than the holders of
  `discipline_plan.read`. A goal's words can carry sensitive psychosocial or spiritual content that nothing flags (only Part 2 is flagged), and a Part 2 goal
  is withheld from a viewer without disclosure in the draft and in the sealed note's view (no cosigner is needed for these disciplines).
- **No link, section-level confirmation.** A confirmation applies to the whole section; one goal cannot be left out of a confirmed section (S4b would add an
  expand-only link table). The audit refs name M15 goal and intervention ids (kinds `discipline_plan_goal`, `discipline_plan_intervention`); the response
  carries kinds only.
- **Words, not outcomes.** The draft lists open goals and active interventions ("Plan-of-care goal: ...", "Plan-of-care intervention: ..."), attributing a goal
  to the patient, the family or the patient's agent only where the record says so and a clinician has not revised it. It never states a status, progress,
  outcome, a met or discontinued goal, a declination or an assessment. What happened at the visit is the clinician's own text.
- **No plan-side audit, and the staff session class.** M15's plan read leaves no row in M15's own audit (its routes write `PLAN_READ`; the seam read writes
  none, as M5's and M39's draft reads write none): the trail of who read a patient's plan through a note is `encounter_draft.viewed` on the encounter. The
  seam asks M15's Part 2 rule with the session class `staff`, as the draft does for M7 and for M39's acknowledgment read: the draft's viewer carries roles and
  membership only, and the routes are key-gated, so a portal or external session that held `encounter.read` and `discipline_plan.read` would get whatever M39
  says rather than M15's restricted-session refusal.
- **A signer learns that a plan exists.** Finalize, sign and an addendum's recompute do not ask `discipline_plan.read` (S1's rule: the signer's draft is the
  same full draft), so a signer without it who is refused 422 or 409 for `interventions` or `plan` learns that open goals or interventions exist for the
  patient. This extends S3's limit for the care-plan keys.
- **No family-violence flag on a goal.** Only assessments carry `family_violence_flag`; a goal or intervention carries `sud_related` alone, so the draft never
  consults M15's family-violence rule and S4 reads no assessment.
- **Not proven live.** The live suites do not exercise an amendment of a signed social-work or chaplain note (S1's path, unchanged), nor an M39 outage
  between M15's read and the draft's own verdict (unit-proven), and M39 is a fake in both (the real M39 on the new seam is not mounted by
  `test:m7:consent-wiring:live`). The cross-check catches one direction only (M15 withheld, the draft's verdict clears: 503); a consent change between the
  two calls that goes the other way is a race both calls share.
- **Rollout.** The switch is tenant-wide: a tenant already switched on at deploy would get these drafts, their key requirement and the unreviewed 2026.12.3
  phrases at once. Enabling is refused (409 `CORPUS_REVIEW_PENDING`) while the review is pending, so none should be on; the operator confirms that before the deploy.

### RN admission visit drafts (ADR-0114 slice S2b, design §3.4): limits recorded

- **Three more reads under the sign lock.** An admission draft adds M12's orders as of the visit, M5's roster for the service date and M39's
  acknowledgment evaluation to the draft's reads. They take their turn with the others (`serial-seams.ts`) and are bounded and fail closed like
  the rest; sign, the section PUTs and finalize hold their transaction across them, a few milliseconds longer each. M39's `evaluate` is a pure read
  (no audit row per call). It is asked `historical: true`, so the answer is what was on file at the visit, not the record's status today: a patient's
  death between the visit and the sign (the M39 cascade expires the row) no longer removes the section and blocks the sign. The end instant of an expired
  row is the earlier of its `expires_at` and `updated_at`, so an expired row is never read as in force past its own expiry. A record also counts only if it had been entered by the visit instant (the later of `created_at` and `signed_at`, both set by the server): its effective date can be backdated, so an acknowledgment entered after the visit, or
  created before it and signed after it, is not drafted as on file at it.
- **The list is the orders in effect, not a reconciliation.** The draft states each order's drug, strength, form and route, and "as needed" where it
  is (the order's flag, or a PRN frequency code, as M13 reads it); no frequency, no dose schedule, no home-medication history. If any order that remains has a blank field or no as-needed flag, no list is
  drafted at all (a list with an order missing from it would read as complete). A SUD-treatment order is left out for a viewer without Part 2
  disclosure, so two authors can draft different lists (the signer's own draft is what is sealed).
- **Caregivers are as of the service date.** M5 had only a current-links read; `caregiversOn(day)` decides from each link's own involvement dates
  (`involvement_from <= day`, and no end or `involvement_to >= day`, the end day included). The draft states the name and the relationship, never a
  contact detail. A caregiver whose relationship the draft has no word for, or whose name is blank, drafts no caregiver section at all.
- **The acknowledgment is a fact, not a directive.** M39's record says the patient was given the information, so the draft says an acknowledgment
  was on file at the visit time; it carries no date (M39's evaluation returns none), and says nothing when there is none (never "no directive").
- **Who may read it.** The admission visit's draft needs `patient.read` (M5) and `consent.read` (M39) on top of the three every draft needs, asked by
  template in the same places as S2's (`drafting/admission-reads.ts`). **Before a tenant's switch is turned on, every role that authors an admission
  note holds these keys.**
- **The shared care-plan phrases also reach `med_reconciliation`'s menu.** They are tagged for this visit so `interventions` and `plan` draft, and
  carry the category that section already offered its legacy phrases through (the same overlap `interventions` and `plan` have in the routine visit).
- **Deploy side effect.** `narrative-vocab@2026.12.1` becomes the running corpus for every tenant at deploy: a draft encounter whose selections were
  saved under an earlier release answers `409 VOCAB_VERSION_MISMATCH` at finalize until they are saved again. The corpus review is still checked only
  when the switch is enabled (CW-AC-49's gap), and a release that adds drafted templates is held until its own review is approved.

### Recertification and face-to-face drafts (ADR-0114 slice S2, design §3.3): limits recorded

- **More reads under the sign lock.** A recertification's draft adds four M6 reads (periods, level of care for one day, face-to-face, certification)
  and one weights read to the draft's reads; a face-to-face adds the periods and the weights. They take their turn with the others (`serial-seams.ts`),
  so the connection peak is unchanged, but sign, the section PUTs and finalize hold their transaction across them (the limit above), a few milliseconds
  longer each. A GET snapshots the weights with the other store reads (every weight up to the visit time, cut to the period start in code), so it holds
  no connection across the seam reads either. Each read is bounded by the same 5 s and fails closed.
- **M6's readers are now-reads cut by date here.** The period is the one covering the service date (M6's own rule); a face-to-face attested, or a
  certification signed, after the service date is not drafted; a certification that is not `signed` now, or was voided or superseded since, is not
  drafted (the safe direction: silence, never a stale claim). The level of care is named only when exactly one level counted for that day.
- **Weights across encounters.** The patient's weights come from this encounter and from the patient's signed encounters (an unsigned draft of another visit
  is not yet part of the record), cut to the benefit period by the organization's local date. When ANY weight inside the period cannot be used (not a
  positive decimal, no `kg`/`lb` unit, an unreadable time) or the weights are in two units, no weight is drafted at all: the sentences say "the first" and
  "the only weight recorded", and a row skipped in silence would make them false. Nothing is converted. There is no plausibility bound: a typed `1500` for
  `150` drafts a large percentage, and the clinician's confirmation of the section is the check. The snapshot reads every weight of the patient up to the
  visit (a look-back cut would make "the first weight of the period" wrong for a period that began earlier); a patient's weights are few.
- **Dates from M6.** A face-to-face's attested date and a certification's signing date are the organization's own calendar day (M6's store converts the
  instant in the organization's zone). The level of care on the visit date is M6's own day count (`getLevelOfCareDays`, also what billing counts), whose
  day is the UTC day of the change's instant: a level-of-care change made in the evening, US time, counts on the next day, here as in M6.
- **Who may read it.** The draft of a recertification visit needs `election.read`, `cti.read`, `f2f.read` and `loc.read` (M6's own read keys for the four
  facts, which its seams do not check), and the face-to-face visit's draft needs `election.read`. The service refuses 403 a caller of such an encounter who
  lacks one, after the switch and tenant checks and before any source is read (`drafting/admission-reads.ts`). The check is by template, so it is the same
  for every viewer (one draft per patient and visit); a routine visit's draft needs no key it did not before. Finalize, sign and an addendum's finalize and
  sign recompute the draft for the caller and ask the same keys at the same point (`readNoteDraft`), resolved from the whole request context as the route
  guards resolve them. **Before a tenant's switch is turned on,
  every role that authors a recertification or face-to-face note holds these keys**: they are per-tenant grants, and a role without them cannot read or
  confirm the draft, so cannot sign once the switch is on.
- **The corpus review is checked when the switch is enabled.** A tenant already on keeps the switch on after a later corpus release moves the wording
  (CW-AC-49's gap). If a review of `narrative-vocab@2026.11.0` is approved before this release deploys, tenants enabled on it would get the recertification
  wording unreviewed; a release that adds drafted templates is held until its own review is approved.
- **Deploy side effect.** `narrative-vocab@2026.12.0` becomes the running corpus for every tenant at deploy, the switch on or off: a draft encounter whose
  selections were saved under `2026.11.0` or `2026.06.0` answers `409 VOCAB_VERSION_MISMATCH` at finalize until `PATCH /encounters/{id}/selections` saves
  them again (the web composer saves before it finalizes; another client must too).
- **Selections are not checked against the menu.** `PATCH .../selections` accepts any code of the corpus (S1's design): the menu's rules decide what the
  composer offers, not what the API takes, so an author can store a recertification phrase in any section with parameters they invent. They could type the
  same words as free text, and a section's drafted text is what the clinician confirms.
- **Not drafted, by decision.** The physician's face-to-face attestation and the certification narrative (module 6's, never quoted: VN-D32), and any
  statement of prognosis, eligibility or life expectancy; FAST, NYHA, laboratory values and hospitalisations (VN-D33). The admission visit's own
  sections follow in a later slice (VN-D31).

### Amendments of a signed drafted note (ADR-0114 VN-D30, PR E2): limits recorded

An addendum may name sections of a signed drafted note it amends; its sign seals the author's confirmed redraft of each as an append-only
amendment row (the note's own rows and pin never change) and publishes `m8.encounter.section_amended` per amended section (outbox: ids only). The audit
event of the same name is ONE per signed addendum, `{ addendumId, sectionCount }`, standard retention class and not Part 2 eligible (`audit.read` is not Part 2
gated, so no section id, flag or Part 2 class may sit on it); the per-section trail is the row trigger of the sealed amendment row. Same fail-closed
posture as the note's own sign (a source or key-ring outage is a 503, never a pass). Finalize of an addendum whose ONLY content is a confirmed amended
section (no selection, no annotation) depends on the same sources: it reads the author's draft (M7, M9, M12, M39) to count what sign would seal, so an outage
there is a 503 `COMPLIANCE_GATE_UNAVAILABLE` at finalize too, not only at sign. Such an addendum could not finalize at all before, and an addendum with a
selection or an annotation, or with no confirmed section, reads nothing at finalize. Recorded limits:

- **No billing re-open.** An amendment touches no claim, no billability read and no event M23/M24 consumes.
- **The amendment's cosignature request is worked like a note's** (PR E2b). `addendum_cosignature_request` is a sibling of `cosignature_request` (that one
  is `UNIQUE (encounter_id)`; relaxing it is a contract migration); the §2.4 workflow (acknowledge, sign, supervisor release, the 12h/24h/48h SLA cron,
  the `cosignature_routed` alert) runs for both through one generalisation by subject (`cosignature/subject.ts`, `cosignature/db-cosignature.ts`, the
  cron's two-table sweep). Signing publishes `m8.encounter.addendum_cosigned` (no consumer), not `m8.encounter.cosigned`, and its provenance row is the new
  `encounter_signature` kind `addendum_cosignature` (migration 1524). The cosignature queue lists both kinds, told apart by `cosign.subject`.
- **M22 has no Part 2 document path.** A rendered document shows the withheld marker where a Part 2 derived section (a note's, or an amendment's) is.
- **A note that holds Part 2 content is amended only by an author with Part 2 disclosure** (`422 AMENDMENT_PART2_NOT_ENTITLED` at naming, at finalize when a
  confirmed amended section is the addendum's sole content, and again at sign; an M39 failure is a 503, never a denial). "Holds Part 2 content" is ONE note-wide fact: its pin is `part2_derived`, or any sealed row is (an original, or an
  amendment of any section). A signer without disclosure is refused the same way whichever section they name, so the refusal says nothing of which sections are
  Part 2 (answering "unknown section" for one would be the same oracle: template section ids are public). The refusal says "this note cannot be amended by this
  signer" and names no section; the verdict is asked only when the note has Part 2 content, and a free addendum is unaffected. An entitled author's redraft can
  still hold no Part 2 content when its sources no longer do; a viewer without disclosure still gets that section withheld whole, because it had a Part 2 version.
- **Who may name sections.** Only the note's author or a supervisor (`403`, before any write; a free addendum is anyone's with the addendum permission).
  The amendment's cosigner is never the note's author: the cosign service refuses the author at acknowledge and sign, so an author who is the only RN on
  the caseload leaves the amendment `422 NO_ELIGIBLE_COSIGNER` before any write.
- **A viewer without disclosure is told nothing about a Part 2 section's identity: one withheld set decides every field.** A section with a Part 2 version at
  any time is withheld whole. The current view keeps its place and a withheld flag with no section id, amending addendum or date; the history omits it (`null`
  when none is left); an addendum's `amendsSectionIds` drops its id, signed or not, and an addendum whose every named section is withheld reads as a free
  addendum (`cosignStatus` `not_required`). Its own `signedAt` stays, as a free addendum has one.
- **The amendment draft is its addendum author's view alone.** `GET .../addenda/{addendumId}/draft` is `403` for anyone else (the note's author and a supervisor
  included), whether the addendum is free, amending or absent, so the refusal cannot be probed for which addenda name sections; the author of a free addendum
  still gets `404`. The writes before a sign (the addendum's creation and finalize, a note's finalize, a vitals capture and edit) are filed under the acting user.
  Recorded: the selections saves, the mileage writes and the EVV reconciliation are still filed under the system actor.
- Only a section the draft can redraft can be amended; the web, the mobile app and other note types
  are out of scope.

### Cosignature SLA clock during outages (§2.4)

The 12h/24h/48h cosignature SLA is computed from the `timestamptz` primary-sign time, not a running
service, so it advances during an outage. The escalation *emissions* (`m8.encounter.cosignature_*`) are
driven by the `encounter.cosignature` queue; a declared `outage_window` excludes the outage duration
from the elapsed-hours math (same pattern as M7's gate clock) so a backlog of escalations does not fire
en masse on recovery.

## Integration inventory — cross-module couplings

M8 has **no direct external integration of its own** (HearthNote Layer 2 reaches Anthropic via M32's
`ai-platform` seam, never directly). Its couplings are internal seams/events:

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| publish | M14/M22/M23/M24/M30/M31/M33/M36 | `m8.*` outbox events (§4.4) — created/signed/cosigned/finalized/voided/late_entry_override/… | minimal (ids); `m8.encounter.signed` payload feeds M31 visit summary (consent-gated) |
| serve | M23/M24 (Billing) | `BillableEncounterReader` seam — billable signed encounters (§4.7) | yes (ids) |
| serve | M14 (IDG) | `SignedEncountersReader` seam — signed encounters per patient since a timestamp | yes (ids) |
| serve | M17 (Scheduling) | `MileagePayrollReader` + `EncounterCreator` seams (plan-only deny-stubs in Phase 1) | yes (ids) |
| serve | M22 (Documents) | `/internal/encounters/:id/render-payload` — PDF-render payload | yes |
| consume | M7 (Care Plan) | `CarePlanReader` seam — `relevantElementsForEncounter` element picker + `isReviewOverdue` sign gate (§7.8) | yes (ids) |
| consume | M7 (Care Plan) | `CarePlanReader.relevantElementsAsOf` — the goals and interventions as of the visit time, per-viewer Part 2 redaction; a draft source (ADR-0114), fails closed | yes (text) |
| consume | M9 (Assessments) | `ScaleSeriesProvider.series` seam — scored scale series over the visit window; a draft source (ADR-0114), fails closed | yes (scores) |
| consume | M12 (DoseSpot) | `MedicationOrderProvider.getMedicationChangesBetween` seam — medication changes since the previous visit; `isSudTreatment` is not redacted by the seam, M8 applies the Part 2 verdict; a draft source (ADR-0114), fails closed | yes (names, dates) |
| consume | M39 (Consent) | the per-actor Part 2 verdict (`evaluateForInternalAccess`, through M7's `sudDisclosureAllowedForActor`) — whether this viewer may read this patient's SUD content. M7's own reads read an M39 error as "not allowed"; **M8 fails CLOSED** (`onError: "throw"`, `drafting/default-ports.ts`): an M39 error is a thrown failure, never a denial and never a disclosure, so the draft is 503 `DRAFT_UNAVAILABLE`, sign and finalize 503 `COMPLIANCE_GATE_UNAVAILABLE`, a note view 503 `NOTE_VIEW_UNAVAILABLE` and an amendment's naming or sign 503 (see the exception above) | yes (ids) |
| consume | M6 (Admission) | S2, the recertification and face-to-face drafts only: `ElectionPeriodReader.listPeriodsForAdmission` (the benefit period covering the service date), `LevelOfCareReader.getLevelOfCareDays` over that one day, `FaceToFaceReader.getAttestedF2fForPeriod` (performer role and dates, **never the attestation narrative**) and `CertificationReader.getActiveCertification` (status and signing date, never the narrative); the as-of cut by date is made in `drafting/inputs.ts`; fails closed | yes (dates, no free text) |
| consume | M5 (Patient) | `PatientReader` — patient identity / caseload linkage | yes (ids) |
| consume | M5 (Patient) | S2b, the admission draft only: `PatientCaregiverRosterReader.caregiversOn` — the caregivers on record on the service date (name, relationship; contact details are never read) | yes |
| consume | M12 (DoseSpot) | S2b, the admission draft only: `MedicationOrderProvider.getMedicationsAsOf` — the orders in effect at the visit time; `isSudTreatment` filtered per viewer | yes |
| consume | M39 (Consent) | S2b, the admission draft only: `ConsentEvaluator.evaluate` for `advance_directive_acknowledgment` as of the visit time — whether an acknowledgment was on file, never its content | yes (ids) |
| consume | M6 (Admission) | admission linkage (encounter belongs to an active election period) | minimal (ids) |
| consume | M36 (Messaging) | `AlertEmitter` seam — cosignature SLA + late-entry-override alerts | minimal (ids) |
| consume | M38 (Terminology) | HearthNote vocabulary / value-set pins (`@chartwarden/narrative-vocab` `VOCAB_VERSION`) | no |
| consume | M18 (EVV) | `EvvBracketResolver` forward-seam (inert deny-stub; M18 in Wave F) | yes (ids) |
| consume | M17 (Scheduling) | canonical `m17.visit.published` → live `seed-visit-encounter` handler with per-tenant visit idempotency | minimal (ids + scheduling/siting fields) |
| consume | M32 (AI Platform) | HearthNote Layer-2 enhancement (flag-gated OFF Phase 1; deterministic Layer-1 fallback) | yes (in-perimeter) |

Notes:
- The M17 visit-seeding path is live; the M18 EVV-bracket path remains a pure decision core / deny-stub
  (M8-T11/T08); the live bindings wire in Wave F. No `dependsOn` edge is created for either (the
  consumed `m17.*` / `m18.*` strings are not M8-owned events; M8 `dependsOn` stays `[1,6,7,9,36,38]`; the draft's M9 / M12 / M39 reads go through the M1 seam registry, no import edge).
- All logs are PHI-free by construction (Pino redaction §8.4): `encounter_id` / `patient_id` /
  `org_id` / `membership_id` UUIDs + enums only — never `free_text` annotations, `layer1`/`layer2`/
  `final` narrative text, vital numerics, or the override `reason` strings.

## STRIDE highlights (§4.7)

- **Repudiation (T1):** `encounter_signature` captures `membership_id`, `signer_role`,
  `signature_method`, `signed_at`, `step_up_auth_at`, `attestation_variant`; signing requires a fresh
  step-up session class (D13, > 5 min ⇒ re-auth); the M4 PHI write-audit trigger makes an immutable
  `audit_event` on INSERT. `m8.encounter.signed` records the business attestation. A signed encounter is
  never UPDATEd or DELETEd, except by destruction certificate (the eraser's tombstone and deletes) — corrections are append-only addenda (§3.6 voided-not-deleted). The pinned
  narrative (`hearthnote_assembled_output` `layer1_cipher` / `layer2_cipher` / `final_cipher`) is frozen in
  the database once the encounter is `signed`, `cosign_pending` or `cosigned` (migration 1521): only the
  eraser's shred sentinel is accepted, and sign pins it BEFORE the status flips.
- **Elevation (T2):** cosignature is RBAC-gated (`encounter.cosign` ∈ {RN, Clinical Supervisor, DON}) +
  ABAC `cosigner_role_match` (the cosigner must be an RN and NOT the primary author) ∧
  `caseload_membership` ∧ `step_up_fresh`. The administrative >14d override emits
  `m8.encounter.administrative_late_override` at severity **critical** for SIEM.
- **Tampering (T4):** HearthNote Layer 2 can NEVER change a clinical fact — vital numerics and
  medication doses are D7 hard-blocked; an attempted change is silently restored to Layer 1 and recorded
  as `m8.encounter.layer2_hard_block_attempted` for audit transparency. Layer-1 assembly is
  deterministic (byte-identical for the same selections) so the signed note is reproducible.
- **Information disclosure (T3):** §7.6 SUD redaction is applied SERVER-side on every encounter
  read/summary/portal-derivation path; SUD-flagged content is dropped regardless of snapshot content and
  the response carries `redacted: true`. The M31 family-portal visit summary is derived from the
  `m8.encounter.signed` payload subject to M39 consent, with SUD content omitted.
- **Cross-tenant (T5):** RLS on every owned table (the ten above plus the seven ADR-0113 / ADR-0114 additions: `documentation_obligation_policy`, `documentation_obligation_override`, `encounter_draft_confirmation`, `hearthnote_signed_section`, `visit_note_draft_policy`, and the two of ADR-0114 VN-D30 (amendments), `encounter_amendment` and `addendum_cosignature_request`) keys on `app.org_id` with `WITH CHECK`; even with
  RBAC/ABAC stubbed open, RLS alone blocks the cross-tenant read; a forged `encounterId` returns 404 (the
  row is RLS-hidden), never 403 — no existence disclosure. Proven on real Postgres (§9.3 / §9.4).

## Destruction (`encounter_record`, §3.6 / D9)

The `encounter_record` data class is erased ONLY through the M4 destruction-cert workflow (M8-T12
eraser; today the only caller is M34's tenant shred). `subjectId` is the patient being destroyed. The eraser
first REFUSES, before any write, unless its connection is a member of `chartwarden_destruction`
(`DATABASE_DESTRUCTION_URL`; the composition root falls back to the app pool when it is unset, which can shred and
tombstone but not delete). Then, as three transactions: (1) it SHREDS the HearthNote ciphertext itself
(`hearthnote_selection.free_text_cipher`, `hearthnote_assembled_output.layer1_cipher`/`layer2_cipher`/`final_cipher` and the
sealed `hearthnote_signed_section.text_cipher` of ADR-0114; `layer2_cipher` becomes `""` on a Layer-2-involved output, which
`hearthnote_output_layer2_consistency` requires non-null, and stays NULL on a Layer-2-off one; migrations 1521/1525 let only
that sentinel through on a signed note; the store holds a `DbClient`, not the key custodian, so it destroys the bytes, not the
DEK); (2) it TOMBSTONES the `encounter`
root (voided, every reason text replaced by one placeholder, the fall link `fall_incident_id` / `fall_occurred_on` cleared, PK kept
for FK integrity; `voided_by` is the note's author because
no system membership exists, and the audit actor is NULL); (3) it DELETES the satellites (signatures, addenda, care-plan links,
cosignature requests, vitals, mileage, the recorded ADLs and nutrition (`encounter_adl`, `encounter_nutrition`: the root is only
tombstoned, so their `ON DELETE CASCADE` never fires and they are deleted by name), HearthNote selection/assembled-output/llm-modification, and ADR-0114's
`encounter_draft_confirmation`, `hearthnote_signed_section` (an amendment's rows included: they carry the encounter id, so
the same shred and delete cover them), `encounter_amendment` and `addendum_cosignature_request`, children before parents).
A failure between the
transactions must be retried (re-post the shred with the same certificate id); every step is idempotent. `erased` counts the
satellite rows plus the roots tombstoned in that run. Disjoint from M5's `clinical_record` (patient spine), M6's
`admission_record` (admission subtree), and M7's `care_plan_record` (care-plan subtree).

What destruction does NOT reach (spec §3.6 "What survives"): the `audit_event` before/after images the 0031 write-audit
triggers recorded keep clinical values their denylists do not name (vitals numbers, `hearthnote_selection.selections`,
`encounter_signature.attestation_text`, mileage figures), and the destruction's own satellite DELETEs add more; M8
outbox payloads carry reason text, and `failed` dead letters are never auto-purged. M8 reads no legal hold: the M34 shred
preflight refuses the whole tenant while any hold is active, before any eraser runs.
