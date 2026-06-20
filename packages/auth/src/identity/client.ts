// @wardenx/auth/client — browser-safe Better Auth client (M2, AUTH-T07, ADR-0033 §4).
//
// The FRONTEND auth surface. Sign-in / MFA / password-reset go through Better Auth's own client (NOT
// the generated REST client — ADR-0032/0033). This file imports ONLY `better-auth/react`; it pulls in
// NO server code (no @wardenx/db, drizzle, or the auth instance), so it is safe to bundle into apps/web.
// Exposed via the package's "./client" subpath export; the vendor-adapter rule is satisfied because
// `better-auth` is imported inside packages/auth (its owner).
//
// A narrow, nameable interface is declared for the methods screens use — Better Auth's full client type
// is not portably nameable across the composite project boundary (TS2742), and the frontend only needs
// this slice. Extend it as screens grow (signUp, forgetPassword, twoFactor.*, passkey.*).
import { createAuthClient } from "better-auth/react";

export interface AuthResult {
  readonly error: { readonly message?: string } | null;
}

export interface WardenxAuthClient {
  signIn: { email(input: { email: string; password: string }): Promise<AuthResult> };
  signOut(): Promise<AuthResult>;
}

/**
 * Build the WardenX auth client. `baseURL` is the app origin Better Auth serves `/api/auth/*` under;
 * omit it in the browser to use the current origin (the Vite dev proxy forwards /api to the backend).
 */
export function createWardenxAuthClient(baseURL?: string): WardenxAuthClient {
  return createAuthClient(baseURL ? { baseURL } : undefined) as unknown as WardenxAuthClient;
}
