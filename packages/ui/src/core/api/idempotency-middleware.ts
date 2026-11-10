// @chartwarden/ui — the API client's Idempotency-Key middleware (§4.1.1, TASK-020): one key per write INTENT, for every caller.
//
// A write whose reply is lost (offline, a reset, a timeout) may or may not have landed. For the server to recognise the retry as a retry,
// the retry has to carry the SAME key; a fresh key per attempt would make a lost-reply write double up. So the key is held per intent,
// the intent being method + full URL (path and query) + If-Match + JSON body (the server hashes the same things), by the rule
// `keepsKey` (ops-write/idempotency-key.ts: `fateOf` below calls it) that the kit's createIdempotencyKeeper / sendWrite share:
//   - the same intent keeps its key across a request that got NO answer, across a gateway page that never reached the app (a 5xx whose
//     body is not the API error envelope), and across the 409 that says an earlier request under the key is still running (that first
//     attempt is unresolved: a new key would run the write a second time);
//   - any other ANSWER, success or refusal, renews it. The server caches a completed answer under the key, refusals included (a 403
//     STEP_UP_REQUIRED, a 409, a 422), so the next attempt after an answer is a new intent and must start on a new key;
//   - a changed body, URL, query, method or If-Match is another intent, with its own key.
// A request that supplies its own Idempotency-Key (the kit's sendWrite / useOpsWrite callers) is never touched and never tracked.
//
// What it cannot do, so callers know:
//   - A body that carries a per-attempt timestamp or nonce never matches its own retry, so such a write silently gets a fresh key every
//     time. Give it its own key (pass `Idempotency-Key`, or use the kit's sendWrite / useOpsWrite), not this middleware.
//   - Only no-body and JSON bodies are fingerprinted; a file, multipart form, stream or a body past MAX_FINGERPRINT_BODY_CHARS goes out
//     on a fresh key every time (a Request cannot tell a stream from a string, so the read is bounded by size and by time).
//   - React StrictMode runs a mount effect twice in development, so a mount-time POST sends two identical requests on one key and the
//     second is answered 409 in-flight. Production does not do this.
//
// State is per client instance, not module-level: every app builds one client at its root so a screen sees the same table either way,
// but tests (and any second client) cannot leak keys into each other, and the clock is injectable. The table keys on a short digest of
// the intent, never on the body text (a clinical note must not sit in memory as a map key). It does NOT clear itself on a 401: not every
// 401 is a dead session (a mistyped unlock or step-up code, a session with no organization yet), and dropping a held key there would turn
// a lost-reply retry into a second write. The apps clear it with clearIdempotencyKeys(client) where they already decide the session is
// over: the shell's session-expired signal (web), the session guard (portal), the actor-session 401 (admin), and every sign-out that
// does not reload the page. A sign-out that reloads discards the table with the page.
import type { Middleware } from "openapi-fetch";
import {
  MAX_TRACKED_INTENTS,
  isInFlightDuplicate,
  keepsKey,
  keyIdleTooLong,
  keyPastMaxAge,
  newIdempotencyKey,
  opaqueIdempotencyIntent,
} from "../ops-write/idempotency-key";

/** Methods that mutate state: the ones the backend's `requireIdempotencyKey` guard can gate (TASK-020). */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

// MAX_TRACKED_INTENTS (ops-write/idempotency-key.ts) caps the IDLE intents that hold a key; past it the least recently used idle one is
// forgotten (it gets a new key on its next retry). An intent whose request is still in flight is never evicted by the cap (a bulk
// action may fire more of them than this), only by IDEMPOTENCY_KEY_MAX_AGE_MS.

/** A body longer than this is not fingerprinted: the request goes out on a fresh key every time. */
export const MAX_FINGERPRINT_BODY_CHARS = 64 * 1024;

/**
 * The longest the body read may take. A string body is read at once; a JSON-typed stream that never ends (openapi-fetch labels ANY
 * non-FormData body application/json) must not hold the request back, so past this it is sent on a fresh key.
 */
export const FINGERPRINT_READ_TIMEOUT_MS = 250;

/** UTF-8 encodes one UTF-16 code unit in at most this many bytes, so a chunk longer than cap * this cannot fit under the char cap. */
const MAX_UTF8_BYTES_PER_CHAR = 3;

/** The only bodies whose text is a stable fingerprint: JSON. A file or a multipart form is not (its boundary changes per request). */
const JSON_CONTENT_TYPE = /[/+]json\b/i;

type Fate = "renew" | "slide" | "hold";

interface TrackedIntent {
  readonly key: string;
  readonly firstAttemptAt: number;
  /** The last attempt that ended unanswered (no answer or a gateway page); an in-flight 409 leaves it alone. */
  readonly lastAttemptAt: number;
  /** Requests under this key that have not been answered yet. */
  readonly inFlight: number;
}

/**
 * cyrb53, a non-cryptographic 53-bit string hash: crypto.subtle is unavailable in an insecure context, and the server's own request hash
 * is the backstop (a collision would only share a key between two intents, which the server answers 409 IDEMPOTENCY_CONFLICT).
 */
const digest = (text: string): string => opaqueIdempotencyIntent(text, "");

/**
 * The body text, or null when it is past the size cap or cannot be read in time. It reads chunk by chunk and gives up at the first chunk
 * that is past the cap (a chunk is not decoded when its BYTES alone prove it is: UTF-8 is at most 3 bytes per UTF-16 unit), never
 * `.text()` of a stream.
 */
async function readBoundedText(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timedOut");
  const deadline = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), FINGERPRINT_READ_TIMEOUT_MS);
  });
  try {
    let text = "";
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === timedOut) return null;
      if (next.done) return text + decoder.decode();
      if (next.value.byteLength > MAX_FINGERPRINT_BODY_CHARS * MAX_UTF8_BYTES_PER_CHAR) return null;
      text += decoder.decode(next.value, { stream: true });
      if (text.length > MAX_FINGERPRINT_BODY_CHARS) return null;
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined); // the clone's branch only: the original still goes to the wire
  }
}

/**
 * A short digest of the intent (method, URL, If-Match, body), or null when the request cannot be fingerprinted: its body is not JSON, is
 * too large, is not readable in time or cannot be cloned. Such a request is not tracked and gets a fresh key, as every request did before
 * intents were tracked. The digest, not the text, is what the table holds.
 */
export async function fingerprintOf(request: Request): Promise<string | null> {
  const intent = `${request.method}\n${request.url}\n${request.headers.get("if-match") ?? ""}\n`;
  if (!request.body) return digest(intent); // no body: the method, URL and version are the whole intent
  if (!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "")) return null;
  // A size hint, honoured where a caller can set it (Node, SSR, tests). Browsers drop a script-set Content-Length (a forbidden header
  // name), so there this never fires and the bounded read below is the real guard. Bytes are never fewer than chars.
  const declaredLength = Number(request.headers.get("content-length"));
  if (declaredLength > MAX_FINGERPRINT_BODY_CHARS) return null;
  try {
    const text = await readBoundedText(request.clone());
    return text === null ? null : digest(intent + text);
  } catch {
    return null; // a body that cannot be cloned or read: never fail the request over its bookkeeping
  }
}

/** What the answer means for the key: `keepsKey` decides whether it survives; an in-flight 409 holds it, a gateway page slides it. */
async function fateOf(response: Response): Promise<Fate> {
  const { status } = response;
  if (status < 500 && status !== 409) return "renew";
  let copy: Response;
  try {
    copy = response.clone();
  } catch {
    return "renew"; // the answer cannot be read (a locked body): it was an answer, so the attempt is over
  }
  const body: unknown = await copy.json().catch(() => undefined); // an empty or non-JSON body is "no envelope"
  if (!keepsKey(status, body)) return "renew";
  return isInFlightDuplicate(status, body) ? "hold" : "slide";
}

export interface IdempotencyKeys {
  readonly middleware: Middleware;
  /** Forget every key (the session ended): the next attempt of any intent starts on a new one. */
  clear(): void;
  /** The digests the table is keyed by, for tests and diagnostics: never the body or URL text. */
  heldIntents(): readonly string[];
}

/** `now` is injectable for tests; production uses the wall clock (a record from last night must expire across a sleeping laptop). */
export function createIdempotencyKeys(now: () => number = Date.now): IdempotencyKeys {
  // Keyed by the intent's digest. Position is recency: a record is re-inserted when an unanswered attempt ends, so the first IDLE entry
  // is the least recently used.
  const intents = new Map<string, TrackedIntent>();

  function purge(): void {
    const current = now();
    for (const [digestOfIntent, intent] of intents) {
      const tooOld = keyPastMaxAge(intent.firstAttemptAt, current);
      const idleTooLong = intent.inFlight === 0 && keyIdleTooLong(intent.lastAttemptAt, current);
      if (tooOld || idleTooLong) intents.delete(digestOfIntent);
    }
    for (const [digestOfIntent, intent] of intents) {
      if (intents.size <= MAX_TRACKED_INTENTS) return;
      if (intent.inFlight === 0) intents.delete(digestOfIntent);
    }
  }

  /** The key for this attempt: the intent's own, or a new one; the attempt counts as in flight until it is answered or fails. */
  function begin(fingerprint: string): string {
    purge();
    const current = now();
    const known = intents.get(fingerprint);
    const intent: TrackedIntent = known
      ? { ...known, inFlight: known.inFlight + 1 }
      : { key: newIdempotencyKey(), firstAttemptAt: current, lastAttemptAt: current, inFlight: 1 };
    intents.set(fingerprint, intent);
    purge();
    return intent.key;
  }

  /** The attempt under `key` ended. A key the caller supplied is in no record, so this does nothing for it. */
  function end(key: string, fate: Fate): void {
    for (const [fingerprint, intent] of intents) {
      if (intent.key !== key) continue;
      const inFlight = Math.max(0, intent.inFlight - 1);
      if (fate === "hold") {
        intents.set(fingerprint, { ...intent, inFlight });
      } else {
        intents.delete(fingerprint);
        if (fate === "slide") {
          intents.set(fingerprint, { ...intent, inFlight, lastAttemptAt: now() });
        }
      }
      break;
    }
    purge();
  }

  const middleware: Middleware = {
    async onRequest({ request }) {
      if (!MUTATING_METHODS.has(request.method) || request.headers.has(IDEMPOTENCY_KEY_HEADER)) {
        return request;
      }
      const fingerprint = await fingerprintOf(request);
      request.headers.set(
        IDEMPOTENCY_KEY_HEADER,
        fingerprint === null ? newIdempotencyKey() : begin(fingerprint),
      );
      return request;
    },

    async onResponse({ request, response }) {
      const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
      if (key !== null) end(key, await fateOf(response));
      return undefined;
    },

    // No answer at all (offline, a reset, an abort: openapi-fetch rethrows): the key stays, so the retry replays.
    onError({ request }) {
      const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
      if (key !== null) end(key, "slide");
      return undefined;
    },
  };

  return { middleware, clear: () => intents.clear(), heldIntents: () => [...intents.keys()] };
}
