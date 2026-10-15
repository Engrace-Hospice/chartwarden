// apps/backend/src/modules/36-messaging/urgent/urgent-service.ts - WP 4.1: the "Urgent clinical" entry (ADR-0068). One
// atomic, idempotent send over the shipped idempotent send (WP 1.2), SBAR (WP 3.3) and clinical links (WP 3.2): the message
// is stored with `urgency = 'urgent'` and one named, qualified recipient, and the outbox event commits with it.
//
// It does NOT page, escalate, time or track a response from anyone (WP 4.2 - 4.4). It never reads the message text or the SBAR
// urgency label: urgency comes from this entry alone. Qualification of the recipient is checked here (ports, fail closed);
// the structural rules are re-checked by the send core (assertUrgentSend), and the database holds the shape.
import {
  type MessagingRouteService,
  type ValidatedClinicalLinkInput,
  derivePatient,
  urgentRecipientInvalid,
} from "@wardenx/messaging";
import {
  NotFoundError,
  type RichBody,
  URGENT_RECIPIENT_CAP,
  type UrgentMessageOptions,
  type UrgentMessageResponse,
  type UrgentRecipient,
  WardenXError,
} from "@wardenx/types";
import { linkNotAvailable } from "../clinical-link/clinical-link-service";
import type { HintOutboxPort } from "../message-hint-events";
import { resolveRichWrite } from "../rich-body-codec";
import { publishUrgentSent } from "./urgent-events";

export interface UrgentActorRef {
  readonly orgId: string;
  readonly userId: string;
}

export interface UrgentSend {
  readonly channelId: string;
  /** The SBAR document as the client built it; sanitised by the same codec as any send. */
  readonly bodyDoc: unknown;
  readonly recipientUserId: string;
  readonly clientMessageId: string;
  readonly correlationId?: string | undefined;
}

/** Request-scoped: authorises the link node(s) exactly as a normal send does (validateRichBodyLinks). */
export type ValidateLinks = (richBody: RichBody) => Promise<readonly ValidatedClinicalLinkInput[]>;

export interface UrgentChannelFacts {
  readonly kind: string;
  readonly subjectId: string | null;
}

export interface UrgentServiceDeps {
  /** The flag `messaging.urgent_clinical` AND `messaging.sbar`. A throw reads as off. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly outbox: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
    sendMessage: MessagingRouteService["sendMessage"];
  };
  readonly channelFacts: (orgId: string, channelId: string) => Promise<UrgentChannelFacts | null>;
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
  /** recipientEligible + `messaging.urgent.receive` for this patient. A throw reads as not qualified. */
  readonly isQualified: (orgId: string, userId: string, patientId: string) => Promise<boolean>;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

export interface UrgentService {
  send(
    actor: UrgentActorRef,
    input: UrgentSend,
    validateLinks: ValidateLinks,
  ): Promise<UrgentMessageResponse>;
  options(actor: UrgentActorRef, channelId: string): Promise<UrgentMessageOptions>;
}

const channelNotFound = (): NotFoundError => new NotFoundError("channel");

/** A port that throws answers "no": a seam outage must never name a guess as the recipient. */
async function orElse<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export function createUrgentService(deps: UrgentServiceDeps): UrgentService {
  const clock = deps.now ?? (() => new Date());

  /** Qualified = active, urgent-receive, Part 2 gate (isQualified) AND able to view this channel (membership). */
  const qualifiedFor = (orgId: string, channelId: string, patientId: string) => (userId: string) =>
    orElse(
      async () =>
        (await deps.messaging.canViewChannel(orgId, userId, channelId)) &&
        (await deps.isQualified(orgId, userId, patientId)),
      false,
    );

  async function visibleChannel(actor: UrgentActorRef, channelId: string): Promise<void> {
    if (!(await deps.isEnabled(actor.orgId).catch(() => false))) throw channelNotFound();
    if (!(await deps.messaging.canViewChannel(actor.orgId, actor.userId, channelId))) {
      throw channelNotFound();
    }
  }

  async function patientOf(orgId: string, channelId: string): Promise<string | null> {
    const facts = await deps.channelFacts(orgId, channelId);
    if (!facts) throw channelNotFound();
    return facts.kind === "care_team" ? derivePatient(facts.kind, facts.subjectId) : null;
  }

  return {
    async send(actor, input, validateLinks) {
      await visibleChannel(actor, input.channelId);
      const patientId = await patientOf(actor.orgId, input.channelId);
      if (!patientId) {
        throw new WardenXError(
          "URGENT_NOT_PATIENT_CHANNEL",
          "An urgent clinical message needs a patient conversation.",
          422,
        );
      }
      // One uniform answer for: the author, a non-member, off the care team, not qualified (H-02).
      const careTeam = await orElse(() => deps.careTeamMembers(actor.orgId, patientId), []);
      const qualified =
        input.recipientUserId !== actor.userId &&
        careTeam.includes(input.recipientUserId) &&
        (await qualifiedFor(actor.orgId, input.channelId, patientId)(input.recipientUserId));
      if (!qualified) throw urgentRecipientInvalid();

      const rich = resolveRichWrite({ bodyDoc: input.bodyDoc });
      if (!rich) throw new WardenXError("VALIDATION_FAILED", "an SBAR body is required", 422);
      const clinicalLinks = await validateLinks(rich.richBody);
      // A link to ANOTHER patient's record must not ride in this patient's urgent message (one answer, as 3.10).
      if (clinicalLinks.some((l) => l.patientId?.toLowerCase() !== patientId.toLowerCase())) {
        throw linkNotAvailable();
      }

      const outcome = { hookRan: false };
      const sent = await deps.messaging.sendMessage(actor.orgId, {
        channelId: input.channelId,
        authorUserId: actor.userId,
        body: rich.plainText,
        bodyKind: "rich",
        richBody: rich.richBody,
        clientMessageId: input.clientMessageId,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        references: rich.references,
        clinicalLinks,
        urgentRecipientUserId: input.recipientUserId,
        inTransaction: async (tx, { messageId }) => {
          outcome.hookRan = true;
          await publishUrgentSent(deps.outbox, tx, {
            orgId: actor.orgId,
            channelId: input.channelId,
            messageId,
            authorUserId: actor.userId,
            recipientUserId: input.recipientUserId,
            at: clock(),
          });
        },
      });
      return {
        message_id: sent.messageId,
        channel_id: sent.channelId,
        patient_id: patientId,
        recipient_user_id: input.recipientUserId,
        created: outcome.hookRan,
      };
    },

    async options(actor, channelId) {
      if (!(await deps.isEnabled(actor.orgId).catch(() => false))) return { enabled: false };
      await visibleChannel(actor, channelId);
      const patientId = await patientOf(actor.orgId, channelId);
      if (!patientId) {
        return { enabled: true, patient_linked: false, patient_id: null, recipients: [] };
      }
      const qualified = qualifiedFor(actor.orgId, channelId, patientId);
      const ids = [...(await orElse(() => deps.careTeamMembers(actor.orgId, patientId), []))]
        .filter((id, i, all) => id !== actor.userId && all.indexOf(id) === i)
        .sort();
      const recipients: UrgentRecipient[] = [];
      for (const id of ids) {
        if (recipients.length >= URGENT_RECIPIENT_CAP) break;
        if (!(await qualified(id))) continue;
        recipients.push({
          user_id: id,
          display_name: await orElse(() => deps.displayName(actor.orgId, id), null),
        });
      }
      recipients.sort(
        (x, y) =>
          (x.display_name ?? "").localeCompare(y.display_name ?? "") ||
          x.user_id.localeCompare(y.user_id),
      );
      return { enabled: true, patient_linked: true, patient_id: patientId, recipients };
    },
  };
}
