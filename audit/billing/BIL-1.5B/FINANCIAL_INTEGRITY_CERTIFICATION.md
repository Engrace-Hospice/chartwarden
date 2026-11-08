# Financial integrity

`CHARTWARDEN_TEST_DATABASE_URL=... bun run test:m25:835-ingestion:live` passed 35/35 on a private database. It covers actual M25 persistence, concurrent posting retries, independent intake records, tenant/provider scope, reversal, rollback after posting failure, M23 claim bridge, cursor replay, and RLS. Five pre-existing synthetic fixtures needed valid synthetic TRN values because the new conservative financial guard holds a remittance without a verifiable trace. The guard was not weakened.

The common M25 posting boundary uses serialized exact financial identity and holds uncertain cases. Claim.MD ERA delivery stages protected M25 review records but does not call `receiveAdvice` or `postAdvice` (`claimmd-era-delivery.ts`). The focused test verifies the service has no posting port. A successful Claim.MD stage is not an authorization to post.

The live suite proves its implemented scenarios only. It does not establish universal exactly-once accounting for every correction, secondary payment, PLB arrangement, or all cross-source import combinations. Automatic Claim.MD-origin posting remains prohibited.
