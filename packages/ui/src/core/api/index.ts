// @chartwarden/ui — typed REST API surface (F0-T02, ADR-0032). The client is generated from
// docs/api/openapi.json (the frontend↔backend contract); regenerate with `bun run client:gen`.
export type { components, operations, paths } from "./schema";
export { BACKGROUND_REQUEST_HEADERS, createApiClient } from "./client";
export type { ApiClient, ApiClientOptions } from "./client";
export { ApiClientProvider, useApiClient } from "./provider";
export type { ApiClientProviderProps } from "./provider";
