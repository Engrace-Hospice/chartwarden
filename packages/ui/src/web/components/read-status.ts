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
