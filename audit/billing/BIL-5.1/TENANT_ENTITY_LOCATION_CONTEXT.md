# Tenant, provider and location context

`GET /api/v1/auth/context` now returns `providerEntityIds` already resolved by the authenticated request context. `apps/web/src/shell/actor-session.ts` maps that server-provided scope to the session; the workspace offers only those provider IDs. The organization directory is used only to label IDs after intersecting them with the authenticated scope.

Location choices come from the existing provider-bound `/api/v1/locations` lookup and are intersected with session `locationIds`. The workspace sends a selected location only to M25, whose stage list applies organization, server-derived provider scope and `locationId` predicates together. Other modules do not currently expose a common location filter, and the UI labels this restriction explicitly.

Query-string provider IDs are accepted only when present in the server-issued session scope. Source APIs remain authoritative if scope changes or a stale link is opened; no tenant ID is accepted as a filter. A changed provider clears the location. A changed provider/location/filter reloads the lists without carrying source cursors forward.
