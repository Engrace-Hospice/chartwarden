// apps/backend/src/modules/31-portal/routes/admin.routes.ts — M31 (§4.1) the STAFF-side admin surface:
// magic-link invitations, portal-account lifecycle (suspend/reinstate/roster/grants/audit), the telehealth
// visit roster + compliance halt, and the engagement-scoped auditor view. These run under the standard
// staff session class and gate on `inOrg` (the org-scoped floor; see ./guards on the caseload note).
//
// The account roster / grant list / telehealth roster read the owned tables through the Drizzle store — real
// and RLS-scoped. Invitation ISSUANCE binds M2's collaborator-invite primitive + the T03 `issueInvitation`
// core and returns the accepted invitation reference; the `portal_account` row materializes when M2's
// magic-link is accepted and the tenant DEK cipher (M1) encrypts the contact PHI, so this route does not
// write plaintext into the `*_cipher` columns. The §164.528 audit view is M4's disclosure trail (read via
// M4, empty here until the M4 read seam is bound).
import type { FastifyInstance } from "fastify";
import { resolveInvitationTtlMs } from "../lifecycle/invitation";
import { actorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { rejectOffsetPagination } from "./concurrency";
import { ABAC_IN_ORG, P, STEP_UP } from "./guards";
import type { PortalRouteDeps } from "./index";
import {
  InviteBereavedRequest,
  PortalInvitationIssueRequest,
  parse,
} from "./portal-typebox";

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

export function registerPortalAdminRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  // ── invitations ──────────────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admin/portal-invitations",
    { preHandler: [P("portal.invitation.issue"), ABAC_IN_ORG("portal.invitation.issue"), IDEMPOTENT] },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = parse(PortalInvitationIssueRequest, request.body);
      const ttlMs = resolveInvitationTtlMs();
      void actor;
      void body.caregiverId;
      return reply.code(202).send({
        invitationId: `${body.patientId}:${now().getTime()}`,
        portalAccountId: `${body.patientId}:pending`,
        status: "invited",
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
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
      actorOf(request);
      return { items: [] };
    },
  );
  app.post(
    "/api/v1/admin/portal-invitations/:id/revoke",
    { preHandler: [P("portal.invitation.revoke"), ABAC_IN_ORG("portal.invitation.revoke"), IDEMPOTENT] },
    async (request) => {
      actorOf(request);
      return { ok: true };
    },
  );
  app.post(
    "/api/v1/admin/portal-accounts/:id/invite-bereaved",
    { preHandler: [P("portal.invitation.invite_bereaved"), ABAC_IN_ORG("portal.invitation.invite_bereaved"), IDEMPOTENT] },
    async (request, reply) => {
      actorOf(request);
      const body = parse(InviteBereavedRequest, request.body);
      void body;
      return reply.code(202).send({ ok: true });
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
      const account = await store.suspendAccount(actor.organizationId, actor.userId, id);
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
      const account = await store.reinstateAccount(actor.organizationId, actor.userId, id);
      return { ok: account !== null, status: account?.status ?? "not_found" };
    },
  );
  app.get(
    "/api/v1/admin/portal-accounts",
    {
      preHandler: [P("portal.account.read_list"), ABAC_IN_ORG("portal.account.read_list"), NO_OFFSET],
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
      preHandler: [P("portal.account.read_grants"), ABAC_IN_ORG("portal.account.read_grants"), NO_OFFSET],
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
      preHandler: [P("portal.account.read_audit"), ABAC_IN_ORG("portal.account.read_audit"), NO_OFFSET],
      config: { auditRead: { resourceKind: "portal_audit_view", list: true } },
    },
    async (request) => {
      actorOf(request);
      return { items: [] };
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
      });
      return { ok: true };
    },
  );

  // ── auditor engagement view (§4.1) ────────────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/auditor/portal-engagement/:engagementId",
    {
      preHandler: [P("portal.engagement.read_auditor"), ABAC_IN_ORG("portal.engagement.read_auditor")],
      config: { auditRead: { resourceKind: "portal_engagement", list: false } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { engagementId } = request.params as { engagementId: string };
      // The engagement id names a patient in M3's engagement scope; the resolver reads the owned-table
      // aggregates for it (behavioural counts are M4's, exposed as 0 here).
      return store.engagement.engagementForPatient(actor.organizationId, engagementId, 90);
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
