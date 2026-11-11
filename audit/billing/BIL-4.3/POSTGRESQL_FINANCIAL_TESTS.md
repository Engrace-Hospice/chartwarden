# PostgreSQL financial tests

Executed with `scripts/test-m25-835-ingestion-private.sh`, which provisions its own disposable PostgreSQL container and real restricted application role. The expanded authenticated integration fixture stages a synthetic $100 charge / $70 payment / $30 CO CAS claim, obtains a server plan, and verifies a policy blocker, preserved CO classification, no `remittance_advice`, and unchanged M41 `submitted` state. It makes no approval or execution request after the plan is blocked.

The latest private run passed the ingestion/plan/approval/execution/RLS integration suite **48/48**, legacy/golden manual 835 suite **21/21**, M23/M24 feedback consumers **7/7**, M26 CAP consumers **4/4**, and synthetic clearinghouse pull suite **15/15**. The private runner created and removed its isolated cluster; no live vendor call or shared database was used.

`bunx vitest run apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-financial-assessment.test.ts` passed **15/15**, including CO policy refusal, unmapped CO CARC, PR/CLP mismatch, PI refusal, and OA preservation. `bunx vitest run apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` passed **10/10**; the blocked CO display is visible and a reviewer without posting permission has no execution button.

There is no PostgreSQL test of authorized CO write-off: no authorized policy operation exists to execute. Unit tests cover PR and PI refusal. The test does not certify production policy, bank settlement, or external payer rules.
