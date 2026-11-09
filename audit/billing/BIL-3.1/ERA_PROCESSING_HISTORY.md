# ERA processing history

`GET /api/v1/remittance/claimmd-era/:id` first loads the stage with organization and provider scope, then projects central records only after exact stage binding is verified against delivery ownership, account/environment, ERA identity and source digest. It uses durable inbox discovery/capture timestamps, resolution history, delivery history and delivery-linked recovery actions. Event rows are ordered by recorded time.

No raw 835, ciphertext, digest, central inbox metadata, credentials, or recovery actor UUID is returned. Recovery actor classification is null because the existing record does not store actor kind. A stage creation entry uses the durable stage `createdAt` and does not infer its original state. Missing or failed history projection is marked unavailable; incomplete durable history is partial. No events are backfilled from current state.
