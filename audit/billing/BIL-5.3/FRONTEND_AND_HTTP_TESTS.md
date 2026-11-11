# Frontend and HTTP tests

The focused Billing Operations DOM test covers summary loading, monetary labels, PLB separation, provider query scope, and the absence of a derived receivable. The live M25 test exercises the registered Fastify route against private PostgreSQL with a server-mapped authenticated test principal and `remittance.read`; unauthorized provider/org scope returns no foreign aggregate.

This is application authorization plus database RLS evidence, not production IdP certification. OpenAPI/client consistency is checked separately. See `TEST_RESULTS.md` for commands and outcomes.
