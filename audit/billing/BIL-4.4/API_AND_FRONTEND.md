# API and Frontend

The existing `GET /api/v1/remittance/claimmd-era/:id`, financial-review and posting-plan APIs are reused. TypeBox response schemas include masked provider identity, fiscal period, segment position, occurrence, reason, reference, signed cents, classification, unverified historical reference, unconfigured policy, and no proposed action. OpenAPI and generated client artifacts are synchronized.

The existing Revenue Cycle ERA workspace presents PLB as provider-level adjustments, displays source signs and balance context, explains the absent financial policy, and offers a permission-aware nonposting investigation follow-up. It has no reversal/posting action. An initial PostgreSQL run caught a missing `providerAdjustments` posting-plan response mapping; that mapping was fixed and the live suite rerun successfully.
