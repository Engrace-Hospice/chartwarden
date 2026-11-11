# HTTP and frontend test results

Executed focused Vitest command:

`bunx vitest run apps/web/src/modules/23-billing-medicare/__tests__/billing-operations.dom.test.tsx apps/web/src/shell/actor-session.test.ts apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts --reporter=dot`

Result: 3 files passed, 30 tests passed. Coverage includes all four source pages, provider scope sent to owner APIs, filtering of location options to authorized session locations, source-denied display, provider switching, M25 location query forwarding, actor-context mapping, ERA navigation and no write call from the workspace.

This DOM suite stubs the owner HTTP responses. It is not an authenticated end-to-end API-to-PostgreSQL test. No live Claim.MD or payer call was made.
