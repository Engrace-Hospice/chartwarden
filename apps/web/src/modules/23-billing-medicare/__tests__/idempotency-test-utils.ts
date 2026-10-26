import { expect } from "vitest";
import type { vi } from "vitest";

type Mock = ReturnType<typeof vi.fn>;
type Init = { params?: { header?: Record<string, string> } };

/** The Idempotency-Key header of the nth call of a mocked client verb. */
export function keyOfCall(mock: Mock, call: number): string {
  const init = (mock.mock.calls[call] as unknown as [string, Init])[1];
  const key = init.params?.header?.["Idempotency-Key"];
  expect(key, `call ${call} carries an Idempotency-Key`).toBeTruthy();
  return key as string;
}

export const expectSameKey = (mock: Mock, a: number, b: number): void =>
  expect(keyOfCall(mock, b)).toBe(keyOfCall(mock, a));

export const expectNewKey = (mock: Mock, a: number, b: number): void =>
  expect(keyOfCall(mock, b)).not.toBe(keyOfCall(mock, a));

export type Script = Array<"throw" | number>;

/**
 * A fetch stub for createApiClient: GETs answer `getBody(path)` (200); each write consumes the next script entry ("throw"
 * rejects like a dropped connection, a number is the HTTP status, default 201) and records its Idempotency-Key.
 */
export function scriptedFetch(script: Script, getBody: (path: string) => unknown = () => ({})) {
  const keys: string[] = [];
  const reply = (code: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { "content-type": "application/json" },
    });
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = typeof input === "object" && "url" in input ? (input as Request) : null;
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    if (method === "GET")
      return reply(
        200,
        getBody(new URL(req ? req.url : String(input), "http://localhost").pathname),
      );
    keys.push(req?.headers.get("Idempotency-Key") ?? "");
    const next = script.shift() ?? 201;
    if (next === "throw") throw new TypeError("network down");
    return next < 300
      ? reply(next, { id: "x", ok: true })
      : reply(next, { error: { code: "X", message: "refused" } });
  };
  return { keys, fetchStub };
}
