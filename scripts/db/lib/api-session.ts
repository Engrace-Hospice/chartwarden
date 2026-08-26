/**
 * WardenX — shared authenticated-session helper for scenario seed scripts (local dev only).
 *
 * Every `scripts/db/seed-scenario-*.ts` script drives the REAL backend API (not raw SQL) as a
 * signed-in demo user, so RLS/ABAC/state-machine rules are exercised honestly instead of
 * bypassed. This module centralizes the sign-in → select-org → typed-client wiring that
 * `seed-patients.ts` first established with raw `fetch` — reimplemented here on top of the
 * generated `@wardenx/ui` `createApiClient` (the same typed client the frontend uses, built from
 * `docs/api/openapi.json`) so every scenario script gets compile-time-checked request bodies
 * instead of hand-typed JSON.
 *
 * `createApiClient`'s built-in CSRF middleware reads `document.cookie` (WX-PR-017,
 * packages/ui/src/core/api/client.ts) — a browser-only API that's always `undefined` in a Bun
 * script, so that middleware silently no-ops here. `signIn()` below adds its own middleware that
 * echoes the CSRF cookie from this module's own jar instead (the built-in one never sets the
 * header itself in this environment, so there's nothing to conflict with).
 */
import { readFileSync } from "node:fs";
import { type ApiClient, createApiClient } from "@wardenx/ui";
import { group } from "../../lib/strict";
import { fetchAuthWithRateLimitRetry } from "./auth-rate-limit";
import { SEED_CREDENTIALS_PATH } from "./credentials";

export const API = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
export const ORG_SLUG = "wardenx-demo";

export interface WxSession {
  client: ApiClient;
  userId: string;
  organizationId: string;
  email: string;
}

/**
 * Read a seeded user's generated password out of the gitignored CREDENTIALS.local.md. Three things a
 * naive `includes(email)` gets wrong, all confirmed live:
 *   1. Substring collision: `"orgadmin@wardenx.local".includes("admin@wardenx.local")` is TRUE — a plain
 *      substring search for `admin@wardenx.local` also matches `orgadmin@wardenx.local`'s row. Matching
 *      the backtick-delimited exact cell (`` `${email}` ``) avoids this.
 *   2. Ordering: `orgadmin@wardenx.local` is one of `seed.ts`'s base 4 accounts AND is separately
 *      dropped-and-recreated with a different password by `seed-org-admin.ts` (its own header: "drops a
 *      prior orgadmin@wardenx.local first, then re-creates it") — in `db:reset`'s pipeline order the base
 *      block is written first and is stale (that user no longer exists) by the time any script signs in,
 *      so the LAST matching line is always the authoritative one for any persona recreated by a later step.
 *   3. Not every line containing the needle is a credentials-table row — a prose note elsewhere in the
 *      file can legitimately mention an account by its exact backtick-quoted email (e.g. explaining a
 *      role grant) without being the `| Persona | Email | Password | ... |` row itself. Taking the
 *      literal last needle-matching line unconditionally threw on exactly that case; matching against
 *      every needle-line and keeping the LAST one that actually fits the two-backtick-cells pipe-table
 *      shape (skipping any that don't) is robust to prose lines landing after the real row.
 */
function readPassword(email: string): string {
  const md = readFileSync(SEED_CREDENTIALS_PATH, "utf8");
  const needle = `\`${email}\``;
  const lines = md.split("\n").filter((l) => l.includes(needle));
  for (const line of [...lines].reverse()) {
    const m = line.match(/`([^`]+)`\s*\|\s*`([^`]+)`/);
    if (m) return group(m, 2, "CREDENTIALS.local.md password cell");
  }
  throw new Error(
    `could not read password for ${email} from CREDENTIALS.local.md (run db:seed first)`,
  );
}

function absorbSetCookie(jar: Map<string, string>, res: Response): void {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    // `split(";")` always yields at least one element, so `pair` is always a string — but the
    // type cannot say so. `?? ""` costs nothing and makes the empty-header case a no-op rather
    // than a throw.
    const pair = c.split(";")[0] ?? "";
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function csrfHeader(jar: Map<string, string>): Record<string, string> {
  const token = jar.get("wardenx_csrf");
  return token ? { "x-csrf-token": token } : {};
}

/** Sign in as `email`, select the (single) demo org, and return a ready-to-use typed client. */
export async function signIn(email: string): Promise<WxSession> {
  const jar = new Map<string, string>();
  const password = readPassword(email);

  const signInRes = await fetchAuthWithRateLimitRetry(
    `${API}/api/auth/sign-in/email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    `sign-in for ${email}`,
  );
  if (!signInRes.ok) {
    throw new Error(
      `sign-in failed for ${email}: HTTP ${signInRes.status} ${await signInRes.text()}`,
    );
  }
  absorbSetCookie(jar, signInRes);
  const signInBody = (await signInRes.json()) as { user?: { id?: string } };
  const userId = signInBody.user?.id;
  if (!userId) throw new Error(`sign-in for ${email} returned no user id`);

  const memRes = await fetch(`${API}/api/v1/auth/memberships`, {
    headers: { cookie: cookieHeader(jar) },
  });
  absorbSetCookie(jar, memRes);
  if (!memRes.ok) {
    throw new Error(
      `list memberships failed for ${email}: HTTP ${memRes.status} ${await memRes.text()}`,
    );
  }
  const memBody = (await memRes.json()) as {
    memberships: Array<{ organizationId: string; organizationName: string }>;
  };
  const org = memBody.memberships[0];
  if (!org) throw new Error(`${email} has no memberships — run db:seed first`);

  const selRes = await fetch(`${API}/api/v1/auth/select-organization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader(jar), ...csrfHeader(jar) },
    body: JSON.stringify({ organizationId: org.organizationId }),
  });
  if (!selRes.ok) {
    throw new Error(
      `select-organization failed for ${email}: HTTP ${selRes.status} ${await selRes.text()}`,
    );
  }
  absorbSetCookie(jar, selRes);

  const client = createApiClient({
    baseUrl: API,
    // openapi-fetch calls this with a single `Request` object (headers/body/method already
    // encoded on it), not the (url, init) shape — reconstructing from `init` alone silently
    // dropped the real Content-Type + body and made every mutating call 415. `new Request(req,
    // {headers})` clones everything else off the original request and only overrides headers.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set("cookie", cookieHeader(jar));
      const res = await fetch(new Request(req, { headers }));
      absorbSetCookie(jar, res);
      return res;
    }) as typeof fetch,
  });
  client.use({
    onRequest({ request }) {
      const token = jar.get("wardenx_csrf");
      if (token) request.headers.set("x-csrf-token", token);
      return request;
    },
  });

  return { client, userId, organizationId: org.organizationId, email };
}

/** Look up a seeded demo patient's id by exact last name (the 6 db:seed:patients demo patients). */
export async function findPatientIdByLastName(
  session: WxSession,
  lastName: string,
): Promise<string> {
  const { data, error } = await session.client.GET("/api/v1/patients", {
    params: { query: { q: lastName, limit: 20 } },
  });
  if (error) throw new Error(`patient search for "${lastName}" failed: ${JSON.stringify(error)}`);
  const hit = data?.items.find((p) => p.lastName === lastName);
  if (!hit)
    throw new Error(`no patient found with last name "${lastName}" — run db:seed:patients first`);
  return hit.id;
}

/** Simple run-summary accumulator so every scenario script logs a consistent created/skipped/failed tally. */
export class ScenarioLog {
  private created = 0;
  private skipped = 0;
  private failed = 0;
  constructor(private readonly label: string) {}

  ok(msg: string): void {
    this.created++;
    console.log(`  ✓ ${msg}`);
  }
  dup(msg: string): void {
    this.skipped++;
    console.log(`  • ${msg}`);
  }
  fail(msg: string): void {
    this.failed++;
    console.log(`  ✗ ${msg}`);
  }
  /**
   * A step that could not run because a PLATFORM capability is unbound — not because the seed is wrong.
   * Counted as skipped, so `db:seed:all` stays green, and printed distinctly so the output says which
   * capability and which issue rather than looking like a seeding bug. Use only for a named, filed gap.
   */
  blocked(msg: string): void {
    this.skipped++;
    console.log(`  ⊘ ${msg}`);
  }
  summary(): void {
    console.log(
      `\n✓ ${this.label}: ${this.created} created, ${this.skipped} skipped (already present), ${this.failed} failed.`,
    );
    if (this.failed > 0) process.exitCode = 1;
  }
}
