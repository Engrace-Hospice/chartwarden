# Frontend workflow

The M23 claim editor retains its renderer-backed review and secure preview confirmation from BIL-2.1.2. This phase updates the existing submission timeline to show durable `sending` and `in_doubt` states with a plain-language reconciliation instruction. The UI does not expose the opaque preview reference, MBI, TIN, or X12.

Replacement/void actions remain in the editor's existing confirmation ceremony and chain breadcrumb. Queued, transmitted, and payer-accepted states remain distinct. Full client-generated OpenAPI regeneration is not required for this response projection in the current route shape; verify the route contract and client during the targeted API checks.
