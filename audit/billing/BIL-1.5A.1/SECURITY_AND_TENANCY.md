# Security and Tenancy

- Central recovery action records are platform-only and have `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and a policy for `claimmd_capture`; the migration grants only `SELECT, INSERT` on this append-only ledger.
- Tenant ERA stage review reads only M25-owned staging rows inside `withOrgContext`; organization and provider scope are server-derived.
- The M25 projection decrypts details only after the row has been filtered by organization/provider; raw source remains central.
- Recovery needs a platform actor and injected authorization callback, and its store runs through the audited platform bypass context. No tenant-facing requeue API is present.
- Metrics use bounded enumerated labels; failure detail is reduced to safe code.
- Financial guard stores only safe hold reason and existing advice reference in JSON summary; it does not log 835 content.

## Certification limits

Migration role behavior and FORCE RLS have not been executed against private PostgreSQL. The requeue authorization callback has unit coverage but lacks a production composition/route using the platform-ops authorization model. This means the security boundary inside the service exists, while authorized operator reachability remains incomplete.
