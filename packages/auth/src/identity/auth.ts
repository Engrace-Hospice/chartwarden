import { createHash } from "node:crypto";
import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
// @chartwarden/auth · identity — Better Auth integration (M2-T01; M2 spec §1, §3.1).
//
// This file is the ONE place `better-auth` may be imported (vendor-adapter mandate,
// ARCHITECTURE §25.14 / manifest VENDOR_ADAPTERS["better-auth"] = "packages/auth";
// enforced by the `vendor-adapter-better-auth` dependency-cruiser rule). The rest of the
// system depends on this module's typed exports — never on `better-auth` directly.
//
// It configures Better Auth against Module 1's identity tables (`user`, `session`,
// `account`, `verification`); M1 owns those tables, M2 owns their auth behavior
// (M02-F01). Per ADR-0026, Better Auth is the SINGLE authentication surface — no module
// mints its own session tokens.
//
// Scope note: M2-T01 landed the base Better Auth instance + Drizzle binding. M2-T03 adds
// the four session classes + the session additionalFields (class / scope / engagement
// window / screen-lock / step-up freshness) below — see ./session-classes for the class
// taxonomy + lifecycle state machine. Argon2id password hashing + HIBP breach check
// (password-policy), the org / two-factor / passkey / magic-link plugins (M2-T02+), the
// explicit step-up route that writes the step-up fields (M2-T05), and the published
// session seams (M2-T07) land in their own tasks.
import { type DbClient, schema } from "@chartwarden/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { haveIBeenPwned, magicLink, twoFactor, username } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { type AuthAuditEvent, type AuthAuditSink, buildPasswordResetEvent } from "./auth-audit";
import { credentialAdminPlugin, isAllowedUsername, normalizeUsername } from "./credential-admin";
import { type EmailTransport, createNoopEmailTransport } from "./email-transport";
import { hostOnlyCookieOptions } from "./host-only-cookies";
import { linkSessionPlugin } from "./link-session";
import { argon2idHash, argon2idVerify } from "./password-hash";
import { SESSION_MAX_ABSOLUTE_SEC, isUserStatusBlocked } from "./session-timeout";
import { type TenantOriginMatcher, rewriteLinkToRequestOrigin } from "./tenant-origin";
import { type EncryptableAdapter, withTwoFactorEncryption } from "./two-factor-adapter";
import { loadTwoFactorKey } from "./two-factor-crypto";

/**
 * The Drizzle database handle Better Auth reads/writes through. Typed as the adapter's
 * own `DB` contract so this module stays decoupled from any particular Drizzle client
 * construction — the live pg client is injected at boot (no shared client exists in the
 * slice; the codebase injects `db` structurally everywhere, cf. `withOrgContext`).
 */
export type IdentityAuthDb = Parameters<typeof drizzleAdapter>[0];

/**
 * Delivers a password-reset link. Better Auth mints the single-use token and calls this with the
 * full reset `url` (token in its query). The composition root injects M36's transactional email
 * transport at boot (FB-T14); the default is a no-op stub (the token-issuance + resetPassword flow
 * works regardless). This is the delivery SEAM — the auth-live lane injects a capturing sender to
 * exercise the full flow.
 */
export type ResetPasswordSender = (data: {
  readonly user: { readonly email: string };
  readonly url: string;
  readonly token: string;
}) => Promise<void> | void;

/** Optional injected behavior for the identity auth instance (delivery seams). */
export interface IdentityAuthOptions {
  /**
   * Token-capturing override for the password-reset link (the auth-live lane uses this to drive the
   * full reset). When omitted, the reset link is delivered through `emailTransport`.
   */
  readonly sendResetPassword?: ResetPasswordSender;
  /**
   * The transactional email transport reset + magic-link links are delivered through. Defaults to a
   * no-op (links are minted but not delivered — the prior behavior); the composition root injects a
   * console transport in dev and a provider adapter when credentials are present.
   */
  readonly emailTransport?: EmailTransport;
  /**
   * GAP-009 — when true, `POST /api/auth/sign-up/email` needs an `x-invite-token` header naming a pending,
   * unexpired invitation issued to the SAME email, and magic-link sign-in may not create accounts. When
   * omitted, {@link resolveSignUpRequiresInvite} decides from the environment.
   */
  readonly requireInviteForSignUp?: boolean;
  /**
   * GAP-002 - persists `m2.auth.password_reset` (the one auth event only Better Auth's own callback can
   * attribute to a user). The other auth events are written by the Fastify bridge (`registerIdentityAuth`).
   */
  readonly auditSink?: AuthAuditSink;
  /** Called when the audit sink rejects; a failed audit write never fails the password reset. */
  readonly onAuditError?: (err: unknown, event: AuthAuditEvent) => void;
  /**
   * ADR-0049 D6 — subdomain mode. A request whose Origin is `https://<live tenant>.<base domain>` is trusted by
   * rule on top of the static allowlist, and the passkey ceremony takes the (already validated) request origin.
   * Omitted in single-host mode, which keeps the static allowlist byte for byte.
   */
  readonly tenantOrigins?: TenantOriginMatcher;
  /** Does this email hold an active membership in the organization served at this host? Gates the reset / magic-link host rewrite. */
  readonly userMayUseTenantHost?: (email: string, host: string) => Promise<boolean>;
}

/** The header the invitee's sign-up carries; its value is the one-time invitation token. */
export const INVITE_TOKEN_HEADER = "x-invite-token";

/**
 * Whether open self-registration is closed. `CHARTWARDEN_SIGNUP_REQUIRES_INVITE` (`true`/`false`) wins;
 * unset, it is STRICT in production and OPEN everywhere else — the dev seeds and the in-process suites
 * create their users through the sign-up API and have no invitation to present.
 */
export function resolveSignUpRequiresInvite(env: {
  readonly CHARTWARDEN_SIGNUP_REQUIRES_INVITE?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}): boolean {
  if (env.CHARTWARDEN_SIGNUP_REQUIRES_INVITE === "true") return true;
  if (env.CHARTWARDEN_SIGNUP_REQUIRES_INVITE === "false") return false;
  return env.NODE_ENV === "production";
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * True when `token` names a pending, unexpired invitation issued to `email`. Reads through M2's
 * `m2_find_invitation_by_token` SECURITY DEFINER function (migration 0324): the signer has no org bound
 * and `organization_invitation` is RLS-scoped. Pure read — the one-time token is consumed later, by
 * `POST /invitations/accept`, not here.
 */
async function inviteTokenMatchesEmail(
  db: DbClient,
  token: string,
  email: string,
): Promise<boolean> {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await db.execute(sql`SELECT * FROM m2_find_invitation_by_token(${tokenHash})`);
  const row = (
    result as unknown as {
      rows?: { email: string; status: string; expires_at: string | Date }[];
    }
  ).rows?.[0];
  if (!row || row.status !== "pending") return false;
  if (new Date(row.expires_at).getTime() <= Date.now()) return false;
  return normalizeEmail(row.email) === normalizeEmail(email);
}

/**
 * Maps Better Auth's canonical model names onto M1's Drizzle table objects. M1 names the
 * tables in plural JS bindings (`users`) over singular SQL tables (`"user"`); Better Auth
 * keys models singularly, so we map explicitly rather than rely on `usePlural`.
 */
const m1Schema = {
  user: schema.users,
  session: schema.sessions,
  account: schema.accounts,
  verification: schema.verifications,
  // M2-T05 plugin models (M1-owned tables): TOTP/backup-code secrets + WebAuthn credentials.
  twoFactor: schema.twoFactor,
  passkey: schema.passkey,
};

/**
 * TASK-010 (SEC-005/OPS-010): `PASSKEY_RP_ID` unset previously fell through to a hardcoded
 * `"localhost"` regardless of `NODE_ENV` — in production that silently weakens (or outright breaks)
 * every WebAuthn ceremony instead of refusing to boot. `bootstrap/env.ts` now requires the var in
 * production too; this is the defense-in-depth twin at the point of use (mirrors the `session-step-up`
 * route's `resolveWebauthnRpId`).
 */
/**
 * The WebAuthn relying-party id passkeys are ENROLLED under.
 *
 * Exported because step-up VERIFICATION has to use the identical value: @simplewebauthn checks the
 * asserted RP id hash against the expected one, so a step-up that resolved its own would refuse every
 * passkey this instance ever enrolled — and would do it as "assertion invalid", which reads as an
 * attack rather than as a misconfiguration.
 */
export function resolvePasskeyRpId(): string {
  const configured = process.env.PASSKEY_RP_ID;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("PASSKEY_RP_ID is required in production");
  }
  return "localhost";
}

/**
 * The BROWSER origins a WebAuthn ceremony may run on — same argument as {@link resolvePasskeyRpId}, and
 * the same value enrolment and step-up verification must both use.
 *
 * F-081 — this used to return `BETTER_AUTH_URL ?? "http://localhost:5173"`, which is two different
 * things wearing one name. `BETTER_AUTH_URL` is the AUTH SERVER's base URL; WebAuthn's `expectedOrigin`
 * is the origin of the PAGE that ran `navigator.credentials.*`, i.e. the SPA. The `:5173` fallback is
 * the SPA origin, so the intent was right — but production REQUIRES `BETTER_AUTH_URL`, and any
 * deployment that does not serve the SPA same-origin therefore refused every registration with
 * `Unexpected registration response origin "<spa>", expected "<api>"`. Proven on this repo's own dev
 * stack, where the web app is Vite on :5173 and the API is :3000.
 *
 * It resolves from the SAME source the CSRF layer already trusts (`TRUSTED_ORIGINS`, plus `baseURL`,
 * which Better Auth trusts implicitly) rather than a new env var, because the two questions have one
 * answer: an origin the browser may call this API from is exactly an origin a ceremony may run on, and
 * a second variable is a second thing to get wrong. @simplewebauthn accepts the list.
 */
export function resolvePasskeyOrigins(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const trusted = resolveWebTrustedOrigins(env);
  const base =
    env.BETTER_AUTH_URL ?? (env.NODE_ENV === "production" ? undefined : "http://localhost:3000");
  // `baseURL` last: a same-origin deployment names it and nothing else, and a split deployment needs
  // the SPA origin in the list either way. Deduped so an origin present in both is not repeated in the
  // "expected one of: …" message a genuine mismatch prints.
  return [...new Set([...trusted, ...(base ? [base] : [])])];
}

/**
 * Browser HTTP(S) origins allowed to call this server. This is also the only allowlist WebAuthn and
 * CORS may consume: a native deep-link scheme is not a WebAuthn expectedOrigin and is not a browser
 * CORS origin.
 */
export function resolveWebTrustedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.TRUSTED_ORIGINS) {
    const origins = env.TRUSTED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    for (const origin of origins) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error("TRUSTED_ORIGINS must contain exact HTTP(S) origins");
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        origin.replace(/\/$/, "") !== parsed.origin
      ) {
        throw new Error("TRUSTED_ORIGINS must contain exact HTTP(S) origins");
      }
    }
    return [...new Set(origins.map((origin) => origin.replace(/\/$/, "")))];
  }
  if (env.NODE_ENV === "production") return [];
  // The three local-dev SPAs: web (:5173), portal (:5174), the admin/platform-ops console (:5175) —
  // each proxies /api to this backend at a different Vite dev-server origin.
  return ["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"];
}

/**
 * Explicit native callback schemes trusted by Better Auth's Expo integration.
 *
 * The value is intentionally separate from `TRUSTED_ORIGINS`: it may contain only exact custom
 * schemes (`chartwarden://`), never HTTP(S), `null`, a wildcard, host, path or query. Universal/App Links
 * are HTTPS browser origins and belong in `TRUSTED_ORIGINS`. There is no implicit production or
 * localhost fallback.
 */
export function resolveMobileAuthOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.MOBILE_AUTH_TRUSTED_ORIGINS;
  if (!raw?.trim()) return [];
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    if (
      !/^[a-z][a-z0-9+.-]*:\/\/$/i.test(origin) ||
      /^https?:/i.test(origin) ||
      /^exp:/i.test(origin)
    ) {
      throw new Error(
        "MOBILE_AUTH_TRUSTED_ORIGINS must contain exact custom schemes such as chartwarden://",
      );
    }
  }
  return [...new Set(origins)];
}

/** Better Auth's complete exact allowlist: browser origins plus native callback schemes. */
export function resolveTrustedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [...new Set([...resolveWebTrustedOrigins(env), ...resolveMobileAuthOrigins(env)])];
}

/**
 * Better Auth's Expo plugin trusts the broad `exp://` scheme automatically in development. ChartWarden
 * requires every native scheme to be configured explicitly, so retain the official plugin's request
 * and callback handling while removing only that implicit development initializer. This is pinned to
 * @better-auth/expo 1.7.14 and covered by the config-shape test.
 */
function explicitOriginsExpoPlugin(): ReturnType<typeof expo> {
  const { init: _implicitDevelopmentOrigin, ...plugin } = expo();
  return plugin as ReturnType<typeof expo>;
}

/**
 * Builds the Better Auth instance bound to M1's identity tables.
 *
 * `db` is injected so the host wires the real pooled pg client at boot while tests/build
 * stay infra-free. `account.fields` reconciles Better Auth's canonical column names with
 * M1's at-rest-encrypted naming (`passwordHash`, `accessTokenEncrypted`,
 * `refreshTokenEncrypted`); `session.additionalFields` declares M1's server-bound
 * `active_organization_id` so Better Auth round-trips the org binding for a session.
 */
export function createIdentityAuth(db: IdentityAuthDb, options: IdentityAuthOptions = {}) {
  // The delivery transport for reset + magic-link links (no-op unless the host injects one).
  const emailTransport = options.emailTransport ?? createNoopEmailTransport();
  const requireInvite = options.requireInviteForSignUp ?? resolveSignUpRequiresInvite(process.env);
  return betterAuth({
    appName: "ChartWarden",
    secret: process.env.BETTER_AUTH_SECRET,
    // `baseURL` is the canonical origin of the auth server (this backend) — used for callbacks,
    // redirects, and cookie domains. Production MUST set BETTER_AUTH_URL (the deploy host); we keep it
    // fail-loud there (undefined → Better Auth warns) rather than silently pinning a wrong origin. Dev
    // and test fall back to the local backend origin so the "Base URL is not set" warning stays out of
    // the dev/test output (mirrors the passkey `origin` fallback below). Multi-host front-ends (e.g. the
    // M31 per-tenant portal) are an additive `trustedOrigins` concern, not a second baseURL.
    baseURL:
      process.env.BETTER_AUTH_URL ??
      (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3000"),
    // The web app is served from a different origin than this auth server (dev: Vite :5173 proxying to
    // the backend :3000), so the browser's Origin header won't match `baseURL` and Better Auth's CSRF
    // check rejects it (INVALID_ORIGIN). `trustedOrigins` is the additive allowlist for those front-end
    // hosts (comma-separated `TRUSTED_ORIGINS`); dev falls back to the Vite origin. `baseURL` is always
    // trusted regardless, so production that serves the SPA same-origin needs no entry here.
    trustedOrigins: options.tenantOrigins
      ? async (request?: Request) => {
          const fixed = resolveTrustedOrigins();
          if (!request) return fixed;
          // A link opened from a mail client is a plain navigation with no Origin header; its own https host stands
          // in, so the tenant-host callbackURL the Phase 4 rewrite put in the link still validates.
          const requestHostHeader = request.headers.get("host")?.toLowerCase();
          const origin =
            request.headers.get("origin") ??
            (requestHostHeader ? `https://${requestHostHeader}` : null);
          if (!origin) return fixed;
          // A tenant origin is only valid for its own host (tenant hosts are same-site, so a sibling tenant's page
          // must not pass); the lookup runs only once the host matches.
          const requestHost =
            request.headers.get("host")?.toLowerCase() ?? new URL(request.url).host;
          let originHost: string;
          try {
            originHost = new URL(origin).host;
          } catch {
            return fixed;
          }
          if (originHost !== requestHost) return fixed;
          return (await options.tenantOrigins?.isTrusted(origin)) ? [...fixed, origin] : fixed;
        }
      : resolveTrustedOrigins(),
    // M1's identity PKs are `uuid` (defaultRandom) — Better Auth's default id generator emits non-UUID
    // strings, which fail to insert into a uuid column (AUTH-T06 live finding). Generate UUIDs instead;
    // a UUID string is valid for the uuid PKs (user/session/account/passkey) AND for verification's
    // text id. (ADR-0033.)
    advanced: { database: { generateId: () => crypto.randomUUID() }, ...hostOnlyCookieOptions() },
    // ADR-0034: wrap the Drizzle adapter so the twoFactor secret + backup codes are AES-256-GCM-encrypted
    // at rest (Better Auth's plugin stores them plaintext). The key loads lazily (only on a 2FA op), so
    // construction never requires TWO_FACTOR_ENCRYPTION_KEY. `database` accepts an adapter factory
    // (options) => Adapter; the wrapper decorates the inner Drizzle adapter per request.
    database: ((options: unknown) =>
      withTwoFactorEncryption(
        (
          drizzleAdapter(db, { provider: "pg", schema: m1Schema }) as unknown as (
            o: unknown,
          ) => EncryptableAdapter
        )(options),
        () => loadTwoFactorKey(),
      )) as never,
    emailAndPassword: {
      // M2 §3.1 (AUTH-T04): NIST 800-63B-aligned — length floor (no composition rules), Argon2id
      // hashing, and the HIBP k-anonymity breach check (haveIBeenPwned plugin below). No upper-bound
      // truncation surprises (max well above any real passphrase).
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      password: {
        hash: argon2idHash,
        verify: ({ hash, password }) => argon2idVerify(hash, password),
      },
      // M2 §3.1 (AUTH polish): self-service password reset. Better Auth mints a single-use,
      // time-boxed token and calls this with the reset URL (token in the query of `redirectTo`).
      // A token-capturing override (auth-live lane) takes precedence; otherwise the link is delivered
      // through the injected email transport. The new hash re-runs Argon2id (the `password` config
      // above), so reset credentials are stored identically.
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        if (!options.auditSink) return;
        const event = buildPasswordResetEvent(user.id);
        try {
          await options.auditSink(event);
        } catch (err) {
          options.onAuditError?.(err, event);
        }
      },
      sendResetPassword: async (
        rawData: { user: { email: string }; url: string; token: string },
        request?: Request,
      ) => {
        // Phase 4: on a tenant host the link opens on that host (see rewriteLinkToRequestOrigin for the guards).
        const data = {
          ...rawData,
          url: await rewriteLinkToRequestOrigin(
            rawData.url,
            request,
            options.tenantOrigins,
            rawData.user.email,
            options.userMayUseTenantHost,
          ),
        };
        if (options.sendResetPassword) {
          await options.sendResetPassword(data);
          return;
        }
        await emailTransport.send({
          to: data.user.email,
          subject: "Reset your ChartWarden password",
          text: `Reset your ChartWarden password using this link (it expires shortly):\n\n${data.url}\n\nIf you didn't request this, you can ignore this email.`,
        });
      },
    },
    // M2 plugins (M2-T05). The `organization` plugin is deliberately NOT used: ChartWarden owns its org /
    // membership / invitation model (M1/M2 tables + RLS + select-organization), which Better Auth's
    // org plugin would duplicate/conflict with; the session's `activeOrganizationId` additionalField
    // carries the binding instead. Magic-link + reset delivery flow through M36's transactional email
    // transport, injected at the composition root (FB-T14). Runtime + any schema reconciliation are
    // exercised in the AUTH-T06 live-PG lane.
    plugins: [
      // Native clients use the same Better Auth instance, tables, routes and session cookies. The
      // plugin maps Expo's explicit `expo-origin` header into Better Auth's existing origin check; it
      // does not introduce a token type or a second auth surface.
      explicitOriginsExpoPlugin(),
      // Server-only mint of the session a REDEEMED collaborator / funeral-home link yields (never on the HTTP router).
      linkSessionPlugin(),
      credentialAdminPlugin(),
      username({
        minUsernameLength: 3,
        maxUsernameLength: 32,
        usernameNormalization: normalizeUsername,
        usernameValidator: isAllowedUsername,
        validationOrder: { username: "post-normalization" },
      }),
      haveIBeenPwned({
        // Keep Better Auth's defaults and include the two trusted server-only credential writers.
        // Their endpoint metadata is SERVER_ONLY, so these paths are context labels for the hashing
        // hook and are never mounted on the HTTP router.
        paths: [
          "/sign-up/email",
          "/change-password",
          "/reset-password",
          "/email-otp/reset-password",
          "/phone-number/reset-password",
          "/admin/create-user",
          "/admin/set-user-password",
          "/_chartwarden-internal/provision-identity-credential",
          "/_chartwarden-internal/replace-identity-password",
        ],
      }), // HIBP k-anonymity breach check (M2 §3.1)
      // TOTP + backup codes (M2 §3.1). Field-map to M1's at-rest-encrypted columns (the decorator
      // above seals/opens the values); ADR-0034. SMS fallback never qualifies as step-up.
      twoFactor({
        issuer: "ChartWarden",
        schema: {
          twoFactor: { fields: { secret: "secretEncrypted", backupCodes: "backupCodesEncrypted" } },
        },
      }),
      passkey({
        rpName: "ChartWarden",
        rpID: resolvePasskeyRpId(),
        // Subdomain mode: Better Auth's global origin check (trustedOrigins above) has already validated the
        // request Origin, and `null` makes the ceremony expect exactly that origin.
        origin: options.tenantOrigins ? null : [...resolvePasskeyOrigins()],
        // Field-map: Better Auth's `credentialID` → M1's drizzle property `credentialId` (the other
        // passkey fields — publicKey/deviceType/backedUp/transports/counter/aaguid — already match the
        // M1 bindings). The WebAuthn ceremony is browser-only, so this is e2e- (not CI-) verified.
        schema: { passkey: { fields: { credentialID: "credentialId" } } },
      }),
      magicLink({
        // Closed registration (GAP-009): a magic link may sign an EXISTING user in, never mint an account.
        disableSignUp: requireInvite,
        // Auditor / external-collaborator / funeral-home magic-link classes. Token is generated
        // server-side; the link is delivered through M36's transactional email transport, bound to this
        // port at the composition root (FB-T14). Stamping the session CLASS on consume is the §3 follow-up.
        sendMagicLink: async (
          { email, url: rawUrl }: { email: string; url: string },
          ctx?: { request?: Request },
        ) => {
          const url = await rewriteLinkToRequestOrigin(
            rawUrl,
            ctx?.request,
            options.tenantOrigins,
            email,
            options.userMayUseTenantHost,
          );
          await emailTransport.send({
            to: email,
            subject: "Your ChartWarden sign-in link",
            text: `Sign in to ChartWarden using this link (it expires shortly):\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
          });
        },
      }),
    ],
    account: {
      fields: {
        password: "passwordHash",
        accessToken: "accessTokenEncrypted",
        refreshToken: "refreshTokenEncrypted",
      },
    },
    user: {
      additionalFields: {
        credentialState: { type: "string", required: false, defaultValue: "active", input: false },
        credentialStateReason: { type: "string", required: false, input: false },
        credentialVersion: { type: "number", required: false, defaultValue: 0, input: false },
        passwordChangedAt: { type: "date", required: false, input: false },
      },
    },
    // GAP-009 — closed registration. Staff accounts are created through an invitation: the web accept page
    // signs the invitee up with the invitation token in `x-invite-token`, and the token must match the
    // sign-up email. Every refusal reads the same (no oracle for which tokens or emails exist).
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!requireInvite || ctx.path !== "/sign-up/email") return;
        const token = ctx.headers?.get(INVITE_TOKEN_HEADER);
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        const allowed =
          typeof token === "string" &&
          token.length > 0 &&
          typeof email === "string" &&
          (await inviteTokenMatchesEmail(db as unknown as DbClient, token, email));
        if (!allowed)
          throw new APIError("FORBIDDEN", { message: "INVITE_REQUIRED", code: "INVITE_REQUIRED" });
      }),
    },
    // GAP-001 — M2 §6: a suspended/deactivated user cannot authenticate. Every sign-in path (password,
    // passkey, magic link, 2FA completion) ends in a session insert, so refusing it here covers them all;
    // the authenticate hook's enforcer also revokes any such session on use.
    databaseHooks: {
      session: {
        create: {
          before: async (session: { userId: string }) => {
            const [user] = await (db as unknown as DbClient)
              .select({ status: schema.users.status })
              .from(schema.users)
              .where(eq(schema.users.id, session.userId))
              .limit(1);
            if (user && isUserStatusBlocked(user.status))
              throw new APIError("FORBIDDEN", { message: "USER_INACTIVE", code: "USER_INACTIVE" });
          },
        },
      },
    },
    session: {
      // GAP-002 — a FIXED lifetime, never extended on use. Better Auth's default was 7 days rolling
      // (refreshed daily), which outlived every SESSION_POLICY bound. The per-class idle/absolute
      // decision is the authenticate hook's (createDbSessionTimeoutEnforcer); this is only the outer
      // cap, sized to the longest FIXED class absolute so it never cuts one of those early. The auditor
      // class has no fixed absolute (engagement_end); for it this 72-h cap is an intended second bound —
      // see the AUDITOR note in ./session-timeout.
      expiresIn: SESSION_MAX_ABSOLUTE_SEC,
      disableSessionRefresh: true,
      // M2-T03 (M2 spec §3.6): the session-class / lifecycle / step-up fields are carried
      // as Better Auth additionalFields over M1's `session` table (their at-rest columns +
      // CHECK invariants live in packages/db/src/schema/sessions.ts). All are server-bound:
      // a session's class, scope, engagement window, and step-up freshness are decided by
      // the auth flow, never by client input. See SESSION_CLASSES / sessionLifecycle below.
      additionalFields: {
        activeOrganizationId: {
          type: "string",
          required: false,
          // Server-bound at session issuance / `select-organization` — never client input.
          input: false,
        },
        sessionClass: {
          type: "string",
          required: false,
          defaultValue: "staff",
          input: false,
        },
        // Class-specific scope, e.g. { patientId } for external_collaborator / funeral_home.
        scope: { type: "json", required: false, input: false },
        // Auditor engagement window (both bounds set for the auditor class).
        engagementStart: { type: "date", required: false, input: false },
        engagementEnd: { type: "date", required: false, input: false },
        // UI screen-lock timestamp (staff / auditor lifecycle).
        screenLockedAt: { type: "date", required: false, input: false },
        // Step-up freshness (paired-write: both set or both null) — M2-T05 writes these.
        lastStepUpAt: { type: "date", required: false, input: false },
        lastStepUpFactor: { type: "string", required: false, input: false },
      },
    },
  });
}

/** The configured Better Auth instance type, for consumers that hold a built instance. */
export type IdentityAuth = ReturnType<typeof createIdentityAuth>;
