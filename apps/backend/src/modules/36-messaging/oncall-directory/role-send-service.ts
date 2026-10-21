// apps/backend/src/modules/36-messaging/oncall-directory/role-send-service.ts - ADR-0081 (PROPOSED): role-based send ("message the
// on-call RN"). The sender names a ROLE for a patient's care-team conversation; this service asks the guarded EscalationRouter seam (M19
// owns rosters) who covers tier 1 NOW and the sender CONFIRMS that person. The send is the ordinary urgent send to that ONE person, with
// the role stored on the response request (migration 1129).
//
// Fail-closed rules, each with a test:
//   - the tenant flag `messaging.role_send` off is the uniform 404, decided before any router call;
//   - only tier 1 is addressed: a gap, an unconnected roster (the deny-stub) and "no ladder" are explicit refusals carrying the telephone
//     procedure wording, NEVER a fall-back to a backup tier, another role or a guessed person;
//   - the resolution labels each person with the router's EXPLICIT rank and lists primaries first (hazard H-02); sending to a
//     backup stays allowed (the sender confirms ONE person). A rank change alone never fails a send: the staleness check compares the
//     PERSON set, so a chosen person who is still covering goes through whatever their rank now is;
//   - the confirmed person must STILL cover tier 1 when the send is made (re-resolved at send time); otherwise 409 and the sender
//     confirms again - nothing is silently re-routed;
//   - a retry of a send that already committed replays without re-resolving (the original was confirmed when made);
//   - a router failure propagates (a 5xx), it is never turned into a gap or a person.
// Logs carry the organisation, the sender, the role and a status word only (no patient id, no name, no message text).
import {
  type EscalationRouter,
  NotFoundError,
  type OnCallDirectoryRole,
  ROLE_SEND_ERROR_CODES,
  ROLE_SEND_TELEPHONE_PROCEDURE,
  type RoleSendResolutionDto,
  type RoleSendResponse,
  ChartWardenError,
} from "@chartwarden/types";
import type { UrgentActorRef, UrgentService, ValidateLinks } from "../urgent/urgent-service";
import { rankedIds, unavailableStatus, validShiftEnd } from "./oncall-coverage-service";

export interface RoleSendDeps {
  /** The flag `messaging.role_send`. A throw propagates (a 5xx); a clean false is the uniform 404. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The guarded router (org and answer checks; a test source is refused by the guard). */
  readonly router: EscalationRouter;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  /** The patient of a care-team channel, null for any other channel (or a missing one). */
  readonly channelPatient: (orgId: string, channelId: string) => Promise<string | null>;
  /**
   * The recipient and the ROLE of the message this sender already stored under this client id in this channel (role null for a
   * person-send), or null when there is none.
   */
  readonly findReplay?: (
    orgId: string,
    authorUserId: string,
    channelId: string,
    clientMessageId: string,
  ) => Promise<{ readonly recipient: string | null; readonly role: string | null } | null>;
  readonly urgent: Pick<UrgentService, "send">;
  readonly log?: (message: string, context: Record<string, string>) => void;
  readonly now?: () => Date;
}

/** Everything but the urgent service (the route layer owns that one) and the test hooks: what the composition root supplies. */
export type RoleSendPorts = Omit<RoleSendDeps, "urgent" | "log" | "now">;

export interface RoleSendTarget {
  readonly channelId: string;
  readonly patientId: string;
  readonly role: OnCallDirectoryRole;
}

export interface RoleSendInput extends RoleSendTarget {
  /** The person the sender confirmed from the resolution. */
  readonly recipientUserId: string;
  readonly bodyDoc: unknown;
  readonly clientMessageId: string;
  readonly correlationId?: string | undefined;
}

export interface RoleSendService {
  resolve(actor: UrgentActorRef, target: RoleSendTarget): Promise<RoleSendResolutionDto>;
  send(
    actor: UrgentActorRef,
    input: RoleSendInput,
    validateLinks: ValidateLinks,
  ): Promise<RoleSendResponse>;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const noCoverage = (status: string): ChartWardenError =>
  new ChartWardenError(ROLE_SEND_ERROR_CODES.noCoverage, ROLE_SEND_TELEPHONE_PROCEDURE, 422, [
    { field: "status", code: status, message: status },
  ]);

const clientIdReused = (): ChartWardenError =>
  new ChartWardenError(
    ROLE_SEND_ERROR_CODES.clientIdReused,
    "That message id was already used for a different message. Nothing was sent.",
    409,
  );

const resolutionChanged = (): ChartWardenError =>
  new ChartWardenError(
    ROLE_SEND_ERROR_CODES.resolutionChanged,
    "Who is on call changed. Nothing was sent. Review the new name and confirm again.",
    409,
  );

export function createRoleSendService(deps: RoleSendDeps): RoleSendService {
  const now = deps.now ?? (() => new Date());
  const log =
    deps.log ??
    ((message, context) => console.warn(`[m36:role-send] ${message}`, JSON.stringify(context)));

  async function guardTarget(actor: UrgentActorRef, target: RoleSendTarget): Promise<void> {
    if (!(await deps.isEnabled(actor.orgId))) throw new NotFoundError("channel");
    const patientId = await deps.channelPatient(actor.orgId, target.channelId);
    // One answer for: not a patient conversation, a missing channel, a patient other than the channel's.
    if (!patientId || !same(patientId, target.patientId)) throw new NotFoundError("channel");
  }

  async function tierOne(
    actor: UrgentActorRef,
    target: RoleSendTarget,
  ): Promise<RoleSendResolutionDto> {
    const asOfDate = now();
    const asOf = asOfDate.toISOString();
    const answer = await deps.router.resolveTier(actor.orgId, {
      patientId: target.patientId,
      requiredRole: target.role,
      tier: 1,
      asOf,
    });
    const base = { role: target.role, as_of: asOf } as const;
    if (answer.kind === "unavailable") {
      return {
        ...base,
        status: unavailableStatus(answer),
        people: [],
        shift_ends_at: null,
        time_zone: null,
      };
    }
    if (answer.kind !== "resolved") {
      return {
        ...base,
        status: "coverage_gap",
        people: [],
        shift_ends_at: null,
        time_zone: answer.timeZone,
      };
    }
    // The router's explicit rank, primaries first (no position inference). Lowercased ids, first occurrence wins.
    const people = await Promise.all(
      rankedIds(answer).map(async ({ id, rank }) => ({
        user_id: id,
        display_name: await deps.displayName(actor.orgId, id).catch(() => null),
        rank,
      })),
    );
    return {
      ...base,
      status: "covered",
      people,
      shift_ends_at: validShiftEnd(answer.shiftEndsAt, asOfDate),
      time_zone: answer.timeZone,
    };
  }

  const refuse = (actor: UrgentActorRef, role: string, status: string): void =>
    log("role send refused", { organizationId: actor.orgId, userId: actor.userId, role, status });

  return {
    async resolve(actor, target) {
      await guardTarget(actor, target);
      const resolution = await tierOne(actor, target);
      log("role resolved", {
        organizationId: actor.orgId,
        userId: actor.userId,
        role: target.role,
        status: resolution.status,
      });
      return resolution;
    },

    async send(actor, input, validateLinks) {
      await guardTarget(actor, input);
      // A lookup failure propagates: an unknown replay state must never become a fresh send.
      const replay = deps.findReplay
        ? await deps.findReplay(actor.orgId, actor.userId, input.channelId, input.clientMessageId)
        : null;
      // A client id already stored for a person-send or for ANOTHER role is never a replay of this role send, and its role is never echoed.
      if (replay && replay.role !== input.role) {
        refuse(actor, input.role, "client_id_reused");
        throw clientIdReused();
      }
      // A retry of a send that already committed to the SAME person is the original's answer: do not re-resolve (a shift may have changed).
      if (!replay?.recipient || !same(replay.recipient, input.recipientUserId)) {
        const current = await tierOne(actor, input);
        if (current.status !== "covered") {
          refuse(actor, input.role, current.status);
          throw noCoverage(current.status);
        }
        if (!current.people.some((p) => same(p.user_id, input.recipientUserId))) {
          refuse(actor, input.role, "resolution_changed");
          throw resolutionChanged();
        }
      }
      const sent = await deps.urgent.send(
        actor,
        {
          channelId: input.channelId,
          bodyDoc: input.bodyDoc,
          // Lowercased: the urgent send compares ids case-sensitively (the router answer and the care team are lowercase).
          recipientUserId: input.recipientUserId.toLowerCase(),
          clientMessageId: input.clientMessageId,
          correlationId: input.correlationId,
          roleAddressed: input.role,
        },
        validateLinks,
      );
      // On a replay the role is the STORED one (the check above made it equal to the requested one).
      return { ...sent, role: input.role };
    },
  };
}
