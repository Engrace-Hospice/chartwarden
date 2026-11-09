# Service-line matching

The 835 parser preserves namespaced service-line references, including payer-returned `REF*6R`; M25 now exposes only the `6R` value in its allowlisted detail projection. Each line is reported as `original_line_evidence_unavailable` when such a payer reference exists, or `payer_line_reference_missing` when absent. Neither outcome is a match.

Current 837I line serialization emits LX positions and service facts but no stable internal line-control reference. Claim.MD immutable evidence stores the payload digest and claim-level send identity, not the sent line snapshot. Therefore this phase does not add a guessed LX/code/date/amount join, does not backfill historical claims, and does not claim service-line matching completion. A future vertical slice must capture internal line IDs and emitted line references at the send-evidence reservation boundary for M23/M41, then correlate only a supported returned reference.
