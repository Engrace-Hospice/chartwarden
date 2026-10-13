// M34 first-admin invitation secret. The emailed URL carries the RAW token; `tenant_invitation.token_hash` stores
// only its sha256 hex, and the public accept route hashes the URL's token the same way. Shared by the provision
// worker (first invitation) and the platform issue/resend route so the two can never disagree on the scheme.
import { createHash, randomBytes } from "node:crypto";

/** What delivers the invitation email (the provision gateway in prod) and where the accept page lives. */
export interface InvitationDeliveryPort {
  readonly acceptBaseUrl: string;
  send(input: {
    readonly to: string;
    readonly inviteeFullName: string;
    readonly invitationUrl: string;
    readonly expiresAt: Date;
  }): Promise<void>;
}

/**
 * A first-admin invitation grants org_admin through the PUBLIC accept route, so it may only be minted or redeemed
 * while the tenant is being set up or live. A suspended, flagged or offboarded tenant must not gain an admin back.
 */
const INVITABLE_TENANT_STATUSES: ReadonlySet<string> = new Set([
  "provisioning",
  "onboarding",
  "active",
]);

export const canInviteFirstAdmin = (tenantStatus: string): boolean =>
  INVITABLE_TENANT_STATUSES.has(tenantStatus);

export interface MintedInvitationToken {
  readonly rawToken: string;
  readonly tokenHash: string;
  readonly invitationUrl: string;
}

export function mintInvitationToken(acceptBaseUrl: string): MintedInvitationToken {
  const rawToken = randomBytes(32).toString("base64url");
  return {
    rawToken,
    tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    invitationUrl: `${acceptBaseUrl.replace(/\/$/, "")}/${rawToken}`,
  };
}
