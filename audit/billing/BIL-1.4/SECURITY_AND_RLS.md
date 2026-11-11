# Security and RLS

Migration 1356 gives central stream/inbox tables FORCE RLS and a `claimmd_capture` policy. The tenant role receives no central table grants. `claimmd_era_m25_stage` has FORCE RLS and `app.org_id` policy for `chartwarden_app`; its intended audit trigger records only state, reason, digest, provider/source IDs. `claimmd_capture` has read access to the stage table for duplicate coordination. A real role/RLS migration test was not run.

`claimmd-payload-cipher.ts` provides AES-256-GCM purpose-separated encryption and configurable maximum size; the ERA store encrypts captured data using its ERA purpose and item-specific AAD. BIL-1.1 M23 response cipher reuses this helper with existing response AAD. No key values were printed. Key provisioning, rotation, failure behavior, platform bypass audit, and worker-role reachability remain runtime blockers.

No tenant route or central inbox API was added. The root consumes `CLAIMMD_ERA_CAPTURE_ENABLED` and constructs the worker only when its exact value is `true`; account reference, usage, keyring, platform DB, Claim.MD binding, and shared rate limiter are required. `CLAIMMD_ERA_M25_DELIVERY_ENABLED=true` fails startup because verified staging is not implemented. Auto-post set to true is rejected. No PHI should be logged; live log redaction has not been certified.
