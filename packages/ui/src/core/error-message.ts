// The API's one error envelope is `{ error: { code, message, correlationId } }` (spec §4.3). Screens kept reading
// RFC 7807 `detail`/`title`, which that envelope never carries, so the server's reason ("no on-call shift covers
// …") was dropped for a generic fallback (#596, F-040).
// Fail closed: the backend emits many 401/403 codes (STEP_UP_REQUIRED, *_SCOPE_*, *_DENIED, session-expiry variants)
// whose messages are policy text, and NOT_FOUND is deliberately non-revealing. Withhold anything that looks like one;
// the caller's own friendly copy or fallback then applies.
const WITHHELD_CODE = /FORBIDDEN|DENIED|SCOPE|STEP_UP|UNAUTHORI[SZ]ED|SESSION|NOT_FOUND|CSRF/;

/**
 * The server's own sentence for a failed request, or `null` when there is none worth showing. Authorization,
 * scope, step-up, session and not-found refusals return `null` so the caller's friendly copy wins over raw policy text.
 */
export function envelopeErrorMessage(error: unknown): string | null {
  const envelope = (error as { error?: { code?: unknown; message?: unknown } } | null | undefined)
    ?.error;
  if (!envelope || typeof envelope.message !== "string" || envelope.message === "") return null;
  if (typeof envelope.code === "string" && WITHHELD_CODE.test(envelope.code)) return null;
  return envelope.message;
}
