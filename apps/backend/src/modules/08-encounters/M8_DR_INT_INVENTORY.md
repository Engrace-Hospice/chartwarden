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
  tenant's draft switch ON (absent row = off) and an encounter whose template drafts a section (today only
  the RN routine visit; every other template behaves as with the switch off: no draft read, no check 13, no
  sealed rows), finalize and sign recompute the draft for the signer from M7 `relevantElementsAsOf`, M9
  scale series, M12 medication changes and the M39 Part 2 verdict. If any of those reads fails, or does not
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

### Amendments of a signed drafted note (ADR-0114 VN-D30, PR E2): limits recorded

An addendum may name sections of a signed drafted note it amends; its sign seals the author's confirmed redraft of each as an append-only
amendment row (the note's own rows and pin never change) and publishes `m8.encounter.section_amended` per amended section (outbox: ids only). The audit
event of the same name is ONE per signed addendum, `{ addendumId, sectionCount }`, standard retention class and not Part 2 eligible (`audit.read` is not Part 2
gated, so no section id, flag or Part 2 class may sit on it); the per-section trail is the row trigger of the sealed amendment row. Same fail-closed
posture as the note's own sign (a source or key-ring outage is a 503, never a pass). Recorded limits:

- **No billing re-open.** An amendment touches no claim, no billability read and no event M23/M24 consumes.
- **The amendment's cosignature request is worked like a note's** (PR E2b). `addendum_cosignature_request` is a sibling of `cosignature_request` (that one
  is `UNIQUE (encounter_id)`; relaxing it is a contract migration); the §2.4 workflow (acknowledge, sign, supervisor release, the 12h/24h/48h SLA cron,
  the `cosignature_routed` alert) runs for both through one generalisation by subject (`cosignature/subject.ts`, `cosignature/db-cosignature.ts`, the
  cron's two-table sweep). Signing publishes `m8.encounter.addendum_cosigned` (no consumer), not `m8.encounter.cosigned`, and its provenance row is the new
  `encounter_signature` kind `addendum_cosignature` (migration 1524). The cosignature queue lists both kinds, told apart by `cosign.subject`.
- **M22 has no Part 2 document path.** A rendered document shows the withheld marker where a Part 2 derived section (a note's, or an amendment's) is.
- **A note that holds Part 2 content is amended only by an author with Part 2 disclosure** (`422 AMENDMENT_PART2_NOT_ENTITLED` at naming and again at sign; an
  M39 failure is a 503, never a denial). "Holds Part 2 content" is ONE note-wide fact: its pin is `part2_derived`, or any sealed row is (an original, or an
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
- Only a section the draft can redraft can be amended; the previous-visit and discipline question, the web, the mobile app and other note types
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
| consume | M5 (Patient) | `PatientReader` — patient identity / caseload linkage | yes (ids) |
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
  never UPDATEd or DELETEd — corrections are append-only addenda (§3.6 voided-not-deleted). The pinned
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
eraser). The eraser (1) cryptographically erases the HearthNote ciphertext by destroying the tenant DEK
(`hearthnote_selection.free_text_cipher`, `hearthnote_assembled_output.layer1_cipher`/`layer2_cipher`/
`final_cipher`, and the sealed `hearthnote_signed_section.text_cipher` of ADR-0114) FIRST so the PHI is
irrecoverable the instant the key is gone, (2) deletes the encounter
subtree (signatures, addenda, care-plan links, cosignature requests, vitals, mileage, HearthNote
selection/assembled-output/llm-modification, and ADR-0114's `encounter_draft_confirmation`,
`hearthnote_signed_section` (an amendment's rows included: they carry the encounter id, so the same shred and delete cover them),
`encounter_amendment` and `addendum_cosignature_request` rows) for the subject patient, and (3) tombstones the `encounter`
root (the PK survives for FK integrity) — disjoint from M5's `clinical_record` (patient spine), M6's
`admission_record` (admission subtree), and M7's `care_plan_record` (care-plan subtree). `subjectId` is
the patient being destroyed. (The spec §3.6 `clinical_record` mention is reconciled to this disjoint
class so the M5 eraser is never double-registered — architecture's one-eraser-per-data-class rule wins.)
