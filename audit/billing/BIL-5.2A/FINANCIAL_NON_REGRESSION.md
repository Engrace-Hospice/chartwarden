# Financial non-regression

The change is limited to M23/M41 read projections and Billing Operations presentation. It adds no write route, event, ledger call, retry, posting action, migration, or worker activation. M25 financial review and posting code are unchanged. Medicare posting remains blocked by its existing certification boundary; Claim.MD controlled posting remains default-disabled.

No new private PostgreSQL financial regression suite was run after this read-only change. Existing BIL-5.1 private-runner counts are historical evidence only, not newly executed results.
