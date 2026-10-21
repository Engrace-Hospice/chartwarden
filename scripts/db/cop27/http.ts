/**
 * COP27 API seed — the authenticated HTTP session.
 *
 * Same handshake `seed-patients.ts` / `lib/api-session.ts` use (Better Auth email sign-in → cookie jar →
 * `chartwarden_csrf` double-submit on every mutating call → `/auth/memberships` + `/auth/select-organization`),
 * but with the base URL and the credentials taken from the caller rather than from `CREDENTIALS.local.md`:
 * this seed is written to run against a deployed environment, where there is no credentials file and the
 * password must never be read from disk, echoed, or passed on the command line.
 *
 * Requests go through the generated `@chartwarden/ui` client (built from `docs/api/openapi.json`), so every
 * request body is type-checked against the published contract. Responses are unwrapped by {@link call} into
 * a small result type that keeps the server's error `code` — the per-step log reports it verbatim.
 */
import { type ApiClient, createApiClient } from "@chartwarden/ui";
import { fetchAuthWithRateLimitRetry, retryDelaySeconds } from "../lib/auth-rate-limit";

export interface Session {
  readonly client: ApiClient;
  readonly userId: string;
  readonly email: string;
  readonly organizationId: string;
  readonly organizationName: string;
}

export type CallResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

/** The step failed with a server answer worth logging (code + message), not a script bug. */
export class ApiError extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(`${step}: HTTP ${status} ${code} — ${detail}`);
  }
}

/** A step that cannot run for a known, non-error reason (missing role, missing org setup). */
export class SkipStep extends Error {}

type Jar = Map<string, string>;

function absorbSetCookie(jar: Jar, res: Response): void {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(";")[0] ?? "";
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
const cookieHeader = (jar: Jar): string =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
const csrfHeader = (jar: Jar): Record<string, string> => {
  const token = jar.get("chartwarden_csrf");
  return token ? { "x-csrf-token": token } : {};
};

/** Pull `code`/`message` out of whatever error envelope the route used (Better Auth or WardenX). */
function describeError(body: unknown): { code: string; message: string } {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const nested = (b.error && typeof b.error === "object" ? b.error : b) as Record<
      string,
      unknown
    >;
    const code = typeof nested.code === "string" ? nested.code : "ERROR";
    const raw =
      typeof nested.message === "string"
        ? nested.message
        : typeof b.error === "string"
          ? b.error
          : JSON.stringify(body);
    const details = Array.isArray(nested.details) ? ` ${JSON.stringify(nested.details)}` : "";
    return { code, message: `${raw}${details}`.slice(0, 600) };
  }
  return { code: "ERROR", message: String(body).slice(0, 600) };
}

/** Unwrap an openapi-fetch result into a {@link CallResult}; `T` is the shape the caller relies on. */
export async function call<T>(
  pending: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<CallResult<T>> {
  const r = await pending;
  if (r.response.ok) return { ok: true, status: r.response.status, data: r.data as T };
  const { code, message } = describeError(r.error);
  return { ok: false, status: r.response.status, code, message };
}

/** Like {@link call} but throws an {@link ApiError} naming `step` on a non-2xx. */
export async function must<T>(
  step: string,
  pending: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<T> {
  const r = await call<T>(pending);
  if (!r.ok) throw new ApiError(step, r.status, r.code, r.message);
  return r.data;
}

type Pending = Promise<{ data?: unknown; error?: unknown; response: Response }>;

/** HTTP statuses that mean "this account cannot see / may not touch it" (scope, caseload, permission). */
const NO_ACCESS = new Set([401, 403, 404]);

/**
 * Run `op` as each session in turn and return the first success. A 403/404 (out of the account's caseload,
 * site or permission set — WardenX answers "not found" rather than leak existence) moves on to the next
 * account; any other error is a real failure. When no account can reach the resource the step is a SKIP.
 */
export async function asAnyone<T>(
  step: string,
  sessions: readonly Session[],
  op: (s: Session) => Pending,
): Promise<T> {
  const refusals: string[] = [];
  for (const s of sessions) {
    const r = await call<T>(op(s));
    if (r.ok) return r.data;
    if (!NO_ACCESS.has(r.status)) throw new ApiError(step, r.status, r.code, r.message);
    refusals.push(`${s.email}: ${r.status} ${r.code}`);
  }
  throw new SkipStep(
    `${step}: no available account can reach it (${refusals.join("; ")}) — the admin lacks the caseload / provider-entity scope or role; supply an existing medical_director account via CHARTWARDEN_SEED_PHYSICIAN_EMAIL/PASSWORD`,
  );
}

/**
 * Like {@link asAnyone} for reads: null instead of a skip when nobody can see it. Reads try the accounts in
 * REVERSE order (the physician before the admin) — a chart the admin may open only partly (a redacted care
 * plan, a caseload-narrowed list) would otherwise mask the full view the physician gets.
 */
export async function readAsAnyone<T>(
  step: string,
  sessions: readonly Session[],
  op: (s: Session) => Pending,
): Promise<T | null> {
  try {
    return await asAnyone<T>(step, [...sessions].reverse(), op);
  } catch (err) {
    if (err instanceof SkipStep) return null;
    throw err;
  }
}

export interface SignInInput {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  /** Pick this org when the account has several memberships; otherwise the only one. */
  readonly organizationId?: string;
}

/** One run makes a few thousand calls; SD-055's authenticated tier is a fixed per-minute window. */
const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Send an API request, waiting out a 429 (the server's `Retry-After`) and resending it. A 429 is refused
 * before the handler runs, so resending a write cannot apply it twice; any other answer is returned as is.
 */
async function fetchWithRateLimitRetry(request: Request, jar: Jar): Promise<Response> {
  for (let retries = 0; ; retries += 1) {
    const response = await fetch(request.clone());
    absorbSetCookie(jar, response);
    if (response.status !== 429 || retries === MAX_RATE_LIMIT_RETRIES) return response;
    const delaySeconds = retryDelaySeconds(response);
    console.log(`  … rate-limited (HTTP 429); retrying in ${delaySeconds}s`);
    await new Promise<void>((resolve) => setTimeout(resolve, delaySeconds * 1_000));
  }
}

/** Sign in, select the organization and return a typed client bound to that session. */
export async function signIn(input: SignInInput): Promise<Session> {
  const { baseUrl, email, password } = input;
  const jar: Jar = new Map();
  const res = await fetchAuthWithRateLimitRetry(
    `${baseUrl}/api/auth/sign-in/email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    `sign-in for ${email}`,
  );
  absorbSetCookie(jar, res);
  const body = (await res.json().catch(() => null)) as {
    user?: { id?: string };
    twoFactorRedirect?: boolean;
  } | null;
  if (!res.ok) {
    const { code, message } = describeError(body);
    throw new Error(`sign-in failed for ${email}: HTTP ${res.status} ${code} — ${message}`);
  }
  if (body?.twoFactorRedirect) {
    throw new Error(
      `${email} has two-factor sign-in enabled; this seed cannot answer a TOTP/passkey challenge. Run it with an account that signs in with a password only.`,
    );
  }
  const userId = body?.user?.id;
  if (!userId) throw new Error(`sign-in for ${email} returned no user id`);

  const memRes = await fetch(`${baseUrl}/api/v1/auth/memberships`, {
    headers: { cookie: cookieHeader(jar) },
  });
  absorbSetCookie(jar, memRes);
  if (!memRes.ok) throw new Error(`list memberships failed for ${email}: HTTP ${memRes.status}`);
  const { memberships } = (await memRes.json()) as {
    memberships: Array<{ organizationId: string; organizationName: string }>;
  };
  const org = input.organizationId
    ? memberships.find((m) => m.organizationId === input.organizationId)
    : memberships.length === 1
      ? memberships[0]
      : undefined;
  if (!org) {
    const list = memberships.map((m) => `${m.organizationId} (${m.organizationName})`).join(", ");
    throw new Error(
      memberships.length === 0
        ? `${email} has no organization membership`
        : `${email} belongs to ${memberships.length} organizations (${list}); set CHARTWARDEN_SEED_ORG_ID to pick one`,
    );
  }

  const selRes = await fetch(`${baseUrl}/api/v1/auth/select-organization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader(jar), ...csrfHeader(jar) },
    body: JSON.stringify({ organizationId: org.organizationId }),
  });
  absorbSetCookie(jar, selRes);
  if (!selRes.ok) {
    throw new Error(`select-organization failed for ${email}: HTTP ${selRes.status}`);
  }

  const client = createApiClient({
    baseUrl,
    // openapi-fetch passes a single Request; clone it with the jar's cookie (see lib/api-session.ts).
    fetch: (async (req: RequestInfo | URL, init?: RequestInit) => {
      const request = req instanceof Request ? req : new Request(req, init);
      const headers = new Headers(request.headers);
      headers.set("cookie", cookieHeader(jar));
      const token = jar.get("chartwarden_csrf");
      if (token) headers.set("x-csrf-token", token);
      return fetchWithRateLimitRetry(new Request(request, { headers }), jar);
    }) as typeof fetch,
  });
  return {
    client,
    userId,
    email,
    organizationId: org.organizationId,
    organizationName: org.organizationName,
  };
}
