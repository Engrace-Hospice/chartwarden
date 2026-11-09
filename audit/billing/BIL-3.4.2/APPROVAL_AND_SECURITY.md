# Approval and security

No separate posting approval model or API exists after this phase. `remittance.financial_review` records nonposting review dispositions and cannot serve as posting approval. No approval is accepted from the UI. The posting feature remains disabled and no new permission bypass or posting route was introduced.

The required source fix is an M25-owned operation that verifies tenant/provider scope, current stage ownership, matching/review revisions, immutable plan identity, approver and executor permissions, and duplicate-effect identity in the same transaction as the ledger writes.
