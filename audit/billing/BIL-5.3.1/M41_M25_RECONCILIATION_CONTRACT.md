# M41/M25 reconciliation contract

The M41 route `GET /api/v1/billing/commercial/claims/:id/payment-reconciliation` first invokes M41's existing `getClaim` authorization path, which reloads the claim, provider and plan under tenant RLS and verifies patient caseload eligibility. Only then does the route call M25's owner read seam with the server-derived claim UUID, provider UUID and payer ID. The endpoint requires both `commercial_billing.read` and `remittance.read`, plus `commercial_claim_in_billing_caseload` ABAC.

M25 filters by authenticated organization, authorized provider scope, exact M41 claim UUID and exact payer ID. It returns CLP-reported history separately from actual posted line effects. It does not read private M41 tables. The route never accepts a match or amount from the browser.

If the M25 seam is not wired, the M41 service now fails with `M25_REMITTANCE_READER_UNAVAILABLE`; it does not turn missing integration into a misleading zero. Source claims that lack required identity/plan data fail closed. Current charge is labeled mutable; original submitted charge remains unavailable.

The endpoint and schema are emitted through existing TypeBox/OpenAPI/client generation. Integrated HTTP/PostgreSQL authorization remains unverified pending the approved private runner.
