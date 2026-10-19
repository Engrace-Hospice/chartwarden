// apps/backend/src/modules/36-messaging/oncall-directory/role-send-service.ts - ADR-0081 (PROPOSED): role-based send ("message the
// on-call RN"). The sender names a ROLE for a patient's care-team conversation; this service asks the guarded EscalationRouter seam (M19
// owns rosters) who covers tier 1 NOW and the sender CONFIRMS that person. The send is the ordinary urgent send to that ONE person, with
// the role stored on the response request (migration 1129).
//
// Fail-closed rules, each with a test:
//   - the tenant flag `messaging.role_send` off is the uniform 404, decided before any router call;
//   - only tier 1 is addressed: a gap, an unconnected roster (the deny-stub) and "no ladder" are explicit refusals carrying the telephone
//     procedure wording, NEVER a fall-back to a backup tier, another role or a guessed person;
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
  WardenXError,
} from "@wardenx/types";
import type { UrgentActorRef, UrgentService, ValidateLinks } from "../urgent/urgent-service";
import { unavailableStatus, validShiftEnd } from "./oncall-coverage-service";

export interface RoleSendDeps {
  /** The flag `messaging.role_send`. A throw propagates (a 5xx); a clean false is the uniform 404. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The guarded router (org and answer checks; a test source is refused by the guard). */
  readonly router: EscalationRouter;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  /** The patient of a care-team channel, null for any other channel (or a missing one). */
  readonly channelPatient: (orgId: string, channelId: string) => Promise<string | null>;
  /** The recipient of the urgent message this sender already stored under this client id in this channel, or null (a throw = null). */
  readonly findReplayRecipient?: (
    orgId: string,
    authorUserId: string,
    channelId: string,
    clientMessageId: string,
  ) => Promise<string | null>;
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

const noCoverage = (status: string): WardenXError =>
  new WardenXError(ROLE_SEND_ERROR_CODES.noCoverage, ROLE_SEND_TELEPHONE_PROCEDURE, 422, [
    { field: "status", code: status, message: status },
  ]);

const resolutionChanged = (): WardenXError =>
  new WardenXError(
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
    const ids = [...new Set(answer.userIds.map((id) => id.toLowerCase()))].sort();
    const people = await Promise.all(
      ids.map(async (id) => ({
        user_id: id,
        display_name: await deps.displayName(actor.orgId, id).catch(() => null),
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
      const replayRecipient = deps.findReplayRecipient
        ? await deps
            .findReplayRecipient(actor.orgId, actor.userId, input.channelId, input.clientMessageId)
            .catch(() => null)
        : null;
      // A retry of a send that already committed to the SAME person is the original's answer: do not re-resolve (a shift may have changed).
      if (!replayRecipient || !same(replayRecipient, input.recipientUserId)) {
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
          recipientUserId: input.recipientUserId,
          clientMessageId: input.clientMessageId,
          correlationId: input.correlationId,
          roleAddressed: input.role,
        },
        validateLinks,
      );
      return { ...sent, role: input.role };
    },
  };
}
