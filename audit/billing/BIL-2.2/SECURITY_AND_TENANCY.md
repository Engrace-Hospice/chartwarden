# Security and tenancy

- Each prepare/finalize database phase sets organization and system actor context through `withOrgContext`; RLS remains the boundary.
- The submission ID must match the job's organization, claim, attempt index and control number before any send reservation.
- The existing reviewed fingerprint and payer route checks are preserved; immutable Claim.MD evidence remains reserved in the transport before network upload.
- A UUID dispatch token fences finalization. A stale worker cannot finalize another worker's reservation.
- Transport uncertainty never becomes an automatic retry. Redelivery checks the durable state and cannot reset the cursor or alter ownership.
- The user-facing history contains only bounded reason codes for newly uncertain transport outcomes.

No RLS policy or database role grant changed. Real-role RLS and concurrent process certification remain pending on a private disposable PostgreSQL instance.
