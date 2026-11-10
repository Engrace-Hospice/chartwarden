# Worklist source contracts and status presentation

The page consumes only existing owner list APIs:

- M23 `GET /api/v1/billing/claims`
- M24 `GET /api/v1/medicaid-claims`
- M25 `GET /api/v1/remittance/claimmd-era`
- M41 `GET /api/v1/billing/commercial/claims`

Rows retain a namespaced key (`M23:<id>`, etc.), source status and source-specific context. Current action destinations are the M23/M24/M41 claim details and M25 ERA review. M25 list fields provide the stage state, hold reason, duplicate flag, claim count, identity exception count, payer, ERA payment and receive date. M25 detail opens from its authorized list using the `stage` query parameter.

The default attention presentation uses explicit source states and M25 exception facts. It does not create a persistent shared state machine. The page does not currently include M23 notices/DDE in this combined view (they remain in All work), M25 posting-history-derived completion states, account-wide quarantine, or durable recent activity across owners.

Claim source amounts are billed charge; M25 amount is ERA-reported payment. Neither is presented as cash settlement.
