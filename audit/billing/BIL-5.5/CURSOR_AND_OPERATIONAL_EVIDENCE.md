# Cursor and operational evidence

Central observability exposes whether a cursor exists, never its value. Preflight reads but does not update stream lease/cursor state. The private test snapshots cursor, generation, and lease before and after preflight plus concurrent dry-runs.

No worker heartbeat or durable request-budget source exists. The API reports both as `unavailable` rather than fabricating health.
