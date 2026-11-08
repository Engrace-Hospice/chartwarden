# Pipeline readiness

Each capability is exposed in the existing `/ready` capability map as `disabled`, `ready`, or `degraded`. Readiness does not make a worker run. A disabled capability is reported disabled regardless of Claim.MD credentials. Notice transmission remains disabled unless its explicit flag is set; when set, its capability is `degraded` because external notice support remains unverified.

For an enabled worker, boot composition is the fail-closed gate. Existing code checks the role, account reference/environment, required database clients, account key for external capture, keyring for protected storage, shared rate limiter for API polling, and schema/bootstrap state appropriate to the pipeline. Internal-only ERA resolution/delivery do not require Claim.MD API credentials. A missing optional integration configuration does not prevent unrelated startup while its worker remains disabled.

| Pipeline | Activation control | Main startup preflight |
|---|---|---|
| Response capture | `CLAIMMD_RESPONSE_CAPTURE_ENABLED` | Worker role, Claim.MD binding, DB/platform DB, account/environment, API key, keyring, shared limiter, bootstrapped stream/schema. |
| Identity resolution | `CLAIMMD_IDENTITY_RESOLUTION_ENABLED` | Worker role, configured account/environment, DB/platform DB, keyring and required evidence dependencies/schema. |
| Acknowledgment dispatch | `CLAIMMD_ACK_DISPATCH_ENABLED` or shadow flag | Exclusive mode, worker role, Claim.MD binding, DB/platform DB, account/environment, keyring, bootstrapped response stream/schema/evidence. |
| ERA discovery/capture | `CLAIMMD_ERA_CAPTURE_ENABLED` | Worker role, Claim.MD binding, DB/platform DB, account/environment, API key, keyring, shared limiter, bootstrapped ERA stream/schema. |
| ERA ownership resolution | `CLAIMMD_ERA_OWNERSHIP_RESOLUTION_ENABLED` | Worker role, account/environment, DB/platform DB, keyring, schema and evidence readers. |
| ERA M25 staging delivery | `CLAIMMD_ERA_M25_DELIVERY_ENABLED` | Worker role, account/environment, DB/platform DB, keyring, central and tenant staging schema. |
| Notice transmission | `M23_CLAIMMD_NOTICE_UPLOAD_ENABLED` | Explicitly gated and reported degraded pending vendor confirmation. Keep false. |

`CLAIMMD_ERA_AUTO_POST_ENABLED=true` is prohibited by config and fails closed. Capture, resolver, acknowledgment and delivery flags are independent. `/ready` capabilities report composition state; they are not a comprehensive live probe of all permissions, lease service, rate-limit service or keyring operations. Enabled startup preflights are authoritative for the checks they execute. Full dependency and role proof remains in BIL-1.5B.
