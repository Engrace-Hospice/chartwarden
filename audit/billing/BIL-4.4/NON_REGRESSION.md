# Non-Regression

- Existing Claim.MD full-payment, multi-claim and supported OA partial-payment paths were not given new PLB accounting semantics.
- PLB-bearing plans fail closed; existing whole-ERA all-or-nothing guard remains.
- Legacy manual/SFTP `auto_posted` classification was inspected and not changed; source review found no direct write-off ledger mutation in that classification/override path.
- Review APIs write only the existing append-only nonposting review-decision records. The private live PLB case asserts no remittance advice or posting outbox event is created by review.
- No migration, worker activation, live external request or production change.

The private runner passed: M25 live suite 49/49; manual/SFTP golden suite 7/7; M24 remittance feedback 4/4; M23/M26 CAP consumers 15/15; clearinghouse-pull adapter 15/15. See [private PostgreSQL results](POSTGRESQL_FINANCIAL_TESTS.md).
