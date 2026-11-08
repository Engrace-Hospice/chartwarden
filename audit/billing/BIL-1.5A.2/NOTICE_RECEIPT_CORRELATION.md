# Notice receipt correlation

Claim evidence and notice evidence are separate relations. The Claim.MD candidate resolver reads only claim evidence, so a notice response cannot become a regular claim match through this evidence path. Existing BIL-1.3 application remains claim-oriented. Notice response semantics are not established here; captured messages must remain unresolved/held unless a future notice-specific adapter proves exact account, environment, notice kind, original attempt/evidence, and unambiguous notice-level reference.

Upload response identifiers are appended with the vendor `field`, a namespace (`file`, `batch`, `claim`, `remote_claim`, `pcn`, `message`, or `opaque_submission`), source and timestamp. File or batch scope is not upgraded into notice identity. `clearinghouseSubmissionId` remains opaque. Receipt observations do not mutate NOE/NOTR/transfer status, and no 999/277CA is synthesized from a normalized response.

There is no notice-specific Claim.MD response resolution or acknowledgment transition in this change. This is deliberate and remains an activation blocker.
