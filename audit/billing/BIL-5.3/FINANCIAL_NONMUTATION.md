# Financial nonmutation

The report endpoint is GET-only and calls the M25 read service. The private HTTP/PostgreSQL test compares relevant advice, remittance-line and outbox counts before and after the reads. No posting, matching decision, approval, payment application, write-off, patient invoice, PLB recovery, replay or submission action is invoked. Claim.MD controlled posting remains default-disabled and Medicare posting remains blocked by existing server rules.
