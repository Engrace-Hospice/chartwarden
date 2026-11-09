# Security and tenancy

Line evidence is associated with the existing tenant-scoped immutable submission evidence and uses organization RLS with FORCE RLS. The migration's write policy requires its evidence parent to match tenant, provider, claim, attempt, account/environment, and payload digest; updates/deletes are rejected by the immutable trigger. No tenant API exposes central inbox data. No posting permission or bypass was added.

Live application-role RLS validation for the new table was not run. Source checks are not a substitute for PostgreSQL certification.
