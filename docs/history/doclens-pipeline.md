# DocLens pipeline (M22 Pillar 3 + M32) — F-236

Decisions and build record for DocLens stages 2–4 and the first live M32 invocation pipeline. The
architecture-level decision is [ADR-0048](../adr/ADR-0048-doclens-docling-plus-grounded-extractor.md);
the chart writeback it feeds is F-235 in [`outbox-248-builds.md`](./outbox-248-builds.md).

**F-236 — DocLens is Docling + an M32 grounded extractor; the M32 pipeline is built for the first time
(2026-10-03).** The product owner chose option B (no LangExtract), a model-agnostic extractor with BOTH a
local model (Ollama) and Claude under the BAA, page classification on the same model path, and the
backend pipeline end to end (review UI later).

*Built, in three commits.* (1) **Stage 2** — `services/docling-worker` (FastAPI, Docling 2.133, EasyOCR,
CPU, models baked into the image): a presigned GET URL in (no object-store credentials in the worker), a
worker-specific `DOCLING_WORKER_TOKEN` (NOT the backend's `INTERNAL_SERVICE_TOKEN`, which authenticates TO
the backend), per-page text blocks with top-left page-point boxes out; never logs text or URLs. M22's
`docling-client.ts` validates the payload strictly. `groundQuote` (`@wardenx/intake-extraction`): a model
quote must occur in Docling's text and contain the value; the box is the tightest matching span, searched
in Docling's order and then in **visual reading order** (rebuilt from the boxes — found on a real run:
Docling emitted "Mobile phone:", "Email:" before both values). (2) **M32** — the `aiSdk.invoke` pipeline
had never been constructed (its blocker, the per-tenant DEK cipher for `prompt_payload_cipher`, now
exists over M34's key provider). Built from the existing Drizzle stores plus: an Ollama adapter (explicit
`num_ctx`; a reply whose prompt filled the window is refused — Ollama truncates silently; vendor token
counts; healthy only if the tag is pulled), the `@anthropic-ai/sdk` transport behind the existing
ZDR-gated adapter (structured outputs via `output_config.format`; refusal / max_tokens throw; SDK
installed in `packages/ai-platform` only), deployment config binding only inventory keys, a health sweep
(the first writer of `last_health_status`, via a two-column platform grant), `db:sync:ai-backends`
(registers configured backends with real pins/Ollama digests and the BAA/ZDR/license facts the DB CHECKs
require — never invented), an `ai_token_budgets` org setting (absent ⇒ refuse), PHI-minimisation
allowlists for the DocLens capabilities only, a real actor resolver (membership → role + default provider
entity; refuses without one), hash-pinned prompt files (`packages/ai-platform/prompts/doclens/*.v1.md`)
through a filesystem artifact reader (seams refuse without an active template; ABAC and R30 now share
that registry — ABAC had silently built a second one), a strict DocLens projector + JSON schemas, and a
per-call dispatch timeout. The capability sync now allows every inventory backend that serves a capability
(it allowed only the default, so a `local_only` tenant could never be served locally). (3) **Stages 3–4**
— field schemas for all 11 types (tier is the registry's, never the model's), the `m22-doclens-intake`
BullMQ job (presign → Docling → classify per page → extract per same-type run → ground → DEK-encrypted
candidates; refused AI ⇒ `awaiting_capability`, unparseable/unfiled ⇒ `parse_failed`, idempotent on
status), `/extraction/run` now enqueues (202) instead of returning an empty in-memory result, and
`POST /intake/uploads` accepts the verified-uploaded `documentId` (the batch used to carry a random
placeholder).

*Not built.* Stage 5 vision verification and the SUD detector (candidates are stored
`vision_verified=false`, `sud_detected=false`, stated in the code); the review UI; writeback targets beyond
M5 (F-235). The four `doclens_*` capabilities stay at `DESIGN_REVIEW` platform-wide; the dev seed's PILOT
promotion is dev-only. Pre-existing and still open: route 20's licence check reads the candidate's risk
from the query string (see F-235).

*Verification.* Real model runs on the host Ollama (`llama3.1:8b-instruct-q8_0`): 15/15 fields grounded on
the synthetic image-only fax; and the full HTTP flow on the local Docker stack — verified upload → batch →
`/extraction/run` → `extraction_complete` in ~48 s → 15 encrypted candidates with Docling boxes → four
`ai_invocation` rows (local backend, real pin, encrypted prompts, `local_only` routing) → review → commit →
only the 7 allowlisted contact fields written to M5. Tests: `f236-docling-grounding` (12, on real worker
output), `f236-m32-doclens-backends` (14), `document-doclens` (+2), pytest 6, and the live suite
`test:f236:doclens-intake:live` (6: the job as `wardenx_app`, plus the pipeline over its real stores —
`local_only` routed locally, ledger ciphertext decrypts, budget/flag gates). Mutation checks (each
reverted, each caught): ungrounded fields kept, a default token budget, the PHI allowlist disabled,
plaintext candidate values stored.

## F-237 — the review screen, stage 5, SUD detection, and the server-side licence check (2026-10-03)

*What.* The four DocLens items F-236 left open. (1) **The licence check is the server's.** Route 20's
`extraction_reviewer_eligible` read the candidate's risk tier from `?riskLevel=` (and bulk approve read
`?anyHighRisk=`), so a browser that sent `low` for a medication let an unlicensed reviewer decide it. The
predicates now load the tier from the candidate row, constrained to the review's own batch (a stranger id
is denied); the discrepancy route resolves its candidate through the discrepancy, never a body field; the
services re-check batch ownership (404) on decide and bulk approve. (2) **Stage 5.** High- and
medium-risk values (medications, allergies, legal name, DOB) are re-read by a vision model from a crop of
their Docling box rendered by the docling-worker's new `/render`; the model is **never shown the extracted
value** — M22 compares the reading (alphanumerics) and stores `vision_verified`, or the reading
DEK-encrypted in `vision_disagreement`, or neither (unverified, said out loud). List fields read every
visible entry and verify membership (Docling often returns a whole list as one block, so a crop cannot
isolate a line — the first E2E run read the neighbouring medication). M32 gained image support end to end
(`ModelBackendCompletionRequest.images`, Ollama `images`, Anthropic image blocks; a request with images
requires the `vision` modality at routing; the ledger records image SHA-256s, never bytes) and a local
vision route, `local-qwen2.5-vl-7b-instruct` (ADR-0048 amendment). Approving a disagreed value unchanged
needs a reason (422). (3) **SUD detection (§7.4 W4 / D8).** A deterministic, high-recall rule set
(`sud-detection/flagger.ts`: MAT drugs, ICD-10 F10–F19 minus tobacco per 42 CFR §2.11, disorder/withdrawal
wording, substance-use history, treatment settings; negation suppresses wording, never a medication) runs
on every page whatever the AI posture, plus the governed `doclens_sud_detect` model pass whose quotes are
grounded before they count. Candidates on indicator pages are tagged; evidence is stored only as
ciphertext; `m22.intake.sud_detected` (ids only) is published atomically with completion; M5's new
`m5.m22-intake-sud-privacy` consumer adds an interim `sud` flag (migration 0308 `sud_flag_origin`), promotes
it on confirm, and retires it on a false-positive rejection **only if DocLens put it there**. Completion is
409 while SUD is unresolved; resolution needs RN-or-above and, for a rejection, a reason; after a rejection
SUD-page contact fields become committable. (4) **The review screen** (`/intake` queue,
`/intake/:batchId/review` workspace): page images with every value's box, per-field accept / edit / reject
behind a per-field source-view confirmation, stage-5 and SUD chips, the W4 banner, bulk approve of eligible
low-risk fields, and a completion dialog showing what will and will not reach the chart. Server half:
`GET /intake/uploads`, `GET …/:id/workspace` (decrypted, read-audited), `GET …/:id/pages/:page/image`,
`POST …/:id/sud-review`. Decisions can now be revised (upsert, audited). Also fixed: `decisions:bulk-approve`
was registered unescaped, so find-my-way read `:bulk` as a parameter (the route matched
`decisions<anything>-approve`); it is `decisions::bulk-approve` now and the OpenAPI emitter understands `::`.

*Not built.* Discrepancy detection (stage 6) and its drawer; reclassification and the fax splitter; an
intake upload UI (batches are still created by API); writeback beyond M5 contacts. Boxes are Docling
block-level: when Docling merges a list into one block every entry shares the list's box. The Claude path
is wired (including images) but untested against the real API.

*Verification.* Real local models on the Docker stack (llama3.1 8B + qwen2.5-vl 7B on host Ollama), a
synthetic fax with methadone and heroin history: rules + model flagged page 2 → M5 interim flag →
workspace/queue/page image over HTTP → 422 on an unchanged disagreed approval → 409 completing with SUD
unresolved → 422 rejecting without reason → rejection retired the flag → completion wrote only the 8
contact fields. Stage 5 verified name, DOB, allergy and two medications and correctly flagged an
OCR-damaged lorazepam line. Tests: `f237-sud-flagger` (20), `f237-doclens-stage5-sud` (24),
`document-routes` (+5, the `?riskLevel=low` bypass now 403), docling-worker pytest (+9), web DOM (7), and
the live suite `test:f237:doclens-review:live` (4) plus the F-235/F-236/M22/M5/M32/M39/dispatcher live
suites. Mutation checks (each reverted, each caught): licence bypass on high risk, planner ignoring SUD,
rejection lifting a consent-derived flag, images not routed to a vision backend.

## F-238 — complex referral packets: ICD-10-CM, the fax splitter, page-scanned codes and coding checks (2026-10-04)

**Goal.** Help the clinical reviewer check a complex patient's faxed records for diagnosis accuracy before
anything is parsed into the chart: which diagnoses the packet documents, with which ICD-10-CM codes, where,
and what is wrong with them. DocLens points out; it never codes, never picks the principal diagnosis and
never decides related/unrelated (AI Governance §2.1.1 hard-blocks AI-introduced codes; the physician decides).

**Measured against a synthetic packet.** `scripts/doclens/make-complex-packet.py` renders a fictional 85M
(end-stage HFrEF, COPD, CKD 4, Alzheimer's, T2DM, AFib, alcohol dependence in remission) as a 21-page fax of
19 documents, with an answer key: document boundaries, 38 diagnosis mentions with pages, 15 planted coding
problems, negations, prognosis evidence present and missing. The real docling-worker parses (both OCR
engines) are committed beside it, so every stage is scored, not eyeballed.

- **OCR.** EasyOCR read 15/55 key phrases and 14/31 ICD codes exactly (`I5o.23`, `EF 15%` → `EF' 158`,
  dropped lines). Tesseract: 42/55 and 21/31, ~10x faster on CPU → now the docling-worker default
  (`DOCLING_OCR_ENGINE`). Its misses are systematic (I→1, Z→2), which the scanner repairs.
- **ICD-10-CM in M38.** `scripts/db/load-icd10cm.ts` loads the real NCHS releases (FY2026 superseded,
  FY2027 active; checksum-pinned), with the Tabular List's manifestation / code-first / use-additional
  flags and FY2027 deprecation mappings (30, e.g. I42.0 → I42.00/.01/.09). M38 search had ignored as-of
  (one row per loaded version came back); fixed. The provider gained `listVersions`.
- **Fax splitter** (`packages/intake-extraction/src/pipeline/splitter.ts`). Replaces "contiguous same-type
  pages = one document" (which merged a 2025 pulmonology note with a memory-clinic letter): continuation
  markers, new section headers, type changes, re-sent pages (word-set + same numbers), the document's own
  date (labelled dates first, never the DOB). 19/19 documents on Tesseract output, also with a classifier
  that calls every page "consult". Segments persist on `classified_page` (migration 0309).
- **Code scanner** (`coding/icd-scanner.ts`). Codes come from the page, never the model (`diagnoses[].icd10`
  is `source: page_scan` and never asked of the extractor; a model-supplied code is dropped). An OCR repair
  is accepted only if the result is a real code AND its title shares words with the diagnosis written
  beside it — "Hypertension (110)" → I10, "BP 110/70" stays a blood pressure; ties are refused. 31/31 key
  codes on the right page.
- **Coding checks** (`coding/coding-checks.ts`, deterministic, each citing its rule): not valid on the
  document's date / retired since written (+ successors), unknown, OCR-repaired, manifestation, CMS-
  unacceptable hospice principal (R53.81, R62.7, R54), symptom code as principal, unspecified while a
  specific code is documented, I10 with HF/CKD → I11.0/I12.x/I13.x, E11.9 with CKD → E11.22, cross-document
  conflicts, resolved, Part 2. A document older than the loaded releases is judged by the earliest one, not
  failed. 15/15 planted problems. Flags are DEK-encrypted per `diagnoses[n].icd10` candidate
  (`coding_flags_cipher`, audit-denylisted) and returned by the workspace API with the document list.

**Not built yet.** The review panel for diagnoses (conditions grouped across documents, click-through
mentions), merging mentions into conditions, the evidence-backed principal suggestion and missing-evidence
list, and code suggestions for uncoded diagnoses.

## F-238 (dx-writeback) — reviewer-attested diagnoses → M7 problem PROPOSALS (2026-10-04)

**What.** A completed DocLens review's approved `diagnoses[n].description | .icd10 | .role` candidates
(same `n` within one extraction job = one diagnosis) now leave review evidence — as **proposals**, never as
charted problems. M22's pure `writeback-plan-dx.ts` (composed next to the F-235 M5 planner; no change to
it) groups and filters them; `writeback-commit-dx-db.ts` writes `extraction_provenance` (`target_module =
'm7'`) and publishes `m22.extraction.diagnosis_commit_requested` in the completion transaction; M7's
`m7.extraction-diagnosis-writeback` consumer lands each as a `pending` row in the new M7 table
`problem_proposal` (migration 0310) and replies `m7.problem.draft_created_from_extraction`; M22's
`m22.extraction-diagnosis-backref` stamps provenance with the proposal id and emits
`m22.extraction.commit_completed` (`targetModule: 'm7'`). A clinician accepts or dismisses via
`GET /api/v1/care-plans/:planId/problem-proposals` and `POST …/:proposalId/accept|dismiss`
(`care_plan.author` + `caseload_or_scope`, AI principals refused, `ifVersion` concurrency).

**Lifecycle decision — a separate table, not a `problem_status`.** Every reader of `problem` (M23 claim
sequencing via `claimDiagnosesForOrg` and the F-214 Part 2 gate, the IDG packet cover, HOPE, the portal
digest, the encounter picker, version `state_snapshot`s, M38 code-usage remediation, the eraser) would
otherwise have to learn to exclude drafts, and one that forgot would surface an unaccepted AI-extracted
diagnosis as a charted one. With `problem_proposal` that is impossible by construction, no `problem`
reader changed, and `problem.kind` keeps NOT NULL with no placeholder value. Accept inserts the real
`problem` (`source = 'intake_extraction'` — the visible extraction label — `status = 'active'`, `kind`
**chosen by the clinician**, `added_by_membership_id` = the accepter), links it (`accepted_problem_id`) and
emits `m7.problem.added`; dismiss charts nothing.

**Governance rules as built.** (1) Never a charted record from DocLens: proposals only. (2) The code is
the as-printed extraction (every stored candidate is grounded verbatim) or the reviewer's typed edit
(`editedCode`, else `editedValue`); `extraction_candidate.value_code` is never read. The shape is checked
(`normalizeIcd10CmShape`, shared in `@wardenx/types`): malformed → that code candidate is excluded
(`icd10_malformed`) and the diagnosis goes without a code. M7 asks M38 (`lookupBatch('icd10cm', …, asOf =
batch upload date)`) → `valid` / `not_valid_as_of`; when ICD-10-CM is not loaded for the date (probe:
R69) or M38 is unbound/erroring → `unvalidated`. The code is kept in every case. (3) The document's
`role` (principal/secondary/history/unspecified) is stored as `document_role`, a label; it never sets
`kind`. (4) Part 2: a diagnosis on a SUD-flagged page is excluded unless the batch detection was rejected
(the F-235 rule); an F10–F19 (not F17) code or SUD wording (the W4 rules, negation-aware) sets
`sud_related`; a CONFIRMED batch sends nothing SUD (`sud_confirmed_batch`); a SUD proposal is omitted
(`redacted: true`) and 404 on decide for a caller without §7.6 disclosure; once accepted it is a
`sud_related` problem the F-214 claim gate withholds without consent. (5) No headless patient
(`patient_unresolved` at M22); M7 attaches to the patient's single non-discharged care plan and otherwise
reports `no_care_plan` / `care_plan_ambiguous` — it never creates a plan. (6) Outbox only. A **separate
event** rather than `commit_requested` + `targetModule='m7'`: on the outbox every declared consumer sees
every row, and M5's F-235 consumer fail-closes (DLQ) on a non-M5 payload; the payload still carries the D5
`targetModule`. (7) Idempotent per source item (UNIQUE org + commit + itemKey → `already_proposed` on
redelivery); at most one PENDING proposal per (patient, code-or-normalized-description) — a second
referral repeating it reports the existing proposal and both referrals' provenance point at it; an ACTIVE
problem with the same code is flagged (`duplicate_of_problem_id`), never merged.

*Not built.* The web UI for accept/dismiss (API only). A dismissed proposal does not suppress a later
referral re-proposing the same diagnosis (deliberate: a new document is new evidence — open question for
the user). `kind = 'terminal'` at accept needs only `care_plan.author`, the same as adding a problem by hand.

*Tests.* `f238-doclens-dx-writeback.test.ts` (pure: shared helpers, every planner exclusion reason and
governance rule, fail-closed payload parsing, the M38 validator); live `test:f238:doclens-dx-writeback:live`
(5): completion → outbox → M7 proposals → back-ref, nothing in `problem` and nothing on the claim read
until accept (then the clinician's `terminal` sequences first), 409/412/422 on decide, redelivery
idempotency, cross-referral dedupe, Part 2 exclusion / hiding / claim withholding, `no_care_plan`, and RLS
as `wardenx_app` (org B sees and decides nothing; the app role cannot DELETE a proposal).

## F-238 (meds + allergies) — reviewer-attested medication lines → M12 medication history; allergies → M5 (2026-10-04)

*What.* F-231's A1 kept every extracted medication out of writeback because M12 D12 / AI Governance
§2.1.1 hard-block AI-introduced medication changes. D12 makes that block operational as "M32's LLM may not
create, modify, sign or otherwise mutate a `medication_order`", and M12 D10 already defines the store an
outside medication list belongs in: `medication_history_record`, "persisted for clinical reconciliation but
never auto-linked to medication_order". So an approved `medications[].name` line now becomes a
reconciliation-only history row (`source = 'doclens_intake'`, the reviewer-attested text verbatim in
`drug_name`, strength/sig/RxNorm NULL — no AI parse, no RxNorm guess), and **nothing on the path can reach a
`medication_order`**: the M12 consumer does not reference the table, `reconcileHistory` records a decision
and always returns `resultingOrderId: null` (for a DocLens row because of D12 — not even a pre-filled draft;
for a DoseSpot row because the D10 carry-forward draft is still unbuilt), and the M32 D18 zone (`medication_`,
D12's boot enforcement — there is no function literally named `validateMedicationAIBlock()`) still passes:
DocLens templates target `extraction_candidate`, and the zone also covers `medication_history_*`, so no
model template may target the history store directly. Approved `allergies[].substance` lines go to the
new M5-owned `patient_allergy` (architecture §10.6.6 "Allergies → Module 5"; migration 0311) as
`unverified`, `source = 'intake_extraction'`; a clinician verifies or marks entered-in-error
(`POST /api/v1/patients/:id/allergies/:allergyId/verify|entered-in-error`, `patient.edit` + caseload), and
the list (`GET /api/v1/patients/:id/allergies`) returns unverified rows, labelled — the Medications tab
shows them in an allergy banner (a failed read is an alert, never "no allergies") beside the outside
medication list with its reconcile actions.

*Mechanics.* A separate pure planner (`writeback-plan-clinical.ts`) and commit
(`writeback-commit-clinical-db.ts`) run in `completeReview`'s transaction after F-235's, leaving F-235's
planner untouched. Exclusions, each named: `risk_not_high` (both paths are HIGH tier), `sud_detected`
(unless the batch's detection was rejected), `sud_treatment_medication` (the W4 flagger's MAT rules,
applied to medication AND allergy lines, unless the batch's detection was rejected — `not_detected`
included), `patient_unresolved`, `edited_value_missing` / `value_missing`, `value_too_long` (never
truncated), `duplicate_in_batch`. One event per target rather than D5's single discriminated
`commit_requested` — the live F-235 M5 consumer fails closed on any other `targetModule`, so a shared event
would hand every target's PHI to every consumer: `m22.extraction.medication_history_requested` → M12
`m12.extraction-medication-history` → `m12.medication_history_record.draft_created_from_extraction`;
`m22.extraction.allergies_requested` → M5 `m5.extraction-allergy-writeback` →
`m5.patient_allergy.draft_created_from_extraction`; M22's `m22.extraction-clinical-writeback-backref`
stamps each line's provenance with the ROW id and emits `m22.extraction.commit_completed` (`targetModule`
widened to `m5 | m12`). Per-line outcomes: `created`, `already_present` (same candidate — redelivery),
`duplicate` (a second fax repeating a line the chart already holds — flagged with the existing row id,
nothing new written; enforced again by partial unique indexes), `skipped`. Both consumers share one
fail-closed parser in `@wardenx/types` (`parseDocLensClinicalCommit`). The completion response gained
`clinicalWriteback`; the review dialog previews and reports it.

*Not built / for the user.* Architecture §10.6.6's table still says Medications → "MedicationOrder (held
for prescriber confirmation)"; the as-built target is the stricter D10 history store, which needs an
ADR/§10.6.6 amendment if accepted. M12's `requestSignature` allergy gate is still the hard-coded
`allergyCheckPassed: true` (no drug-allergy matching exists) — the allergy list is shown to the
prescriber, labelled, but no gate reads it. Verify/EIE reuse `patient.edit` (no dedicated allergy
permission). The M13 reconciliation worksheet still refuses `m12_medhx` lines; reconciliation of DocLens
lines happens on the Medications tab via M12's route. No clinician-entry allergy route yet.

*Verification.* `f238-doclens-clinical-writeback` (18: every exclusion, MAT for meds and allergies, the
methadone-for-pain false positive, dedupe, the shared parsers, and governance — no M22 file touches
`medicationOrders`, the only M12 handler of an `m22.extraction.*` event writes only
`medication_history_record`, reconcile never mints, the D18 zone), a web DOM suite (3), and the live suite
`test:f238:doclens-clinical-writeback:live` (5, disposable PG, real publisher + dispatcher, app role):
completion → both consumers → back-ref, `medication_order` empty throughout, redelivery idempotent, a second
fax flagged `duplicate`, reconcile 409 on a second decision, allergy verify / EIE with attribution and shape
CHECKs, and org-B denial on every surface. F-235's live suite now counts the medication's M12 provenance row
separately; F-235/F-236/F-237 and the M12 vendor-boundary live suites pass.

## F-238 (prospect records) — referral link, per-document identity check, relink (2026-10-04)

A referral rarely arrives complete: older PCP and hospital records are requested later and come back by fax
(occasionally email). They must land on the same prospect, and a fax carrying another patient's page must
never reach a chart. Before this, a batch carried only an optional `patient_id`: nothing tied it to the M6
referral, nothing compared the names on the pages with the patient, and a misfiled batch could not be moved.

- **Referral link** (0312 `intake_upload_batch.referral_id`): `POST /intake/uploads` accepts `referralId`,
  checked through M6's `ReferralReader` (new `getReferralSubject`); the batch takes the referral's resolved
  patient, a conflicting `patientId` is 409 `REFERRAL_PATIENT_CONFLICT`. A batch filed before M6 resolved
  the patient adopts it on the next workspace load (M22 writes only its own row).
- **Identity check** (`@wardenx/intake-extraction` `compareIdentity`, `extraction/batch-identity.ts`): every
  split document's grounded name + DOB vs the patient — or, before one exists, the referral's name/DOB at
  receipt. Two identifiers: `match` (DOB + last name within one OCR character — the packet's wound note really
  reads "DICLENS"), `possible` (same DOB, different surname/first name; or a DOB one OCR slip / day-month swap
  away), `mismatch`, `unverified` (no usable identifier; a DOB or a name alone never confirms). Stored per
  document as status + disagreeing FIELD names (never values) on `classified_page`; the batch keeps the worst
  unresolved verdict, or `no_target`.
- **Review rules**: completion is 409 `IDENTITY_UNRESOLVED` while a document is `possible`/`mismatch` and
  unanswered; `POST /intake/uploads/:id/identity-review` answers one document (`same_patient` /
  `other_patient`, reason required, audit-denylisted). An `other_patient` document's fields cannot be approved
  (409 `DOCUMENT_IS_OTHER_PATIENT`) and are excluded by all three commit paths even if approved earlier.
- **Relink**: `POST /intake/uploads/:id/relink` moves a batch to another patient and/or referral before its
  review completes — append-only `intake_batch_relink` history (FORCEd RLS, reason denylisted), the source
  document follows, earlier answers are cleared and the check re-runs. Refused for a closed batch. A batch
  with a live Part 2 detection (`detected` / `confirmed`) moves too: the relink publishes
  `m22.intake.sud_relinked` (ids only) in the same transaction and M5 moves the DocLens-origin `sud` flag —
  the new patient gains it, the previous one loses it only if DocLens set it and none of their other batches
  still holds a live detection (`fromPatientRetainsFlag`, computed by M22). A referral-filed batch that
  adopts its referral's patient publishes the same event (`fromPatientId: null`). The first cut refused these
  moves (`RELINK_BLOCKED_BY_SUD_FLAG`); browser testing showed that is exactly the misfiled fax that most
  needs moving.
- **Web**: a Patient column in "documents in this fax" (verdict, which identifiers differ, inline answer),
  a banner while unresolved (Complete disabled), Move document dialog with patient or referral lookup
  (`ReferralLookupField`; `GET /referrals` now publishes name/DOB/received/referrer for it).

Also in this round, from testing the packet in the browser: the projector skips "not present" entries
(`value: ""`, `page: 0`) instead of refusing the whole reply, and numbers unnumbered `medications[].name`
entries when unambiguous (showing numbered paths in the prompt made llama3.1:8b loop to `diagnoses[108]`);
the extractor's output cap is 8192 (a discharge summary needs ~5,000) and Bun's hidden 300 s `fetch` timeout
is lifted in the Ollama adapter; pdfium renders are serialised (concurrent renders segfaulted the
docling-worker); a failed DocLens job is removed before re-enqueue (BullMQ silently ignored the re-run);
coding flags and the document list render on the review screen. End to end on the Docker stack: 19/19
documents, 31/31 codes on the right page, 15/15 planted flags, 18/18 extractions.

`test:f238:doclens-identity-relink:live` (6, disposable PG 18, app role, real M5/M6 readers); CI live suites
now run `pgvector/pgvector:pg18` like dev and prod.
