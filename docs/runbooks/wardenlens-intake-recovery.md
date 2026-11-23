# WardenLens Intake Recovery

This runbook covers M22 WardenLens document processing and its handoff to M6 intake. It does not
authorize direct clinical-table edits, admission activation, HIE work, or bypassing tenant/security
controls.

## Detect

Check the API and worker `/ready` endpoints first. Then inspect the bounded
`chartwarden_bullmq_queue_jobs{queue="m22-doclens-intake",state=...}` metrics for waiting, active,
delayed and failed work. Correlate a batch through structured logs using its correlation ID; do not
copy document text, model output, signed URLs, credentials, patient names, or dates of birth into an
incident ticket.

The authoritative clinical state is the database/API batch and job status. A healthy process log or
an empty queue alone does not prove completion.

## Dependency triage

1. `/ready` must report database, Valkey, object storage and outbox healthy.
2. The worker must be running and connected to `m22-doclens-intake`.
3. Docling `/health` must pass from the worker network.
4. ClamAV must be healthy from the API/worker network. Production requires `CLAMD_HOST`; an absent or
   unavailable scanner is an intake outage, not permission to file unscanned documents.
5. The M32 capability/backend health records for classification, extraction, SUD detection and vision
   verification must be healthy and permitted for the tenant.
6. The tenant's document bucket must exist and the verified upload must be filed.
7. `M35_PSEUDONYM_KEY_KEK` and the platform database credential must be present. The KEK identifier and
   prior key material must remain available across image rebuilds and rotations until every wrapped
   pseudonym key using that epoch has been retired under the approved procedure.

Do not move a batch to a success state by hand. Do not delete a failed queue job before retaining its
bounded state, attempts and correlation ID.

## Recovery by failure

### Worker unavailable

Restore the worker. A queued batch remains `uploaded` and should be claimed without re-upload. Confirm
one job reaches `ready_for_review`; verify no duplicate candidates or writeback events were created.

### Valkey unavailable

Keep intake unavailable while `/ready` reports Valkey failure. Restore Valkey, wait for readiness, and
verify waiting/delayed jobs resume. Do not acknowledge a 202 as completion.

### Docling unavailable

Restore Docling and allow BullMQ's configured exponential retries to run. The batch must not report
`docling_complete` until parsing actually succeeds. If attempts exhaust, retain the failed job and use
the authenticated extraction-run endpoint to request a new idempotent run after the dependency is
healthy.

### Object storage unavailable

Restore storage before retrying. A failed initiation must not have a completed upload ledger row. If
bytes were uploaded but completion failed, use the existing verified-completion path; never insert a
document version directly.

### ClamAV unavailable or infected verdict

Keep uploads unavailable while clamd is unhealthy. Do not switch production to the built-in development
scanner. A verified object with an infected verdict is aborted and all object versions are destroyed;
the user must submit a clean source document. The ledger remains retryable until deletion succeeds, so a
storage cleanup failure must be retried rather than manually marked aborted. Objects above the scanner's
25 MiB contract are refused before the API reads their bytes; do not raise that bound without a reviewed
streaming/quarantine design and matching clamd limits. After restoring clamd, repeat a synthetic clean/EICAR smoke
through the verified-upload API and confirm only the clean file creates M22 document state.

### M35 pseudonym KEK unavailable or mismatched

Treat `PseudonymKekError` as a secret/configuration incident. Do not replace or regenerate the KEK while
wrapped rows from its epoch remain active. Restore the exact approved key material, then allow
`m2.session.created` retries to complete. Confirm an active `patient_pseudonym_key`, matching M35 consumer
receipts, `user_active_period` output, and no pending/failed session-event backlog. Never print the KEK or
wrapped ciphertext into logs or tickets.

### Governed AI unavailable or refusing

Restore or authorize an approved M32 backend/capability. Never route around the capability catalog or
replace a required real-provider check with a mock. A refused/malformed response must not create an
accepted candidate. Resume through the supported extraction endpoint and review all sources again.

### Review/writeback uncertainty

Read the review, decision, provenance and outbox records under the tenant application role. Accepted
writeback is idempotent; redelivery must not duplicate clinical facts. Do not activate the resulting
admission: M6 admission-readiness remains authoritative.

## Close the incident

Record only timestamps, bounded states/counts, correlation IDs and sanitized dependency reasons.
Confirm:

- the queue has no unexpected failed/delayed backlog;
- the batch and review have one coherent terminal state;
- writeback and admission conversion occurred at most once;
- audit and provenance records exist;
- no unauthorized access or cross-tenant visibility occurred;
- `/ready` is healthy and the reviewer can see source-grounded candidates.

Repeat the isolated smoke (`bun run test:intake:production-smoke`,
`bun run test:intake:operational-live`, and `bun run test:e2e:intake-operational`) after a recovery-code
or infrastructure change.
