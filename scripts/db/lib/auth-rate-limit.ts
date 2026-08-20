/** Retry Better Auth's deliberate 3 requests / 10 seconds per-IP sign-in/sign-up guard. */
const MAX_AUTH_ATTEMPTS = 5;

export async function fetchAuthWithRateLimitRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  label: string,
): Promise<Response> {
  for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt += 1) {
    const response = await fetch(input, init);
    if (response.status !== 429 || attempt === MAX_AUTH_ATTEMPTS - 1) return response;

    const retryAfter = Number(response.headers.get("x-retry-after"));
    // Better Auth's window reset compares strictly `>`; add one second to avoid retrying on its edge.
    const delaySeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter + 1 : 11;
    console.log(`${label} rate-limited; retrying in ${delaySeconds}s`);
    await new Promise<void>((resolve) => setTimeout(resolve, delaySeconds * 1_000));
  }

  throw new Error(`${label} exhausted rate-limit retries`);
}
