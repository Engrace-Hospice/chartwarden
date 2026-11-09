// apps/backend/src/modules/37-ipu/routes/actor.ts — M37 route actor binding. Org/actor/membership are
// ALWAYS server-assembled from `request.context` (via @chartwarden/shared/route-kit), never read off the
// wire; every authored M37 row is stamped with the server-assembled membership id.
import {
  type ContextCarrier,
  writeActorOf as kitWriteActorOf,
} from "@chartwarden/shared/route-kit";

/** The READ-route actor: org + user + roles, all server-assembled. */
export interface IpuReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /** The active membership id, when the session carries one (GAP-169: the `staff_member` roster match). */
  readonly membershipId?: string | null;
}

/** The MUTATING-route actor: the read actor PLUS the active membership id + step-up flag. */
export interface IpuWriteActor extends IpuReadActor {
  readonly membershipId: string;
  readonly stepUpRecent: boolean;
  /**
   * GAP-106 — the M2 session id the step-up ceremony was performed on, from `context.attributes.sessionId`
   * (stamped by the authenticate hook from the verified session, never read off a request field). It is
   * the step-up assertion an attestation is bound to; null when the session carries none.
   */
  readonly stepUpAssertionId?: string | null;
}

/** The kit write actor (401 without a session, 403 without a membership) plus the step-up assertion id. */
export function writeActorOf(request: ContextCarrier): IpuWriteActor {
  const sessionId = request.context?.attributes?.sessionId;
  return {
    ...kitWriteActorOf(request),
    stepUpAssertionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
  };
}
