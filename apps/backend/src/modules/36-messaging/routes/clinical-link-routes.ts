// apps/backend/src/modules/36-messaging/routes/clinical-link-routes.ts - WP 3.2 clinical links.
//
//   GET /api/v1/messaging/clinical-links/:linkId/resolve
//
// OPEN path. `messaging.read`, the caller must be able to view the message's channel (the same `canViewChannel` rule the
// message reads use: active user, live membership, 42 CFR Part 2 gate), and the owning module's permission + scope is
// re-run NOW against the live summary. Missing link, other tenant, hidden channel, deleted message, missing / forbidden /
// erased / failing source are ONE answer: `{ state: "unavailable" }`. The flag off is a 404 (the feature does not exist).
//
// GET ONLY and READ ONLY. Nothing here, or anywhere in M36, calls a write method of a source seam.
//
// The WRITE half is `validateRichBodyLinks`, used by the send and edit routes: every clinicalLink node is checked before
// the message commits, with the same guards, and any failure is the same generic 422.
import type { GuardHandler } from "@chartwarden/auth";
import {
  type ClinicalLinkKind,
  ForbiddenError,
  NotFoundError,
  type RichBody,
  UnauthorizedError,
  richBodyClinicalLinks,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type ClinicalLinkSourcePorts,
  type LinkPermits,
  type ResolvedClinicalLink,
  type ValidatedClinicalLink,
  linkNotAvailable,
  resolveClinicalLink,
  validateClinicalLinks,
} from "../clinical-link/clinical-link-service";
import type { ClinicalLinkStore } from "../clinical-link/clinical-link-store-db";
import {
  type MeetingScopeTarget,
  defaultMeetingScopeTarget,
  guardForLink,
} from "../clinical-link/link-sources";
import { ClinicalLinkParamsSchema, parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface ClinicalLinkRouteDeps {
  /** The tenant flag `messaging.clinical_links`. A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly sources: ClinicalLinkSourcePorts;
  readonly store: ClinicalLinkStore;
  readonly canViewChannel: (
    organizationId: string,
    userId: string,
    channelId: string,
  ) => Promise<boolean>;
  readonly meetingScopeTarget?: MeetingScopeTarget;
  readonly now?: () => Date;
}

/** Used when the boot supplies none: flag off, so a link is refused on write and 404s on open. */
export const DISABLED_CLINICAL_LINKS: ClinicalLinkRouteDeps = {
  isEnabled: async () => false,
  sources: { summary: async () => null },
  store: { findLink: async () => null },
  canViewChannel: async () => false,
};

/** True when the guard passes; a 403/404 denial is "not permitted". Anything else propagates to the caller to fail closed. */
async function permits(guard: GuardHandler, request: FastifyRequest): Promise<boolean> {
  try {
    await guard(request as unknown as Parameters<GuardHandler>[0]);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof NotFoundError) return false;
    throw err;
  }
}

function flagOn(deps: ClinicalLinkRouteDeps, organizationId: string): Promise<boolean> {
  return deps.isEnabled(organizationId).catch(() => false);
}

/** The caller's verdict for a kind: its permission and scope, evaluated on this request over the summary's target. */
function callerPermits(request: FastifyRequest, deps: ClinicalLinkRouteDeps): LinkPermits {
  const meetingTarget = deps.meetingScopeTarget ?? defaultMeetingScopeTarget;
  return async (kind: ClinicalLinkKind, { sourceId, patientId }) => {
    const org = request.context?.organizationId ?? "";
    const target =
      kind === "idg_meeting" ? await meetingTarget(org, sourceId) : { patientId: patientId };
    return permits(guardForLink(kind, target), request);
  };
}

const logSeamFailure = (request: FastifyRequest) => (kind: ClinicalLinkKind) =>
  // The kind only: an error message from a clinical seam can carry PHI.
  request.log.warn({ kind }, "clinical link source unavailable");

/**
 * Write-time validation for a send/edit body. No link nodes => [] (flag and seams untouched). Flag off, or any node the
 * caller may not link, => the generic 422 BEFORE the message commits.
 */
export async function validateRichBodyLinks(
  request: FastifyRequest,
  deps: ClinicalLinkRouteDeps,
  richBody: RichBody | undefined,
): Promise<readonly ValidatedClinicalLink[]> {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  if (!richBody || richBodyClinicalLinks(richBody).length === 0) return [];
  if (!(await flagOn(deps, ctx.organizationId))) throw linkNotAvailable();
  return validateClinicalLinks(ctx.organizationId, richBody, {
    ports: deps.sources,
    permits: callerPermits(request, deps),
    onSeamFailure: logSeamFailure(request),
  });
}

const UNAVAILABLE: ResolvedClinicalLink = { state: "unavailable" };

export function registerClinicalLinkRoutes(
  app: FastifyInstance,
  guards: { readonly read: PreHandler },
  deps: ClinicalLinkRouteDeps,
): void {
  app.get(
    "/api/v1/messaging/clinical-links/:linkId/resolve",
    {
      preHandler: [requireUuidParams("linkId"), guards.read],
      config: {
        // The link id is the resource; the patient comes from the response (absent for `unavailable` and IDG meetings).
        auditRead: {
          resourceKind: "clinical_link",
          resourceIdParam: "linkId",
          patientIdPayloadPath: "patient_id",
          fields: ["kind", "status", "occurred_at", "link"],
        },
      },
    },
    async (request): Promise<ResolvedClinicalLink> => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const { linkId } = parse(ClinicalLinkParamsSchema, request.params);
      const org = ctx.organizationId;
      if (!(await flagOn(deps, org))) throw new NotFoundError("clinical_link", linkId);

      const stored = await deps.store.findLink(org, ctx.userId, linkId);
      if (!stored || stored.messageDeleted) return UNAVAILABLE;
      // The same visibility rule the message reads use. A viewer who cannot read the message cannot open its links.
      if (!(await deps.canViewChannel(org, ctx.userId, stored.channelId))) return UNAVAILABLE;

      return resolveClinicalLink(stored, org, {
        ports: deps.sources,
        permits: callerPermits(request, deps),
        onSeamFailure: logSeamFailure(request),
        now: deps.now ?? (() => new Date()),
      });
    },
  );
}
