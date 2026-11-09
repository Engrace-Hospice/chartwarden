# BIL-3.5 — Integrated ERA-to-M25 Validation

The narrow BIL-3.4.4 posting path is exercised against an actual M41 historical claim/submission and immutable M23-owned Claim.MD evidence, rather than an injected candidate. This exposed and fixed a source-date representation mismatch: immutable outbound X12 dates are `YYYYMMDD`, while parsed ERA dates are ISO. Matching now compares their normalized dates without rewriting stored evidence.

The private PostgreSQL flow covers a synthetic encrypted stage, financial review, plan, separate approval, explicit M25 execution, duplicate retry, and refusal of a duplicate legacy intake at the Claim.MD stage boundary. The M25 execution remains synchronous through remittance records and transactional outbox; consumers remain separate asynchronous transactions. No live vendor call, production migration, posting activation, commit, or push occurred.

See the linked reports for exact proof and remaining capability limits. Production posting remains disabled.
