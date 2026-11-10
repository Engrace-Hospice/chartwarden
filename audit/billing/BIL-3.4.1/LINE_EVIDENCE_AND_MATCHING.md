# Line evidence and matching

BIL-3.4 records line facts from exact final outbound 837 bytes and binds source line IDs to immutable submission attempts. Migration 1396 was applied in a private PostgreSQL 18.6 migration/RLS rehearsal. M23 tests verify tenant visibility, provider binding, update denial, and audit metadata.

M25 does not yet consume the evidence to establish an 835 service-line association. No `REF*6R` is added to outbound claims; supported reference echo remains route/payer dependent and unverified. Historical attempts without evidence remain unavailable.
