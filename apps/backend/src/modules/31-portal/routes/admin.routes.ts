// apps/backend/src/modules/31-portal/routes/admin.routes.ts — M31 (§4.1) the STAFF-side admin surface:
// magic-link invitations, portal-account lifecycle (suspend/reinstate/roster/grants/audit), the telehealth
// visit roster + compliance halt, and the engagement-scoped auditor view. The org-level rows gate on `inOrg`
// (the org-scoped floor; see ./guards); the per-patient invitation routes gate on `caseload_or_scope`
// (./invitation-scope) and the auditor view on `portal_engagement_scope` (GAP-093).
//
// The account roster / grant list / telehealth roster read the owned tables through the Drizzle store — real
// and RLS-scoped. Invitation ISSUANCE binds M2's collaborator-invite primitive + the T03 `issueInvitation`
// core and returns the accepted invitation reference; the `portal_account` row materializes when M2's
// magic-link is accepted and the tenant DEK cipher (M1) encrypts the contact PHI, so this route does not
// write plaintext into the `*_cipher` columns. The §164.528 audit view is M4's disclosure trail (read via
// M4, empty here until the M4 read seam is bound).
import { ForbiddenError, NotFoundError, ChartWardenError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { actorOf } from "./actor";
import {
  AUDITOR_VIEW_WINDOW_DAYS,
  resolveAuditorEngagementView,
  seamEngagementReader,
} from "./auditor-engagement";
import { requireIdempotencyKey } from "./concurrency";
import { rejectOffsetPagination } from "./concurrency";
import { ABAC_ENGAGEMENT_SCOPE, ABAC_IN_ORG, P, STEP_UP } from "./guards";
import type { PortalRouteDeps } from "./index";
import {
  invitationPatientScope,
  patientFromBody,
  patientsFromAccountGrants,
} from "./invitation-scope";
import {
  AccountSuspendRequest,
  InviteBereavedRequest,
  PortalInvitationIssueRequest,
  parse,
} from "./portal-typebox";
import { provisioningOf } from "./write.routes";

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

export function registerPortalAdminRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * Seal the operator's reason for an account status change (#117).
   *
   * Both routes publish `reason` as `required: true` and both used to parse only the path param, so the
   * suspension was recorded with no reason while every caller believed it had supplied one. With no
   * cipher bound the answer is a REFUSAL, not a silent drop and not cleartext in a column named
   * `_cipher` — the M32 R18 posture, for the same reason: an unreadable audit trail and a missing one
   * look identical afterwards, and only the refusal is visible at the time it matters.
   */
  const sealReason = async (organizationId: string, body: unknown): Promise<string> => {
    const { reason } = parse(AccountSuspendRequest, body);
    if (!deps.reasonCipher) {
      throw new ChartWardenError(
        "PORTAL_REASON_CIPHER_UNBOUND",
        "no per-tenant DEK envelope is bound for M31, so the operator's reason cannot be stored encrypted; recording the status change without it is what this route was filed for (#117)",
        503,
      );
    }
    return deps.reasonCipher.encrypt(organizationId, reason);
  };

  // GAP-093 — the invitation's patient is authorized through `caseload_or_scope`; the handler re-asserts.
  const issueScope = invitationPatientScope("portal.invitation.issue", patientFromBody);
  const inviteBereavedScope = invitationPatientScope(
    "portal.invitation.invite_bereaved",
    patientsFromAccountGrants(store),
  );

  // ── invitations ──────────────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admin/portal-invitations",
    {
      preHandler: [P("portal.invitation.issue"), issueScope, IDEMPOTENT],
    },
    async (request, reply) => {
      await issueScope(request, reply);
      const actor = actorOf(request);
      const body = parse(PortalInvitationIssueRequest, request.body);
      const issued = await provisioningOf(deps).invitations.issue({
        organizationId: actor.organizationId,
        actingUserId: actor.userId,
        patientId: body.patientId,
        relationship: body.relationship,
        ...(body.caregiverId ? { caregiverId: body.caregiverId } : {}),
        inviteeDisplayName: body.inviteeDisplayName,
        inviteeEmail: body.inviteeEmail,
        ...(body.inviteePhone ? { inviteePhone: body.inviteePhone } : {}),
        proposedScopeSet: body.proposedScopeSet,
      });
      return reply.code(202).send({
        invitationId: issued.invitationId,
        portalAccountId: issued.portalAccountId,
        status: issued.status,
        expiresAt: issued.expiresAt,
        ...(issued.inviteUrl ? { inviteUrl: issued.inviteUrl } : {}),
      });
    },
  );
  app.get(
    "/api/v1/admin/portal-invitations",
    {
      preHandler: [P("portal.invitation.read"), ABAC_IN_ORG("portal.invitation.read"), NO_OFFSET],
      config: { auditRead: { resourceKind: "portal_invitation", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      return { items: await provisioningOf(deps).invitations.list(actor.organizationId) };
    },
  );
  app.post(
    "/api/v1/admin/portal-invitations/:id/revoke",
    {
      preHandler: [
        P("portal.invitation.revoke"),
        ABAC_IN_ORG("portal.invitation.revoke"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      await provisioningOf(deps).invitations.revoke(actor.organizationId, actor.userId, id);
      return { ok: true };
    },
  );
  app.post(
    "/api/v1/admin/portal-accounts/:id/invite-bereaved",
    {
      preHandler: [P("portal.invitation.invite_bereaved"), inviteBereavedScope, IDEMPOTENT],
    },
    async (request, reply) => {
      await inviteBereavedScope(request, reply);
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      const body = parse(InviteBereavedRequest, request.body);
      // The decedent is the patient behind the inviting account's grants; with several, the request is ambiguous.
      const patientIds = [
        ...new Set(
          (await store.grantsForAccount(actor.organizationId, id)).map((g) => g.patientId),
        ),
      ];
      if (patientIds.length !== 1 || !patientIds[0]) {
        throw new ChartWardenError(
          "VALIDATION_FAILED",
          "the inviting account must have access to exactly one patient",
          422,
        );
      }
      const issued = await provisioningOf(deps).invitations.issue({
        organizationId: actor.organizationId,
        actingUserId: actor.userId,
        patientId: patientIds[0],
        relationship: "bereaved_family_member",
        bereavedContactId: body.bereavedContactId,
        inviteeDisplayName: body.inviteeDisplayName,
        inviteeEmail: body.inviteeEmail,
        proposedScopeSet: [],
      });
      return reply.code(202).send({
        ok: true,
        invitationId: issued.invitationId,
        portalAccountId: issued.portalAccountId,
        expiresAt: issued.expiresAt,
        ...(issued.inviteUrl ? { inviteUrl: issued.inviteUrl } : {}),
      });
    },
  );

  // ── accounts ─────────────────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admin/portal-accounts/:id/suspend",
    {
      preHandler: [
        P("portal.account.suspend"),
        STEP_UP("portal.account.suspend"),
        ABAC_IN_ORG("portal.account.suspend"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      const reasonCipher = await sealReason(actor.organizationId, request.body);
      const account = await store.suspendAccount(
        actor.organizationId,
        actor.userId,
        id,
        reasonCipher,
      );
      return { ok: account !== null, status: account?.status ?? "not_found" };
    },
  );
  app.post(
    "/api/v1/admin/portal-accounts/:id/reinstate",
    {
      preHandler: [
        P("portal.account.reinstate"),
        STEP_UP("portal.account.reinstate"),
        ABAC_IN_ORG("portal.account.reinstate"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      const reasonCipher = await sealReason(actor.organizationId, request.body);
      const account = await store.reinstateAccount(
        actor.organizationId,
        actor.userId,
        id,
        reasonCipher,
      );
      return { ok: account !== null, status: account?.status ?? "not_found" };
    },
  );
  app.get(
    "/api/v1/admin/portal-accounts",
    {
      preHandler: [
        P("portal.account.read_list"),
        ABAC_IN_ORG("portal.account.read_list"),
        NO_OFFSET,
      ],
      config: { auditRead: { resourceKind: "portal_account", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const rows = await store.accountList(actor.organizationId);
      return {
        items: rows.map((r) => ({
          portalAccountId: r.portalAccountId,
          relationship: r.relationship,
          status: r.status,
          invitedAt: r.activatedAt ?? now().toISOString(),
          activatedAt: r.activatedAt,
          lastActiveAt: r.lastActiveAt,
        })),
      };
    },
  );
  app.get(
    "/api/v1/admin/portal-accounts/:id/access-grants",
    {
      preHandler: [
        P("portal.account.read_grants"),
        ABAC_IN_ORG("portal.account.read_grants"),
        NO_OFFSET,
      ],
      config: { auditRead: { resourceKind: "portal_access_grant", resourceIdParam: "id" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      const rows = await store.grantsForAccount(actor.organizationId, id);
      return {
        items: rows.map((g) => ({
          grantId: g.grantId,
          patientId: g.patientId,
          grantKind: g.grantKind,
          grantedAt: g.grantedAt,
          revokedAt: g.revokedAt,
        })),
      };
    },
  );
  app.get(
    "/api/v1/admin/portal-accounts/:id/audit-views",
    {
      preHandler: [
        P("portal.account.read_audit"),
        ABAC_IN_ORG("portal.account.read_audit"),
        NO_OFFSET,
      ],
      config: { auditRead: { resourceKind: "portal_audit_view", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      const query = request.query as { cursor?: string; limit?: string };
      if (!deps.accountAudit) {
        throw new ChartWardenError(
          "PORTAL_AUDIT_UNAVAILABLE",
          "the portal audit trail is not available right now",
          503,
        );
      }
      const account = await store.accountById(actor.organizationId, id);
      if (!account) throw new NotFoundError("portal account");
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      return deps.accountAudit.viewsForUser({
        organizationId: actor.organizationId,
        userId: account.userId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
    },
  );

  // ── telehealth admin ─────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/admin/telehealth/visits",
    {
      preHandler: [P("telehealth.read_list"), ABAC_IN_ORG("telehealth.read_list"), NO_OFFSET],
      config: { auditRead: { resourceKind: "telehealth_visit", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const rows = await store.telehealthList(actor.organizationId);
      return { items: rows.map(toVisitDetail) };
    },
  );
  app.get(
    "/api/v1/admin/telehealth/visits/:id",
    {
      preHandler: [P("telehealth.read"), ABAC_IN_ORG("telehealth.read")],
      config: { auditRead: { resourceKind: "telehealth_visit", list: false } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      const visit = await store.telehealthById(actor.organizationId, id);
      return visit ? toVisitDetail(visit) : { telehealthVisitId: id, lifecycleState: "not_found" };
    },
  );
  app.post(
    "/api/v1/admin/telehealth/visits/:id/halt-recording",
    {
      preHandler: [
        P("telehealth.record_halt_admin"),
        STEP_UP("telehealth.record_halt_admin"),
        ABAC_IN_ORG("telehealth.record_halt_admin"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      await store.updateTelehealthLifecycle(actor.organizationId, actor.userId, id, {
        recordingEnabled: false,
        recordingRequested: false, // CHECK telehealth_visit_recording_requires_enabled
      });
      return { ok: true };
    },
  );

  // ── auditor engagement view (§4.1) ────────────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/auditor/portal-engagement/:engagementId",
    {
      preHandler: [
        P("portal.engagement.read_auditor"),
        ABAC_ENGAGEMENT_SCOPE("portal.engagement.read_auditor"),
      ],
      // `resourceIdParam` names the engagement: without it the read event carried an EMPTY resource id,
      // the audit insert failed (uuid cast), and the failure was swallowed as "best-effort" - so an
      // auditor's use of their session left no trail at all. The engagement is what was viewed.
      config: {
        auditRead: {
          resourceKind: "portal_engagement",
          resourceIdParam: "engagementId",
          list: false,
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { engagementId } = request.params as { engagementId: string };
      // GAP-093(d) — the route names an ENGAGEMENT. Re-assert (service layer) that it is the session's own,
      // then resolve what it covers through M3's reader and read ONLY those patients' owned-table
      // aggregates (behavioural counts are M4's, exposed as 0 here). An unreadable / not-live engagement
      // is a 403, never a wider answer.
      const sessionEngagementId = request.context.attributes?.engagementId;
      if (actor.sessionClass !== "auditor" || sessionEngagementId !== engagementId) {
        throw new ForbiddenError("auditor engagement scope required");
      }
      let view: Awaited<ReturnType<typeof resolveAuditorEngagementView>> = null;
      try {
        view = await resolveAuditorEngagementView({
          organizationId: actor.organizationId,
          engagementId,
          auditorUserId: actor.userId,
          at: (deps.now ?? (() => new Date()))(),
          windowDays: AUDITOR_VIEW_WINDOW_DAYS,
          reader: deps.engagementReader ?? seamEngagementReader,
          store,
        });
      } catch (err) {
        // An unbound / erroring M3 denies the auditor view (fail closed), loudly.
        request.log.warn({ err, engagementId }, "M31 auditor engagement coverage unreadable");
      }
      if (!view) throw new ForbiddenError("auditor engagement not active");
      return view;
    },
  );
}

function toVisitDetail(v: {
  telehealthVisitId: string;
  m17VisitId: string;
  patientId: string;
  lifecycleState: string;
  vendor: string;
  audioOnlyFallbackActive: boolean;
  visitStartedAt: string | null;
  visitEndedAt: string | null;
}) {
  return {
    telehealthVisitId: v.telehealthVisitId,
    m17VisitId: v.m17VisitId,
    patientId: v.patientId,
    lifecycleState: v.lifecycleState,
    vendor: v.vendor,
    audioOnlyFallbackActive: v.audioOnlyFallbackActive,
    visitStartedAt: v.visitStartedAt,
    visitEndedAt: v.visitEndedAt,
  };
}
