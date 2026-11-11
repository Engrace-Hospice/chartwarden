# BIL-3.3 handoff

Do not treat reviewer-confirmed claim identity as payment allocation or authorization to post. BIL-3.3 may design the financial review/approval workspace over a verified claim-level association, while service-line allocation remains blocked until immutable send-time line identity exists.

Required before line-level reconciliation: M23/M41 owner contracts that preserve exact attempt-specific internal line IDs, outbound references and sent facts; 835 reference namespace validation; synthetic repeated-line and correction-chain integration tests; isolated PostgreSQL RLS and concurrency validation. Preserve PLB as provider-level and do not allocate it to claims or lines implicitly.
