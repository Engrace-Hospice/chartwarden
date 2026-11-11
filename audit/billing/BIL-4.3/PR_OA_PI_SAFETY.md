# PR, OA and PI safety

- **PR:** CAS facts are retained and classified as payer-reported patient responsibility. For the narrow claim case, CAS PR must match CLP05 in cents. The controlled path returns `PATIENT_RESPONSIBILITY_POLICY_UNAVAILABLE`; it creates no patient invoice or patient-responsibility ledger entry.
- **OA:** the BIL-4.2 single claim-level OA residual remains the only supported partial case. It must equal charge minus paid and remain `flagged_review`; it is not recast as CO or PR.
- **PI:** source facts are classified as payer-initiated reduction and blocked with `PAYER_REDUCTION_POLICY_UNAVAILABLE`; no write-off or transfer is performed.
- **CR/unknown:** retained when available and blocked as unsupported correction/reversal or unsupported source classification.

CAS PR and CLP05 are not added together. Unsupported combinations, mismatches, multiple CAS, line-level CAS, PLB, reversals, recoupments and incomplete source facts block the whole controlled plan.
