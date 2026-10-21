// apps/backend/src/modules/02-identity/auditor-link-delivery.ts — email the auditor their magic link
// (M2 spec §4.7 `auth.send_magic_link`: collaborator / auditor / funeral invite → the transactional email
// transport). M3's `POST /engagements/:id/auditors` mints the link through the AuditorSessionMinter seam and
// hands the one-time token here; before this it was dropped on the floor, so no auditor ever received a link.
//
// The link is `<web origin>/auditor/redeem?org=<organizationId>#token=<token>`. The token rides the URL
// FRAGMENT, which a browser never sends to a server, so it is not in access logs, proxy logs or `Referer`;
// the redeem page reads it from `location.hash` and POSTs it. The organization id is not a secret.
//
// Fail closed: without a web origin no usable link can be built, so delivery THROWS (the enrolment route turns
// that into 503 AUDITOR_LINK_DELIVERY_FAILED) instead of reporting an auditor "pending" who was sent nothing.
// The token is never logged and never enters an error message.

/** The slice of M36's transactional email transport this needs (structurally `EmailTransport`). */
export interface AuditorLinkEmailTransport {
  send(message: { to: string; subject: string; text: string }): Promise<unknown>;
}

export interface AuditorLinkDeliveryInput {
  readonly organizationId: string;
  readonly engagementId: string;
  readonly auditorName: string;
  readonly auditorEmail: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/** The redeem page URL for a minted link. Pure, so the shape is unit-testable. */
export function buildAuditorRedeemUrl(
  baseUrl: string,
  organizationId: string,
  token: string,
): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/auditor/redeem?org=${encodeURIComponent(organizationId)}#token=${encodeURIComponent(token)}`;
}

export function createAuditorLinkEmailDelivery(input: {
  readonly transport: AuditorLinkEmailTransport;
  readonly baseUrl: string | undefined;
}): { deliver(link: AuditorLinkDeliveryInput): Promise<void> } {
  return {
    async deliver(link) {
      if (!input.baseUrl) {
        throw new Error(
          "no web origin configured (WEB_APP_URL / BETTER_AUTH_URL): cannot build the auditor link",
        );
      }
      const url = buildAuditorRedeemUrl(input.baseUrl, link.organizationId, link.token);
      await input.transport.send({
        to: link.auditorEmail,
        subject: "Your ChartWarden auditor access link",
        text: [
          `Hello ${link.auditorName},`,
          "",
          "You have been granted time-limited, read-only auditor access. Open this link to start your session",
          `(it can be used once and expires ${link.expiresAt.toUTCString()}):`,
          "",
          url,
          "",
          "If you were not expecting this, ignore this email.",
        ].join("\n"),
      });
    },
  };
}
