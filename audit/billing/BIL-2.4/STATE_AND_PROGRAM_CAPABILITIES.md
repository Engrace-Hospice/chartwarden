# State and program capability matrix

Classification is based on repository implementation, not on whether a state publishes an EDI guide.

| State | Local preparation | Program identity | Adapter/format in WardenX | Transport/certification | Submission |
|---|---|---|---|---|---|
| OR | Existing M24 preparation and validation | unresolved unless an MCO id is persisted; not proof of FFS/MCO | reference adapter builds local `chartwarden.oregon-direct-mmis.v1` JSON envelope | gateway configuration is not OHA approval; no verified production wire protocol/credentials/testing evidence | blocked |
| WA | Existing generic M24 preparation | unresolved or unverified MCO | registered deny stub | no WardenX ProviderOne 837I route | blocked |
| ID | Existing generic M24 preparation | unresolved or unverified MCO | registered deny stub | no verified WardenX Idaho 837I route | blocked |
| CA | Existing generic M24 preparation | unresolved or unverified MCO | registered deny stub | FFS and MCP are separate contracting/routing domains; no verified WardenX route | blocked |
| NV | Existing generic M24 preparation | unresolved or unverified MCO | registered deny stub | official FFS and encounter guides exist, but no WardenX route/certification | blocked |
| Other | Existing generic records may exist | unresolved | no verified route | no verified adapter | blocked |

The registry currently reports `programAssignmentVerified: false`, `outboundFormat: unverified`, and `submissionAvailable: false` for every route. `transportConfigured` means only that an Oregon gateway was bound; it does not imply enrollment, approval, format compatibility, or certification.

**FFS versus managed care:** `mcoId != null` is exposed as an *unverified managed-care assignment*. `mcoId == null` is *unresolved*, never FFS. Actual classification requires authoritative coverage payer/program linkage with effective dates and a state program catalog, none of which is currently available as an M40 MCO routing contract.

Relevant source: `packages/medicaid-adapters/src/registry.ts:114-151`; state registrations/stubs in `packages/medicaid-adapters/src/registry.ts:25-40` and `packages/medicaid-adapters/src/deny-stub-states.ts`; Oregon reference adapter in `packages/medicaid-adapters/src/oregon/`; claim projection in `apps/backend/src/modules/24-billing-medicaid/routes/read-service-drizzle.ts:65-95`.
