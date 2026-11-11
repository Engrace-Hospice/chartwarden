# M23 to M25 ERA Integration

Production composition already combines M23 and M41 owner readers in `apps/backend/src/index.ts`. M25 provides each reader a tenant/provider/account/environment/PCN-scoped query and receives only its safe candidate projection. The new private integration test uses the same composition pattern with actual M23 evidence persisted by `createClaimMdSubmissionEvidenceStore`.

The staged ERA retains its encrypted original parsed transaction and ownership evidence. M25 candidate discovery verifies payer, PCN, service period and source charge against the original attempt. It then exposes the linked claim and module through the existing matching/detail interfaces. A mismatched payer or scope remains nonselectable; no current provider profile or client-supplied claim ID establishes ownership.

The 835 parser's payer-program field is contextual. The M23 source-owner evidence determines the billing module. Medicare ERAs are accepted for review projection, but their financial plan remains blocked independently of payer-neutral parsing.
