// @chartwarden/ui/testing — TEST SUPPORT ONLY. A stub API client for the component suites of every app: its methods dispatch on the typed
// path, answer with what the test says, and record every call (`client.POST.mock.calls`). It lives behind this subpath, not the package
// barrel, so production code cannot import it (or `vitest`) by accident. The admin wizard, the tenant wizard and its panels used to each
// carry a copy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./core/api/client";
import { sharedAttemptKeys } from "./core/ops-write/use-attempt-key";

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

type DeclaredKeyReply = "no answer" | { status: number; error?: unknown };

const DECLARED_KEY_GATEWAY: DeclaredKeyReply = { status: 502, error: "<html>Bad Gateway</html>" };
const DECLARED_KEY_IN_FLIGHT: DeclaredKeyReply = {
  status: 409,
  error: { error: { code: "IDEMPOTENCY_IN_FLIGHT", message: "still being processed" } },
};
const DECLARED_KEY_VALIDATION: DeclaredKeyReply = {
  status: 422,
  error: { error: { code: "VALIDATION_ERROR", message: "invalid" } },
};
const DECLARED_KEY_OK: DeclaredKeyReply = { status: 200 };

function declaredKeyRecordingClient(replies: DeclaredKeyReply[]) {
  const sent: string[] = [];
  const write = vi.fn(
    async (_path: string, init: { params: { header: Record<string, string> } }) => {
      sent.push(init.params.header["Idempotency-Key"] ?? "");
      const reply = replies.shift() ?? DECLARED_KEY_OK;
      if (reply === "no answer") throw new TypeError("Failed to fetch");
      const succeeded = reply.status < 300;
      return {
        data: succeeded ? { id: "x" } : undefined,
        error: succeeded ? undefined : reply.error,
        response: new Response(null, { status: reply.status }),
      };
    },
  );
  return {
    client: { PATCH: write, POST: write, DELETE: write } as unknown as ApiClient,
    sent,
  };
}

/** One API write site whose typed route declares the Idempotency-Key header. */
export type WriteSite = readonly [
  name: string,
  act: (client: ApiClient, changed?: boolean) => Promise<unknown>,
];

/** Shared contract suite for one-key-per-write-intent behavior. Test support only. */
export function describeDeclaredKeyContract(title: string, sites: readonly WriteSite[]): void {
  describe(title, () => {
    beforeEach(() => sharedAttemptKeys.clear());

    describe.each(sites)("%s", (_name, act) => {
      it("retries a request that got no answer under the same key", async () => {
        const { client, sent } = declaredKeyRecordingClient(["no answer"]);
        await expect(act(client)).rejects.toThrow("Failed to fetch");
        await act(client);
        expect(sent).toHaveLength(2);
        expect(sent[0]).toBeTruthy();
        expect(sent[1]).toBe(sent[0]);
      });

      it.each([
        ["a gateway page", DECLARED_KEY_GATEWAY],
        ["an in-flight duplicate", DECLARED_KEY_IN_FLIGHT],
      ])("retries after %s under the same key", async (_label, reply) => {
        const { client, sent } = declaredKeyRecordingClient([reply]);
        await act(client);
        await act(client);
        expect(sent[0]).toBeTruthy();
        expect(sent[1]).toBe(sent[0]);
      });

      it.each([
        ["a success", DECLARED_KEY_OK],
        ["a refusal from the API", DECLARED_KEY_VALIDATION],
      ])("sends a new key after %s", async (_label, reply) => {
        const { client, sent } = declaredKeyRecordingClient([reply]);
        await act(client);
        await act(client);
        expect(sent[1]).toBeTruthy();
        expect(sent[1]).not.toBe(sent[0]);
      });

      it("sends a different key for a changed intent", async () => {
        const { client, sent } = declaredKeyRecordingClient(["no answer"]);
        await expect(act(client)).rejects.toThrow();
        await act(client, true);
        expect(sent[1]).not.toBe(sent[0]);
      });

      it("sends a new key once the session's held keys are cleared", async () => {
        const { client, sent } = declaredKeyRecordingClient(["no answer"]);
        await expect(act(client)).rejects.toThrow();
        sharedAttemptKeys.clear();
        await act(client);
        expect(sent[1]).not.toBe(sent[0]);
      });
    });
  });
}
