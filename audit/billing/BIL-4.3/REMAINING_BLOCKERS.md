# Remaining blockers

1. There is no effective-dated organization/provider/payer accounting policy contract for contractual adjustment authorization. Consequently, controlled Claim.MD CO write-off is not implemented.
2. PR patient receivable/invoice creation has no payer/coverage/jurisdiction policy binding in this controlled path and remains blocked.
3. PI, multiple CAS combinations, line-level adjustment allocation, PLB, reversals, recoupments and unsupported CARCs remain blocked.
4. Existing legacy M25 CO/PI auto-post classification is broad and does not carry the new plan-bound policy evidence. It was not changed here to avoid altering manual/SFTP semantics; its authorization assumptions need separate source-owner review.
5. Claim.MD controlled posting remains disabled by default and production activation is not authorized.
