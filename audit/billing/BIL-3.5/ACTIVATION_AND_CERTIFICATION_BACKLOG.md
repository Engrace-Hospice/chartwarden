# Activation and certification backlog

Development integration does not waive these gates:

- Certify real Claim.MD provider/account mappings, M41 payer routing, ERA variations, controlled-test authorization, and worker operations.
- Establish production finance approver/executor role governance, step-up and separation-of-duties policy, feature-gate activation authorization, release/migration sequencing, recovery procedures, monitoring and alerting.
- Independently test legacy/manual/SFTP-first duplicate cases and broader cross-source payment identity evidence.
- Reconcile external settlement/bank data if required by operations; M25 posting alone is not cash settlement.
- Expand only through separately specified and tested accounting work: multiple claims, partial/zero payments, CAS, PLB, denials, service-line adjudication, reversals/recoupments, Medicare and other payers.
- Resolve historical line-evidence gaps where future accounting rules require line-level identity.

Claim.MD workers and automatic posting remain disabled in production. No external vendor call or production activation occurred in BIL-3.5.
