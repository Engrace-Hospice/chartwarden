# Claim and line identities

## Claim level

The existing stage's verified source outcome is preserved as the sole confirmable identity. The decision refers to the stage, X12 transaction-set control number and claim index; the linked claim UUID comes from that server-owned verified outcome, never a request body. Stage ownership remains the upstream verified organization/provider decision.

Unmatched, ambiguous, conflicting and unsupported outcomes are visible but cannot be manually assigned in this phase. This avoids treating weak candidate evidence as proof.

## Service lines

Parsed ERA lines remain visible in the existing detail view. No WardenX submitted-line snapshot or stable original line reference is available through the reviewed source contracts, so this implementation emits `not_available_without_original_line_reference` and creates no line associations. Similar code/date/amount values are not used to infer identity.

Corrected/replacement claim attempt selection and original payer control-number lineage also remain unimplemented in this phase.
