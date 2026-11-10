# Cross-source duplicate proof

## Identity and behavior

The Claim.MD posting-plan derivation checks prior M25 advice using the tenant, provider, payer, payment trace and amount. A matching prior financial effect produces `POTENTIAL_CROSS_SOURCE_DUPLICATE`; the Claim.MD stage identifier is not used as the duplicate key. The legacy receive path separately refuses to queue an ERA whose trace already belongs to a staged Claim.MD item. The final financial-effect identity remains protected by M25's existing transactional uniqueness and locks.

## Both arrival orders

- **Claim.MD first:** the private M25 test posts the staged ERA, retries execution, then attempts equivalent legacy intake. Legacy intake returns `review_required / CLAIMMD_ERA_STAGE_MATCH`; no second advice, payment line or posting event is created.
- **Legacy first:** the new private test posts the synthetic ERA through `receiveAdvice` and `postAdvice`, then creates an equivalent owned Claim.MD stage and obtains its plan through the real M41 historical reader. The plan is blocked by `POTENTIAL_CROSS_SOURCE_DUPLICATE`. The original M25 advice and its single payment line/events remain unchanged; stage ownership remains the original tenant/provider and the claim association is not reassigned.

The legacy-first plan is blocked before approval, so no Claim.MD execution is attempted. This is the safe outcome for a duplicate financial effect.
