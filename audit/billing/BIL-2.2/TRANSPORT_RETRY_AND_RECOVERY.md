# Transport retry and recovery

Migration `1383_m23_claim_submission_dispatch_state.sql` adds `dispatch_state`, `dispatch_token`, `dispatch_started_at`, and a constrained safe reason code to the existing `claim_submission` row. It does not create a second attempt ledger. A DB trigger permits only `pending → sending`, `sending → in_doubt`, and one guarded terminal outcome. Claim identity, organization, provider, control number and reviewed-source fingerprint remain immutable.

Known pre-send failures and explicit portal rejection use terminal attempt outcomes and the existing retry outbox. The retry processor appends a new attempt/control number, carries forward the reviewed fingerprint, and invokes the same split path. A timeout/exception after `sending` is treated as uncertain; there is no automatic second send. Replays cannot acquire the original pending reservation again.

For a configured clearinghouse, a replay may reconcile from the existing attempt store. If status is not provably `sent`, the attempt remains held. The legacy MAC path has no such durable vendor lookup in this service and therefore needs an operator-led reconciliation before any new attempt. No automatic status mapping asserts payer acceptance.

Contract migration sequencing is mandatory: deploy the code which writes dispatch state before applying the trigger change; quiesce old M23 submission workers around the contract step and verify all queued attempts. Rollback is forward-fix only once the new schema is applied; do not restore an old worker binary that can write claim submissions without a dispatch reservation.
