// apps/backend/src/modules/02-identity/link-delivery.ts — delivers a collaborator / funeral-home link by email.
//
// The platform's transactional email transport is M36's (`selectTransactionalEmailTransport`), injected here
// structurally so M2 imports no vendor and takes no edge on M36 (the composition root is the bridge). The message is
// PHI-FREE by construction: it names no patient, no decedent, no organization detail - only that a secure link has
// been shared and when it expires. The token travels in the URL FRAGMENT (`#token=`), which a browser never sends to
// the server, a proxy, an access log or a `Referer` header; the landing page reads it client-side and POSTs it.
import type { LinkDeliveryPort } from "./identity-ports";

/** The slice of the platform email transport this needs (M36's `TransactionalEmailTransport`, structurally). */
export interface LinkEmailTransport {
  send(message: { to: string; subject: string; text: string }): Promise<unknown>;
}

const LANDING_PATH = {
  funeral_home: "/funeral/redeem",
  external_collaborator: "/collaborator/redeem",
} as const;

const SUBJECT = {
  funeral_home: "Your secure link from the hospice care team",
  external_collaborator: "Your secure link from the hospice care team",
} as const;

export function createLinkDelivery(input: {
  readonly transport: LinkEmailTransport;
  /** The SPA origin that serves the landing page (no trailing slash needed). */
  readonly baseUrl: string;
  /** Per-organization landing origin (tenant host + `/portal`); wins over `baseUrl` when it answers. */
  readonly baseUrlFor?: (organizationId: string) => Promise<string | undefined>;
}): LinkDeliveryPort {
  return {
    async deliver({ kind, organizationId, email, token, expiresAt }) {
      const base = ((await input.baseUrlFor?.(organizationId)) ?? input.baseUrl).replace(/\/$/, "");
      const url = `${base}${LANDING_PATH[kind]}#token=${encodeURIComponent(token)}`;
      await input.transport.send({
        to: email,
        subject: SUBJECT[kind],
        text: `A hospice care team has shared a secure link with you.\n\nOpen it to continue (it can be used once and expires ${expiresAt.toUTCString()}):\n\n${url}\n\nIf you weren't expecting this, you can ignore this email.`,
      });
    },
  };
}
