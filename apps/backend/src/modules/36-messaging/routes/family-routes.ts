// apps/backend/src/modules/36-messaging/routes/family-routes.ts - WP 6.7 (ADR-0099, PROPOSED): family / caregiver messaging without an app.
//
// STAFF (a workforce session). Which PATIENTS a staff member may act on is the care-team predicate inside the service; the permission only says the role exists.
//   GET    /api/v1/messaging/family/settings                           the agency name and numbers (manage)
//   PUT    /api/v1/messaging/family/settings                           (manage)
//   GET    /api/v1/messaging/family/patients/:patientId/caregivers     who may be invited, with the eligibility reason (manage)
//   POST   /api/v1/messaging/family/invitations                        create / reissue (manage + the tenant flag + a fresh step-up); link token and code returned ONCE
//   GET    /api/v1/messaging/family/contacts                           the Family lane (respond; never depends on the flag)
//   GET    /api/v1/messaging/family/contacts/:contactId/thread         one thread (respond); the staff read marks it "received"
//   POST   /api/v1/messaging/family/contacts/:contactId/reply          a staff reply (respond + the tenant flag)
//   DELETE /api/v1/messaging/family/contacts/:contactId/invitation     revoke (manage + a fresh step-up; never depends on the flag)
//   POST   /api/v1/messaging/family/contacts/:contactId/close | reopen (manage; never depends on the flag)
//   POST   /api/v1/messaging/family/contacts/:contactId/block | unblock (manage + a fresh step-up; unblock by a SECOND person)
//
// CONTACT (NOT a user session: a bearer minted by redeeming a one-time link; ADR-0099 D1). Every route answers the uniform 404 when the flag is off, the bearer is
// unknown / expired / revoked / locked, or the contact is no longer eligible. There is no id in any contact URL: the conversation is whatever the invitation
// row says. These routes read the Authorization header, which is a SERVER-minted, hash-checked single-invitation token, never a claim.
//   POST /api/v1/messaging/family-contact/redeem     the link -> enrolment-stage bearer (single use; budgeted per client address)
//   GET  /api/v1/messaging/family-contact/state      stage, mode, the agency numbers, language
//   POST /api/v1/messaging/family-contact/verify     the spoken 8-digit code -> active (5 attempts per invitation)
//   GET  /api/v1/messaging/family-contact/messages   the one thread, oldest first, active stage only; every read leaves a trail row
//   POST /api/v1/messaging/family-contact/messages   send text (<= 2,000 characters); every send leaves a trail row
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import {
  FAMILY_MANAGE_PERMISSION,
  FAMILY_MANAGE_STEP_UP_KEY,
  FAMILY_RESPOND_PERMISSION,
  NotFoundError,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FamilyContactService } from "../family/family-contact-service";
import type { FamilyStaffService } from "../family/family-staff-service";
import {
  CreateFamilyInvitationBodySchema,
  CreatedFamilyInvitationResponseSchema,
  FamilyCaregiversResponseSchema,
  FamilyContactIdParamsSchema,
  FamilyContactListResponseSchema,
  FamilyContactMessagesResponseSchema,
  FamilyContactStateResponseSchema,
  FamilyContactSummarySchema,
  FamilyContactVerifiedResponseSchema,
  FamilyPatientParamsSchema,
  FamilyRedeemResponseSchema,
  FamilyReplyBodySchema,
  FamilyReplyResponseSchema,
  FamilySendResponseSchema,
  FamilySettingsBodySchema,
  FamilySettingsResponseSchema,
  FamilyThreadResponseSchema,
} from "./family-typebox";
import { parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MANAGE = requirePermission(FAMILY_MANAGE_PERMISSION) as PreHandler;
const RESPOND = requirePermission(FAMILY_RESPOND_PERMISSION) as PreHandler;
const STEP_UP = requireStepUp(FAMILY_MANAGE_STEP_UP_KEY) as PreHandler;

/** An unauthenticated body is small by construction: a token, a code, 2,000 characters. */
const CONTACT_BODY_LIMIT = 16 * 1024;
const CONTACT_PREFIX = "/api/v1/messaging/family-contact/";
const CONTACT_PATH_FALLBACK = /^\/+api\/+v1\/+messaging\/+family-contact(\/|$)/i;

export interface FamilyRouteDeps {
  readonly staff: FamilyStaffService;
  readonly contact: FamilyContactService;
  /**
   * D8/D18: false => the CONTACT routes are not mounted (they answer the framework's 404) because per-address budgets would be keyed on a proxy address,
   * or the code pepper is missing. Staff list, revoke, close and block are always mounted. Default true.
   */
  readonly contactRoutes?: boolean | undefined;
}

function staffOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** `Authorization: Bearer <orgId>.<token>`; anything else is "no bearer" (the service answers the uniform 404). */
function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export function registerFamilyRoutes(app: FastifyInstance, deps: FamilyRouteDeps): void {
  const { staff, contact } = deps;
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  /** Off => the uniform 404, before the step-up is asked for. */
  const FLAG_ON: PreHandler = async (request) => {
    if (!(await staff.isEnabled(staffOf(request).organizationId)))
      throw new NotFoundError("patient");
  };

  app.get(
    "/api/v1/messaging/family/settings",
    {
      preHandler: [MANAGE],
      schema: { response: { 200: FamilySettingsResponseSchema } },
      config: {
        auditRead: {
          none: "The tenant's agency name and two phone numbers: no patient, no person, no message",
        },
      },
    },
    async (request, reply) => noStore(reply).send(await staff.getSettings(staffOf(request))),
  );

  app.put(
    "/api/v1/messaging/family/settings",
    { preHandler: [MANAGE, STEP_UP], schema: { response: { 200: FamilySettingsResponseSchema } } },
    async (request, reply) => {
      const body = parse(FamilySettingsBodySchema, request.body);
      return noStore(reply).send(await staff.putSettings(staffOf(request), body));
    },
  );

  app.get(
    "/api/v1/messaging/family/patients/:patientId/caregivers",
    {
      preHandler: [requireUuidParams("patientId"), MANAGE],
      schema: { response: { 200: FamilyCaregiversResponseSchema } },
      config: {
        auditRead: {
          resourceKind: "patient_caregiver",
          patientIdParam: "patientId",
          resourceIdParam: "patientId",
          fields: ["display_name", "relationship", "eligibility"],
        },
      },
    },
    async (request, reply) => {
      const { patientId } = parse(FamilyPatientParamsSchema, request.params);
      return noStore(reply).send({
        caregivers: await staff.caregivers(staffOf(request), patientId),
      });
    },
  );

  app.post(
    "/api/v1/messaging/family/invitations",
    {
      preHandler: [MANAGE, FLAG_ON, STEP_UP],
      schema: { response: { 201: CreatedFamilyInvitationResponseSchema } },
      // The 201 holds the link token AND the code. The shared idempotency capture would copy both into one stored row (and replay them): never.
      config: { noIdempotencyCapture: true },
    },
    async (request, reply) => {
      const body = parse(CreateFamilyInvitationBodySchema, request.body);
      return noStore(reply)
        .code(201)
        .send(await staff.createInvitation(staffOf(request), body));
    },
  );

  app.get(
    "/api/v1/messaging/family/contacts",
    {
      preHandler: [RESPOND],
      schema: { response: { 200: FamilyContactListResponseSchema } },
      config: {
        auditRead: {
          resourceKind: "message_family_contact",
          list: true,
          fields: ["patient_name", "display_name", "relationship", "states"],
        },
      },
    },
    async (request, reply) => noStore(reply).send({ contacts: await staff.list(staffOf(request)) }),
  );

  app.get(
    "/api/v1/messaging/family/contacts/:contactId/thread",
    {
      preHandler: [requireUuidParams("contactId"), RESPOND],
      schema: { response: { 200: FamilyThreadResponseSchema } },
      config: {
        auditRead: {
          resourceKind: "message_family_thread",
          resourceIdParam: "contactId",
          patientIdPayloadPath: "contact.patientId",
          fields: ["messages"],
        },
      },
    },
    async (request, reply) => {
      const { contactId } = parse(FamilyContactIdParamsSchema, request.params);
      return noStore(reply).send(await staff.thread(staffOf(request), contactId));
    },
  );

  app.post(
    "/api/v1/messaging/family/contacts/:contactId/reply",
    {
      preHandler: [requireUuidParams("contactId"), RESPOND, FLAG_ON],
      schema: { response: { 201: FamilyReplyResponseSchema } },
    },
    async (request, reply) => {
      const { contactId } = parse(FamilyContactIdParamsSchema, request.params);
      const body = parse(FamilyReplyBodySchema, request.body);
      return noStore(reply)
        .code(201)
        .send(await staff.reply(staffOf(request), contactId, body.body));
    },
  );

  app.delete(
    "/api/v1/messaging/family/contacts/:contactId/invitation",
    {
      preHandler: [requireUuidParams("contactId"), MANAGE, STEP_UP],
      schema: { response: { 200: FamilyContactSummarySchema } },
    },
    async (request, reply) => {
      const { contactId } = parse(FamilyContactIdParamsSchema, request.params);
      return noStore(reply).send(await staff.revoke(staffOf(request), contactId));
    },
  );

  type Toggle = (
    s: FamilyStaffService,
    a: { organizationId: string; userId: string },
    id: string,
  ) => Promise<unknown>;
  const toggle = (run: Toggle) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { contactId } = parse(FamilyContactIdParamsSchema, request.params);
    return noStore(reply).send(await run(staff, staffOf(request), contactId));
  };
  const toggleOptions = (stepUp: boolean) => ({
    preHandler: [requireUuidParams("contactId"), MANAGE, ...(stepUp ? [STEP_UP] : [])],
    schema: { response: { 200: FamilyContactSummarySchema } },
  });
  app.post(
    "/api/v1/messaging/family/contacts/:contactId/close",
    toggleOptions(false),
    toggle((s, a, id) => s.setClosed(a, id, true)),
  );
  app.post(
    "/api/v1/messaging/family/contacts/:contactId/reopen",
    toggleOptions(false),
    toggle((s, a, id) => s.setClosed(a, id, false)),
  );
  app.post(
    "/api/v1/messaging/family/contacts/:contactId/block",
    toggleOptions(true),
    toggle((s, a, id) => s.setBlocked(a, id, true)),
  );
  app.post(
    "/api/v1/messaging/family/contacts/:contactId/unblock",
    toggleOptions(true),
    toggle((s, a, id) => s.setBlocked(a, id, false)),
  );

  if (deps.contactRoutes === false) return;

  // ADR-0099 D12: EVERY contact response is uncacheable, refusals included. A thrown 404/422/429 is built by the error handler, and a 404 is heuristically
  // cacheable by a browser or a shared proxy. The path test keeps the hook off every other route.
  app.addHook("onSend", async (request, reply, payload) => {
    const routeUrl = request.routeOptions?.url;
    const isContact = routeUrl
      ? routeUrl.startsWith(CONTACT_PREFIX)
      : CONTACT_PATH_FALLBACK.test(request.url.split("?")[0] ?? "");
    if (isContact) reply.header("Cache-Control", "no-store");
    return payload;
  });

  // ── contact surface ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  const meta = (request: FastifyRequest) => ({ ip: request.ip || "unknown" });

  app.post(
    "/api/v1/messaging/family-contact/redeem",
    { bodyLimit: CONTACT_BODY_LIMIT, schema: { response: { 200: FamilyRedeemResponseSchema } } },
    async (request, reply) =>
      noStore(reply).send(await contact.redeem(request.body, meta(request))),
  );

  app.get(
    "/api/v1/messaging/family-contact/state",
    {
      schema: { response: { 200: FamilyContactStateResponseSchema } },
      config: {
        auditRead: {
          none: "The contact's own access state: a stage, a mode, the agency numbers and a language. No patient and no message; the principal is a link bearer, not a user",
        },
      },
    },
    async (request, reply) =>
      noStore(reply).send(await contact.state(bearerOf(request), meta(request))),
  );

  app.post(
    "/api/v1/messaging/family-contact/verify",
    {
      bodyLimit: CONTACT_BODY_LIMIT,
      schema: { response: { 200: FamilyContactVerifiedResponseSchema } },
    },
    async (request, reply) =>
      noStore(reply).send(await contact.verify(bearerOf(request), request.body, meta(request))),
  );

  app.get(
    "/api/v1/messaging/family-contact/messages",
    {
      schema: { response: { 200: FamilyContactMessagesResponseSchema } },
      config: {
        auditRead: {
          none: "Records its OWN per-read trail row (message_family_access, audited by trigger) in the same transaction, fail closed; the principal is a link bearer, not a user",
        },
      },
    },
    async (request, reply) =>
      noStore(reply)
        .header("X-Content-Type-Options", "nosniff")
        .send(await contact.messages(bearerOf(request), request.query, meta(request))),
  );

  app.post(
    "/api/v1/messaging/family-contact/messages",
    { bodyLimit: CONTACT_BODY_LIMIT, schema: { response: { 201: FamilySendResponseSchema } } },
    async (request, reply) =>
      noStore(reply)
        .code(201)
        .send(await contact.send(bearerOf(request), request.body, meta(request))),
  );
}
