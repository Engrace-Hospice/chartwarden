# Backend reporting API

`GET /api/v1/remittance/revenue-cycle-summary` is a read-only M25 owner projection. It uses TypeBox schemas and generated OpenAPI/client contracts. `remittance.read` is required. Authenticated organization context remains server-derived; optional provider selection is constrained by existing provider scope.

The SQL applies provider and UTC receipt-date filters before aggregation and returns bounded aggregate rows rather than loading claims/ERAs into application memory. The requested interval is validated and capped at 366 days. The response exposes exactness only for the M25 advice subset, and explicitly excludes Claim.MD central stages. No mutation endpoint was added.

Posted-amount fields are derived from persisted remittance lines with `match_state='posted'`; the all-posted metric includes posted matched lines from `partial_posted` advice, while the fully-posted-advice metric remains separate. Positive payments only are included; reversal/void CLP status 22 is excluded. No bank settlement or A/R conclusion is implied.
