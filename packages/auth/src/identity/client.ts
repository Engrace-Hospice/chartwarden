// @wardenx/auth/client — browser-safe Better Auth client (M2, AUTH-T07 / ADR-0034, ADR-0033 §4).
//
// The FRONTEND auth surface. Sign-in / MFA go through Better Auth's own client (NOT the generated REST
// client — ADR-0032/0033). This file imports ONLY `better-auth/react` + its client plugins; it pulls in
// NO server code (no @wardenx/db, drizzle, or the auth instance), so it is safe to bundle into apps/web.
// Exposed via the package's "./client" subpath export; the vendor-adapter rule is satisfied because
// `better-auth` is imported inside packages/auth (its owner).
//
// A narrow, nameable interface is declared for the methods screens use — Better Auth's full client type
// is not portably nameable across the composite project boundary (TS2742), and the frontend only needs
// this slice. Extend it as screens grow (signUp, forgetPassword, passkey.*).
import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export interface AuthResult {
  readonly error: { readonly message?: string } | null;
}

/** sign-in may succeed, fail, or require a second factor (twoFactorRedirect). */
export interface SignInResult extends AuthResult {
  readonly data?: { readonly twoFactorRedirect?: boolean } | null;
}

export interface PasskeyInfo {
  readonly id: string;
  readonly name?: string | null;
  readonly createdAt?: string;
  readonly deviceType?: string | null;
}

/** The current session's user, as the client reports it (the subset screens need). */
export interface SessionUser {
  /** The user's stable id (Better Auth's user PK) — present on every session user at runtime. */
  readonly id: string;
  readonly email: string | null;
  readonly username?: string | null;
  readonly name?: string | null;
}

/** The session record's server-bound fields the client surfaces (additionalFields, §3.6). */
export interface SessionInfo {
  /** The session class (staff | auditor | external_collaborator | funeral_home) — gates screen-lock. */
  readonly sessionClass?: string | null;
  readonly activeOrganizationId?: string | null;
}

export interface ChartWardenAuthClient {
  signIn: {
    email(input: { email: string; password: string }): Promise<SignInResult>;
    username(input: { username: string; password: string }): Promise<SignInResult>;
    passkey(): Promise<AuthResult>;
  };
  /** TASK-030 — the invitee's account-creation step (the invite email is fixed by the invite token,
   *  not user-editable; `name` is the one field Better Auth's `user` row otherwise has no source for). */
  signUp: {
    email(input: {
      email: string;
      password: string;
      name: string;
      /** Better Auth's per-request options. GAP-009: the invite page sends `x-invite-token` here. */
      fetchOptions?: { headers?: Record<string, string> };
    }): Promise<AuthResult>;
  };
  signOut(): Promise<AuthResult>;
  /** Read the current session (null when unauthenticated) — drives screen-lock (soft re-auth + class gate). */
  getSession(): Promise<{
    data?: { user: SessionUser; session?: SessionInfo } | null;
    error: { message?: string } | null;
  }>;
  /** Forgot-password step 1: email a single-use reset link (token lands on `redirectTo`). */
  requestPasswordReset(input: { email: string; redirectTo: string }): Promise<AuthResult>;
  /** Forgot-password step 2: set a new password using the token from the reset link. */
  resetPassword(input: { newPassword: string; token: string }): Promise<AuthResult>;
  twoFactor: {
    verifyTotp(input: { code: string }): Promise<AuthResult>;
    verifyBackupCode(input: { code: string }): Promise<AuthResult>;
  };
  passkey: {
    addPasskey(input?: { name?: string }): Promise<AuthResult>;
    listUserPasskeys(): Promise<{
      data?: PasskeyInfo[] | null;
      error: { message?: string } | null;
    }>;
    deletePasskey(input: { id: string }): Promise<AuthResult>;
  };
}

/**
 * Build the WardenX auth client (with the 2FA challenge plugin). `baseURL` is the app origin Better Auth
 * serves `/api/auth/*` under; omit it in the browser to use the current origin (the Vite dev proxy
 * forwards /api to the backend).
 */
export function createChartWardenAuthClient(baseURL?: string): ChartWardenAuthClient {
  return createAuthClient({
    ...(baseURL ? { baseURL } : {}),
    plugins: [twoFactorClient(), usernameClient(), passkeyClient()],
  }) as unknown as ChartWardenAuthClient;
}
