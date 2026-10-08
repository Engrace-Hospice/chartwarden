// @wardenx/portal — the three Better Auth calls the portal sign-in makes (M2 owns authentication; M31 §5.1).
// Plain `fetch` against `/api/auth/*` (the portal takes no compile-time edge into the auth package): the response
// bodies are tiny and the portal needs only their SHAPE of outcome, never a token or a user record. PURE of React and
// DOM globals other than the injected `fetch`, so it is unit-testable in the node environment.
//
// No account enumeration: a magic-link request answers `sent` for any well-formed address (the server does the same),
// and a failed password sign-in is one calm outcome whatever the reason.

export type SignInOutcome = "ok" | "two_factor" | "failed" | "rate_limited";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json" } as const;

async function post(fetchImpl: FetchLike, path: string, body: unknown): Promise<Response> {
  return fetchImpl(path, {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Ask the server to email a single-use sign-in link. The link returns to `/signed-in`. */
export async function requestMagicLink(
  email: string,
  origin: string,
  fetchImpl: FetchLike = fetch,
): Promise<"sent" | "rate_limited" | "failed"> {
  const res = await post(fetchImpl, "/api/auth/sign-in/magic-link", {
    email,
    callbackURL: `${origin}/signed-in`,
    errorCallbackURL: `${origin}/?link=invalid`,
  });
  if (res.status === 429) return "rate_limited";
  return res.ok ? "sent" : "failed";
}

/** Password sign-in. A second factor is signalled by `twoFactorRedirect`; the session is not established yet. */
export async function signInWithPassword(
  email: string,
  password: string,
  fetchImpl: FetchLike = fetch,
): Promise<SignInOutcome> {
  const res = await post(fetchImpl, "/api/auth/sign-in/email", { email, password });
  if (res.status === 429) return "rate_limited";
  if (!res.ok) return "failed";
  const body = (await res.json().catch(() => null)) as { twoFactorRedirect?: unknown } | null;
  return body?.twoFactorRedirect === true ? "two_factor" : "ok";
}

/** Complete a password sign-in with the authenticator code. */
export async function verifyTotp(
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<SignInOutcome> {
  const res = await post(fetchImpl, "/api/auth/two-factor/verify-totp", { code });
  if (res.status === 429) return "rate_limited";
  return res.ok ? "ok" : "failed";
}

/** End the browser session (Better Auth clears the cookie and the server row). Best-effort: the UI moves on regardless. */
export async function signOut(fetchImpl: FetchLike = fetch): Promise<void> {
  await post(fetchImpl, "/api/auth/sign-out", {}).catch(() => undefined);
}
