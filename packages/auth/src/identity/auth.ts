import { passkey } from "@better-auth/passkey";
// @wardenx/auth · identity — Better Auth integration (M2-T01; M2 spec §1, §3.1).
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
import { schema } from "@wardenx/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { haveIBeenPwned, magicLink, twoFactor } from "better-auth/plugins";
import { type EmailTransport, createNoopEmailTransport } from "./email-transport";
import { argon2idHash, argon2idVerify } from "./password-hash";
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
  return betterAuth({
    appName: "WardenX",
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
    // M1's identity PKs are `uuid` (defaultRandom) — Better Auth's default id generator emits non-UUID
    // strings, which fail to insert into a uuid column (AUTH-T06 live finding). Generate UUIDs instead;
    // a UUID string is valid for the uuid PKs (user/session/account/passkey) AND for verification's
    // text id. (ADR-0033.)
    advanced: { database: { generateId: () => crypto.randomUUID() } },
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
      sendResetPassword: async (data: { user: { email: string }; url: string; token: string }) => {
        if (options.sendResetPassword) {
          await options.sendResetPassword(data);
          return;
        }
        await emailTransport.send({
          to: data.user.email,
          subject: "Reset your WardenX password",
          text: `Reset your WardenX password using this link (it expires shortly):\n\n${data.url}\n\nIf you didn't request this, you can ignore this email.`,
        });
      },
    },
    // M2 plugins (M2-T05). The `organization` plugin is deliberately NOT used: WardenX owns its org /
    // membership / invitation model (M1/M2 tables + RLS + select-organization), which Better Auth's
    // org plugin would duplicate/conflict with; the session's `activeOrganizationId` additionalField
    // carries the binding instead. Magic-link + reset delivery flow through M36's transactional email
    // transport, injected at the composition root (FB-T14). Runtime + any schema reconciliation are
    // exercised in the AUTH-T06 live-PG lane.
    plugins: [
      haveIBeenPwned(), // HIBP k-anonymity breach check (M2 §3.1)
      // TOTP + backup codes (M2 §3.1). Field-map to M1's at-rest-encrypted columns (the decorator
      // above seals/opens the values); ADR-0034. SMS fallback never qualifies as step-up.
      twoFactor({
        issuer: "WardenX",
        schema: {
          twoFactor: { fields: { secret: "secretEncrypted", backupCodes: "backupCodesEncrypted" } },
        },
      }),
      passkey({
        rpName: "WardenX",
        rpID: process.env.PASSKEY_RP_ID ?? "localhost",
        origin: process.env.BETTER_AUTH_URL ?? "http://localhost:5173",
        // Field-map: Better Auth's `credentialID` → M1's drizzle property `credentialId` (the other
        // passkey fields — publicKey/deviceType/backedUp/transports/counter/aaguid — already match the
        // M1 bindings). The WebAuthn ceremony is browser-only, so this is e2e- (not CI-) verified.
        schema: { passkey: { fields: { credentialID: "credentialId" } } },
      }),
      magicLink({
        // Auditor / external-collaborator / funeral-home magic-link classes. Token is generated
        // server-side; the link is delivered through M36's transactional email transport, bound to this
        // port at the composition root (FB-T14). Stamping the session CLASS on consume is the §3 follow-up.
        sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
          await emailTransport.send({
            to: email,
            subject: "Your WardenX sign-in link",
            text: `Sign in to WardenX using this link (it expires shortly):\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
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
    session: {
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
