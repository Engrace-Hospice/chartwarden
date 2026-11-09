# Legacy non-regression

`postAdvice` still parses through the existing client, uses the payer-specific automatic candidate provider and existing exact/heuristic matching rules, and retains the original row lock, trace identity lock, duplicate check, status update and outbox semantics. The only shared extraction is `postClaimsInTransaction`, which now performs claim rows, adjustments/remarks, denial/PR records, claim outcome events, advice status and `m25.remittance.advice_posted` on the transaction supplied by its caller.

The private M25 835 ingestion suite passed 39/39, including the existing multi-claim rollback, concurrent retry, duplicate identity, manual/SFTP-compatible receipt and post cases. The explicit path is not wired to the Claim.MD staging consumer or any HTTP route.
