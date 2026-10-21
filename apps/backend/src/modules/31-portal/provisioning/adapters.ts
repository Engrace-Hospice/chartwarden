// apps/backend/src/modules/31-portal/provisioning/adapters.ts — GAP-092. The two provisioning ports M31 can build from
// seams it already owns: the M39 consent port (over the registered `ConsentEvaluator`) and the invitation email
// delivery (over the platform's transactional email transport, injected by the root).
import type { PortalAccessGrantKind } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import { consentTypeForGrantKind, portalSessionClass } from "../lifecycle/portal-access-gate";
import type { PortalConsentPort, PortalInvitationDeliveryPort } from "./types";

/** The M31-side projection of M39's `ConsentEvaluator.evaluate` (it reads the registry opaquely, no M39 edge). */
interface ConsentEvaluatorPort {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string };
    callerModule: string;
  }): Promise<{
    allowed: boolean;
    consentRecordId?: string;
    consentVersionAtEval?: number | string;
  }>;
}

/**
 * The governing portal-access consent for `(patient, grant kind)` — the record + version a grant is stamped with
 * (`portal_access_grant.source_consent_*`, both NOT NULL). FAIL CLOSED: an unregistered / erroring evaluator, or a
 * verdict that is not an affirmative, fully-identified consent, resolves to `null` and no grant is minted.
 */
export function createPortalConsentPort(): PortalConsentPort {
  return {
    async governingConsent({ organizationId, patientId, grantKind }) {
      try {
        const evaluator = getSeam("ConsentEvaluator") as unknown as ConsentEvaluatorPort;
        const verdict = await evaluator.evaluate({
          organizationId,
          patientId,
          consentType: consentTypeForGrantKind(grantKind as PortalAccessGrantKind),
          sessionContext: { sessionClass: portalSessionClass(grantKind as PortalAccessGrantKind) },
          callerModule: "m31",
        });
        if (
          verdict.allowed !== true ||
          !verdict.consentRecordId ||
          verdict.consentVersionAtEval === undefined
        ) {
          return null;
        }
        return {
          consentRecordId: verdict.consentRecordId,
          consentVersion: String(verdict.consentVersionAtEval),
        };
      } catch {
        return null;
      }
    },
  };
}

/** The slice of the platform email transport the invitation email needs (M36's `EmailTransport`, structurally). */
export interface PortalEmailTransport {
  send(message: { to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * Email the invitation link. `baseUrl` is the portal app's origin (the link is `<baseUrl>/accept-invitation?token=…`);
 * unset ⇒ no link can be built, so nothing is sent and the admin response carries no link either (the route says so).
 * Delivery failures are the caller's to swallow: an invitation is already durably recorded.
 */
export function createPortalInvitationDelivery(input: {
  readonly transport?: PortalEmailTransport;
  readonly baseUrl?: string;
}): PortalInvitationDeliveryPort {
  return {
    async deliver({ email, displayName, token, expiresAt }) {
      const base = input.baseUrl?.replace(/\/$/, "");
      if (!base) return { inviteUrl: null };
      const inviteUrl = `${base}/accept-invitation?token=${encodeURIComponent(token)}`;
      if (!input.transport) return { inviteUrl };
      await input.transport.send({
        to: email,
        subject: "You're invited to your care team's family portal",
        text: `Hello ${displayName},\n\nYou have been invited to the family portal. Open this link to accept (it expires ${expiresAt.toUTCString()}):\n\n${inviteUrl}\n\nIf you weren't expecting this, you can ignore this email.`,
      });
      // Sent: the link goes to the invitee, not back through the admin response.
      return { inviteUrl: null };
    },
  };
}
