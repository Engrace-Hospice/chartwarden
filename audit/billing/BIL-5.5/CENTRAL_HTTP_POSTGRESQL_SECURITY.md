# Central HTTP/PostgreSQL security

`GET /api/v1/ops/claimmd/observability` is guarded by `billing.rule_config.platform_admin`, `platform_billing_scope`, and a platform role. The private live test registers the real Fastify route, real M23/M25 durable readers, and the provisioned platform connection.

The response contains bounded aggregates and boolean cursor presence. Account references, cursor values, payloads, credentials, and tenant attribution details are absent. Tenant and unauthenticated principals are rejected before readers run. `chartwarden_app` receives PostgreSQL `42501` on the central inbox.

The test authenticator maps a fixed synthetic principal to server-owned context. This proves application authorization, not production IdP certification.
