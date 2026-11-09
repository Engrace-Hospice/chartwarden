# API and frontend

The existing TypeBox/OpenAPI routes remain the single M25 API surface: scoped list/detail/matching/financial review, posting-plan read-generation, plan-bound approval, explicit execution, and posting history. `bun run openapi:check` and `bun run client:check` confirm generated contracts are current.

Fastify route injection tests confirm the posting routes do not accept ordinary review access as approval/execution authority. The React DOM test exercises the existing screen from opening a staged ERA through plan review, separate approval, explicit execution, and committed posting history; the default-disabled UI test confirms no execution action is advertised when the server reports the capability disabled.

HTTP authorization tests use a mocked domain service; durable plan and financial behavior is covered separately by the private PostgreSQL service integration test. The UI test likewise stubs HTTP responses and is not a browser-to-live-database test.
