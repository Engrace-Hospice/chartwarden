// @chartwarden/ui/testing — TEST SUPPORT ONLY. A stub API client for the component suites of every app: its methods dispatch on the typed
// path, answer with what the test says, and record every call (`client.POST.mock.calls`). It lives behind this subpath, not the package
// barrel, so production code cannot import it (or `vitest`) by accident. The admin wizard, the tenant wizard and its panels used to each
// carry a copy.
import { vi } from "vitest";

export interface StubReply {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}
export interface StubInit {
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}
export type StubHandler = (init: StubInit) => StubReply | Promise<StubReply>;
export type StubHandlers = Partial<
  Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Record<string, StubHandler>>
>;

const NOT_STUBBED: StubReply = {
  error: { error: { code: "NOT_STUBBED", message: "no stub for this call" } },
  response: { status: 500 },
};

/** A client whose methods dispatch on the typed path and record every call. A path with no handler answers 500 NOT_STUBBED. */
export function stubClient(handlers: StubHandlers) {
  const method = (name: keyof StubHandlers) =>
    vi.fn(async (path: string, init: StubInit = {}) => {
      const handler = handlers[name]?.[path];
      return handler ? await handler(init) : NOT_STUBBED;
    });
  return {
    GET: method("GET"),
    POST: method("POST"),
    PUT: method("PUT"),
    PATCH: method("PATCH"),
    DELETE: method("DELETE"),
  };
}
export type StubClient = ReturnType<typeof stubClient>;

export const ok = (data: unknown, status = 200): StubReply => ({ data, response: { status } });

/** A refusal in the standard error envelope (`details` are the per-field errors of a 400 or 422). */
export const refused = (
  status: number,
  code: string,
  message = "refused",
  details?: unknown[],
): StubReply => ({
  error: { error: { code, message, correlationId: "corr-test", ...(details ? { details } : {}) } },
  response: { status },
});

type RecordedCall = readonly unknown[];
interface HeaderBearer {
  headers?: Record<string, string>;
  params?: { header?: Record<string, string> };
}
const headerOf = (call: RecordedCall, name: string): string | undefined => {
  const init = (call[1] ?? {}) as HeaderBearer;
  return init.params?.header?.[name] ?? init.headers?.[name];
};

/** The Idempotency-Key a recorded call carried (a typed `params.header` or the top-level `headers` option). */
export const idempotencyKeyOf = (call: RecordedCall): string | undefined =>
  headerOf(call, "Idempotency-Key");
/** The If-Match a recorded call carried, or undefined. */
export const ifMatchOf = (call: RecordedCall): string | undefined => headerOf(call, "If-Match");
