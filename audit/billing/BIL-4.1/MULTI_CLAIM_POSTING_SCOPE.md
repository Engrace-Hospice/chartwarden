# Multi-claim scope

`claimmd-era-review.ts` now projects one eligibility result per original 835 claim. It validates stage ownership, tenant/provider, payer identity, the matching decision, the selected M41 submission evidence, and each claim's parsed identity and financial shape. It does not choose the latest corrected attempt. An automatic identity with zero or multiple submitted evidence references is blocked; human-selected evidence must still resolve to the exact owner-reader candidate.

Any blocked or duplicate claim blocks the complete plan. Repeated claim identities, different payer IDs, payer/source mismatch, incomplete claim projection, unsupported content, and missing historical evidence fail closed. No claim or line is posted from a partially eligible ERA.
