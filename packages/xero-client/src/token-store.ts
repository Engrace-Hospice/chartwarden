// @chartwarden/xero-client — per-tenant OAuth token-store PORT (M27 §6 `oauth/`, D6).
//
// OAuth is per-tenant with isolated refresh (spec §41). The persistence + the real refresh round-trip
// (Xero's identity `/connections` + token endpoint) land in M34 tenant-onboarding — see the
// TODO(M34-oauth) boundary below. This module owns only the PORT shape the factory injects, plus a
// fail-closed default that reports "no tenant connected" so the factory surfaces a reconnect prompt
// rather than silently succeeding.
import { XERO_NOT_CONNECTED } from "./constants";

/** A decrypted per-tenant OAuth token set for one Xero connection. Never logged. */
export interface XeroTokens {
  /** Bearer access token sent on every Xero API request. */
  readonly accessToken: string;
  /** Long-lived refresh token exchanged when the access token 401s. */
  readonly refreshToken: string;
  /** ISO-8601 access-token expiry; the refresh wrapper may pre-empt on this, but 401 is authoritative. */
  readonly expiresAt: string;
  /** The Xero-side tenant (organisation) id this token set authorizes. */
  readonly xeroTenantId: string;
}

/**
 * The injected token-store port. The live implementation (a Drizzle-backed, envelope-decrypting store
 * over the per-tenant Xero connection rows) is provided by M27's composition root once tenant OAuth
 * onboarding lands in M34. The factory is fail-closed without it.
 */
export interface TokenStore {
  /**
   * Resolve the current token set for a tenant connection, or `null` when the tenant has not connected
   * Xero (or the requested `xeroTenantId` is unknown). `null` ⇒ the factory throws {@link XERO_NOT_CONNECTED}.
   */
  getTokensForTenant(organizationId: string, xeroTenantId?: string): Promise<XeroTokens | null>;
  /**
   * Exchange the refresh token for a fresh access token and persist + return the rotated set. Called by
   * the refresh-on-401 wrapper (see oauth.ts). Must rotate the stored refresh token (Xero rotates on use).
   */
  refresh(organizationId: string, tokens: XeroTokens): Promise<XeroTokens>;
}

/**
 * The fail-closed default store: no tenant is ever "connected", and any refresh attempt throws
 * {@link XERO_NOT_CONNECTED}. The default {@link import("./index").xeroClientFactory} is built on this so
 * an un-wired environment fails closed; the live store is injected via `createXeroClientFactory`.
 *
 * TODO(M34-oauth): replace with the Drizzle-backed per-tenant token store + Xero refresh round-trip
 * wired at tenant onboarding. That store is the ONLY place the real refresh HTTP call may live.
 */
export const NO_TOKEN_STORE: TokenStore = {
  async getTokensForTenant(): Promise<XeroTokens | null> {
    return null;
  },
  async refresh(): Promise<XeroTokens> {
    throw new Error(XERO_NOT_CONNECTED);
  },
};
