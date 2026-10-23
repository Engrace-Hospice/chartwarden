// The API's one error envelope is `{ error: { code, message, correlationId } }` (spec §4.3). Screens kept reading
// RFC 7807 `detail`/`title`, which that envelope never carries, so the server's reason ("no on-call shift covers
// …") was dropped for a generic fallback (#596, F-040).
const AUTHZ_CODES = new Set(["FORBIDDEN", "UNAUTHORIZED"]);

/**
 * The server's own sentence for a failed request, or `null` when there is none worth showing. Authorization
 * refusals return `null` so the caller's friendly copy wins over raw policy text.
 */
export function envelopeErrorMessage(error: unknown): string | null {
  const envelope = (error as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
  if (!envelope || typeof envelope.message !== "string" || envelope.message === "") return null;
  if (typeof envelope.code === "string" && AUTHZ_CODES.has(envelope.code)) return null;
  return envelope.message;
}
