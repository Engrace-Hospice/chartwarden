// @chartwarden/ui — the API client's Idempotency-Key middleware (§4.1.1, TASK-020): one key per write INTENT, for every caller.
//
// A write whose reply is lost (offline, a reset, a timeout) may or may not have landed. For the server to recognise the retry as a retry,
// the retry has to carry the SAME key; a fresh key per attempt would make a lost-reply write double up. So the key is held per intent,
// the intent being method + full URL (path and query) + body, by the same rule createIdempotencyKeeper / sendWrite hold per screen:
//   - the same intent keeps its key across a request that got NO answer, and across a gateway page that never reached the app (a 5xx
//     whose body is not the API error envelope: nothing was cached under the key);
//   - any real ANSWER, success or refusal, renews it. The server caches whatever it answered under the key, refusals included (a 403
//     STEP_UP_REQUIRED, a 409, a 422), so the next attempt after an answer is a new intent and must start on a new key;
//   - a changed body, URL, query or method is another intent, with its own key.
// A request that supplies its own Idempotency-Key (the kit's sendWrite / useOpsWrite callers) is never touched and never tracked.
//
// State is per client instance, not module-level: every app builds one client at its root so a screen sees the same table either way,
// but tests (and any second client) cannot leak keys into each other, and the clock is injectable.
import type { Middleware } from "openapi-fetch";
import { newIdempotencyKey } from "../ops-write/idempotency-key";
import { isGatewayPage } from "../ops-write/send-write";

/** Methods that mutate state: the ones the backend's `requireIdempotencyKey` guard can gate (TASK-020). */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

const MS_PER_MINUTE = 60_000;

/**
 * How long an intent keeps its key after its last attempt. The server caches an answer for a limited time (24h), and a retry long after
 * the first attempt is a new intent (the same text submitted again on purpose), which must not be handed a replay of the old answer; a
 * lost-reply retry comes in seconds to minutes. A retry inside the window restarts it, so a user still retrying keeps the key.
 */
export const IDEMPOTENCY_KEY_TTL_MS = 15 * MS_PER_MINUTE;

/** At most this many intents hold a key at once; past it the least recently used one is forgotten (it gets a new key on its next retry). */
export const MAX_TRACKED_INTENTS = 64;

/** A body longer than this is not fingerprinted (the table would hold its text): the request goes out on a fresh key every time. */
export const MAX_FINGERPRINT_BODY_CHARS = 64 * 1024;

/** The only bodies whose text is a stable fingerprint: JSON. A file, a stream or a multipart form is not (its boundary changes per request). */
const JSON_CONTENT_TYPE = /[/+]json\b/i;

interface TrackedIntent {
  readonly key: string;
  readonly lastAttemptAt: number;
}

/**
 * The intent's fingerprint, or null when the request cannot be fingerprinted (its body is not JSON, is too large, or cannot be read):
 * such a request is simply not tracked and gets a fresh key, which is how every request behaved before intents were tracked.
 */
async function fingerprintOf(request: Request): Promise<string | null> {
  const intent = `${request.method} ${request.url}`;
  if (!request.body) return intent; // no body: the method and URL are the whole intent
  if (!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "")) return null;
  try {
    const text = await request.clone().text();
    return text.length > MAX_FINGERPRINT_BODY_CHARS ? null : `${intent}\n${text}`;
  } catch {
    return null; // a body that cannot be cloned or read: never fail the request over its bookkeeping
  }
}

/** True when the response is a gateway page that never reached the app. Reads a clone: the caller's body is untouched. */
async function neverReachedTheApp(response: Response): Promise<boolean> {
  if (response.status < 500) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined); // an empty or non-JSON body is "no envelope"
  return isGatewayPage(response.status, body);
}

/** `now` is injectable for tests; production uses the wall clock (a record from last night must expire across a sleeping laptop). */
export function createIdempotencyKeyMiddleware(now: () => number = Date.now): Middleware {
  // Insertion order IS recency order (a use re-inserts), so the oldest intent is always the first entry.
  const intents = new Map<string, TrackedIntent>();

  function forgetStaleAndOverflow(): void {
    const cutoff = now() - IDEMPOTENCY_KEY_TTL_MS;
    for (const [fingerprint, intent] of intents) {
      if (intent.lastAttemptAt > cutoff && intents.size <= MAX_TRACKED_INTENTS) break;
      intents.delete(fingerprint);
    }
  }

  function keyFor(fingerprint: string): string {
    forgetStaleAndOverflow();
    const key = intents.get(fingerprint)?.key ?? newIdempotencyKey();
    intents.delete(fingerprint);
    intents.set(fingerprint, { key, lastAttemptAt: now() });
    forgetStaleAndOverflow(); // the new entry may have pushed the table one past its cap
    return key;
  }

  /** An answer renewed the key: the next attempt is a new intent. A key the caller supplied is in no record, so this does nothing. */
  function renew(key: string): void {
    for (const [fingerprint, intent] of intents) {
      if (intent.key !== key) continue;
      intents.delete(fingerprint);
      return;
    }
  }

  return {
    async onRequest({ request }) {
      if (!MUTATING_METHODS.has(request.method) || request.headers.has(IDEMPOTENCY_KEY_HEADER)) {
        return request;
      }
      const fingerprint = await fingerprintOf(request);
      request.headers.set(
        IDEMPOTENCY_KEY_HEADER,
        fingerprint === null ? newIdempotencyKey() : keyFor(fingerprint),
      );
      return request;
    },

    // onError (no answer at all: openapi-fetch rethrows) is deliberately absent: the record stays, so the retry replays.
    async onResponse({ request, response }) {
      const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
      if (key === null || (await neverReachedTheApp(response))) return undefined;
      renew(key);
      return undefined;
    },
  };
}
