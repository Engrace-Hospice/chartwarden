# Financial transaction and idempotency

`postAdvice` currently locks the remittance-advice row, applies its existing cross-source identity check, writes remittance/service-line/adjustment/remark rows and emits posting outcome events inside its own transaction. Its input is a legacy advice ID; it does not accept a stage ID, plan version, approval ID, explicit BIL-3.3 match decision, or caller-owned transaction.

No new Claim.MD posting transaction or idempotency key was added. Existing manual/SFTP logic was not changed. A future implementation must move source/plan/approval validation and these same financial writes into one transaction boundary rather than make sequential route calls.
