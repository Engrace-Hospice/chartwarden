# M25 Review Authorization

The review endpoints remain:

- `GET /api/v1/remittance/claimmd-era`
- `GET /api/v1/remittance/claimmd-era/:id`

They use the existing `remittance.read` permission prehandler. The M25 service applies `withOrgContext`, filters by the server-derived organization and provider scope before decrypting, and returns a deliberate projection. The projection omits raw 835, ciphertext, TIN, member IDs and free-text remarks; it includes authorized payment/claim/service-line/adjustment summaries. No posting dependency exists in this service.

The new Fastify route tests cover authorized access, missing permission, guessed cross-tenant ID (404), invalid ID, and provider-scope derivation. Service projection tests cover encrypted-detail decryption, protected-field exclusion and duplicate hold eligibility. These are route-level mocked authorization tests, not live RLS certification.

There is no account-wide central inbox route. The route test asserts that only list/detail GET paths are registered and no requeue/posting path is exposed. The recovery service is not reachable through these tenant routes.
