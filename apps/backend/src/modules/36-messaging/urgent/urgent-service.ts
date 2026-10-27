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
} from "@chartwarden/messaging";
import {
  ChartWardenError,
  NotFoundError,
  type RichBody,
  URGENT_CANDIDATE_CAP,
  URGENT_RECIPIENT_CAP,
  type UrgentMessageOptions,
  type UrgentMessageResponse,
  type UrgentRecipient,
} from "@chartwarden/types";
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
  /**
   * ADR-0081: set ONLY by the role-based send, after it resolved and the sender confirmed `recipientUserId`. The role is stored on the
   * response request, so the send REQUIRES response tracking: with tracking off it is refused (never sent without a record of the role).
   */
  readonly roleAddressed?: string | undefined;
  /**
   * ADR-0082: set ONLY by the role-based send while after-hours triage is on. Also asks M19, by an id-only event written in this
   * transaction, to open (or join) a triage call. Ignored when the port is absent or its flag is off, and on a replay.
   */
  readonly requestTriageCall?: boolean | undefined;
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
  /**
   * The recipient of an urgent message this sender already sent under this client_message_id in this channel, or null. Read
   * BEFORE the eligibility checks so a retry after the recipient lost access still replays the original (200), never a
   * confusing 422; the send core still compares the body and the recipient and raises the idempotency conflict. A throw = null.
   */
  readonly findReplayRecipient?: (
    orgId: string,
    authorUserId: string,
    channelId: string,
    clientMessageId: string,
  ) => Promise<string | null>;
  /**
   * WP 4.2: tracks a response to the urgent message. When present and `enabled`, the tracker's request is created in the SAME
   * transaction as the message (the send core's hook), so a committed urgent message always has its request and a rolled-back
   * one never does. Off or absent: the urgent entry behaves exactly as in WP 4.1. A throw from `enabled` fails the send (never silently untracked).
   */
  readonly responseTracker?: {
    readonly enabled: (orgId: string) => Promise<boolean>;
    readonly createInTx: (
      tx: unknown,
      facts: {
        readonly orgId: string;
        readonly messageId: string;
        readonly channelId: string;
        readonly patientId: string;
        readonly requesterUserId: string;
        readonly assigneeUserId: string;
        readonly addressedRole?: string | undefined;
      },
    ) => Promise<{ readonly requestId: string } | undefined>;
  };
  /**
   * ADR-0082 (flag `messaging.afterhours_triage`, absent = off): writes the after-hours request event and its link row in the send
   * transaction. `enabled` ERRORS propagate (an after-hours send must never silently lose its request on a blip).
   */
  readonly afterHoursTriage?: {
    readonly enabled: (orgId: string) => Promise<boolean>;
    /** True when the channel's patient is restricted (Part 2). A throw is read as restricted: no triage request is made (ADR-0082 open compliance question). */
    readonly isRestricted: (orgId: string, channelId: string) => Promise<boolean>;
    readonly requestInTx: (
      tx: unknown,
      facts: {
        readonly orgId: string;
        readonly messageId: string;
        readonly requestId: string;
        readonly patientId: string;
        readonly at: Date;
      },
    ) => Promise<void>;
  };
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
/** ADR-0081: a role-based send whose response cannot be tracked is refused whole (nothing sent), never sent without the role on record. */
const roleSendUntracked = (): ChartWardenError =>
  new ChartWardenError(
    "ROLE_SEND_UNAVAILABLE",
    "Messaging a role is unavailable right now. Use the agency telephone procedure; no message was sent.",
    503,
  );

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
        throw new ChartWardenError(
          "URGENT_NOT_PATIENT_CHANNEL",
          "An urgent clinical message needs a patient conversation.",
          422,
        );
      }
      // A retry of a send that already committed to the SAME recipient skips the live eligibility check (the original was
      // eligible when sent); a different recipient on a reused id falls through and is refused or conflicts as usual.
      const replayRecipient = deps.findReplayRecipient
        ? await orElse(
            () =>
              deps.findReplayRecipient!(
                actor.orgId,
                actor.userId,
                input.channelId,
                input.clientMessageId,
              ),
            null,
          )
        : null;
      const isReplay = replayRecipient?.toLowerCase() === input.recipientUserId.toLowerCase();
      if (!isReplay) {
        // One uniform answer for: the author, a non-member, off the care team, not qualified (H-02).
        const careTeam = await orElse(() => deps.careTeamMembers(actor.orgId, patientId), []);
        const qualified =
          input.recipientUserId !== actor.userId &&
          careTeam.includes(input.recipientUserId) &&
          (await qualifiedFor(actor.orgId, input.channelId, patientId)(input.recipientUserId));
        if (!qualified) throw urgentRecipientInvalid();
      }

      const rich = resolveRichWrite({ bodyDoc: input.bodyDoc });
      if (!rich) throw new ChartWardenError("VALIDATION_FAILED", "an SBAR body is required", 422);
      const clinicalLinks = await validateLinks(rich.richBody);
      // A link to ANOTHER patient's record must not ride in this patient's urgent message (one answer, as 3.10).
      if (clinicalLinks.some((l) => l.patientId?.toLowerCase() !== patientId.toLowerCase())) {
        throw linkNotAvailable();
      }

      const tracker = deps.responseTracker;
      // A flag lookup ERROR propagates: an urgent message must never silently lose its request on a blip.
      const track = tracker ? await tracker.enabled(actor.orgId) : false;
      // A replay of a send that already committed answers with the original even if tracking was turned off since (the core replays).
      if (input.roleAddressed && !track && !isReplay) throw roleSendUntracked();
      const afterHours = deps.afterHoursTriage;
      // Fail closed: the request event names the patient, so it is never emitted for a restricted (Part 2) channel or when that cannot be told.
      // The message itself still goes; the triage call is simply not requested (the same as the flag being off).
      const askTriage =
        !!input.requestTriageCall &&
        track &&
        !isReplay &&
        !!afterHours &&
        (await afterHours.enabled(actor.orgId)) &&
        !(await afterHours.isRestricted(actor.orgId, input.channelId).catch(() => true));
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
          if (track && tracker) {
            const created = await tracker.createInTx(tx, {
              orgId: actor.orgId,
              messageId,
              channelId: input.channelId,
              patientId,
              requesterUserId: actor.userId,
              assigneeUserId: input.recipientUserId,
              addressedRole: input.roleAddressed,
            });
            if (askTriage && afterHours) {
              if (!created) throw new Error("after-hours triage needs the response request id");
              await afterHours.requestInTx(tx, {
                orgId: actor.orgId,
                messageId,
                requestId: created.requestId,
                patientId,
                at: clock(),
              });
            }
          }
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
      // Bounded BEFORE the per-person checks so a huge care team cannot make this read an unbounded number of lookups.
      const ids = [...(await orElse(() => deps.careTeamMembers(actor.orgId, patientId), []))]
        .filter((id, i, all) => id !== actor.userId && all.indexOf(id) === i)
        .sort()
        .slice(0, URGENT_CANDIDATE_CAP);
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
