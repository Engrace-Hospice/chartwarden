# Security and Tenancy

The API resolves organization and actor from authenticated request context, never from the request body. Existing permission and caseload ABAC guards are reused. The service reloads the original claim within the actor organization, verifies provider reach, and confirms durable rejection evidence before creating a child.

Database lineage foreign keys include `organization_id`; uniqueness is organization-scoped; the trigger requires matching patient, provider, plan, service period, filing indicator and route. The new API exposes only bounded claim summaries under existing claim access. No central Claim.MD inbox is involved.

The operation creates a draft only. It does not transmit, post ERA, modify AR, alter the original claim, or reassign historical acknowledgments. Automated route-authorization tests and live PostgreSQL/RLS certification remain tracked in test results and blockers.
