// @chartwarden/ui — classify an openapi-fetch result so a denied or failed read is never rendered as an
// empty one. 403 is its own state (DeniedState, no retry); any other error is `failed` (ErrorState + retry).
export type ReadStatus = "ok" | "denied" | "failed";

export function classifyRead(res: {
  error?: unknown;
  response?: { status: number } | undefined;
}): ReadStatus {
  const status = res.response?.status;
  if (status === 403) return "denied";
  if (res.error !== undefined && res.error !== null) return "failed";
  return status !== undefined && status >= 400 ? "failed" : "ok";
}

type ReadResult = { error?: unknown; response?: { status: number } | undefined };

/** What a 404 means for a read: `empty` is a true absence (status ok, no data); `denied` is deny-as-404;
 *  `failed` (the default) is an ordinary failure. */
export type NotFoundMeaning = "empty" | "denied" | "failed";

/**
 * Await a request and classify it. A REJECTED request (network error, timeout: openapi-fetch rejects) is
 * a `failed` read, never an exception, so a caller's `setLoading(false)` always runs and the Retry state
 * shows. `res` is present only when the read is `ok`.
 */
export async function settleRead<R extends ReadResult>(
  request: Promise<R>,
  notFound: NotFoundMeaning = "failed",
): Promise<{ status: ReadStatus; res?: R }> {
  try {
    const res = await request;
    if (res.response?.status === 404 && notFound !== "failed") {
      return notFound === "denied" ? { status: "denied" } : { status: "ok", res };
    }
    const status = classifyRead(res);
    return status === "ok" ? { status, res } : { status };
  } catch {
    return { status: "failed" };
  }
}
