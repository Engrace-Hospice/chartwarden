# Authenticated HTTP-to-PostgreSQL posting

The private M25 integration test mounts the existing `registerClaimMdEraReviewRoutes` and injects HTTP requests into the actual Fastify routes. The registered service is backed by the NOBYPASSRLS `chartwarden_app` connection, the encrypted staged ERA, the M41 historical submission reader, and the real M25 posting service.

The sequence covers financial review, eligible plan retrieval, separate approval, explicit execution, persisted posting/history reads, concurrent execution and idempotent retry. Review completion and approval are asserted to create no M25 financial effect. The persisted result has one remittance line and one each of the `claim_paid` and `advice_posted` outbox events.

Route permissions and `requireStepUp` are the production guard implementations. The integration test's authentication hook maps named synthetic principals to server-owned test identity facts; the real deployment identity provider and its session issuance are not certified here. A test-local `step_up_recent` predicate reads only the hook-provided server context. The test denies approval to a financial reviewer and matching reviewer, denies execution to an approver, denies an executor without approval and a stale-step-up executor, and rejects another tenant's stage. The service path separately rejects provider-scope mismatch, stale plans and disabled capability.

This verifies application authorization and database RLS in the integration harness. It does not certify an external IdP or production role assignment.
