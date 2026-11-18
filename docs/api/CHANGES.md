# ChartWarden API — changes for integrators

Dated notes on API changes an integrator has to act on. The machine-readable contract is
[`openapi.json`](./openapi.json) (regenerated with `bun run openapi:emit`); every field named below carries
its full description there. Newest first.

---

## 2026-11-18 — Visit-note closure clock (M8, ADR-0113): a new `403 NOTE_CLOSURE_REQUIRED` and `503 NOTE_CLOSURE_UNAVAILABLE` for a clinician with an overdue note, six new routes under `/encounters`, a `closure` field on My notes

**Additive for a tenant that does nothing; a tenant that sets the policy to `block` changes what a clinician's session may call.** The policy defaults to `warn` (banner and alerts, nothing refused), so no existing integration changes until a tenant opts in. A new status code on every non-allowlisted route is the thing an integrator has to plan for once a tenant does.

- **`403 NOTE_CLOSURE_REQUIRED` on any route outside a short allowlist, for a staff session whose oldest open visit note is past its deadline (policy mode `block` only).** The clock starts at arrival (EVV check-in, else the visit's start, else the first authoring write on a seeded draft, else the creation of an ad-hoc note) and runs for the tenant's threshold (default 24 hours). `error.details` names the oldest open note (`encounterId`, code `OLDEST_OPEN_NOTE`), its `deadlineAt` and the `overdueCount`. A note is open while it is `draft` or `finalized`; signing it (or `cosign_pending` / `cosigned`) closes it, and `voided` is excluded. What stays callable: the routes that finish the note, the read-only chart, eMAR and orders, on-call and triage, field safety and emergency messaging, the alert inbox, and the override routes below. Creating an ad-hoc note with `POST /encounters` stays allowed (it starts its own clock). A supervisor's override lifts the refusal for one clinician for 1 to 24 hours. Only a staff session is gated: machine credentials, the portal, auditors and every other session class are never refused, nor is a tenant in `off` or `warn`. The refusal is not replayed under an `Idempotency-Key` (a `403` never is).
- **`503 NOTE_CLOSURE_UNAVAILABLE` when the gate cannot read the clinician's state.** The check fails closed: a policy or evaluation read that throws on a non-allowlisted route answers `503` (retryable), never a pass. The one exception is an organization whose last known policy, read within the last few minutes, was `off` or `warn`: that policy is served.
- **New routes** (all static `/api/v1/encounters/<segment>` paths, all in the generated client):
  - `GET /encounters/closure-status` (`encounter.author`): the caller's own position on the clock (`mode`, `thresholdHours`, `verdict` clear | warn | blocked, `stage`, `encounterId`, `patientId`, `encounterStatus`, `deadlineAt`, `hoursOverdue`, `overdueCount`, `overrideExpiresAt`). The web shell polls it. `patientId` and `encounterStatus` (`draft` | `finalized`) describe the oldest open note and are `null` exactly when `encounterId` is, so the banner links it without a second, read-audited `GET /encounters/{encounterId}`; the route stays unaudited (the caller's own position, opaque ids and an enum). The `403 NOTE_CLOSURE_REQUIRED` refusal `details` are unchanged and carry no patient id.
  - `GET /encounters/overdue-notes` (`encounter.closure_override`): the supervisor board, at-risk, overdue and escalated open notes, oldest first, `limit` 1 to 200 (default 50), `truncated` says more matched. An org-wide role sees every site; any other caller sees their own sites and any note that has no site. Read-audited as a multi-patient read (one `encounter.viewed` event per distinct patient on the page; an empty page writes none).
  - `POST /encounters/closure-overrides` (`encounter.closure_override`, fresh step-up, `Idempotency-Key`; AI principals refused): lift the block for one clinician for `hours` 1 to 24 (default 4). The `reason` (at least 40 characters) is screened and refused with `422 VALIDATION_FAILED` (`details[0].field` `reason`, `details[0].code` `EVIDENCE_LOOKS_LIKE_PHI`, value never echoed) when it looks like an SSN or Medicare number; it is stored with the override, copied into the `m8.encounter.closure_override_granted` audit event as `context.justification`, and returned by no route. Also refused: `403 NOTE_CLOSURE_GRANTOR_BLOCKED` ("Close your own overdue notes before releasing someone else."; a blocked supervisor cannot release another, but one who is clear or already overridden can), `409 NOTE_CLOSURE_SUBJECT_NOT_BLOCKED` ("This clinician is not blocked right now, so there is nothing to lift."; the clinician is clear, warn-only or already overridden), `403 NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE` ("That clinician's note is outside your sites."; same site rule as the board) and `403 FORBIDDEN` for an override of oneself. Answers `201` with the override (`id`, `subjectMembershipId`, `grantedByMembershipId`, `obligationKind`, `grantedAt`, `expiresAt`, `revokedAt`).
  - `POST /encounters/closure-overrides/{overrideId}/revoke` (`encounter.closure_override`, fresh step-up; idempotent): the same shape plus **`remainingActiveUntil`**, the latest expiry of any OTHER active override for the same clinician (revoking one supervisor's grant does not re-block a clinician another has also released), or `null` when the revoke re-blocks them. The revoke that takes effect writes an `m8.encounter.closure_override_revoked` audit event; a repeat writes none.
  - `GET` and `PUT /encounters/closure-policy` (`encounter.closure_policy_admin`; the PUT needs a fresh step-up and refuses AI principals): `mode` off | warn | block, `thresholdHours` 1 to 168, and `enforceFrom` (set whenever the mode moves to `block`, so notes already overdue get a fresh window from that instant).
- **`GET /encounters/my-drafts` rows carry `closure`** (`clockStartedAt`, `deadlineAt`, `stage` ok | at_risk | overdue | escalated). A note with no clock (it existed before the clock shipped, and nothing is back-filled) has `null` instants and stage `ok`: it never alerts and never blocks. The list is ordered by nearest deadline first, notes with no clock last, and now includes `finalized` notes (not closed until signed).
- **Alerts.** The three `m8.encounter.closure_at_risk | closure_overdue | closure_escalated` alerts replace `m8.encounter.unsigned` and `m8.encounter.documentation_late`, which are retired (their alert rules are disabled, not deleted). New permissions `encounter.closure_override` and `encounter.closure_policy_admin` are granted to the supervisor roles, not to `org_admin`.

---

## 2026-11-15 — HOPE: a workspace open that refreshes chart answers bumps the draft `version`; a refused coded answer no longer echoes its value; a `401` or `403` is no longer replayed on an `Idempotency-Key`

**Behaviour changes; no new fields.** The version bump and the `401`/`403` rule can make a call that used to succeed answer `409` or run again, so integrators who cache a draft's version or retry a refused call should read them.

- **`GET /hope/assessments/{id}/workspace` bumps `assessment.version` when it changes an answer.** Opening a draft Admission, HUV or Discharge workspace re-reads the chart and rewrites the answers the clinician did not type (the prefill and payer numbers). When that rewrite changes an answer, the draft's `version` goes up by one in the same transaction and the response carries the new version, so an `ifVersion` read before the open is refused with `409` (`PATCH .../answers`, `PATCH .../huv/completion-date`, `POST .../sign`): reload, review the changed answer and act on the new version. An open that changes nothing bumps nothing. Only a caller holding `hope.timepoint.write` refreshes: a caller with `hope.timepoint.read` alone (an auditor, for one) is shown the stored state, and the same applies to the SFV self-heal that `GET .../review` runs.
- **A read-only caller never freezes a legacy draft's spec.** `GET /hope/assessments/{id}/workspace` and `.../review` run the chart refresh and
  the SFV self-heal only for a caller who holds `hope.timepoint.write`; a caller who holds only `hope.timepoint.read` (an auditor
  included) is shown the stored state. For a legacy draft that has no frozen spec yet, that caller now gets `409 CONFLICT` ("This draft needs
  to be opened once by a clinician who can edit it.") and nothing is written: freezing the spec updates the assessment and writes control
  answers, which a read permission does not allow. A draft that already has its spec reads as before.
- **`POST /admissions/{admissionId}/hope/timepoints` on an admission and RFA that already has a draft does the same.** It returns that draft, and when the chart has since changed an answer the clinician did not type it rewrites it, bumps `version` by one and answers the new version (it used to rewrite without a bump and answer the version it had read before). The first fill of a brand-new record is unchanged: it answers `version` 1.
- **A refused coded answer names the item, not the value.** `PATCH .../answers` with a value outside the item's CMS list answers `422` with the same code (`HOPE_INVALID_ANSWER_VALUE`) and the message "the value is not an allowed CMS value for <item code>" (it used to repeat the value, and the idempotency layer replays a `422` for 24 hours). A string `value` longer than 64 characters is now `422 VALIDATION_FAILED` (the longest HOPE assessment text item, A0500C, is 18).
- **A `401` or `403` is no longer cached under an `Idempotency-Key` (every module; every method except GET and HEAD, which carry no key).** The claim is taken before a route's own permission, scope and step-up guards run, so a `403 STEP_UP_REQUIRED` used to be replayed to a retry on the same key after the user completed the step-up. A refusal now frees the key, exactly as a `5xx` does: the same-key retry runs again. As for a `5xx`, the key is freed only when nothing of the request had committed (a refusal after a committed write is still replayed, so the write is never run twice). A `2xx` and every other `4xx` replay as before, and a replay is still answered before the guards run (the fingerprint binds organization, user and actor kind).

## 2026-11-15 — HOPE: a schedule skip takes a fixed reason code (breaking for a client that sends another); the operator writes refuse an AI principal

- **`POST /api/v1/hope/schedules/{id}/skip`: `reasonCode` is one of a closed list, and `note` is gone (breaking).** The reason used to
  be any 1 to 64 characters, was stored on the window and copied into the audit trail, and a `note` was accepted and silently dropped.
  It is now one of `patient_deceased`, `patient_revoked`, `patient_hospitalized`, `transferred_out`, `admission_discharged`,
  `duplicate_window`, `other` (the list the web dialog offers; `HOPE_SCHEDULE_SKIP_REASON_CODES`), so no free text, and no PHI, can be
  stored. Any other value, a `note` or any other property answers `422 VALIDATION_FAILED`; the error names the field (and the list)
  and never echoes what was sent. Windows already skipped keep whatever code they hold; only a new skip is judged. On POST the
  idempotency layer replays this `422` for 24 h on the same key, so send a corrected request with a NEW `Idempotency-Key`.
- **An AI principal is refused (`403`) on seven more HOPE writes**, even one that holds the permission: `POST /hope/schedules/{id}/skip`,
  `POST /hope/submissions/{id}/retry`, `POST /hope/submissions/assemble`, `POST /hope/submissions/{id}/mark-uploaded`,
  `POST /hope/submissions/{id}/cancel`, `POST /hope/submissions/{id}/results` and `POST /hope/admin/regenerate-schedules`. Signing and
  the SFV completion already refused an AI principal (they also ask for a fresh step-up; these seven do not).
- **`GET /api/v1/hope/submissions/{id}/package` refuses an AI principal too (`403`).** It streams the whole package (patient names, dates
  of birth, MBI/SSN) and moves a `packaged` batch to `exported`, so it is a submission operation like the others. A person's download
  is unchanged, and now also records who took the package out (`exported_by_membership_id`, beside `exported_at`, on the first download only).
- **A 422 about an unexpected property no longer names it.** A body with a property the route does not accept (the skip, cancel and results
  bodies reject any other property) answers `422 VALIDATION_FAILED` with the field `(unexpected property)`; it used to name the property
  the client sent, which the idempotency layer then replayed for 24 h.
- **Skip, retry and regenerate-schedules now wait at most 5 seconds for a row lock** and answer the retryable `409 M10_RECORD_BUSY`
  (see "Not covered" in the entry below, which no longer lists them). No request or response shape changes.

## 2026-11-15 — HOPE: a package holds at most 200 records per call; one record without a location no longer blocks the others

**Additive; no request or response shape changes.** Four behaviours of existing HOPE submission routes change, none of them the shape of a request or a response.

- **`POST /api/v1/hope/submissions/assemble` looks at no more than 200 eligible records per call** (oldest signed first), so a package
  holds at most 200 items. The records left over stay eligible: call again to package the next ones. The ordinary `409 CONFLICT`
  ("No signed HOPE assessments are eligible for iQIES package generation") says none are left; the response has no field that says
  more remain, so a client that wants everything repeats the call until it answers that `409`. Records the validator refused on an
  earlier call (an unresolved error finding), or that have no location, sort after the others, so they cannot fill the 200 and hide
  newer records. Before this, one call validated every eligible record while holding its advisory key and a database connection, so
  a large set (for example after cancelling a big batch) made a second assemble answer `409 M10_RECORD_BUSY`.
- **A signed record with no location (no provider entity / location siting, so its validation findings cannot be stored) is skipped**
  by assemble, and the other records are packaged. Before this, such a record made every assemble for its provider entity answer
  `409` (the siting error) and nothing could be packaged. The skip is logged by record id and does not appear in the response; such a
  record stays unpackaged until its siting is repaired. Under the same call the records are also judged again just before the
  package is written, so a record whose correction was signed while the others were being validated is dropped instead of packaged.
- **`GET /api/v1/hope/submissions` answers at most 500 batches, newest first, and the cap keeps the unfinished batches first.** It
  used to answer every batch of the organization in no particular order. The route has no pagination and the response does not say
  when it was cut. An organization has about one batch per provider entity and period, but the worklist reads the whole organization
  (every entity at once), so 500 is not a long history per entity: once 500 newer batches exist, an old `exported` or `rejected`
  batch would have dropped off the worklist while it still needed someone. The cap is therefore applied with the unfinished batches
  first (every status but `accepted`, `accepted_with_warnings` and `cancelled`), newest first within each group, and the answer is
  then put back newest first. A batch that still needs an operator can be cut only when more than 500 of them are unfinished at once. `rejected` and `partially_accepted` batches are never treated as finished (a correction is a NEW batch; the old one stays `rejected`), so an organization with 500 or more of them would lose its newer accepted batches from this list: that needs a filter or pagination on the route, which this change does not add.
- **`POST /api/v1/hope/submissions/{id}/results` no longer stores a blank `iqiesRecordId`.** An empty or whitespace-only id in a report
  row is treated as no id: it is not written on the item or on the assessment (it used to be, and an empty `iqies_record_id` made
  every `IS NULL` eligibility test read the record as already recorded). A non-blank id is stored exactly as sent. The
  recording itself is the same operation, written in bulk (one statement per 500 rows) so a long report holds the batch row lock
  for far less time; its result and error codes are unchanged, with one addition: if the bulk update of the items stores fewer
  items than the report named (an item gone or settled meanwhile), nothing of the import is kept and the call answers `409 CONFLICT`
  ("The batch's items changed while the result was being recorded ..."), naming no id or value: reload the batch, then record the
  result with a NEW `Idempotency-Key` (a plain `409 CONFLICT` is replayed for 24 h on the same key).
- **`reportReference` (`POST .../results`) and `iqiesSubmissionReference` (`POST .../mark-uploaded`) are limited to letters, digits and
  ` . _ : # / -`, and refused when they look like a patient identifier.** Both are operator-typed free text that is stored on the
  batch (the report reference also on every stored report row). A value with any other character, or an empty string, answers
  `422 VALIDATION_FAILED`; a value shaped like a Social Security or Medicare number answers `422 EVIDENCE_LOOKS_LIKE_PHI`. Neither
  422 echoes the value. Omit the field or send `null` for no reference. **Both are now at most 128 characters (they were 500 and
  200) and must not start with a space** (the pattern is `^[A-Za-z0-9._:#/-][A-Za-z0-9 ._:#/-]*$`, so a value of only spaces is
  refused). The service screens them again for a patient identifier, so the check does not depend on the route. On POST the
  idempotency layer replays this `422` for 24 h on the same key, so send a corrected request with a NEW `Idempotency-Key`. The audit
  trail records both references as `<changed>` (as the other free-text and storage columns of a batch).
- **The fields of a CMS result row (`POST .../results`) are checked for format and for patient identifiers; the service checks them
  again, and stores only the rows it rebuilt.** `code`, `itemCode` and `iqiesRecordId` are stored unscrubbed in audit row images and
  (the codes) in the `m10.hope.submission_rejected` payload, so each is ONE word: `^(?:[A-Za-z0-9._:#-]{1,64})?$` (letters, digits,
  `. _ : # -`, a leading `-` allowed as in `-3015`; no space, no slash; empty is a blank cell and names nothing, and is stored as no
  code, not as an empty one). `severity` is one of `fatal`, `error`, `warning` (any case) or empty: the values the import acts on, so
  **a row with any other severity (`Info`, `Informational`) makes the whole import `422`: drop such rows from the report.** The
  closed set is not yet confirmed against real iQIES output: a human should confirm the severity vocabulary with a CMS sample.
  `status`, `result` and `outcome` are phrases CMS wrote ("received, pending review") and keep
  `^(?:[A-Za-z0-9._:#/-][A-Za-z0-9 ._:#/(),;-]*)?$`, at most 64. `assessmentId` is spelt like an id: `^[\s{}0-9A-Fa-f-]{1,64}$` (hex
  digits, hyphens, one pair of braces, blanks around it which are trimmed: a trailing carriage return of a CRLF-split CSV is a blank);
  text outside a uuid's characters is `422`, so a name is never stored or returned (a hex-only word such as "Dee Cafe" fits the
  pattern and can still be stored in the raw report, but no read returns it), and a read of an unmatched row returns the assessment id
  only when it is a uuid. Anything else (markup, quotes, a space-only value, a severity outside the set, a key the row does not
  have, a value that is not a string) is `422 VALIDATION_FAILED`. A value shaped like a Social Security or Medicare number is
  `422 EVIDENCE_LOOKS_LIKE_PHI` with the field `results.<row>.<field>`; for `code`, `itemCode` and `iqiesRecordId` so is a calendar date
  (`YYYY-MM-DD`, `DD.MM.YYYY`, `MM-DD-YYYY` and the like, years 1800 to 2099) and a US phone number (3-3-4 digits, optional leading 1), set
  apart by any of `- . _ : #` (mixed allowed, `1990-05_17`). Compact digit forms (`YYYYMMDD`, `MMDDYYYY`, ten unbroken digits) and
  month-name dates such as `12-Mar-1945` remain a documented residual: nothing tells them from a code. An `iqiesRecordId` that is a
  uuid is not screened (its hex digits resemble an MBI about one time in sixty). An `assessmentId` that is no uuid is screened for an SSN
  or MBI shape and, like a code, for a calendar date or a US phone number, set apart here by hyphens, blanks (a space, a no-break
  space), braces or any run of them (`1990 05 17`, `555 867 5309`, `{555}{867}{5309}`, `555 - 867 - 5309`; `422
  EVIDENCE_LOOKS_LIKE_PHI`, field `results.<row>.assessmentId`; the compact forms stay the documented residual above), and
  `message` (at most 1000) is screened for an SSN or MBI shape: a message that names a patient's number is refused, so remove it
  before recording the report (the field is named, never the value). `status`, `result`, `outcome`, `message` and `reportReference`
  get that SSN and MBI screen only (and the charset where one exists). NUL and an unpaired surrogate in an `assessmentId` or a
  `message` are `422` with the code `INVALID_CHARACTERS`: they were a `500`, because Postgres refuses them in text and jsonb. Any other
  control character (U+0001, U+001B, U+007F to U+009F) is storable and is refused as a policy choice; a message keeps tab, line feed
  and carriage return. **A report is limited to 2000 rows and to 100,000 characters of text the identifier screen reads: every `message`
  and every `assessmentId` that is not a uuid (a uuid is free).** The budget is shared by the messages, so about 660 rows fit at
  150-character messages and about 330 at 300; the 2000-row limit is reachable only when messages average 50 characters. A bigger
  import is `422` with the field `results` and the code `TOO_LARGE`; split it into several imports. **The request body is limited to
  3 MiB** (a report at the 2000-row limit with every field filled is about 1.2 MB, at most about 1.9 MB if every message character
  is escaped): a larger body is `413` with the standard
  error envelope. **A batch holds at most 20,000 recorded report rows across all its imports that settle no item**: an import that
  settles no pending item and would pass that is a static `409 CONFLICT` and records nothing, while an import that settles an item
  (a CMS verdict, which is final) always lands, so a batch's real result can never be refused for the count. A batch's findings read
  returns its newest rows, at most 20,000, oldest first. **A report that was accepted before these rules and is sent again under a new `Idempotency-Key`, and that the stricter rules now
  refuse, answers `422` rather than the batch's idempotent replay** (the rows are checked before the stored report is compared;
  nothing is stored either way, and the same key still replays the stored answer for 24 h). Neither 422 echoes the value. Not closeable here: a single-word surname or a hyphenated name still fits a code, and the
  real iQIES edit-code and record-id formats are unverified, so the code pattern stays permissive within the no-space, no-slash rule.
- **`GET /hope/assessments/{id}/validation` and `GET .../workspace` store nothing for a caller who does not hold `hope.timepoint.write`.** The
  final-mode validation read used to reconcile the stored validation findings, and the workspace open used to rewrite out-of-date
  workflow-control answers, both under no actor. A read-only caller now gets the same findings, and a workspace that equals a writer's
  only for the workflow-control items (A0050, A0250) of a draft no writer has opened yet, shown `answered` with their derived values,
  and the progress counts that follow from them, derived in memory and not stored (the response shape is unchanged); a caller who can
  write persists them as before. On the workspace, the chart refresh and the workflow-control reconcile are done for a writer
  only: a reader sees chart-derived answers as stored and the workflow controls derived on the fly, so a draft that needs a chart
  refresh reads differently for a reader until a writer opens it. A final-mode `GET .../validation` persists the findings only for a
  caller who can write. A signed or inactivated record is shown as stored, for everyone.
- **Assemble now records the batch's items in one statement and re-checks the records after the package is serialised.** The request,
  the response and the codes are unchanged. A record superseded while the package was being serialised is dropped as before (it
  is now judged and share-locked just before the batch is written, not before the serialising, so a correction's signature waits
  for the lock for a much shorter time; the ZIP is built before the lock, and the same re-judgement now also drops a record that
  gained an unresolved error finding since it was validated).
- **A legacy record whose `iqies_record_id` is an empty string is not packaged by assemble**, as the candidate scan of the assemble
  job already did not: a blank id is not "no id". Such a record needs its id cleared (set to `NULL`) to be packaged; the result import no longer
  writes blank ids.

---

## 2026-11-15 — HOPE: record writes wait at most 5 seconds for a lock (`409 M10_RECORD_BUSY`); drafts can no longer be rewritten after signing

**Additive; no request or response shape changes.** A client that already retries a `409` needs nothing, except that, on a POST, PUT or
PATCH, a retry under the SAME `Idempotency-Key` is released only when nothing of the request had committed (see "Retrying a
`409 M10_RECORD_BUSY`" below); a GET carries no key. Requests that used to answer a generic `500` now answer a typed `422`
(`M10_SPEC_NOT_IN_FORCE`, and `POST .../hope/timepoints` with `rfaKind: "04_sfv"`; both below), and skipping a schedule that is no
longer open now answers `409` (below). `POST /hope/submissions/assemble` can now answer `409 M10_RECORD_BUSY` (below).

- **New retryable `409 M10_RECORD_BUSY`.** A HOPE write that has to take a record's row lock (patching answers, opening a draft's
  workspace when its chart prefill or control answers are out of date, the HUV completion date, the review repair, the SFV
  completion, ...) waits at most **5 seconds** for another request that holds it, then answers this code. Most of these locks are new in
  this release: until now only `mark-uploaded` and recording a CMS result locked a submission batch row (with no bound), and the writes
  on assessment and SFV records took no explicit lock and could race (the lost-update fixes below).
  The message reads:
  "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again."
  An earlier step may have been applied because some requests run more than one
  transaction (opening a legacy draft's workspace, signing it, or reading its review first freezes the draft's spec in a transaction of
  its own, which stays committed if a later lock times out). The routes covered take their locks through the HOPE record-lock helpers, and each wait is bounded: the assessment, SFV and
  submission-batch rows (patching answers, updating a draft, the HUV completion date, signing with its own sign lock, the SFV completion's
  SFV and draft locks, cancelling a package, marking it uploaded, recording its CMS result), the advisory keys that serialise recording
  a timepoint, a correction or an inactivation and assembling a package (`POST /hope/submissions/assemble`, one key per provider
  entity, taken as its first statement), the write that freezes a legacy draft's spec when its workspace is opened, the download's
  `packaged` to `exported` write, and the writes that queue behind another request's row lock: the schedule skip
  (`POST /hope/schedules/{id}/skip`), the submission retry (`POST /hope/submissions/{id}/retry`) and the schedule insert of
  `POST /hope/admin/regenerate-schedules` (a concurrent regenerate of the same admission). The bound stays in force for the rest of the transaction that set it, so a lock timeout raised by any
  LATER statement of that same transaction answers the same code, not a `500` (signing a correction or an inactivation also updates the
  corrected original through a trigger; a wait on that row answers it too). **Not covered**: a route that takes none of these locks
  keeps PostgreSQL's default of no timeout, namely the validation-finding writes. The destruction eraser takes its own per-patient
  advisory lock with no timeout. The background jobs have their own bound (below).
- **Retrying a `409 M10_RECORD_BUSY` with an `Idempotency-Key` (POST, PUT and PATCH only).** On those routes the same Idempotency-Key
  may be reused because the key is released. The key is released only when nothing of the request had committed; if an earlier step of the request had
  already committed (the spec freeze above), the 409 is kept and replayed on the same key, so check the current state and send the
  request again with a NEW Idempotency-Key. A GET (`.../workspace`, `.../review`, the package download) carries no Idempotency-Key and is
  never claimed or cached, so it is simply sent again.
- **Signing no longer fails when the draft moved partition under it.** A sign that was waiting for a draft whose HUV completion date
  was changed meanwhile used to fail with the raw serialization error (`409 CONCURRENT_UPDATE`); like the other record locks it now
  retries once on the moved row and then judges that row (status, `ifVersion`).
- **New `422 M10_SPEC_NOT_IN_FORCE`.** No HOPE spec is in force for that target date (the record's: before every loaded spec, or in a
  gap between two). `POST .../hope/timepoints`, opening a legacy draft (`GET .../workspace`, `GET .../review`, `POST .../sign`) and
  `POST .../hope/sfv` (judging the J2052/J2053 values against the triggering assessment's spec) answered a generic `500 INTERNAL_ERROR`
  for this; they now answer this typed `422`, the message names no date and no value, and an administrator fixes it by loading the
  spec version that covers the date. A retry does not help until then. On POST, PUT and PATCH the idempotency layer replays the 422
  for 24 h on the same key, so after an operator loads the spec use a NEW Idempotency-Key. A GET (`.../workspace`, `.../review`)
  carries no key and is never cached, so it is simply sent again once the spec is loaded.
- **`POST /api/v1/hope/schedules/{id}/skip` skips only an `open` schedule.** The write now judges the row it waits for: a schedule a
  sign completed (or the watchdog expired) in the meantime is no longer overwritten with `skipped`, and a schedule that is already
  `completed`, `expired` or `skipped` is no longer rewritten (a second skip of the same schedule included). Each of those answers
  `409 CONFLICT` ("HOPE schedule {id} is {status}; only an open schedule can be skipped"; not the retryable `M10_RECORD_BUSY`, which
  is only the answer when the row's lock was not granted within the bound above); an unknown id is still `404`. A skip that succeeded and is sent again under a NEW
  Idempotency-Key answers this `409`; read the schedule for its current status instead.
- **`POST /api/v1/admissions/{admissionId}/hope/timepoints` with `rfaKind: "04_sfv"` is now `422 VALIDATION_FAILED`** (detail
  `field: "rfaKind"`, `code: "M10_RFA_KIND_NOT_A_TIMEPOINT"`; it used to answer a generic `500`). An SFV completion is inserted signed
  against an open SFV and is recorded with `POST /api/v1/admissions/{admissionId}/hope/sfv`, never as a draft timepoint. The request
  schema still lists `04_sfv` among the `rfaKind` values, so the refusal comes from the service, after the route's permission and
  author checks, not from schema validation.
- **`POST /api/v1/hope/submissions/assemble` can answer `409 M10_RECORD_BUSY`.** It takes an advisory key per provider entity as its
  FIRST statement, before it reads the signed records, so two parallel assembles for one provider entity serialise: the loser waits at
  most 5 seconds and then answers the retryable `409 M10_RECORD_BUSY`, or, once the winner has committed, finds the winner's records
  already packaged (the ordinary `409 CONFLICT`, "No signed HOPE assessments are eligible for iQIES package generation", when that was
  all of them). The lock is taken before anything of the request has committed, so a timeout on it releases the Idempotency-Key and the
  same key may be reused (POST). The other refusals are unchanged: `422` when the submission header or an assessment's payload cannot be
  built (the message names what to set). No assemble cron is scheduled in this build (the runner exists but has no schedule or Worker), so this
  route is the only way a package is assembled.
- **`POST /api/v1/hope/admin/regenerate-schedules` creates only the schedule windows an admission is missing** (stated here because
  its OpenAPI summary used to say "recompute"). An RFA that already has a schedule row in any status (`open`, `completed`, `expired`
  or `skipped`) is left exactly as it is: nothing is recomputed, moved or reopened, so correcting an admission's start-of-care date does
  not move a window that was already written. `scheduleCount` is the admission's total number of schedule rows after the call; it does
  not say how many were created.
- **`422 M10_ADMISSION_PROJECTION_GAP` is raised by two routes:** `POST /admissions/{admissionId}/hope/sfv` (the M6 seam answers but
  cannot say whose admission the path names; third entry below) and `POST /hope/admin/regenerate-schedules` (the admission is
  visible but not sited: no provider entity or location; an admission the caller cannot see, absent or another organization's,
  answers `404` from the scope guard first). A data fault an operator repairs; a plain retry does
  not help. On POST, PUT and PATCH the idempotency layer replays the 422 for 24 h on the same key, so use a NEW Idempotency-Key after an
  operator repairs the admission projection; a GET carries no key (neither route is a GET).
- `GET .../workspace` takes the record's lock only when something has to be written (the chart prefill or the control answers are out
  of date), so a plain open of a draft does not queue behind, or block, the author's autosave or the sign call.
- `PATCH .../answers` now refuses a protected item (`403`), an unknown item (`404`) and an invalid value or an item that is inactive for
  the record's ISC (`422 VALIDATION_FAILED`) **before** it takes any lock (the codes are the ones this route
  already answered; no lock wait comes first). An item that is not applicable under the proposed answers is refused **after** the locks, on the locked row (`422
  VALIDATION_FAILED`, details code `HOPE_ITEM_NOT_APPLICABLE` or `HOPE_ITEM_APPLICABILITY_PENDING`): that check needs the locked row's
  answers, so the request can wait for a lock (and answer `M10_RECORD_BUSY`) before it is refused.
- `PUT /api/v1/hope/assessments/{id}` (update a draft) now judges "is it still a draft" on the locked row and writes only a draft:
  an edit that raced a sign used to overwrite the **signed** record's payload (and its version). It now answers
  `409 M10_CORRECTION_TARGET_NOT_SIGNED` and the signed record is untouched.
- Two parallel `POST .../hope/timepoints` for the same admission and RFA now return the **same** draft (they used to create two), and two
  parallel corrections or inactivations of one signed record yield one `201` and one `409` (they used to fork the chain).
- `PATCH .../huv/completion-date` changes the record's `target_date`, which can move it to another partition of `hope_assessment`. A
  request that was waiting on that row used to fail `40001`; it now retries once on the moved row. **For audit consumers:** such a move
  is recorded as a `hope_assessment` **delete followed by an insert** with the same record id and no `update` row event; read that pair,
  within one transaction, as one update.
- Audit rows: the deadline-override event (`hope.late_deadline_override`) now carries the same request facts as the signature events
  (`actor_user_id`, `request_id`, `source_ip`, sanitised `user_agent`, a server-generated `correlation_id`, the client's own id only in
  `context.clientCorrelationId`). It still carries the typed justification text (`context.justification`, trimmed): the event is
  immutable and is the only record of why the cutoff was lifted. Because that text is free text, `adminOverrideJustification` is now
  screened for patient identifiers on `POST .../hope/timepoints` and `POST .../hope/sfv`: an SSN- or MBI-shaped value is refused with
  `422 EVIDENCE_LOOKS_LIKE_PHI` (field `adminOverrideJustification`, the text never echoed), and the 20 to 1000 character rule is
  measured after the surrounding whitespace is trimmed and every run of whitespace (spaces, tabs, line breaks, no-break and em spaces,
  U+2028 and U+2029) is collapsed to one space (a blank, padded or whitespace-stuffed one is a `422 TOO_SHORT`: a text of 20 characters
  with inner runs of blanks can now fail). The stored text is the trimmed text as typed. A justification that contains control
  characters (other than tab and line breaks), zero-width or other invisible formatting characters, or an unpaired surrogate is also a
  `422` (field `adminOverrideJustification`, code `INVALID_CHARACTERS`): the text is **rejected, never stripped**, so what is stored is
  what the admin typed. User agents also lose lone surrogates, private-use and unassigned code points.
- **First tick after deploy.** The first watchdog run after this release pages once for every Symptom Follow-Up Visit that is already
  overdue, and for every SFV missed or schedule expired in the last 7 days, whose alert was never recorded (the alert used to be
  emitted on the status change only, and a failed emit was lost). That one-time burst is expected; each such alert is then recorded and not
  repeated. An alert whose emit resolves **no recipient** under the organization's current alert rules is recorded once and **not
  retried** (a repeated emit is deduped, so a rule fixed later does not deliver an alert recorded earlier); the tick logs it at error
  level, with the alert id, while the rules still resolve nobody. That count is today's rules, not a record of who the stored alert
  reached. A failed or hung alert emit is now bounded and cannot hide the organization's later alerts while the emitter still answers: each
  emit gets at most 10 seconds, and after three failures in a row the organization's last alert is tried once as a probe. If the probe
  answers, the failures were per alert and every remaining alert is attempted; if it fails too, the organization stops for that tick and
  the alerts not yet tried are planned again by the next tick (for as long as they are inside their 7-day window). A poisoned LAST
  alert defeats the probe: the alerts between wait for the next tick even though the emitter answers. Six timed-out emits of one
  organization still running stop that organization's alert emitting (30 across the whole process stop every organization's) until some
  settle; the cap is checked before every emit, not only at the start, and the tick then reports the organization as failed. The background jobs also bound their database
  lock waits to the same 5 seconds, so one blocked write fails that organization and the run continues with the next. The monthly
  retention scan likewise continues past a failing organization and reports all failures at the end. The two watchdog jobs now run
  with `attempts: 1` (the next 15-minute firing is the
  retry). The repeatable schedules are now registered with `upsertJobScheduler` under one scheduler id per queue, and a repeatable an
  earlier deploy stored under the old registration (with its old attempts) is removed, so `attempts: 1` takes effect at the first boot
  of the new release, with no manual re-registration. During a rolling deploy an old replica can re-create the old repeatable until a new
  replica next boots: a transient double tick, which the watchdogs absorb.

---

## 2026-11-15 — HOPE: a package that was never uploaded to iQIES can be cancelled; new `cancelled` status (breaking for strict status decoders)

**Breaking for a client that decodes a HOPE submission or item `status` with a closed enum.**

- New `POST /api/v1/hope/submissions/{id}/cancel` (`hope.submission.manage`, the same permission and provider-entity scope as `mark-uploaded`). Body
  `{ "reasonCode": "package_lost" | "never_uploaded" | "generated_in_error" | "other" }` and nothing else (a free-text field, an unknown
  code or an empty body is `422`; the reason is a fixed code list so no PHI can ride along). It cancels a batch that was **never marked
  uploaded** (`packaged` or `exported`) and returns the batch (`status: "cancelled"`). Its assessments are packaged again by the next
  assemble, in a **new** batch. A replay on an already cancelled batch answers `200` with the original reason and time. Any other
  status (marked uploaded, result recorded, queued, rejected, ...) is `409 M10_SUBMISSION_CANCEL_NOT_ALLOWED`; another tenant's batch is `404`.
  Cancelling is not an outbox event: nothing downstream saw the package leave. **The package ZIP and every record's XML are deleted with
  the cancel unless a legal hold applies** (they hold the patient's name, date of birth and MBI/SSN, a cancelled package was never
  transmitted so it has no CMS 10-year hold, and no retention scan or eraser reaches it). The delete covers every record of the batch, whatever
  its status, and is a logical deletion (the stored values are set to null: the database frees the space at its next vacuum, and write-ahead
  logs, replicas and backups keep the old bytes until their own retention expires). **A legal hold wins over the delete:** when the organization has an
  active org-wide legal hold, when any record of the batch belongs to a patient a legal hold names, or when the hold list cannot be read
  (it fails closed), the batch is still cancelled but ALL its bytes are kept (the ZIP cannot be partly cleared), and the
  `hope.submission_cancelled` event says why (`bytesKeptReason`: `legal_hold` or `hold_scope_unreadable`, never both; `packageBytesPurged: false`;
  `bytesKeptForLegalHold` is true only for `legal_hold`). **To delete kept bytes after the hold is released, repeat the cancel
  (`POST .../cancel` again, **with a NEW `Idempotency-Key`**: a repeat under the same key replays the first answer for 24 h and never reaches
  the purge):** on an already-cancelled batch that still holds bytes, the hold list is read again, and when nothing holds them
  now they are deleted and a `hope.submission_cancelled` event with `repeatCancel: true` (and `priorStatus: "cancelled"`) is written
  (status, reason, time and actor unchanged); otherwise the repeat answers `200` with the batch unchanged and writes nothing. The
  response and the status flow are the same either way, so the response does not say whether bytes were deleted: the audit event is the
  evidence. This path is API-only (the web client offers Cancel only on a batch that was never uploaded), and releasing a legal hold in M4 does
  not signal M10, so nothing repeats the cancel for you. What stays is the evidence that a package existed: the batch's `packageSha256`,
  `packageSizeBytes` and file name, each record's XML hash and size, and `cancelledAt` / `cancelReasonCode` / who cancelled. Nothing on
  the API returned the bytes of a cancelled batch (the download is `409 M10_SUBMISSION_CANCELLED`), so no response changes shape; the bytes
  of a batch that was marked uploaded, or has a result, are not touched. Cancel, a schedule skip and `regenerate-schedules` each also leave
  an explicit audit event (`hope.submission_cancelled`, `hope.schedule_skipped`, `hope.schedules_regenerated`), and a refused SFV
  completion that names another admission's triggering assessment leaves a `denied` one (`hope.sfv_completion_denied`); each carries ids
  and codes only (the acting membership in `context.byMembershipId`, the session user in `actor_user_id`).
- `status` on a submission is now also `cancelled`, and `status` on a submission item is now also `cancelled` (a rejected item whose
  correction sits only in a cancelled batch reads `correction_in_progress` again, not `resubmitted`). A strict enum decoder breaks on it.
- The submission view carries two new fields, `cancelledAt` (date-time or `null`) and `cancelReasonCode` (one of the four codes or `null`);
  the reading of `submittedAt` and the counts is unchanged.
- A cancelled batch cannot be handed onward: downloading its package (`GET /hope/submissions/{id}/package`), marking it uploaded and
  recording a CMS result against it are all `409 M10_SUBMISSION_CANCELLED`; retry stays `409 M10_SUBMISSION_RETRY_NOT_REJECTED`.
- **Deploy order.** Run migration `1495_m10_hope_submission_cancel` before the new image takes traffic (two enum values, three nullable
  columns and two CHECK constraints on `hope_submission`: `cancel_reason_code` must be one of the four reason codes, and
  `cancelled_at` / `cancelled_by_membership_id` / `cancel_reason_code` are all set on a `cancelled` batch and all null on every other one;
  and two plain, non-concurrent index builds that serve the watchdog alert replay described in the first entry:
  `idx_sfv_org_status_updated` on `symptom_follow_up_visit` and `idx_hope_sched_org_status_updated` on `hope_timepoint_schedule`, each on
  `(organization_id, status, updated_at)`, during which writes to that table wait; additive, `-- compat: expand`). The previous image keeps working on the new schema but does not know the
  cancelled guards above, so do not roll back to it while a cancelled batch exists.

---

## 2026-11-15 — HOPE: signing needs an attestation and a fresh step-up; an SFV completion is bound to its admission (breaking)

**Breaking for any client that signs a HOPE record or completes an SFV.**

- `POST /api/v1/hope/assessments/{id}/sign` — `attestationConfirmed` is now **required** and must be `true` (it was optional and never
  read). It must be the JSON boolean `true`: absent, `false`, `"true"` or `1` is `422 M10_ATTESTATION_REQUIRED` (the service layer refuses
  an unattested signature too), and the draft keeps its status and version. The route also needs a **fresh step-up**
  (`403 STEP_UP_REQUIRED` otherwise; an emergency break-glass grant does not satisfy it) and refuses an AI principal (`403`). A caller
  denied by permission, caseload or discipline gets that denial (`403`/`404`), never a step-up prompt.
- `POST /api/v1/admissions/{admissionId}/hope/sfv` — it inserts an already-signed RFA-04, so it takes the same three requirements
  (`attestationConfirmed: true` required, fresh step-up, no AI principal). `triggeringAssessmentId` is now a **uuid** (a non-uuid is
  `422`, it used to reach the database cast). The completion must also carry the full J2053A-J2053H follow-up content in `data.J.J2053`:
  without it the answer is `422 M10_SFV_COMPLETION_INCOMPLETE`, no record is inserted and the SFV stays open (it used to close the SFV and
  insert the signed RFA-04 with no J2053 behind it). Each J2053 value must also be a code the CMS spec allows for that item (`0`-`3`, `9`;
  the skip-pattern caret and any other string or number are refused with the same `422`, naming the item codes and never the values). If
  the M6 admission seam answers but cannot say whose admission the path names (no summary, another tenant's admission, no patient), the
  answer is `422 M10_ADMISSION_PROJECTION_GAP` (on POST, PUT and PATCH the idempotency layer replays the 422 for 24 h on the same key,
  so use a NEW Idempotency-Key after an operator repairs the admission projection; a GET carries no key, and this route is not a GET).
  If the service's own seam read **fails**, the answer is a retryable `503 DEGRADED` (the
  idempotency layer releases a 5xx key, where a 422 would be replayed for 24 hours). That is the request's SECOND read of the seam: the
  caseload check (`hope.scope`) reads it first and turns a failure there into `404`, so a real outage usually answers `404` before the
  service runs, and the `503` is for a read that fails after the check passed. Neither is any longer `409 M10_SFV_NO_TRIGGER`.
- **A real calendar date-time with an explicit offset** (`YYYY-MM-DDTHH:MM[:SS[.fff]]Z` or `±HH:MM`, the instant's UTC year between 1900
  and 2200) is now required of exactly these four inputs, and nowhere else: `targetDate` on recording a timepoint
  (`POST .../hope/timepoints`) and on completing an SFV (`POST .../hope/sfv`), `submittedAt` on
  `POST /hope/submissions/{id}/mark-uploaded`, and `submissionDate` on `GET /hope/assessments/{id}/validation`. A Feb 30, an Apr 31 or a
  Feb 29 in a common year is `422` (it used to be stored as the next valid date, March 2 / May 1, while J2052B said Feb 30), as are hour
  24, a timestamp with no offset (a server read it in its own local time), a date with no time and a year outside the range.
  `targetDate` on `POST /hope/assessments/{id}/correct` is **required but ignored** (the correction reuses the original record's
  date), so it keeps the route's plain `date-time` format and is not checked more strictly. J2052B is the date as the clinician wrote it in
  their own offset (a `2026-06-01T20:00:00-07:00` visit is June 1); it is written once and a later review never rewrites it, and the
  server now records that as-written date on the completed RFA-04 itself, so even a repair that has to rebuild a missing J2052B uses
  June 1, not the stored instant's UTC day.
- **Additive: the attestation wording version.** Both signing bodies accept an optional `attestationVersion` (string, at most 32
  characters), the wording version the signer was shown. When present and not the current version the answer is
  `409 M10_ATTESTATION_STALE` (the wording changed: reload and review it again), checked before anything is written. A client that sends
  none keeps working unchanged, and its signature is accepted against the server's current wording **without the client having
  named a version**. The audit rows say exactly that: `serverCurrentAttestationVersion` and `serverCurrentAttestationStatementSha256` (the
  SHA-256, hex, of the exact statement text the server held) record the wording at the moment of signing, `attestationVersionSupplied`
  records whether the client named a version, and `suppliedAttestationVersion` is that version when it did. `attestationVersionSupplied: true`
  means the client **named** the current version; a script can send that string, so it proves naming, not that a person read the text.
- **Additive: `GET /api/v1/hope/sfv?triggeringAssessmentId={uuid}`** returns only the SFV that assessment triggered (scope, caseload
  narrowing and read audit are unchanged). An unknown id is an empty list, never a `404`; a non-uuid is `422`.
- Date answers must be real calendar dates wherever the answer engine validates them (`PATCH .../answers`, workflow dates): `2026-02-30`
  and `2026-13-01` are refused with `HOPE_INVALID_ANSWER_VALUE`; a leap day such as `2028-02-29` is accepted.
- **The SFV must belong to the admission in the path.** A `triggeringAssessmentId` that names an SFV of another admission, another
  patient or another organization answers `409 M10_SFV_NO_TRIGGER`, exactly like an id that does not exist (the response carries no
  patient id and never says the SFV is already completed). The signed RFA-04 is written with the SFV's own patient and admission.
  Completing one SFV twice in parallel yields one `201` and one `409 M10_SFV_ALREADY_COMPLETED`. Signing one draft twice in parallel
  yields one `200` and one `409 M10_CORRECTION_TARGET_NOT_SIGNED` (the loser used to get a misleading `404`).
  `POST .../hope/sfv` is rate limited per caller: at most 10 requests a minute per user and 100 a minute per organization (a clinician signing a
  clinical form completes a handful an hour), `429 RATE_LIMITED` with `Retry-After: 60` beyond that. Each refused, unbound completion
  leaves an immutable audit event, so the limit bounds what a caller can add to the trail; the answers within the limit are unchanged.
- `GET /api/v1/admissions/{admissionId}/hope` (workflow state): `sfvs` now lists only the SFVs of **that admission**. It used to list every
  SFV of the patient across all admissions, so a re-admitted patient's capture workspace was handed a previous admission's SFV, which the
  binding above refuses (`409 M10_SFV_NO_TRIGGER`). `summary` counts follow the same scope.
- Both signatures now leave an explicit audit event (`hope.timepoint_signed`, `hope.sfv_completed`) naming the signing membership,
  the attestation (`attestationConfirmed`, always `true`; the wording version and statement hash the server held, and whether the client
  named a version: see above) and the step-up operation the route **required** (`stepUpRequiredOperation`: `hope.timepoint.sign`, `hope.sfv.record`; the row does not claim
  what the session proved), with the HTTP request id, the caller's address and user agent (control characters removed, at most 256
  characters, control, format and line-separator characters removed) in the row's `request_id` / `source_ip` / `user_agent` columns, the
  signing session user in `actor_user_id`, a **server-generated** `correlation_id` (`hope-signature:<assessment id>`; the request's own
  `x-correlation-id`, which a client can choose, is kept only as `context.clientCorrelationId`, a trace hint and not evidence) and
  `actor_kind = user`; the audit resource id and
  the outbox aggregate and payload ids are the stored row id; ids and enums only.

---

## 2026-11-10 — Support-session commands are idempotent and the go-live review shows commercial choices

`POST /api/v1/platform/support-sessions`, `POST /api/v1/platform/support-sessions/{id}/elevate`, and
`POST /api/v1/platform/support-sessions/{id}/close` now require `Idempotency-Key`. Start and elevate are documented as `201` responses.
The service also rejects an elevation by a platform operator other than the one who opened the session.

The admin go-live review now loads the tenant's clearinghouse choice and subscription billing-service mode before enabling approval. A
failed or incomplete commercial read is shown as an error/loading state and keeps approval disabled; it is not presented as “Not chosen”
or “No contract.” The same view lists any onboarding steps the tenant skipped and their recorded rationale.

---

## 2026-11-10 — Help requests are live (slice 7, piece 7B)

The six help-request routes are live over the integrated support-grant operation bundle; their shapes did not change. What an
integrator can rely on:

- **Who may use them.** Only a human on a `staff` session who is an active member of the organization: an AI principal, an auditor or
  family session and ChartWarden's own operators (who are members of every tenant) get `403` on all four tenant routes. Approve and
  close are checked against the member's roles in the service: `org_admin` or `compliance_officer` (close also by the member who
  filed it). There is deliberately no permission key on file, read and close.
- **One live request per tenant account.** A second `POST /tenant/help-requests` while one is `open` or `approved` is
  `409 HELP_REQUEST_ALREADY_OPEN` with the live request's id in `details[0].message` (also for two members filing at once). New
  codes: `409 HELP_REQUEST_NOT_OPEN` (approve of a request that is not open), `409 HELP_REQUEST_ENDED` (an operator's Resolve of one
  that has ended), `422 HELP_REQUEST_STEP_UNKNOWN` (`stepKey` names no onboarding step). A message or note that looks like a
  patient identifier (SSN, MBI, labelled MRN or date of birth shape) is `422 EVIDENCE_LOOKS_LIKE_PHI`; it is never echoed, logged,
  audited or put in an event. Mutating responses are excluded from the idempotency response cache so the text is not copied there.
- **End help is idempotent.** Ending an ended request answers it. An `open` request ends `cancelled`, an `approved` one `resolved`
  (its consent grant is revoked and its open sessions closed). An operator's Resolve of an `open` request (answered without
  consent) also ends it `resolved`, with no grant.
- **It ends and ages out by itself.** A request nobody answered for 14 days is cancelled and one whose consent grant expired or was
  revoked is resolved, both with `closedBy: "system"` (every five minutes). Ninety days after close, the message and operator note
  are nulled at rest; reads project a fixed retention placeholder for the removed message.
- **Operators.** `GET /platform/help-requests` is an audited cross-tenant read; a row's `supportConsentGrantId` is what Start posts.
  A tenant is told `ChartWarden operations`, never an operator id, name or organization.
- **Ledger.** Filing emits `m34.help_request.requested` (ids and the step key only) and, after the filing commits, calls the M36 alert
  seam to raise `tenant.help_requested` to the operators. While the organization is still onboarding the four tenant routes are on
  the pre-activation allowlist.

---

## 2026-11-10 — Operators can revoke a tenant clearinghouse BAA from the onboarding console

The admin onboarding clearinghouse card now exposes the BAA-revocation contract added on 2026-11-09. An authorized operator chooses one
of the closed reason codes and supplies an operator ticket; the console sends no free-text reason and pins the request to the BAA's
`recordedAt`. The card shows current and previous revocation facts. When a tenant re-records the same document that was revoked, verification
requires the operator to review that history and send `acknowledgePreviousRevocation: true` explicitly. Revocation rate limits answer 429;
stale records and the BAA-specific conflict codes are shown as actionable failures and the current record is reloaded.

The hourly M35 repair for “outside means billing mode none” now enumerates every current, not-canceled contract before statement generation.
That includes onboarding and paused tenants, which may not have a statement run and therefore could previously miss the repair.

---

## 2026-11-09 — The tenant's own skip is live (MAC credentials, payer enrollment, DoseSpot kickoff)

`POST /api/v1/tenant/onboarding/{taskId}/skip` no longer answers `501`. The org_admin (the literal `org_admin` role, a fresh step-up,
`Idempotency-Key`, no AI actor) settles MAC credentials, payer enrollment or DoseSpot kickoff with a `skipRationale` of 8-2000
characters, screened for patient identifiers (`422 EVIDENCE_LOOKS_LIKE_PHI`). Any other step, sample data, go-live and a step an operator
added included, is `409 ONBOARDING_STEP_NOT_TENANT_SKIPPABLE`; the order, already-settled and owner rules are the operator skip's
(`409 ONBOARDING_STEP_OUT_OF_ORDER`, `409 ONBOARDING_STEP_ALREADY_SETTLED`, `403 ONBOARDING_STEP_OWNER_MISMATCH`). The tenant's skip is
onboarding data the officer did not see, so it revokes a pending go-live attestation; an operator's skip and the system's do not. The
route is on the not-yet-live organization's allowlist. Re-open of the tenant's
own skip is unchanged (`409 GO_LIVE_PENDING` while an attestation is pending).

The step view reads who skipped from what the skip recorded: `skippedBy` is `tenant`, `platform_ops` or `system` (a skip recorded before
the kind existed reads as `platform_ops`, or `system` for the clearinghouse sync's); `systemSkipped` is unchanged. New `skippedByLabel`
on the tenant surface: `Your organization` for the tenant's own skip, `ChartWarden operations` for an operator's, never a person or a
membership (null on the platform surface and for a system skip). `tenantSkippable` is now true only for the three steps while they are
not done or skipped, no earlier step still locks them (`locked` is false) and, on the tenant surface, only for an org_admin viewer. The platform view lists a tenant's skip with its rationale
(`skippedBy: "tenant"`, `skipRationale`), which the go-live approver reads; the approval guards are unchanged.

---

## 2026-11-09 — A not-yet-live organization reaches its billing steps; `auth/context` says which stage it is in

**Reachable during onboarding.** A session on an organization that is not live yet (go-live not approved) may now call the routes
the clearinghouse and MAC credential steps need, and nothing else beside them: `GET|PUT /api/v1/tenant/clearinghouse`,
`POST /api/v1/tenant/clearinghouse/baa|verify|activate`, `GET /api/v1/subscription/pricing`, `GET /api/v1/billing/mac-credentials`,
`GET /api/v1/billing/mac-credentials/{providerEntityId}`, `POST /api/v1/billing/mac-credentials` and
`POST /api/v1/billing/mac-credentials/{providerEntityId}/test`. Before, each answered `403 ORGANIZATION_ONBOARDING`. Every other
billing route, the support-consent grant and support-session routes, and the DSAR and export downloads still do. Each route keeps
its own guards (permission, fresh step-up, AI-actor block, `Idempotency-Key`).

**Stage signal.** `GET /api/v1/auth/context` gains `organizationStage`: `onboarding` while the organization is confined to the
onboarding routes, `live` otherwise (also for a session that is not bound to an organization yet).

**A billing write voids a pending go-live attestation.** The tenant's own clearinghouse writes (choice, BAA record, verify,
activate) and a MAC credential save now revoke a pending go-live attestation in the write's own transaction, with the reason
`onboarding data changed after attestation`, as the operator's writes and the org-profile write already did. The compliance
officer attests again. A refused write voids nothing.

**MAC credential routes typed.** `POST /api/v1/billing/mac-credentials` now documents its `Idempotency-Key` and optional `If-Match`
(a first save omits it, a change sends the credential's `version`), answers `201` on a first save and `200` on a change, and returns the
credential view (never the secret). `POST /api/v1/billing/mac-credentials/{providerEntityId}/test` documents its `Idempotency-Key`.

**`baaRecordRef` is screened.** The MAC credential's BAA reference (also on the operator's `POST /api/v1/platform/tenants/{orgSlug}/mac-credentials`)
is folded to one line (1-256 characters) and refused with `422 EVIDENCE_LOOKS_LIKE_PHI` when it looks like a social security number or an MBI,
the same screen the clearinghouse BAA reference has; the error never echoes the text, and nothing is stored. A blank value is
`422 MAC_BAA_RECORD_REF_INVALID` (omit the field to leave it unset). `submitterId`, `tradingPartnerId` and `clientId` are identifiers the
MAC issues and are not screened.

**What the MAC "test" says.** `POST /api/v1/billing/mac-credentials/{providerEntityId}/test` checks that the MAC portal for the credential's
jurisdiction answers; it does not validate the credential. It sends no secret, client id or submitter id, and the first real submission is
the first time they are used. The response (`ok`, `method: "portal_health_probe"`, `detail`, `lastSandboxTestAt`) and the credential's
`lastSandboxTestAt` keep their names; their descriptions now say so, and `detail` reads "The MAC portal for this jurisdiction answered. This
does not validate the credential." or "... did not answer." A client should label `lastSandboxTestAt` as the last portal check, not as a
credential test.
---

## 2026-11-09 — Slice 7 (7S): the support session works end to end (support-session reads, the `assist` scope, revoke and close are real)

No path or schema changes; the support-session routes now implement the previously published contract.

**Reads.** `GET /api/v1/tenant/support-sessions` and `.../{id}/events` are RLS-scoped to the organization; another
organization's session is `404`. `GET /api/v1/platform/support-consent-grants` returns grant window, scope and state,
never the grantor or patients in scope.

**Consent.** `scope: "assist"` is non-PHI, lasts 1–24 whole hours, and may be issued only by an `org_admin` or
`compliance_officer`; other scopes keep their permission-and-step-up rule. A non-active organization may issue only
`assist`. Revoking a grant ends every open session on it, records the close, and makes a later start return
`409 SUPPORT_GRANT_INACTIVE`.

**Sessions.** A session is recorded in the consent grant's organization. The operator must be distinct from the grantor
by membership and person. An `assist` session cannot be elevated (`403 SUPPORT_SESSION_NON_PHI`). Manual close is
idempotent and records its ledger, audit, outbox event and grantor alert. Successful non-GET requests under
`/api/v1/platform/tenants/{orgSlug}/` append an `ops.write` ledger row containing only route template, method and status.

---
## 2026-11-09 — Slice 7 contract: help requests, support-session reads and tenant skip

The tenant onboarding wire contract adds tenant help requests and approval, the platform help inbox, tenant-visible
support-session summaries and ledgers, the non-PHI `assist` consent scope, and tenant skip for the three eligible
onboarding steps. Mutating routes require their declared permission, step-up and `Idempotency-Key`; free text is screened
for patient identifiers. Support views never identify the operator.

---

## 2026-11-10 — Operators can revoke a tenant clearinghouse BAA from the onboarding console

The admin onboarding clearinghouse card now exposes the BAA-revocation contract added on 2026-11-09. An authorized operator chooses one
of the closed reason codes and supplies an operator ticket; the console sends no free-text reason and pins the request to the BAA's
`recordedAt`. The card shows current and previous revocation facts. When a tenant re-records the same document that was revoked, verification
requires the operator to review that history and send `acknowledgePreviousRevocation: true` explicitly. Revocation rate limits answer 429;
stale records and the BAA-specific conflict codes are shown as actionable failures and the current record is reloaded.

The hourly M35 repair for “outside means billing mode none” now enumerates every current, not-canceled contract before statement generation.
That includes onboarding and paused tenants, which may not have a statement run and therefore could previously miss the repair.

---

## 2026-11-09 — A paused subscription whose end date has passed is resumed automatically

**Why.** `POST /api/admin/subscriptions/{id}/pause` takes an optional `pausedUntil`. Billing already treated such a pause as over at that
date, but nothing changed the stored status, so the subscription read `paused` (in the admin list, the tenant's own view and the
claims-billing entitlement) until an operator remembered to resume it.

- An hourly sweep (`m35.subscription-pause-resume`) now resumes a subscription that is `paused` with a `pausedUntil` that has passed: `status`
  becomes `active` and `pausedAt` and `pausedUntil` become `null`. Until the sweep runs (normally within the hour; longer if the worker is late
  or skips the row) the stored status still reads `paused`, and billing still counts the pause as over at its date.
- The resume is announced with the same `m35.subscription.resumed` event an operator's resume publishes; `resumedAt` is the pause's end
  date, not the instant the sweep ran. The subscription's status history (`reasonCode` `platform_ops_pause_lapsed`, no actor) is dated at
  that end date too, so a statement for the month the pause ended in does not change when the sweep runs.
- The sweep visits active organizations only, and acts on the organization's newest subscription only. A pause with no end date, a pause
  whose date is ahead, an organization suspension (which pauses with no end date) and an older, superseded subscription are never resumed by
  it. The newest subscription's pause is also left alone when an older subscription of the organization is live.
- When the platform suspends an organization (`m2.organization.suspended`) while an operator's dated pause is still running, the pause
  becomes open-ended: `pausedUntil` is cleared, the subscription's status history gains a `paused` to `paused` row (`reasonCode`
  `org_suspended_by_platform_admin`) dated at the suspension, and `m35.subscription.paused` is published again with `pausedUntil: null`.
  The suspended organization stays unbilled past the old date until it is reactivated.
- `POST /api/v1/subscription/resume` (the tenant's own resume of a non-contracted subscription) now reads the subscription under the same row
  lock, so it cannot announce a resume the sweep has just made, and it answers `409 SUBSCRIPTION_NOT_PAUSED` for a subscription that is
  neither paused nor scheduled to cancel (it used to answer `200`, touch `updatedAt` and publish `m35.subscription.resumed` again).
  Resuming a subscription scheduled to cancel at period end still clears the schedule; it no longer publishes `m35.subscription.resumed`,
  which means "resumed from paused".
- `POST /api/v1/subscription/resume` also answers `409 SUBSCRIPTION_CANCELED` for a canceled subscription (it is final), even when it still
  carries a cancel-at-period-end schedule: it used to answer `200`, flip the schedule and clear the pause columns of a canceled row.
- `POST /api/admin/subscriptions/{id}/resume` and `POST /api/v1/subscription/resume` answer `409 SUBSCRIPTION_OTHER_LIVE_EXISTS` when the
  organization already has another live subscription (an organization can hold one live subscription; a paused one does not count). They used
  to fail with a raw `500` from the database's unique index. The tenant response says to contact support; the operator response says to cancel
  or pause the other subscription by id. The hourly sweep then resumes this one on its next tick (or an operator can resume it again by hand).
  The sweep and organization-activation consumer both leave such a pause alone and raise the same dedicated operator notice (ids only) at most
  once a day per subscription until it is unblocked.
- `POST /api/admin/subscriptions/{id}/resume` answers `409 SUBSCRIPTION_SUPERSEDED` when the requested paused row is older than the
  organization's current subscription. It no longer resurrects an older row behind a newer paused subscription.
- An organization's current subscription is the subscription with the newest `startedAt`; rows that share that instant are ordered by the
  higher `id`. Subscription readers and writers use that ordering, so the tenant's view, the resume routes, the lifecycle consumer and the
  sweep agree on which subscription is current. Contract selection retains its separate `createdAt`, `id` ordering.
- No request or response shape changes.
---

## 2026-11-09 — Onboarding-step catalog writes name their operator; the notice list moves behind the notice key

- `POST /api/v1/platform/onboarding-templates` now requires an `Idempotency-Key` header and a `reason` (8-500 characters after
  whitespace is collapsed, screened for patient identifiers), refuses an AI actor, and leaves one `m34.onboarding_template.upserted`
  audit event naming the operator, the reason and the step. The step catalog is shown in every tenant's wizard.
- `GET /api/v1/platform/tenants/{orgSlug}/notice-filings` is gated on `tenant_notice_filing.withdraw_platform` (the notice-filing
  key), no longer on `tenant_onboarding_data.read_platform`: a notice id with its dates identifies a patient's record. Its audit row
  records the number of NOEs and NOTRs shown, never which.
- `POST /api/v1/platform/tenants/{orgSlug}/go-live/approve` answers `409 GO_LIVE_APPROVER_WROTE_BAA` for an operator who UPLOADED the
  signed agreement of the governing BAA, as well as one who recorded or last changed the record. A document whose content was
  destroyed (a tombstone) no longer counts as a filed agreement.

---

## 2026-11-09 — A platform operator can revoke a tenant's vendor BAA; the tenant can then leave the vendor

**New route.** `POST /api/v1/platform/tenants/{orgSlug}/clearinghouse/baa/revoke` revokes the vendor BAA a tenant recorded for its
own Stedi or Claim.MD account (the vendor ended the agreement). Platform ops only
(`tenant_clearinghouse.revoke_baa_platform`, a fresh step-up, an `Idempotency-Key`; an AI actor is refused). `If-Match` is required
and is the `baa.recordedAt` of the record the operator read (428 without it, 422 if malformed, 409 `CLEARINGHOUSE_BAA_CHANGED` if the
tenant has recorded another since). Not limited to a tenant that is still onboarding. At most 10 revokes per operator (across every
tenant) and 20 in all per ten minutes, then 429.

**No free text.** The body is `{"reasonCode": "vendor_terminated" | "account_closed" | "baa_expired" | "other", "ticketRef":
"SEC-42"}`; the ticket must match `^[A-Z][A-Z0-9]{1,9}-\d{1,8}$`. There is no `reason` field and an unknown field is a 422. Both
values are recorded as given on the tenant's own audit trail, which the tenant can read: the ticket is a reference, never a name.

**What it does.** In one transaction it records who and why, voids the BAA's verification, takes a live config out of `active` (to
`verified`, as re-recording a changed BAA does), writes the audit row and tells the tenant (an alert to its billing, compliance and
org administrators with counts of attempts still in flight, attempts sent in the response window and queued work; and a platform-ops
notice). If the audit row or the announcement cannot be written, nothing is revoked. It never touches the credential. The tenant's
claims, NOE, NOTR and transfer notices are then held, and new claims and eligibility work is refused with 402
`clearinghouse_baa_revoked` (a new reason beside `clearinghouse_not_active`); its acknowledgment and 835 pulls skip, with a once-a-day alert while responses may still be
owed. No new job or tick starts after the commit; a job already past its pre-flight finishes. It is not an expiry: a BAA still never
ends by itself, and no vendor signal reaches ChartWarden.

**New errors, all 409.** `CLEARINGHOUSE_BAA_REVOKED` — on the revoke of a BAA that is already revoked, on `baa/verify`, and on
`POST /api/v1/tenant/clearinghouse/activate` while the revocation stands; `CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED` — on `baa/verify`
of a record whose document is the one that was revoked before, unless the request carries `acknowledgePreviousRevocation: true`;
`CLEARINGHOUSE_BAA_NOT_RECORDED` (existing) when there is no BAA to revoke. 503 `CLEARINGHOUSE_OUTBOX_UNBOUND` if the outbox is not
bound.

**Clearing it.** The tenant clears a revocation by recording a new BAA (`POST /api/v1/tenant/clearinghouse/baa`, which now also
accepts re-recording the identical document; it starts again at unverified) or by leaving the vendor (a vendor change, or
`outside`). A same-vendor mode change keeps it.

**The vendor lock has one exception.** While the BAA is revoked, `PUT /api/v1/tenant/clearinghouse` no longer answers
`CLEARINGHOUSE_VENDOR_LOCKED`: the tenant may change vendor or mode, or switch to `outside`, although production traffic is recent.
Once it has left the revoked vendor, that vendor's attempts no longer lock the next config either (a tenant that picked the wrong next
vendor can move on); the new config's own traffic locks as ever. The operator's PUT gets no such exception (and stays
onboarding-only). Switching away means the old vendor's late acknowledgments and remittances are no longer pulled for the tenant (they
stay with the vendor).

**View.** The clearinghouse view's `baa` object gains `revoked` (boolean), `revokedAt` (timestamp or null) and `revokedReasonCode` (the
closed code or null) on both the tenant and the platform routes; `revokedTicketRef` and `previousRevocation` (`at`, `sameDocument`)
appear on the platform routes only.

---

## 2026-11-09 — The clearinghouse vendor lock has a 90-day window; the platform PUT is rate limited

**Vendor and mode lock.** `PUT /api/v1/tenant/clearinghouse` (and the operator's onboarding PUT) answer 409
`CLEARINGHOUSE_VENDOR_LOCKED` while the organization has any production attempt in flight (reserved) or sent in the last 90 days
(the same window as the credential release). Before, one production claim locked vendor and mode for good; now they can be changed
again only after 90 days with no production attempt. An organization that sends continuously stays locked for as long as it does,
and there is no operator override. Test-mode, released and voided attempts do not lock.

**Rate limit.** `PUT /api/v1/platform/tenants/{orgSlug}/clearinghouse` now allows 10 saves a minute per operator and 30 per
tenant, counted per target tenant, and answers 429 beyond that (503 when the limiter's store is unavailable), as the tenant's own
PUT does: both can answer `CLEARINGHOUSE_ACCOUNT_IN_USE`, which says a credential is held elsewhere.

---

## 2026-11-08 — Releasing a tenant's earlier clearinghouse credentials

**New route.** `POST /api/v1/platform/tenants/{orgSlug}/clearinghouse/credentials/release` frees every clearinghouse credential a
tenant still holds except its current one, so another organization may connect it. Platform ops only
(`tenant_clearinghouse.release_credential_platform`, a fresh step-up, an `Idempotency-Key` and a `reason`; an AI actor is refused).
Refused with 409 `CLEARINGHOUSE_RESPONSES_PENDING` while the tenant has a production submission in flight or sent one in the last
90 days.

**The reason is visible to the tenant.** It is recorded as given on the tenant's own audit trail. Give a ticket reference only,
never the name of the organization an account moved to.

**Saving a credential.** `PUT /api/v1/tenant/clearinghouse` (and the platform operator's onboarding PUT) answer 409
`CLEARINGHOUSE_ACCOUNT_IN_USE` for a credential another organization (or the platform) holds, and 409
`CLEARINGHOUSE_CREDENTIAL_LIMIT` once the organization holds 20 earlier credentials per configured fingerprint key.

---

## 2026-11-08 — Price plan writes are pinned to the version read

**Why.** Two operators editing one draft price plan could overwrite each other's prices, or publish prices the publisher never saw.

- `PUT /api/admin/pricing/plans/{id}`, `POST /api/admin/pricing/plans/{id}/publish`, `POST /api/admin/pricing/plans/{id}/new-version` and
  `POST /api/admin/pricing/plans/{id}/archive` now require `If-Match: "<updatedAt>"`, the plan's `updatedAt` as read (a UTC ISO
  timestamp, quoted, weak-prefixed or bare). Without it the answer is `428 IF_MATCH_REQUIRED`; a value that is not a timestamp is `422`; a plan that changed since it was
  read is `409 PRICING_PLAN_CHANGED`, with `details: [{ field: "currentUpdatedAt", message: <the current updatedAt> }]`. Re-read the plan,
  show the operator what it now says, and send the fresh value; never retry the same body on the new pin without that re-read.
- Nothing is written on any of these refusals.

---

## 2026-11-07 — Skippable steps, the BAA register's governing record, and a proxy's 413

**Why.** The console offered Skip from its own list and guessed which BAA record go-live judges; both now come from the server.

- Each step of `GET /api/v1/platform/tenants/{orgSlug}/onboarding` carries `skippable`: true for a non-canonical catalog step (added by platform ops) and
  for the canonical steps on the server's allowlist (MAC configuration, payer enrollment, the DoseSpot kickoff, sample data). Go-live is
  never skippable.
- `POST /api/v1/platform/onboarding-templates` naming the key of a canonical template is now `409 ONBOARDING_TEMPLATE_CANONICAL` and
  changes nothing (it could overwrite the template and mark it non-canonical). Canonical templates change only by migration.
- `POST /api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/skip` on any other step is `409 ONBOARDING_STEP_NOT_SKIPPABLE` (answered
  before the sequence check, so it is final whatever is still open).
- Each item of `GET /api/v1/platform/baa-register` carries `governing` (true on the one record per tenant that go-live and step 3 judge:
  an undated termination, else the newest dated record, judged over the tenant's whole register whatever the status filter) and
  `documentFiled` (on the governing record, whether its `documentId` is a signed BAA filed for that tenant, false with no link; null on any
  other record, or when no check is configured).
- `POST /api/v1/platform/tenants/{orgSlug}/baa-document` behind the production proxy: the Platform Ops vhost admits bodies up to 16m on this
  route only. A body the proxy refuses is a `413` with an HTML page, not the error envelope (no `code`); treat any `413` with no envelope as
  "too large at the edge". The API's own `413 BAA_UPLOAD_TOO_LARGE` and `422 UPLOAD_SIZE_INVALID` (over 10 MiB decoded) are unchanged.

---

## 2026-11-06 — The operator switches a live tenant off "bills outside ChartWarden"

**Why.** A live tenant that bills outside ChartWarden and holds a contract could not move to a vendor by any route: its own lane is
blocked while a contract exists, and the operator's write was onboarding-only.

- `PUT /api/v1/platform/tenants/{orgSlug}/clearinghouse` that moves a tenant with a contract from `outside` to a vendor (the body names
  `billingServiceMode`) is now accepted for a tenant that is provisioning, onboarding, active, at risk or suspended (an explicit allowlist:
  any other status, such as offboarding, final export pending, retained, being destroyed, destroyed or a sign-up intent, is
  `409 TENANT_NOT_ONBOARDING`, answered before any mode is written). Every other write on that route stays onboarding-only. For a live tenant the mode is dated the 1st of next month,
  like any mode change.
- A body that names `billingServiceMode` also needs the pricing key `subscription.onboard_platform` (`403` with the clearinghouse key alone).
- Everything that can be refused beforehand is refused BEFORE the mode is written (the plan's `422`s, the body's rules, `412`/`428` on the
  If-Match, the switch's locks, a missing credential), so a plain input error writes no mode; a refusal is audited as a failed attempt.
  After the vendor commits, the mode is asked for again (idempotent), and once more if that fails, so a sync that ran in between cannot
  leave the tenant on none. If it still cannot be confirmed the answer carries `billingModeConfirmed: false` (the vendor change stands):
  read the contract and set the mode if it is not the one chosen.
- That early status refusal is audited (`write_refused`) on its own short transaction and fails closed: a refusal that cannot be audited is
  `503 ONBOARDING_AUDIT_UNAVAILABLE` (nothing changed; try again).
- If the vendor's commit fails WITHOUT a definite answer from the database (a lost connection, or a connection-class or server-error
  SQLSTATE), the vendor row is read again before the mode is undone. Not saved: the mode goes back to `none` and the failure is answered.
  Saved: the switch stands and the answer is the row as it is. Unreadable: the mode is left as set and the answer is
  `503 CLEARINGHOUSE_SWITCH_OUTCOME_UNKNOWN` (read the tenant's clearinghouse and contract before changing anything). One narrow case
  cannot be closed from the server: a commit the server gave up on can still land after the read-back saw `outside`, leaving a vendor with
  the mode put back to `none`; after any failed switch, read the tenant's clearinghouse and contract and set the mode if it is not the one chosen.
- A `write_failed` audit row for a commit that failed with no definite answer carries `detail.commitOutcomeUnknown: true`: the write may
  have landed, so the row can sit beside a success row (it is not a rollback).
- A contract that is PAUSED counts: the tenant's own switch is `409 CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR`, the operator names the
  mode, and the outside-means-none rule applies to it. A canceled contract is none. A contract that cannot be read is
  `503 CLEARINGHOUSE_CONTRACT_UNAVAILABLE` on the operator's route too.
- `GET /api/v1/platform/tenants/{orgSlug}/clearinghouse` now carries `hasContract` (a contract that is not canceled): the server's answer to
  whether the switch takes a billing mode, for a screen to use instead of inferring it.

---

## 2026-11-06 — A platform operator uploads a tenant's signed BAA

**Why.** Onboarding step 3 linked the signed agreement by a document id the operator had to be handed. The operator can now upload it.

- New `POST /api/v1/platform/tenants/{orgSlug}/baa-document` (`201`): body `{ contentBase64, mimeType, reason }` and nothing else (a field
  naming a document kind, patient or title is a `422`). Headers: `Idempotency-Key` (required) and a fresh step-up. It answers
  `{ documentId, mimeType, byteSize, sha256Hex }`; link `documentId` on the BAA register row (`POST /api/v1/platform/baa-register` or
  `PATCH /api/v1/platform/baa-register/{id}`) as before.
- The file goes through the documents pipeline: at most 10 MiB decoded (`422 UPLOAD_SIZE_INVALID`; a declared Content-Length over the limit is `413 BAA_UPLOAD_TOO_LARGE`, refused before the body is read), a type allowlist (`415`), magic
  bytes (`415 UPLOAD_CONTENT_MISMATCH`), not base64 (`422`), a scanner refusal (`422 UPLOAD_REJECTED`), no object store configured
  (`503`). The size and digest are the server's.
- New permission `tenant_baa_document.upload_platform`, held by `platform_ops` only. It is not `documents.upload`: it files one document
  kind (`tenant_baa`) for the tenant in the path, and reads or lists no document. Accepted while the tenant is `provisioning`, `onboarding`,
  `active`, `at_risk` or `suspended` (a live tenant's renewal files its new signed copy); any other status is `409 TENANT_NOT_ONBOARDING`.
  A successful upload voids a pending go-live attestation, like any other onboarding data write; for a tenant that is no longer onboarding it
  runs no onboarding pass (no step settles, no `m34.tenant.onboarding_overdue` is emitted).
- The `tenant_baa` kind is not accepted by `POST /api/v1/documents`, and a `tenant_baa` document takes no new version, metadata edit, link or
  tag from any generic documents route (`409 DOCUMENT_IMMUTABLE`).
- `POST /api/v1/platform/baa-register` and `PATCH /api/v1/platform/baa-register/{id}` now require `documentId` to be a signed BAA filed for
  the record's own tenant (the document `tenant_baa` kind, in that organization): another tenant's document, a document of another kind or an
  unknown id is `422 BAA_DOCUMENT_INVALID` (field `documentId`). Wizard step 3
  settles only on a governing BAA whose document verifies the same way.
- **Deploy note: go-live now needs the BAA's document to verify.** The go-live guard (the wizard's approval and the status route's
  `onboarding -> active` activation) treats a governing BAA as executed only when its `document_id` is a `tenant_baa` document of that
  organization, not on the `executed` status alone. A tenant whose governing BAA is `executed` but whose `document_id` does not verify
  (an id pasted before the upload existed, another tenant's document, another kind, or none) is refused go-live (the BAA guard fails)
  until the BAA is relinked to an uploaded document (`PATCH /api/v1/platform/baa-register/{id}`). Before deploying, list the tenants this
  would hold back (an operator's read-only query; nothing is changed by it):

  ```sql
  SELECT a.organization_id, b.tenant_account_id, b.addendum_version, b.document_id
  FROM platform_tenant_baa_record b
  JOIN tenant_account a ON a.id = b.tenant_account_id
  WHERE a.status IN ('provisioning', 'onboarding')
    AND b.baa_status = 'executed'
    AND NOT EXISTS (SELECT 1 FROM document d
                    WHERE d.id = b.document_id AND d.organization_id = b.organization_id AND d.aggregate_type = 'tenant_baa');
  ```

---

## 2026-11-06 — Leaving "bills outside ChartWarden" is a platform operator's switch

**Why.** A tenant that bills outside ChartWarden is on billing service mode `none` (the system sets it). Moving it to a clearinghouse also
means choosing the billing mode the vendor billing calls for, which only an operator may do.

- `PUT /api/v1/tenant/clearinghouse` that moves an organization from `outside` to a vendor now answers
  `409 CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR` while the organization has a pricing contract (`503
  CLEARINGHOUSE_CONTRACT_UNAVAILABLE` if the contract cannot be read). An organization with no contract can still switch.
- `PUT /api/v1/platform/tenants/{orgSlug}/clearinghouse` takes an optional `billingServiceMode` (`none`, `billing_software`,
  `managed_billing`). It is required (`422 BILLING_SERVICE_MODE_REQUIRED`, field `billingServiceMode`) when a tenant with a contract
  leaves `outside` for a vendor, and refused (`422 BILLING_SERVICE_MODE_NOT_APPLICABLE`) on any other write. The mode is set first,
  through the pricing path (dated like any mode change, audited as the operator), then the vendor; if the vendor change fails the mode is
  put back to `none`.
- `PUT /api/v1/platform/tenants/{orgSlug}/subscription/billing-service-mode` for a tenant that bills outside ChartWarden now answers
  `409 BILLING_MODE_REQUIRES_NONE_WHILE_OUTSIDE` for any mode but `none`.

---

## 2026-11-06 — Admin console reads for the tenant onboarding wizard

**Why.** The platform-ops console now runs tenant onboarding as one ordered wizard. It needs a few reads and one relaxed field.

- `GET /api/v1/platform/tenant-invitations` accepts `?tenantAccountId=<uuid>` and returns only that tenant's invitations (a malformed id is a
  `422`). Without it the list is unchanged (every tenant, newest first).
- New `GET /api/v1/platform/tenants/{orgSlug}/members` (platform ops; `tenant_onboarding_data.read_platform`): a tenant's **active** staff
  (`membershipId`, `displayName`, `email`, `roleKeys`) so an operator can pick the compliance officer by name. Read on the tenant's own
  scope and audited. Capped at 500, named members first (by name, then id); `truncated` says when there were more.
- `GET /api/v1/platform/tenants` and `GET /api/v1/platform/tenants/{orgSlug}` carry `onboardingProgress`
  (`doneCount`, `totalCount`, `currentStepKey`, `goLiveState`), judged over the gating wizard steps for every tenant (`live` once
  active, `closed` once past onboarding), read for the requested page only. On the overview the older
  `onboarding.{totalTasks,doneTasks,currentStep}` now follow the same rule: they used to count every task row, retired history
  included, and to name whichever pending row came back first.
- Every wizard step (`GET /api/v1/platform/tenants/{orgSlug}/onboarding`, `GET /api/v1/tenant/onboarding` and the step answers) carries
  `systemSkipped`: true only when the SYSTEM skipped the step because the tenant bills outside ChartWarden. Read it, never the
  `skipRationale` text: a person can type the same words.
- New `GET /api/v1/platform/tenants/{orgSlug}/notice-filings` (platform ops; `tenant_onboarding_data.read_platform`): the NOEs and NOTRs the
  tenant recorded as filed outside ChartWarden, newest record first (`noticeKind`, `noticeId`, `state`, `windowTargetAt`,
  `windowBreachedAt`, `filedOn`, `recordedAt`, `breachStampFromRecord`; no patient, admission or control number). `recordedAt` is the
  `If-Match` the withdraw routes pin; `breachStampFromRecord` says the withdrawal will clear the breach stamp. Not gated on the
  tenant's onboarding status, audited, capped at 200 (`truncated` says when older records exist).
- `POST /api/v1/platform/tenants` no longer requires `planLabel`. The retired flat tier is replaced by the census-banded contract signed at
  onboarding step 2, so an omitted label is stored as `"unassigned"`. A label that is sent must still be `starter`, `standard` or `enterprise`.

---
## 2026-11-09 — More operator free-text fields refuse a patient identifier (`422 EVIDENCE_LOOKS_LIKE_PHI`)

**Why.** Text typed by an operator and stored on a row a tenant can read, or copied into the audit trail, is no place for a patient.
Some fields were screened and some were not.

- These fields are now refused with `422 EVIDENCE_LOOKS_LIKE_PHI` (the same code, status and envelope as the fields that were already
  screened; the error names the field and never echoes the value) when they hold an SSN- or MBI-shaped value:
  - platform: the tenant status-transition, offboard and shred `transitionReason`; the feature-flag `rationale` and every string
    (and object key) inside the flag `value`; the signup-intent rejection `rejectionReason`; the oversized-export `approvalReason`;
    the onboarding-template `title` and `description`; the provision `legalBusinessName` and `firstAdminFullName` and the qualify
    `firstAdminFullName`; the onboarding-data `reason` (it is now screened as typed, before control characters are stripped);
  - tenant: the support-consent grant `grantReason` and `revocationReason`, the tenant-export `justification`, the DSAR request
    `requestorIdentityVerificationEvidence` and the DSAR denial `narrative`, the onboarding org-profile `displayName` (both surfaces);
  - public: the self-serve signup `legalBusinessName`;
  - M35: the refund `reasonDetail`, the refund-denial `reason`, and the plan `name` and `description` (create and update).
  A flag `value` nested deeper than 8 levels, with more than 500 strings or more than 20,000 characters is refused with `422
  VALIDATION_FAILED` rather than left partly unscreened.
- Accepted and NOT stored, so not screened: the DEK-rotation `reason`, the support-session close `note` and the DSAR extension
  `reason`. Closing a session is always permitted and is never refused for its note.
- Wizard and onboarding text that is stored now has zero-width and bidi format characters removed (U+200B, U+200E/F, U+202A-E,
  U+2060-4, U+2066-9, U+FEFF), as it already had control characters; U+200C and U+200D are kept.
- The screen itself is stricter: a nine-digit value is no longer excused because a bare number sits near it ("SSN 900 123 456, 5 days"),
  a long run of spaces between groups no longer hides it, and the refusal text now says to cite documents by title or ticket number and
  that long ids and UUIDs can also trip the check. If a legitimate note is refused, cite the document by its title.
- Not screened, on purpose: an unbroken run of ten to twelve digits (NPIs, phone numbers, ticket numbers).

## 2026-11-09 — New error codes `IDEMPOTENCY_IN_FLIGHT` and `IDEMPOTENCY_KEY_STUCK`

**Why.** A duplicate that arrived while the first request with the same `Idempotency-Key` was still running was answered as a
plain `409` with code `CONFLICT`, the same code a business-rule refusal carries. A client that reads any 409 as "this key is
spent, mint a new one" would then start a second write while the first was still in progress. And if the first request never
finished (its process died after claiming the key), the same answer repeated for 24 hours.

- `IDEMPOTENCY_IN_FLIGHT` replaces `CONFLICT` for that answer. The status is still `409`, the body is the standard error envelope
  (`{ "error": { "code", "message", "correlationId", "documentationUrl" } }`) and the message is unchanged ("Idempotency-Key
  request is still being processed"). Only the `code` value changed, from `CONFLICT`.
- **How to handle it.** Treat it as "your first request is still running": keep the SAME `Idempotency-Key`, wait, and retry with
  the same key and body. Do not mint a new key. Once the first request finishes the retry replays its stored response (or, if
  that request failed before committing anything, runs again). Do this for at most 15 minutes.
- `IDEMPOTENCY_KEY_STUCK` (new, `409`, same envelope) is what a duplicate gets once the first request has been pending for more
  than 15 minutes. Its outcome is UNKNOWN: it may have been applied. **Do not retry with this key, and do not assume it failed.**
  Read the resource to see whether the change is there; use a new key only if it is not. The server never reclaims or re-runs
  the stuck row.
- The other idempotency 409 is unchanged: `IDEMPOTENCY_CONFLICT` is the same key sent with a different body (a client bug; do
  not retry). A business-rule `409 CONFLICT` still means the request itself was refused.
- Clients that matched on `409` + `CONFLICT` for the in-flight situation must match `IDEMPOTENCY_IN_FLIGHT` instead.

## 2026-11-09 — `Idempotency-Key`: a failed request frees its key only when it committed nothing

**Why.** A `5xx`, or the retryable `409 CONCURRENT_UPDATE`, used to be stored as the key's response and replayed for 24 hours,
so a same-key retry never ran the write.

- A `5xx` or `409 CONCURRENT_UPDATE` that provably committed nothing (the request failed before anything became durable) no
  longer consumes the key: retrying with the SAME `Idempotency-Key` runs the request again.
- If any write of the request had already committed, or may have, or was still in progress when the response was built (a
  post-commit step threw, a response failed to serialize, a second transaction deadlocked after the first committed, a
  transaction was still running when a sibling failed), the response is stored and replayed exactly as before: the retry
  answers the same failure and does not write twice. Read the failure, check the resource, and use a new key for a new attempt.
- The `409 CONCURRENT_UPDATE` text no longer says "nothing was saved". It now reads "This step conflicted with another change in
  progress and was not applied. An earlier step of the same request may have been applied: check the current state before
  retrying." The code and the status are unchanged. A request can run several transactions; only the one the database aborted is
  known not to have applied, so check the resource before you retry.
- While the idempotency store is unreachable (the usual companion of a database outage) the key cannot be freed; it stays
  `pending`: a retry answers `409 IDEMPOTENCY_IN_FLIGHT` for up to 15 minutes and `409 IDEMPOTENCY_KEY_STUCK` after that (read the
  resource; do not retry with the key), until the key's 24-hour record expires.
- Not tracked: an effect outside Postgres made directly in a route (an outbound call, a queue or object-store write). Those
  belong behind the outbox (after the commit) by the platform's convention; a route that makes one directly is not covered.
## 2026-11-06 — Tenant lifecycle transitions refuse a stale status

**Why.** Two operator transitions racing on one tenant were last-writer-wins, and the status ledger recorded the wrong
from-status.

- `POST /api/v1/platform/tenants/{orgSlug}/status` and `POST /api/v1/platform/tenants/{orgSlug}/offboard` answer
  `409 TENANT_STATUS_CHANGED` when another transition changed the tenant's status while the request was waiting. Nothing is
  written; reload the tenant and retry.

## 2026-11-05 — Tenant pricing: census-banded plans, a signed contract, and a monthly statement

**Why.** The flat starter / professional / enterprise tiers are retired. A tenant now signs a *census-banded* plan version at
onboarding step 2: the monthly platform fee is the **greater of** (active staff accounts x the per-user price) and the flat fee of the
average-daily-census band the tenant falls in, plus a percentage of net collections when the tenant bills through ChartWarden. The default
bands are five: 0-9, 10-16, 17-25, 26-29 and 30+ patients (`GET /api/admin/pricing/defaults` returns `[0, 10, 17, 26, 30]`). Every
price is a column on a plan version and a published version is frozen, so a tenant keeps the price it signed. Money is integer cents,
rates are basis points.

### 1. What changes for existing clients

- `tier` on plan and subscription responses can now be `census_banded` (the three old values stay readable on existing rows).
- `GET /api/v1/plans` (the tenant catalog) never lists a `census_banded` plan, and the retired flat plans are no longer offered.
- `POST /api/v1/subscription` and `PATCH /api/v1/subscription` answer `404` for a `census_banded` slug (exactly what a plan that does not
  exist answers), and `403 PLAN_ASSIGNED_BY_OPERATIONS` for a tenant that is already on one; so does `POST /api/v1/subscription/cancel`: a
  contracted plan is assigned and ended by ChartWarden operations.
- `POST /api/admin/subscriptions/{id}/pause`, `/resume` and `/cancel` now check the subscription's status under a row lock and answer
  `409` with a stable code instead of acting on any status: `SUBSCRIPTION_NOT_PAUSED` (resume of a subscription that is not paused),
  `SUBSCRIPTION_CANCELED` (pause or cancel of a canceled subscription: it is final), `SUBSCRIPTION_ALREADY_PAUSED` (pause of a paused
  one). A refused request writes nothing. They answer `503 AUDIT_UNBOUND` when the platform audit writer is not bound.
- `POST /api/admin/plans` no longer accepts `tier: census_banded`; `activate`, `deprecate` and `meters` on such a plan answer
  `403 PLAN_ASSIGNED_BY_OPERATIONS` (use the pricing plan editor below), and the legacy edit and activate answer `409` for a retired flat plan.

### 2. New routes

| Route | Who | Guards |
|---|---|---|
| `GET /api/admin/pricing/defaults`, `GET /api/admin/pricing/plans[/{id}]` | platform billing roles | `plan.admin.read` |
| `POST /api/admin/pricing/plans` (draft), `PUT .../{id}` (replace a draft), `POST .../{id}/publish`, `/new-version`, `/archive` | platform billing roles | `plan.admin.write`, step-up, no AI actor, `Idempotency-Key`, body `reason` |
| `GET /api/v1/platform/pricing/plans`, `POST /api/v1/platform/pricing/preview` | platform ops and billing roles | `subscription.pricing_read_platform` |
| `GET /api/v1/platform/tenants/{orgSlug}/subscription` | platform ops and billing roles | `subscription.pricing_read_platform` |
| `POST /api/v1/platform/tenants/{orgSlug}/subscription` | `platform_ops` only | `subscription.onboard_platform`, `tenant_lifecycle_platform_ops`, step-up, no AI actor, `Idempotency-Key`, body `reason` |
| `PUT /api/v1/platform/tenants/{orgSlug}/subscription/billing-service-mode` | `platform_ops` only | same |
| `GET /api/v1/subscription/pricing` | the tenant | `subscription.read` (read-only) |

`POST .../subscription` signs the tenant onto a published plan version in one transaction (subscription, contract, `m35.subscription.created`,
audit row) and then settles the wizard's `plan_contract` step through the wizard. It refuses while an earlier step is unsettled
(`409 ONBOARDING_STEP_OUT_OF_ORDER`) or once the tenant is live (`409 TENANT_NOT_ONBOARDING`). The response carries
`planContractStep.status`: `settled`, `already_settled`, or `pending` (the subscription exists but the step could not be settled; repeat the
same POST to resume, nothing is duplicated).

`billingServiceMode` is `none` (the tenant bills outside ChartWarden, no percentage), `billing_software` or `managed_billing`. The mode is an
effective-dated history: a change takes effect from the **1st of the next month** (the contract view shows it as `pendingBillingServiceMode`), and
immediately only while the tenant is still onboarding with no statement yet. A statement prices with the mode in force for its period, and a
month that is already final can never be re-dated. `GET .../subscription` writes a read-audit row naming the operator.

### 3. The statement

One statement per subscription per UTC month, `draft` while the month is open and `final` once it is closed (five days after month end, so
late-posted remittances dated inside the month still count). It shows both sides of the greater-of rule, the meters it used (active staff
accounts, average daily census with its days observed, net collections with its remittance and pending counts) and the total. The tenant reads
its latest statement on `GET /api/v1/subscription/pricing`; it never carries the ChartWarden operator who signed the contract.

- **Charged from go-live, by days.** The platform fee and the plan minimum are charged by `inputs.daysLive / inputs.adcDaysInPeriod`: the
  subscription's live days in the month, the go-live day (and a cancel day) counting in full, half up to the cent. A go-live on the 1st is a whole
  month; mid-month it is a part. The implementation fee is not prorated. The billing percentage is on what was collected, so it is naturally partial.
- **The minimum floors the platform fee only.** `minimumAdjustmentCents` lifts the (prorated) platform fee to the (prorated) plan minimum; the billing
  fee is added on top.
- **Late money is never lost.** A remittance dated inside a closed month that posts after the month finalized is billed on the next open
  statement as a `priorPeriodLines` entry stored with its source month and that month's own rate (`priorPeriodFeeCents`), and never re-bills the
  closed month. After a subscription ended, a settlement statement (`daysLive` 0) carries it.
- **`needsReview`** marks a statement an operator should look at: its staff count fell back to the unfiltered ledger, or a remittance of the month had
  not posted when it closed. Statements finalize on schedule either way.
- **A canceled or paused subscription** is billed for the days it was live; a month already closed finalizes whatever the subscription has become.
- New fields on the statement and contract views: `inputs.daysLive`, `priorPeriodLines`, `priorPeriodFeeCents`, `needsReview`,
  `pendingBillingServiceMode`; the price preview takes an optional `plannedGoLiveOn` and returns `firstMonthDaysLive` / `firstMonthDaysInPeriod`.

### 4. Later changes to the same release

- `POST /api/v1/subscription/resume` and `POST /api/v1/subscription` answer `403 PLAN_ASSIGNED_BY_OPERATIONS` for a tenant that holds a
  contracted subscription (resuming one, or starting another beside a paused one): a contracted subscription is paused and resumed by ChartWarden
  operations. A pause that was left open (the subscription was resumed by a path that wrote no history row) now closes at the subscription's last
  write instead of billing nothing for ever.
- `POST /api/v1/roles` answers `422 RESERVED_ROLE` for the key `external_auditor` (whatever the category): that role is created by the system on the
  first auditor redemption, and an auditor is only ever attached to it. The database refuses the same for any other writer.
- A platform operator's pause, resume and cancel of a subscription no longer write the operator into the tenant-readable state history (or its
  audit copy); they write a platform-scoped audit row (`m35.subscription.platform_paused|resumed|canceled`) that names the operator and the tenant.
- The onboarding evidence note for step 2 (tenant-readable) no longer carries the order-form reference.
- A settlement statement (`daysLive` 0, carrying late money after a cancel or pause) now finalizes after its grace like any other, and prior-period
  money rides the EARLIEST open statement only (a later draft does not carry it again).
- A closed month with no census day is recorded once per subscription-month for review (platform-only) instead of being logged every hour.
- The staff count excludes an auditor or platform operator by what they WERE when they signed in (recorded in the staff ledger), not by their roles at
  statement time, so changing a member's roles afterwards cannot move them on or off the bill.
- The band is chosen on the exact mean (patient-days against threshold x days), not the rounded ADC shown.
- A published plan version and a final statement cannot be deleted; a tenant reads its contract's identity and start only (not who signed, why, or the
  order form).

---

## 2026-11-05 — Onboarding wizard v2, pre-PR review fixes (go-live integrity)

**Why.** The pre-PR review found ways one operator could open a tenant, or approve a go-live on data nobody had checked. These
change what the existing routes refuse.

- `POST /api/v1/platform/organizations/{organizationId}/status` with `event: "activate"` is refused
  `409 GO_LIVE_TWO_PARTY_REQUIRED` while the organization's tenant is provisioning or onboarding. The organization opens only
  through go-live approval; once the tenant is `active` the same call (a manual retry) is accepted.
- `POST /api/v1/platform/tenants/{orgSlug}/go-live/approve` is **repeatable**: once the tenant is active with an approved
  attestation, repeating it skips the guards and only finishes the organization's activation. A failed first activation now
  answers `503 ORGANIZATION_ACTIVATION_FAILED` (it was a 500) and says to repeat the approval; the daily onboarding sweep also
  opens any organization still `created` whose tenant is active. `409 GO_LIVE_APPROVER_WROTE_BAA` refuses an approver who
  recorded or last changed the governing BAA record.
- **Platform staff cannot be the compliance officer or the go-live attester.** `PUT .../compliance-officer` (both surfaces) and
  `POST /api/v1/tenant/go-live/attest` answer `422 COMPLIANCE_OFFICER_PLATFORM_STAFF` for a member whose user is the acting
  operator, is bound to `platform_alert_audience` in the tenant, or holds a platform role at home; an attestation whose attester
  became staff is `409 GO_LIVE_ATTESTATION_STALE` with detail `attester_platform_staff` at approval.
- **A pending attestation does not survive a data change.** Any write to the onboarding data (provider entities, locations, MAC
  and Medicaid credentials, the org profile, the platform BAA register) revokes a pending go-live attestation in the same
  transaction (`revokeReason`: "onboarding data changed after attestation"); the go-live step returns to pending and the officer
  attests again.
- `POST /api/v1/platform/baa-register` takes an optional `documentId`; an `executed` BAA needs one on create and on update
  (`422 BAA_DOCUMENT_REQUIRED`). A duplicate attestation or duplicate (tenant, addendum) BAA record is `409`, not `500`.
- The platform operator's `reason` on onboarding-data writes is screened for patient identifiers like every wizard free text
  (`422 EVIDENCE_LOOKS_LIKE_PHI`), and a write now runs the onboarding advance after it commits.
- `PATCH /api/v1/orgs/{id}` (the organization's display and legal name) and `POST .../admin/billing/npi-verifications/{id}/verify`
  and `/revoke` (the `ccn_registered` step's data) also revoke a pending go-live attestation in the same transaction, like every
  other write to the onboarding data. An operator's void records their user (a membership is recorded only when it is the
  user's own active membership of that organization).
- A deadlock or serialization failure (`40P01`, `40001`) is `409 CONCURRENT_UPDATE`, not a 500. (Its text was reworded on
  2026-11-09: see the `Idempotency-Key` note above.)
- Go-live approval takes the exclusive onboarding lock before it reads anything and judges the attestation as it is under that
  lock; activation re-checks that the attester is still the assigned officer (`409 GO_LIVE_ATTESTATION_STALE`).
- A session on an organization that is not `active` (created, suspended, closed or unknown) is confined to an exact list of
  onboarding routes; every other route answers `403 ORGANIZATION_ONBOARDING`, including the tenant DSAR / export downloads,
  support-consent grants, the care-team staff list, member credentials and direct user provisioning.

---

## 2026-11-05 — Onboarding wizard v2: ordered steps, attestation with evidence, two-party go-live

**Why.** Tenant onboarding is now an ordered wizard that the server enforces. A step can only be started, completed, attested
or skipped when every earlier required step is done or skipped (`409 ONBOARDING_STEP_OUT_OF_ORDER`). A human marks a step done
by attesting with evidence. Going live takes two people: the tenant's compliance officer attests readiness, then a platform
operator approves; the daily sweep no longer activates a tenant. The Xero and payroll steps are retired.

### 1. `GET /api/v1/platform/tenants/{orgSlug}/onboarding` and `GET /api/v1/tenant/onboarding` — new fields

Both return `steps` (ordered): `key`, `title`, `owner` (`platform_ops` | `org_admin` | `compliance_officer` | `either`),
`sequence`, `optional`, `status`, `locked` and `lockedBy`, `completionMode` (`auto` | `attestation` | `either`), `evidence`
(`note`, `ref`), `attestedBy` (`membershipId`, `actorKind`, `label`, `at`), the due/started/completed times; plus `currentStepKey`,
`goLive` (`state`: `not_ready` | `awaiting_attestation` | `awaiting_approval` | `live` | `closed`, the latest `attestation`
with `expiresAt` while pending, `failedGuards`, `complianceOfficerMembershipId`) and `orgProfile` (`displayName`, `orgTimezone`).
**The tenant read never carries a ChartWarden operator's id.** Where an operator attested a step, approved the go-live or
revoked an attestation, the tenant sees `membershipId: null` / `approvedByMembershipId: null` and a label
(`attestedBy.label`, `approvedByLabel`, `revokedByLabel`: `"ChartWarden operations"`) with the time; reasons are kept. A
revocation by the tenant's own org_admin (see below) keeps its membership id. The platform read is unchanged
(`label` is null there). The tenant read is audited (`onboarding_task` list read). The older names stay as
aliases: `tasks` and `currentStep` (platform), `items`, `nextCursor` and `hasMore` (tenant; the whole wizard is one page).

### 2. New routes

| Route | Who | Guards |
|---|---|---|
| `POST /api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/attest` | platform ops | `onboarding.manage_platform`, step-up, no AI actor; body `evidenceNote`, `evidenceRef?`, `reason` |
| `POST /api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/reopen` | platform ops | same; body `reason` |
| `PATCH /api/v1/platform/tenants/{orgSlug}/org-profile` | platform ops | same; body `displayName?`, `orgTimezone?` (IANA) |
| `PUT /api/v1/platform/tenants/{orgSlug}/compliance-officer` | platform ops | same; body `membershipId` (an active member of that organization holding `compliance_officer`) and `reason` (8 to 500 characters; recorded with the operator in the audit trail) |
| `POST /api/v1/platform/tenants/{orgSlug}/go-live/approve` and `.../revoke` | platform ops | `go_live.approve_platform`, step-up, no AI actor; body `reason` |
| `POST /api/v1/tenant/onboarding/{taskId}/attest` and `/reopen` | the step's owner role | `onboarding.update`; no AI actor; `/reopen` body `reason` (8 to 1000 characters) is now **required** |
| `PATCH /api/v1/tenant/org-profile` | org_admin | `onboarding.manage_own` |
| `PUT /api/v1/tenant/compliance-officer` | org_admin | `onboarding.manage_own`, step-up |
| `POST /api/v1/tenant/go-live/attest` | compliance officer | `go_live.attest`, step-up; body `attestationConfirmed: true` |

`POST /api/v1/tenant/onboarding/{taskId}/complete` is now a deprecated alias of `/attest`: `evidenceNote` is required
(`422 ONBOARDING_EVIDENCE_REQUIRED`) and `completionEvidence` is ignored. `.../skip` now also refuses out of sequence and refuses
the go-live step.

`POST /api/v1/tenant/onboarding/{taskId}/start` and `/block` now also refuse an AI principal.

### 3. Changed behaviour

- **Go-live is two people, not two memberships.** The approver must be a different *person* than the attester: a platform
  operator who is also invited into the tenant as its compliance officer holds two memberships and is still one user, so
  the approval is refused `409 GO_LIVE_SAME_PERSON`. The database enforces it too (both user ids and both membership ids
  differ on an approved row).
- **An attestation must still stand at approval.** Approval is refused `409 GO_LIVE_ATTESTATION_STALE` (the `details` code is
  `attester_not_active`, `attester_not_compliance_officer` or `attester_not_assigned_officer`) when the attester is no longer an
  active member, no longer holds `compliance_officer`, or is no longer the assigned officer; and `409 GO_LIVE_ATTESTATION_EXPIRED`
  once it is more than 14 days old (a new attestation is refused the same way until platform operations revoke the old one).
  Reassigning the compliance officer voids a pending attestation by another officer automatically.
- **Compliance officer assignment** (both surfaces): the member must hold the `compliance_officer` role
  (`422 COMPLIANCE_OFFICER_LACKS_ROLE`); the officer can be changed while the tenant is `onboarding` or `active`, not while it is
  suspended or closing (`409 COMPLIANCE_OFFICER_LOCKED`).
- **Free text** (evidence note and reference, reasons, skip rationale, blocker reason, go-live note) is cleaned: a NUL character is
  `422 ONBOARDING_TEXT_INVALID`, other control characters except tab and newline are stripped, and text that looks like a Social
  Security or Medicare number is `422 EVIDENCE_LOOKS_LIKE_PHI` (the value is never echoed).

- `POST /api/v1/platform/tenants/{orgSlug}/status` with `toStatus: "active"` from `onboarding` is refused
  `409 GO_LIVE_TWO_PARTY_REQUIRED`. Approval refuses `409 GO_LIVE_NOT_ATTESTED` without a pending attestation and
  `409 ACTIVATION_GUARDS_FAILED` (the failed guards are in `details`) when a guard fails at approval time.
- `POST` and `PATCH /api/v1/platform/baa-register` now need `platform_tenant_baa.write_platform` and a fresh step-up.
- Typed refusals: `ONBOARDING_STEP_OUT_OF_ORDER`, `ONBOARDING_STEP_OWNER_MISMATCH` (403), `ONBOARDING_STEP_NOT_ATTESTABLE`,
  `ONBOARDING_STEP_ALREADY_SETTLED`, `ONBOARDING_EVIDENCE_REQUIRED` / `ONBOARDING_EVIDENCE_INVALID`, `TENANT_NOT_ONBOARDING`,
  `GO_LIVE_ALREADY_ATTESTED`, `GO_LIVE_NOT_ASSIGNED_OFFICER` (403), `GO_LIVE_SAME_PERSON`, `GO_LIVE_ATTESTATION_STALE`,
  `GO_LIVE_ATTESTATION_EXPIRED`, `GO_LIVE_PENDING`,
  `INVALID_ORG_TIMEZONE`, `COMPLIANCE_OFFICER_NOT_A_MEMBER`.

---

## 2026-10-06 — Discharge details the Medicare claim needs (place of death, receiving care setting)

**Why.** A Medicare hospice claim must report the patient discharge status (UB-04 FL 17 / 837I CL103,
CMS Pub. 100-04 Ch. 11 §30.3). For a death that status depends on **where the patient died**; for a transfer
to another hospice it depends on **where the receiving hospice cares for the patient**. ChartWarden now records
both and derives the claim codes from them. Requests that do not send them are refused with a specific error,
and records created before this change can be completed afterwards.

| Value sent | Claim patient status |
|---|---|
| `placeOfDeath: "home"` | 40 — expired at home |
| `placeOfDeath: "facility"` | 41 — expired in a medical facility (hospital, SNF, ICF, hospice facility) |
| `placeOfDeath: "unknown"` | 42 — expired, place unknown |
| `receivingCareSetting: "home"` | 50 — discharged to hospice, home |
| `receivingCareSetting: "facility"` | 51 — discharged to hospice, medical facility |

### 1. `POST /api/v1/admissions/{id}/discharge` — `placeOfDeath` required on a death

Required when `reason` is `"death"`; refused for any other reason. HL7-reported deaths that carry no place are
recorded as `"unknown"` (status 42).

```json
{
  "reason": "death",
  "dischargeDate": "2026-10-05",
  "narrative": "Patient expired peacefully with family present.",
  "deathCertifierId": "55555555-5555-4555-8555-555555555555",
  "placeOfDeath": "home"
}
```

Missing or invalid on a death — `422`:

```json
{
  "error": {
    "code": "PLACE_OF_DEATH_REQUIRED",
    "message": "placeOfDeath is required when reason is \"death\". Send \"home\", \"facility\" or \"unknown\": it sets the Medicare claim's patient discharge status (40 expired at home, 41 expired in a medical facility, 42 expired, place unknown — CMS Pub. 100-04 Ch. 11 §30.3). Without it the final claim cannot be billed. \"unknown\" is a valid answer when the place of death is not known.",
    "details": [{ "field": "placeOfDeath", "code": "PLACE_OF_DEATH_REQUIRED", "message": "…same text…" }],
    "correlationId": "…",
    "documentationUrl": "https://docs.chartwarden.app/errors/PLACE_OF_DEATH_REQUIRED"
  }
}
```

Sent with another reason — `422 PLACE_OF_DEATH_NOT_ALLOWED` ("placeOfDeath is only accepted when reason is
\"death\" (it sets claim patient status 40/41/42). Remove the field for any other discharge reason.").

### 2. `POST /api/v1/admissions/{id}/transfer-out` — `receivingCareSetting` required

```json
{
  "direction": "out",
  "effectiveDate": "2026-10-05",
  "otherHospiceName": "Desert Sun Hospice",
  "otherHospiceCcn": "031234",
  "receivingCareSetting": "facility",
  "narrative": "Family relocated; Desert Sun accepted the patient."
}
```

Missing or invalid — `422` (previously a generic `VALIDATION_FAILED`):

```json
{
  "error": {
    "code": "RECEIVING_CARE_SETTING_REQUIRED",
    "message": "receivingCareSetting is required on a transfer-out. Send \"home\" or \"facility\" — where the RECEIVING hospice will care for the patient: it sets the Medicare claim's patient discharge status (50 discharged to hospice, home; 51 discharged to hospice, medical facility — CMS Pub. 100-04 Ch. 11 §30.3). Without it the final claim cannot be billed.",
    "details": [{ "field": "receivingCareSetting", "code": "RECEIVING_CARE_SETTING_REQUIRED", "message": "…same text…" }]
  }
}
```

### 3. New — complete a death or transfer recorded without the detail

Deaths and transfer-outs recorded before this change have neither value, and their final claim is held by the
`bereavement_discharge_legitimacy` validation rule (defect `PLACE_OF_DEATH_MISSING` /
`RECEIVING_CARE_SETTING_MISSING`). Record the value on the existing record:

| Route | Permission | Body |
|---|---|---|
| `GET /api/v1/admissions/{id}/discharge-details` | `admission.read` + admission scope | — returns the completed discharge / transfer-out, their versions, and `missing` (`place_of_death`, `receiving_care_setting` or `null`) |
| `POST /api/v1/discharges/{dischargeEventId}/place-of-death` | `discharge.death` + scope on the owning admission | `{ "placeOfDeath": "facility", "ifVersion": 2 }` |
| `POST /api/v1/transfers/{transferEventId}/receiving-care-setting` | `transfer.out` + scope on the owning admission | `{ "receivingCareSetting": "home", "ifVersion": 0 }` |

Rules:

- `ifVersion` is the record version from the GET. A stale version → `409 VERSION_MISMATCH`.
- Filling a value that was never recorded needs nothing else. Replacing a recorded value needs
  `correctionReason` (20–2000 characters), stored with the change; without it →
  `409 DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED`. Sending the value already recorded is a no-op
  (`changed: false`).
- A place of death only on a **completed death** discharge; a care setting only on a transfer **out** —
  otherwise `422 DISCHARGE_DETAIL_NOT_APPLICABLE`.
- Success returns `{ id, admissionId, detail, value, previousValue, changed, version, claimPatientStatus }`.
  Each change publishes `m6.discharge.details_recorded`; billing re-validates the admission's open claims.

```json
POST /api/v1/discharges/cccccccc-cccc-4ccc-8ccc-cccccccccccc/place-of-death
{ "placeOfDeath": "home", "ifVersion": 3,
  "correctionReason": "Death certificate lists the residence, not the nursing facility." }
```

### 4. Claim reads and Type of Bill

- **Type of Bill.** A stay that ended by **revocation** or **transfer-out** now ends the claim cadence: the last
  claim is final **811/814**, no longer interim **812/813**. Re-validation updates unsubmitted claims
  automatically. Claims already **submitted** with 812/813 need a replacement (TOB 817,
  `POST /api/v1/billing/claims/{id}/replace`) once the MAC has accepted them; a claim in `partial_paid` or
  `denied` cannot be replaced in ChartWarden and must be adjusted with the MAC directly.
- `GET /api/v1/billing/claims` and `GET /api/v1/billing/claims/{id}` items carry an optional `attention` block:
  `stayEnd`, `typeOfBill { stored, derived, changed, remedy }` (`remedy`: `revalidate`,
  `await_acknowledgment`, `replace`, `manual`), `missingDischargeDetail` and `flags`.
- New list filter `?attention=missing_discharge_details` or `?attention=tob_changed` (scans up to 1,000 claims
  per request; follow `nextCursor`).
- Validation results' `remediation` is now stored flat (`summary`, `fixAction`, `fixDeepLink`, `observed`,
  `defects[]`) for both the initial and re-validation runs; older re-validation rows keep the nested
  `{ remediation, observed }` shape.
