# M23 notice send paths

## NOE and NOTR

The write service creates the notice attempt with `outcome: queued` and enqueues the job (`routes/write-service-drizzle.ts`, `submitNoe` / `submitNotr`). The outbox bridge in `outbox-consumers/submit-requests.ts` previously used the attempt ID as the queue key but omitted it from payload. It now includes it. `runNoeSubmit` and `runNotrSubmit` fetch the exact attempt and reject a wrong tenant, kind, or notice association before generation/upload. The same attempt ID and index reach the upload port and terminalization.

## Transfer

`services/transfer-notice-service.ts` creates and queues a retry-indexed attempt; `jobs/transfer-notice-jobs.ts` validates its association, builds its specific notice document, and passes its identity to the upload port. Existing status and event transitions remain unchanged.

## Transport and uncertain outcome

The shared transport wrapper reserves typed evidence before network I/O. Existing attempt-store idempotency/reconciliation remains in force. A transport exception is not converted into successful notice evidence; existing job behavior retains its failure/in-doubt handling. No new resend path or notice status transition was added. Any vendor response is recorded as receipt observation under its actual field namespace. Upload success does not run notice acknowledgment application.

Claim.MD notice upload now additionally requires `M23_CLAIMMD_NOTICE_UPLOAD_ENABLED=true`; the default is disabled. That flag is not set in repository configuration by this change.
