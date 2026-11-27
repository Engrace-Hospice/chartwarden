# M16 mailing batch files: the retention purge (CW-BR-10, ADR-0109 D10)

A bereavement mailing batch is rendered into ONE PDF holding every recipient's name and mailing address (M22 document, aggregate type
`bereavement_mailing_batch`, org-level, internal-only, seam-only). The daily `m16-mailing-file-purge` job (04:30 UTC) destroys those files once they
are due. It deletes PHI, so **execution is disabled in code**: the job is a dry run that reports what it would destroy and destroys nothing.

> **`M16_MAILING_FILE_PURGE_EXECUTE=true` does nothing today.** The constant `MAILING_FILE_PURGE_EXECUTE_SUPPORTED` (`jobs/index.ts`) is `false`. With the env
> switch on, the worker logs one ids-and-counts line per organisation (`EXECUTE REQUESTED BUT DISABLED IN CODE`), boot logs a warning, and every pass stays a
> dry run. The destroy path is built and proven live (through a test-only dependency), but it is not reachable from the deployment. The next step is a
> follow-up change that binds the §24.2 approved-certificate gate; only that change, once the two decisions below are made, flips the constant.

## Two decisions that are the owner's (execution stays disabled in code until both are implemented)

1. **The retention class and period.** ADR-0004 and M16 spec M16-F01 say the 13-month window is a program window that must not trigger destruction before the
   7-year clinical class; M22 still files the batch under the `bereavement` class (13 months), and this job's default follows that class (396 days after
   the confirmed mailing). Either amend ADR-0004 / M16-F01 to treat the batch as a derived print file (the contact-log activity rows stay as the record of
   care) and keep 396 days, or anchor the period to 7 years. The 30-day (cancelled) and 7-day (unreferenced) periods sit below the class floor and need the
   same decision.
2. **Whether destruction needs an approved M4 destruction certificate.** ARCHITECTURE §24.2 and the ops runbook require an approver record and a
   certificate for any retention-expired PHI class, and architecture wins over module specs and ADRs. The job has NO such gate yet, which is exactly why the
   code refuses to execute. The recommended path is to follow §24.2 (gate each pass on an approved M4 certificate, the M36 pattern). The alternative, one
   compliance-class audit event per destroy plus a recorded divergence in ADR-0109, is only for an owner who accepts the divergence.

## What it destroys, and when (the default)

A file is due only when no hold protects it and one of these holds. All times count from the event, never from the render alone.

| Basis | The file | Due |
| --- | --- | --- |
| `mailed_retention` | named by a run staff confirmed **mailed** | 396 days after `mailed_at` |
| `cancelled_grace` | named by a **cancelled** run | 30 days after the cancel |
| `cancelled_past_floor` | named by a **cancelled** run generated more than 396 days ago | at once (no reprint grace on a batch that old; this is also how a purge-time cancel whose destroy failed retries on the next attempt) |
| `abandoned_ready` | named by a run still **ready** (rendered, never mailed, never cancelled) | 396 days after it was generated; the run is cancelled first |
| `unreferenced` | named by **no run** (a regenerate detached it, a render attempt lost the compare-and-set or abandoned its claim) | 7 days after it was rendered |

396 days is the `bereavement` retention class's 13 months (the program window, `BEREAVEMENT_WINDOW_DAYS`): the floor. A deployment may **lengthen** it
(`M16_MAILING_FILE_RETENTION_DAYS`); a smaller value is raised to the floor, never below it. The default is an engineering placeholder: **compliance
decides the period** (ADR-0109 deferred list). The 7- and 30-day graces are not configurable.

"Destroy" means: every object version in the tenant bucket is deleted (version-aware), then the `document` row becomes `destroyed_tombstone` with no
active version and its in-row cipher shredded. The `document` and `document_version` rows stay (ids, hash, size, the opaque key: no name, no address).
The record that a mailing happened (the contact-log activity rows, kept as a record of care) is not touched.

## What it never touches

- A file under an **M22 hold** (a `document_legal_hold` row not yet released, status `legal_hold`) or of 42 CFR Part 2 class.
- Any file of an organisation with an active **org-wide M4 hold** (one that names no patient, including date-range and resource-kind holds).
- With an active **patient-scoped M4 hold**: a file whose run holds a family of a held patient, and every file **no run names** (its recipients cannot be
  known). Releasing the hold lets the next run take them. A messaging-only hold does not protect these files.
- A file younger than 7 days, a patient's document, any other document type, another tenant's file (the seam and the queries are org-scoped twice).

## Prerequisites

1. The object-store contract (`OBJECT_STORE_*`) is set. Without it the destroy throws before touching anything: the files stay and the job fails loudly.
2. The Valkey connection and the active-organisation enumerator are bound (the M16 crons already need them). The M4 legal-hold read is bound at boot; if
   it were ever missing the job refuses to run (a purge that cannot see a hold must not purge).
3. The mailing program has run long enough to have files; an empty tenant reports `due: 0`.

## Dry-run report procedure (nothing is deleted)

Every pass is a dry run today (execution is disabled in code), with or without the env switch. Deploying this change destroys nothing.

1. After deploy, the worker logs `M16 mailing-file purge (m16-mailing-file-purge, daily 04:30 UTC) constructed` with `mode: "dry_run"`. If
   `M16_MAILING_FILE_PURGE_EXECUTE=true` is set, boot also warns that it is IGNORED.
2. After the next 04:30 UTC tick (or add a one-off job named `m16.mailing-file-purge.cron` to the queue `m16-mailing-file-purge` with your BullMQ tooling),
   read the worker log for `m16.mailing-file-purge: DRY RUN (nothing destroyed)` (or `EXECUTE REQUESTED BUT DISABLED IN CODE ...: DRY RUN` when the env switch is
   on). One line per organisation: `listed`, `due`, `held`, `retained`, `cap`,
   `wouldRefuse` and `documentIdsByBasis` (document ids by rule). Ids and counts only; no name, address or key is logged.
3. Cross-check one organisation with this read-only query (ids and dates only). Run it as an operator session on a replica or with the organisation's
   context; it must not be pasted anywhere with names:

   ```sql
   SELECT d.id AS document_id, d.created_at, d.status AS document_status,
          r.id AS run_id, r.status AS run_status, r.mailed_at, r.generated_at, r.updated_at
     FROM document d
     LEFT JOIN bereavement_mailing_run r ON r.rendered_document_id = d.id
    WHERE d.organization_id = '<org uuid>'
      AND d.aggregate_type = 'bereavement_mailing_batch'
      AND d.patient_id IS NULL
      AND d.status <> 'destroyed_tombstone'
    ORDER BY d.created_at;
   ```
   Apply the table above by hand to a few rows (a mailed run older than 396 days, a cancelled one older than 30, a file with no run older than 7 days)
   and confirm the report's `documentIdsByBasis` lists those ids and no others.
4. Read the active legal holds (M4 `/api/v1/legal-holds`) and confirm every hold you expect is one the job will honour (see "What it never touches").
5. If `wouldRefuse` is `true`, the plan is bigger than the cap (default 50 per organisation per run). Once execution exists such a plan is refused whole. Decide
   deliberately: raise `M16_MAILING_FILE_PURGE_MAX_PER_RUN` to at least `due` only after step 3 matches.

## Apply checklist (for when execution exists: a person ticks every line)

Not applicable today: nothing can be applied until a follow-up change binds the §24.2 certificate gate and flips `MAILING_FILE_PURGE_EXECUTE_SUPPORTED`.

- [ ] The owner decided the two questions above (retention class and period; certificate or audit-event destruction model) and the follow-up that implements
      them is merged (it flips `MAILING_FILE_PURGE_EXECUTE_SUPPORTED`).
- [ ] Compliance signed off the retention default (396 days after the confirmed mailing; 30 days cancelled; 7 days unreferenced) or set a longer
      `M16_MAILING_FILE_RETENTION_DAYS`.
- [ ] The dry-run report of every organisation was read and matches the query in step 3.
- [ ] Active legal holds were reviewed; the files they protect are the ones the report counts as `held`.
- [ ] You know that a pre-purge backup or the second copy can bring a purged file back (see "Known limits"): decide whether a restore needs a re-purge.
- [ ] `M16_MAILING_FILE_PURGE_MAX_PER_RUN` is at least the largest `due` you accept in one run.
- [ ] Set `M16_MAILING_FILE_PURGE_EXECUTE=true` on the **worker** process and restart it. The next tick destroys, at most the cap per organisation.

## After it runs (once execution exists)

- Log: `m16.mailing-file-purge: file destroyed` (organisation, document id, rule, run id) and `org pass done` with `destroyed`, `refused`, `failed`.
- Database: the document is `destroyed_tombstone`, `active_version_id` is null, and `audit_event` holds the `document.update` (and `document_version.update`)
  rows for it (ids, status and timestamps; the title, the object key and the cipher are denylisted).
- A `ready` batch abandoned past the floor is `cancelled` first (its `version` is bumped; it keeps its `rendered_document_id`).
- Re-running over a finished organisation does nothing. An interrupted run resumes: a file whose object delete failed keeps its row and object and is
  retried; a file whose object went but whose row did not is finished by the next run.

## Alarms

A plan larger than the cap, a list too long to evaluate (1000 files), an organisation whose pass threw, or a file whose destroy failed makes the tick
throw. BullMQ retries it three times (5-minute exponential backoff), then the job lands in the failed set and the platform's DLQ-promotion alert
(`DLQ promotion [m16:m16-mailing-file-purge]`, and `OPS_ALERT_WEBHOOK_URL` when set) fires. The message carries counts and the organisation id only. One
organisation's refusal never starves the others in the same tick.

## Stop / roll back

- Stop destroying (once execution exists): unset `M16_MAILING_FILE_PURGE_EXECUTE` (or anything but `true`) and restart the worker; the next tick is a dry run.
  Today nothing destroys, so there is nothing to stop.
- Destroyed files cannot be restored from the application; regenerate a batch from current data. The contact log still records who was mailed.

## Known limits (also in `compliance/controls.yaml`, CW-BR-10)

- **No second-copy tombstone.** `object_destruction_tombstone` (CW-DS-01, migration 1560) cannot name these objects without a change to it: its `basis`
  column admits only `patient_erasure` and only the destruction role may insert. The purge therefore writes no tombstone, so a restore from the second
  copy or a pre-purge backup can bring a purged file back, and `scripts/object-store-copy.ts --tombstones` will not stop it. The document and version
  rows are kept after a purge so a later tombstone backfill can name them. Do not widen that table casually; PR #1215 (migration 1583) changes it too.
- **The hold race is closed for M4 holds, and alarms for the rest.** Every M4 hold application takes the per-org hold advisory lock exclusive; the purge reads the
  M4 scope again right before each destroy under that lock held shared (the M36 protocol), so a hold applied in that instant either is seen or waits. A hold
  that still gets in after the objects were deleted (an M22-level one) leaves the row as it was and the job counts the file as FAILED with an `ALARM` log line,
  so the tick throws and the DLQ alert fires: the bytes are gone and a human must look. Each object delete is bounded to 60 seconds, so a hung object store
  cannot keep the lock (and so a `POST /legal-holds`) waiting: the delete times out, the file counts as failed and the next run retries it.
- **No per-run M4 destruction certificate** (decision 2 above). That is why execution is disabled in code: the destroy path exists and is live-proven, but it
  is not reachable from the deployment until a follow-up binds the §24.2 gate.
- **No state or per-tenant retention extension** is read (`state_retention_override` has no row for this class); lengthen deployment-wide with the env key.
- A decedent's destruction certificate still cannot reach the patient-less batch PDF: that family's name and address stay in it until the retention
  purge removes it.
