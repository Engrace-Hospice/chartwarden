# API and frontend

Existing posting-plan, approval, execution and history routes were extended in the TypeBox schemas and regenerated OpenAPI/client artifacts. Plan responses contain per-claim evidence, amounts, eligibility and blocker codes. Results/history retain the existing single-line field and expose the complete `remittanceLineIds` list for batches.

The existing M25 ERA detail now presents a claim table, total payment and the all-or-nothing rule. It retains one plan-level approval and one explicit execution action; there are no per-claim posting shortcuts. Posted history distinguishes committed M25 records from downstream processing that may still be pending.
