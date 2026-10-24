// apps/backend/src/modules/22-documents/records-request/records-request-routes.ts — F-238: request a
// prospect's older records from a PCP / hospital, print the cover sheet that carries the request code, and
// track the request (cancel, mark received). Records that come back are filed by the intake job when it
// finds the code (./inbound-match.ts), or by hand at upload (`recordsRequestId` on POST /intake/uploads).
//
// Permissions reuse the §4.6 intake keys M22 already registers: asking for records is part of intake
// upload work (`intake.upload` — create / cancel / mark), reading them is `intake.read`. On top of RBAC the
// caller must be able to read the referral itself (M6 ReferralReader seam), exactly like an upload filed
// against a referral; a referral the caller cannot see is a non-leaking 404.
//
// The cover sheet is a PDF (./cover-sheet.ts) — the same bytes staff print and the send-fax route sends
// through M22's outbound-fax port (../fax/outbound-fax.ts; ./records-request-fax.ts records every attempt).
// Sending is `intake.upload` (it is part of making the request); no step-up: it discloses exactly what the
// printed sheet does, to the recipient the request already names or the number staff type.
import { requirePermission } from "@chartwarden/auth";
import {
  DegradedError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normaliseFaxNumber } from "../fax/fax-number";
import type { OutboundFaxTransport } from "../fax/outbound-fax";
import { parse } from "../routes/documents-typebox";
import { type CoverSheetSubject, renderRecordsRequestCoverSheetPdf } from "./cover-sheet";
import { type RecordsRequestFaxStore, sendRecordsRequestFax } from "./records-request-fax";
import type { RecordsRequestActor, RecordsRequestService } from "./records-request-service";
import {
  CancelRecordsRequestRequest,
  CreateRecordsRequestRequest,
  ExtendRecordsRequestRequest,
  MarkRecordsRequestRequest,
  RecordsRequestParamsSchema,
  RecordsRequestReferralParamsSchema,
  SendRecordsRequestFaxRequest,
} from "./records-request-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const INTAKE_UPLOAD = P("intake.upload");
const INTAKE_READ = P("intake.read");

export interface RecordsRequestRouteDeps {
  readonly service: RecordsRequestService;
  /** M6 ReferralReader slice (getSeam at the composition root). Absent ⇒ 503 on every route. */
  readonly referralReader?: {
    canAccessReferral(input: {
      organizationId: string;
      userId: string;
      referralId: string;
    }): Promise<boolean>;
    getReferralSubject(input: { organizationId: string; referralId: string }): Promise<{
      patientId: string | null;
      patientNameAtReceipt: string;
      patientDobAtReceipt: string | null;
    } | null>;
  };
  /** M5 PatientReader slice — the chart's legal name/DOB once the referral resolved a patient. */
  readonly patientReader?: (
    organizationId: string,
    patientId: string,
  ) => Promise<{ lastName: string; firstName: string; dateOfBirth: string } | null>;
  /** The requesting organization's display name — the cover sheet's "From" line (omitted when absent). */
  readonly organizationName?: (organizationId: string) => Promise<string | null>;
  /** Outbound fax (F-238). Absent ⇒ send-fax answers 503 and the list carries no `fax` field. */
  readonly fax?: {
    readonly transport: OutboundFaxTransport;
    readonly store: RecordsRequestFaxStore;
  };
}

/** E.164 → how a person reads it on the cover sheet: NANP as (503) 555-0100, anything else as E.164. */
const displayFax = (e164: string): string =>
  /^\+1\d{10}$/.test(e164) ? `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}` : e164;

function actorOf(request: FastifyRequest): { organizationId: string; actor: RecordsRequestActor } {
  const ctx = request.context;
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || !ctx.userId || typeof membershipId !== "string") {
    throw new UnauthorizedError();
  }
  return { organizationId: ctx.organizationId, actor: { userId: ctx.userId, membershipId } };
}

export function registerRecordsRequestRoutes(
  app: FastifyInstance,
  deps: RecordsRequestRouteDeps,
): void {
  const { service } = deps;

  /** The caller can read the referral (M6) — else 404 — and who it is about. */
  async function referralFor(organizationId: string, userId: string, referralId: string) {
    const reader = deps.referralReader;
    if (!reader) {
      throw new DegradedError(
        "referral-reader",
        "records requests require the M6 ReferralReader seam",
      );
    }
    if (!(await reader.canAccessReferral({ organizationId, userId, referralId }))) {
      throw new NotFoundError("referral");
    }
    const subject = await reader.getReferralSubject({ organizationId, referralId });
    if (!subject) throw new NotFoundError("referral");
    return subject;
  }

  /** The request (404 if not this referral's) and who the cover sheet names: the chart once resolved. */
  async function coverSheetInputs(
    organizationId: string,
    userId: string,
    id: string,
    requestId: string,
  ) {
    const subject = await referralFor(organizationId, userId, id);
    const req = await service.get(organizationId, id, requestId);
    const patientId = subject.patientId ?? req.patientId;
    const chart =
      patientId && deps.patientReader ? await deps.patientReader(organizationId, patientId) : null;
    const named: CoverSheetSubject = chart
      ? { displayName: `${chart.lastName}, ${chart.firstName}`, dateOfBirth: chart.dateOfBirth }
      : { displayName: subject.patientNameAtReceipt, dateOfBirth: subject.patientDobAtReceipt };
    const fromOrganization = deps.organizationName
      ? await deps.organizationName(organizationId)
      : null;
    return { req, subject: named, fromOrganization };
  }

  // Create a request (and its code) for a referral's older records.
  app.post(
    "/api/v1/referrals/:id/records-requests",
    { preHandler: [INTAKE_UPLOAD] },
    async (request, reply) => {
      const { organizationId, actor } = actorOf(request);
      const { id } = parse(RecordsRequestReferralParamsSchema, request.params);
      const body = parse(CreateRecordsRequestRequest, request.body);
      const subject = await referralFor(organizationId, actor.userId, id);
      const res = await service.create(
        organizationId,
        actor,
        { referralId: id, patientId: subject.patientId },
        body,
      );
      return reply.code(201).send(res);
    },
  );

  // The referral's requests, newest first.
  app.get(
    "/api/v1/referrals/:id/records-requests",
    {
      preHandler: [INTAKE_READ],
      config: { auditRead: { resourceKind: "intake_records_request", list: true } },
    },
    async (request) => {
      const { organizationId, actor } = actorOf(request);
      const { id } = parse(RecordsRequestReferralParamsSchema, request.params);
      await referralFor(organizationId, actor.userId, id);
      const items = await service.listForReferral(organizationId, id);
      if (!deps.fax) return { items };
      const faxes = await deps.fax.store.latestForRequests(
        organizationId,
        items.map((r) => r.id),
      );
      return { items: items.map((r) => ({ ...r, fax: faxes.get(r.id) ?? null })) };
    },
  );

  // Cancel an open request.
  app.post(
    "/api/v1/referrals/:id/records-requests/:requestId/cancel",
    { preHandler: [INTAKE_UPLOAD] },
    async (request) => {
      const { organizationId, actor } = actorOf(request);
      const { id, requestId } = parse(RecordsRequestParamsSchema, request.params);
      const body = parse(CancelRecordsRequestRequest, request.body);
      await referralFor(organizationId, actor.userId, id);
      return service.cancel(organizationId, actor, id, requestId, body.reason ?? null);
    },
  );

  // Staff say the records are in — all of them, or only some.
  app.post(
    "/api/v1/referrals/:id/records-requests/:requestId/status",
    { preHandler: [INTAKE_UPLOAD] },
    async (request) => {
      const { organizationId, actor } = actorOf(request);
      const { id, requestId } = parse(RecordsRequestParamsSchema, request.params);
      const body = parse(MarkRecordsRequestRequest, request.body);
      await referralFor(organizationId, actor.userId, id);
      return service.mark(organizationId, actor, id, requestId, body.status);
    },
  );

  // F-238 — push the expiry out; an expired request re-opens (same code, same cover sheet).
  app.post(
    "/api/v1/referrals/:id/records-requests/:requestId/extend",
    { preHandler: [INTAKE_UPLOAD] },
    async (request) => {
      const { organizationId, actor } = actorOf(request);
      const { id, requestId } = parse(RecordsRequestParamsSchema, request.params);
      const body = parse(ExtendRecordsRequestRequest, request.body);
      await referralFor(organizationId, actor.userId, id);
      return service.extend(organizationId, actor, id, requestId, body);
    },
  );

  // The cover sheet + request letter as a PDF (open / print / save). Read-audited: it names the prospect.
  app.get(
    "/api/v1/referrals/:id/records-requests/:requestId/cover-sheet",
    {
      preHandler: [INTAKE_READ],
      config: {
        auditRead: { resourceKind: "intake_records_request", resourceIdParam: "requestId" },
      },
    },
    async (request, reply) => {
      const { organizationId, actor } = actorOf(request);
      const { id, requestId } = parse(RecordsRequestParamsSchema, request.params);
      const { req, subject, fromOrganization } = await coverSheetInputs(
        organizationId,
        actor.userId,
        id,
        requestId,
      );
      const pdf = renderRecordsRequestCoverSheetPdf(req, subject, { fromOrganization });
      return reply
        .code(200)
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${pdf.filename}"`)
        .header("Cache-Control", "no-store")
        .send(Buffer.from(pdf.bytes));
    },
  );

  // Fax the cover sheet + letter to the recipient (idempotent per request; ./records-request-fax.ts).
  app.post(
    "/api/v1/referrals/:id/records-requests/:requestId/send-fax",
    { preHandler: [INTAKE_UPLOAD] },
    async (request) => {
      const { organizationId, actor } = actorOf(request);
      const { id, requestId } = parse(RecordsRequestParamsSchema, request.params);
      const body = parse(SendRecordsRequestFaxRequest, request.body);
      const fax = deps.fax;
      if (!fax) throw new DegradedError("outbound-fax", "no outbound fax port is bound");
      const faxNumber = normaliseFaxNumber(body.faxNumber);
      if (!faxNumber) {
        const message =
          "enter a dialable fax number: 10 digits (US/Canada) or + and the country code";
        throw new ValidationError(message, [{ field: "faxNumber", code: "INVALID", message }]);
      }
      const { req, subject, fromOrganization } = await coverSheetInputs(
        organizationId,
        actor.userId,
        id,
        requestId,
      );
      const document = renderRecordsRequestCoverSheetPdf(req, subject, {
        fromOrganization,
        faxTo: displayFax(faxNumber),
      });
      return sendRecordsRequestFax(fax, organizationId, actor, {
        request: req,
        faxNumber,
        document,
      });
    },
  );
}
