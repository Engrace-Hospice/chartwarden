# HTTP and PostgreSQL integration evidence

The affected Fastify route, M23 provider-scope, M41 historical-reader and Billing Operations DOM suites were run as focused tests. The existing private PostgreSQL M25 runner had passed during BIL-5.1, before these M23/M41 list projections were added.

No new authenticated multi-tenant HTTP-to-PostgreSQL test was executed for these projections. No result in this report certifies their RLS behavior under restricted application roles. BIL-5.2A therefore does not meet its mandatory integrated security-test criterion.
