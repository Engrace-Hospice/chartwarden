# Duplicate effects and idempotency

- The M25 posting-plan derivation checks existing remittance advice by organization, provider, payer, payment trace, and amount. A prior matching effect produces `POTENTIAL_CROSS_SOURCE_DUPLICATE` and blocks posting; it does not rely on the Claim.MD ERA identifier.
- The shared legacy receive path checks for an existing Claim.MD stage with the same tenant/provider and trace before queuing advice. The live integration test posts a staged Claim.MD ERA, then attempts legacy intake of the same trace. Intake returns `review_required / CLAIMMD_ERA_STAGE_MATCH`, creates no second advice, and leaves the original financial line count at one.
- The live test also repeats execution and runs two concurrent execution calls; only one commits and the other returns `already_posted`.

The legacy-first-to-Claim.MD-plan refusal is enforced by the source query described above but was not separately exercised with a manually posted fixture in this phase. Cross-source duplicate protection is therefore **implemented, with the Claim.MD-first reverse direction runtime-tested**; broader payer-specific identity collisions remain a certification item. Ambiguous identity remains blocked rather than treated as a duplicate success.
