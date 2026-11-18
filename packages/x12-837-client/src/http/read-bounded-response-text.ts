export type BoundedResponseText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too_large" | "unreadable" };

const MAX_SUPPORTED_LIMIT = 8 * 1024 * 1024;

function declaredLength(raw: string | null): bigint | null {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Reads at most `limit` response bytes. The declared length is only an early-rejection hint; the streamed byte count
 * is authoritative. A mismatched valid Content-Length and invalid UTF-8 are unreadable, never partial text.
 */
export async function readBoundedResponseText(
  response: Response,
  limit: number,
): Promise<BoundedResponseText> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_SUPPORTED_LIMIT)
    throw new RangeError("limit must be between 0 and 8 MiB");

  const declared = declaredLength(response.headers.get("content-length"));
  if (declared !== null && declared > BigInt(limit)) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return declared === null || declared === 0n
      ? { ok: true, text: "" }
      : { ok: false, reason: "unreadable" };
  }

  const bytes = new Uint8Array(limit);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - total) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
    if (declared !== null && declared !== BigInt(total)) return { ok: false, reason: "unreadable" };
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total)),
    };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "unreadable" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed/aborted stream may already have released its reader.
    }
  }
}
