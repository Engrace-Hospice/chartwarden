# Billing Operations UX

The existing `/billing/operations` page now loads the user's persisted, provider-scoped investigation list when `billing.operations.read` is present. Users can open a case from the list even after the source submission is no longer in doubt. Provider changes invalidate prior case-list requests and clear stale rows.

The existing investigation panel presents source status separately from case status, supports assignment, notes, permitted transitions, resolution, closure, reopening, and audit history, and links to the owner detail. Actions remain permission-aware and read-only users receive a clear read-only state. Source retry and financial actions are not presented.

The DOM test covers historical detail navigation and the read/triage note interaction. The existing responsive worklist remains in place.
