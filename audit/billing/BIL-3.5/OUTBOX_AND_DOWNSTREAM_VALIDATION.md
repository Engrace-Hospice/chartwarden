# Outbox and downstream consumers

M25 inserts the remittance records and catalog-validated outbox events in its posting transaction. The private live suite verifies exactly one `m25.remittance.claim_paid` and one `m25.remittance.advice_posted` event for the committed supported posting, and that injected failure before commit leaves no financial rows or success events.

The private runner separately runs the existing M23/M24 remittance-feedback consumer suite and M26 CAP consumer suite. These prove the relevant consumer handling against synthetic outbox scenarios; they do not make downstream processing part of the M25 transaction. A committed outbox event is not itself proof that each production consumer has completed. Deployment-time crash/restart monitoring and operational alerting remain open activation work.
