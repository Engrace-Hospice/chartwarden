# Observability source of truth

| Fact | Durable source | Exposure |
|---|---|---|
| Tenant stage state and timestamp | `claimmd_era_m25_stage` | Authorized tenant/provider |
| Response polling attempt/success/failure | `claimmd_response_stream` via M23 operational reader | Platform only |
| ERA polling attempt/success/failure | `claimmd_era_stream` via M25 ERA store | Platform only |
| Capture/resolution/delivery backlog | Central inbox/resolution/delivery aggregate readers | Platform only |
| In-doubt submissions and M25 exceptions | Existing M23/M41/M25 Billing Operations feeds | Authorized tenant/provider/caseload |
| Live worker heartbeat | Not durably recorded | Explicitly unavailable |
| Observed current request budget | Counter store does not expose a durable snapshot | Explicitly unavailable |

No status is inferred from render time or from the presence of a current state alone.
