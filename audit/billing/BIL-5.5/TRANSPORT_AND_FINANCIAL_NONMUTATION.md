# Transport and financial nonmutation

The new services perform SELECT-only recovery assessment. They do not call Claim.MD, advance a cursor, change a lease, assign tenant ownership, create an M25 stage, invoke posting, emit financial success events, or touch payment/adjustment records.

`CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED` remains default-disabled and the production startup guard is unchanged.
