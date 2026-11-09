# Security, approval and RLS

- Tenant review and posting use the M25 stage as the authorization root; the central Claim.MD inbox is not exposed by these routes.
- Historical evidence is queried through M23's and M41's owner-controlled readers. The M41 test uses the NOBYPASSRLS `chartwarden_app` role and tenant/provider/account/environment scope.
- Financial review, `remittance.posting.approve`, `remittance.posting.execute`, and platform recovery remain distinct permissions. Approval and execution routes require separate permission checks, step-up, and idempotency keys. The integrated service test uses distinct approver and executor memberships and proves approval alone creates no M25 advice/outbox effect.
- Cross-tenant and out-of-provider posting-plan, approval, and execution refusals are exercised in the private M25 live suite.
- `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED` defaults false; startup rejects enabling it in production. No production setting was changed.

The API route suite separately exercises Fastify injection and denial of posting operations when the caller has ordinary read/review permissions only. The test does not impersonate a full production identity provider session; production auth/step-up configuration remains deployment-owned.
