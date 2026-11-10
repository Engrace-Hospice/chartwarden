// @chartwarden/ui core — how a write's result is read, in ONE place, for every console write that runs it directly (the ones that
// do not go through `useOpsWrite`, which is built on the same two pieces).
//
// 1. Success is `no error AND response.ok`. openapi-fetch returns `{ error: undefined, response }` for a NON-ok response whose body is
//    empty (Content-Length 0: an empty-body gateway 502/504), so `error` alone would call a failed money write a success.
// 2. A request that got NO answer at all (offline, reset: openapi-fetch rethrows) is its own outcome, never an exception: the caller
//    releases its busy lock and says the server was not reached.
// 3. With a keeper, the Idempotency-Key is held per user intent: the same fingerprint keeps the key across a retry after no answer (the
//    request may have landed and only the reply been lost, so the server must be able to recognise the retry), and any ANSWER renews it,
//    except a gateway page and the server's "an earlier request under this key is still running" 409 (`keepsKey`, idempotency-key.ts).
import type { IdempotencyKeeper } from "./idempotency";
import { isGatewayPage, keepsKey } from "./idempotency-key";

export interface WriteResponse {
  readonly error?: unknown;
  readonly response?: { readonly ok?: boolean; readonly status: number };
}

/** True when the server did not accept the write: an error body, or a non-ok status even with an empty body. */
export function writeRefused(result: WriteResponse): boolean {
  if (result.error !== undefined && result.error !== null) return true;
  const response = result.response;
  if (response === undefined) return false;
  return response.ok === false || response.status >= 400;
}

/** A gateway error page: a 5xx whose body is not the API's error envelope never reached the app (the definition lives in idempotency-key.ts). */
export function reachedNoOne(result: WriteResponse): boolean {
  return isGatewayPage(result.response?.status ?? 0, result.error);
}

export type SettledWrite<R extends WriteResponse> =
  | { readonly status: "ok"; readonly res: R }
  /** The server answered and did not accept it: `res.error` / `res.response` say why (`error` is undefined for an empty body). */
  | { readonly status: "refused"; readonly res: R }
  /** No answer at all: the change may or may not have landed. */
  | { readonly status: "unreachable" };

/** Await a write and classify it; a rejected request is `unreachable`, not an exception. */
export async function settleWrite<R extends WriteResponse>(
  request: Promise<R>,
): Promise<SettledWrite<R>> {
  let res: R;
  try {
    res = await request;
  } catch {
    return { status: "unreachable" };
  }
  return writeRefused(res) ? { status: "refused", res } : { status: "ok", res };
}

/**
 * Send a write under the keeper's key for `fingerprint` (the body, or any stable text for the intent) and classify it. The key is kept
 * when the request got no answer, when a gateway answered for the app, and when the server says an earlier request under the key is
 * still running (`keepsKey`); it is renewed by every other answer, success or refusal.
 */
export async function sendWrite<R extends WriteResponse>(
  keeper: IdempotencyKeeper,
  fingerprint: string,
  call: (idempotencyKey: string) => Promise<R>,
): Promise<SettledWrite<R>> {
  const settled = await settleWrite(call(keeper.keyFor(fingerprint)));
  if (settled.status === "unreachable") return settled;
  if (!keepsKey(settled.res.response?.status ?? 0, settled.res.error)) keeper.settled();
  return settled;
}
