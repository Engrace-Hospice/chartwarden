// Dev-only mock ApiClient for modules-preview. Fixtures are keyed by route template; a bare path is a GET and a
// write is keyed "POST /api/v1/…". A fixture is the response body or a function of the request. An unmatched
// GET answers 404 (a visible error beats invented data); an unmatched write answers an empty 200.
import type { ApiClient } from "@chartwarden/ui";

export interface MockRequest {
  params?: { path?: Record<string, string>; query?: Record<string, string> };
  body?: unknown;
}
export type Fixture = unknown | ((request: MockRequest) => unknown);
export type Fixtures = Record<string, Fixture>;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const answer = (data: unknown) =>
  Promise.resolve({ data, error: undefined, response: new Response(null, { status: 200 }) });

const notFound = (path: string) =>
  Promise.resolve({
    data: undefined,
    error: { status: 404, title: `No preview fixture for ${path}` },
    response: new Response(null, { status: 404 }),
  });

export function createMockClient(fixtures: Fixtures): ApiClient {
  const client: Record<string, unknown> = {};
  for (const method of METHODS) {
    client[method] = (path: string, request: MockRequest = {}) => {
      const key = method === "GET" ? path : `${method} ${path}`;
      const fixture = fixtures[key] ?? (method === "GET" ? undefined : {});
      if (fixture === undefined) return notFound(path);
      return answer(typeof fixture === "function" ? fixture(request) : fixture);
    };
  }
  return client as unknown as ApiClient;
}
