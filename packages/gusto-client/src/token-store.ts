// @wardenx/gusto-client — per-tenant OAuth token-store PORT (M27 §6 `oauth/`, D6).
//
// OAuth is per-tenant with isolated refresh (spec §43). The persistence + the real refresh round-trip
// (Gusto's token endpoint) land in M34 tenant-onboarding — see the TODO(M34-oauth) boundary below. This
// module owns only the PORT shape the factory injects, plus a fail-closed default that reports "no tenant
// connected" so the factory surfaces a reconnect prompt rather than silently succeeding. (Tenants on
// `wage_source='manual'` bypass this path entirely — manual S-3 entry, no Gusto pull.)
import { GUSTO_NOT_CONNECTED } from "./constants";

/** A decrypted per-tenant OAuth token set for one Gusto connection. Never logged. */
export interface GustoTokens {
  /** Bearer access token sent on every Gusto API request. */
  readonly accessToken: string;
  /** Long-lived refresh token exchanged when the access token 401s. */
  readonly refreshToken: string;
  /** ISO-8601 access-token expiry; the refresh wrapper may pre-empt on this, but 401 is authoritative. */
  readonly expiresAt: string;
  /** The Gusto-side company id this token set authorizes. */
  readonly gustoCompanyId: string;
}

/**
 * The injected token-store port. The live implementation (a Drizzle-backed, envelope-decrypting store over
 * the per-tenant Gusto connection rows) is provided by M27's composition root once tenant OAuth onboarding
 * lands in M34. The factory is fail-closed without it.
 */
export interface TokenStore {
  /**
   * Resolve the current token set for a tenant connection, or `null` when the tenant has not connected
   * Gusto (or the requested `gustoCompanyId` is unknown). `null` ⇒ the factory throws {@link GUSTO_NOT_CONNECTED}.
   */
  getTokensForTenant(organizationId: string, gustoCompanyId?: string): Promise<GustoTokens | null>;
  /**
   * Exchange the refresh token for a fresh access token and persist + return the rotated set. Called by
   * the refresh-on-401 wrapper (see oauth.ts). Must rotate the stored refresh token (Gusto rotates on use).
   */
  refresh(organizationId: string, tokens: GustoTokens): Promise<GustoTokens>;
}

/**
 * The fail-closed default store: no tenant is ever "connected", and any refresh attempt throws
 * {@link GUSTO_NOT_CONNECTED}. The default {@link import("./index").gustoClientFactory} is built on this so
 * an un-wired environment fails closed; the live store is injected via `createGustoClientFactory`.
 *
 * TODO(M34-oauth): replace with the Drizzle-backed per-tenant token store + Gusto refresh round-trip wired
 * at tenant onboarding. That store is the ONLY place the real refresh HTTP call may live.
 */
export const NO_TOKEN_STORE: TokenStore = {
  async getTokensForTenant(): Promise<GustoTokens | null> {
    return null;
  },
  async refresh(): Promise<GustoTokens> {
    throw new Error(GUSTO_NOT_CONNECTED);
  },
};
