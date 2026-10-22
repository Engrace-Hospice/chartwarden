# M36 message destruction: enabling the retention executor (WP 5.6, ADR-0086 proposed)

The weekly `messaging.retention_scan` plans which messages are past their retention window. The **destruction executor** (same tick, after the scan)
can delete them. It deletes PHI, so it ships **off** and needs two switches plus a human approval. Do not enable it before compliance has signed off
ADR-0086 and confirmed the retention periods (care_related 7y, bereavement 7y, operational 1y are engineering placeholders).

## What it will and will not do

- It acts only on a **destruction certificate for `message.<class>` that a person approved** in M4 (`POST /api/v1/destruction-certificates/:id/approve`: permission, step-up, a person other than the scan, a live hold pre-check). The scan opens the certificate; nothing here approves it.
- The certificate's count is a **ceiling**: the scan records the exact destroyable count, every batch spends it, and it never destroys more than is left. An approval is acted on for **35 days** after the scan opened the certificate; an older one is refused (reported as `expiredCertificateIds` in the run row) and the next scan opens a fresh one.
- It never touches a message under an active legal hold (re-checked inside the delete transaction), a message with an attachment object not yet destroyed, or a message a reply still points at.
- It removes at most 500 messages per transaction, 40 batches per certificate per run. A big backlog drains over several weekly runs.
- It closes the certificate (`executed`) only when nothing past the certificate's window remains for the class. A held message keeps it `approved`; releasing the hold lets the next run finish it.
- It does NOT destroy attachment objects (a message that bears one is kept), and `record_count` is spent as batches commit (it shows what is LEFT of the approved count; the original figure is in the certificate's own audit row). Actual counts are in the run's audit rows.

## Prerequisites

1. `DATABASE_DESTRUCTION_URL` is set (a login `IN ROLE chartwarden_destruction`; `bun run db:provision-roles`). Without it the executor is not bound at all.
2. Migration 1156 is applied (redaction table; the executor itself needs no new migration).
3. A compliance officer can approve certificates (M4 `destruction_certificate.approve` permission and step-up).

## Turn it on, in this order

1. **Per tenant: set the ops flag** `messaging.retention_destruction` to true for that organisation (tenant `feature_flag` row; absent = off). The retention screen (`/messaging/governance/retention`) now says "dry-run mode".
2. **Run a dry run first.** After the next Sunday 02:00 UTC scan (or a manual run of the tick), read the `m36.retention_destruction.run` audit row for the org: per approved certificate `eligible`, `heldRefused`, `attachmentPending`, `referenced`, `pastWindowRemaining`. Nothing has been deleted. Compare `eligible` with what the approver was shown.
3. **Only then set `M36_RETENTION_DESTRUCTION_EXECUTE=true`** on the worker process (deployment-wide). From the next run the tenants whose flag is on destroy under their approved certificates; the screen says the mode is live.

## Evidence

Per run and org, in `audit_event` (ids and counts only, retention class `compliance`): `m36.retention_destruction.run`, `.batch_started` (written and committed BEFORE the delete, names the planned ids), `.batch_completed` (planned, destroyed, `refusedAtDelete`, the ids), `.certificate_executed`. Each removed message also writes its own PHI delete audit row. An interrupted batch leaves a `batch_started` row with no `batch_completed`: compare its ids with the `message` table.

## Roll back / stop

- Stop destroying immediately: unset `M36_RETENTION_DESTRUCTION_EXECUTE` (or set it to anything but `true`) and restart the worker; the next run is a dry run. Or turn the tenant flag off for one organisation.
- Destroyed messages cannot be restored (restore from backup only). Move a certificate to `held` in M4 (`POST /destruction-certificates/:id/hold`) to stop it being acted on.
- A legal hold placed at any time protects every not-yet-removed message at once (live criteria, no wait for the overlay).

## Known limits

See ADR-0086 "Implementation status". Notably: attachment-object destruction is not built, and the redaction single-officer fallback is not built.
