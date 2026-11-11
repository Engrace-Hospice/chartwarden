# State, assignment, notes, and audit

Migration `1454_m25_billing_operations_investigations.sql` adds the M25-owned investigation, event, and note records. Source identity is unique within an organization. Each state/assignment operation is version-checked and idempotency-bound; notes and event history are append-only at the database layer. List paging uses a signed organization-bound keyset and a stable `(updated_at, id)` order. The count is explicitly a `lower_bound` over authorized cases on the returned page, not a queue total.

The lifecycle is `open → investigating → waiting_external/resolved → closed`, with audited reopening. Resolution/closure/reopen requires the separate `billing.operations.resolve` permission. Assignment targets must be active, scoped investigators with triage permission. Assignment and triage cannot change source workflow state.

The M25 API lives under `/api/v1/billing/operations/investigations`; schemas are emitted through TypeBox/OpenAPI and the generated client. No retry, replay, resubmit, quarantine-release, posting, or financial action endpoint exists.
