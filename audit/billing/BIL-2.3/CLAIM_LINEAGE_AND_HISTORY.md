# Claim Lineage and History

Migration `1380_m41_clearinghouse_rejection_corrections.sql` adds optional parent/root claim IDs, correction kind/reason and request key to `commercial_claim`. Composite same-organization foreign keys, a single-child-per-parent index and a tenant-scoped idempotency index protect lineage. The migration trigger requires a rejected parent, unchanged provider/location/patient/plan/service window/filing indicator/clearinghouse route, and the same claim-frequency value as the rejected original. This preserves historical billing identity when a clearinghouse-rejected claim is resubmitted. It prevents lineage mutation and unrelated overlapping claims.

The claim read service returns a bounded related-claim view scoped to the same organization, provider and patient. Submission timeline responses include linked claims; the M41 UI links original and corrected drafts. Existing submission and acknowledgment rows remain attached to their original claim and attempt.

Multiple correction generations can form a chain only after a subsequent child itself has a verified clearinghouse rejection. No payer-assigned claim control number is populated from a file, batch or internal UUID.
