// apps/backend/src/modules/21-supplies/routes/supply-requests.routes.ts — M21 (§4.1) rows 1–10: the
// supply-request surface, which is the §2.2 fulfillment machine driven over HTTP.
//
// EVERY state transition requires `If-Match` (§7.2). That is stricter than most modules, and the reason is
// §7.2's own edge case: two coordinators open the same request, both press "assign vendor", and without
// the stamp the second write silently replaces the first — including the frozen D4 routing record that is
// supposed to answer "why this vendor" forever. The create route does not require it (there is no row to
// have read), and neither does a list.
//
// ROW 1'S ABAC CELL IS CONDITIONAL — `controlled_substance_dispatcher_eligible` "(when
// kind=comfort_kit_deploy)". {@link ABAC_DISPATCHER_ON_KIND} reads the raw `kindPayload.kind` off the body
// and short-circuits to allow for `dme` / `supply`. See routes/guards.ts rule 1 for why binding it
// unconditionally would have been strictly wrong rather than merely strict.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchStamp, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_DISPATCHER_ON_KIND, P } from "./guards";
import {
  AssignVendorBody,
  CancelRequestBody,
  CaptureCaregiverSignatureBody,
  ConfirmReceivedBody,
  CreateSupplyRequestBody,
  ListSupplyRequestsQuery,
  MarkDeliveredBody,
  MarkInTransitBody,
  MarkOrderedBody,
  RecordVendorInvoiceBody,
  RequestIdParams,
  ReturnRequestBody,
  SetCoverageDeterminationBody,
  parse,
  parseQuery,
} from "./m21-typebox";
import type { M21ReadService } from "./read-service";
import type { M21WriteService } from "./write-service";

export interface SupplyRequestRouteDeps {
  readonly readService: M21ReadService;
  readonly writeService: M21WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/** The M4 read-audit declaration every PHI supply-request read carries (§8.1 / M4 §2.5). */
const REQUEST_READ = {
  resourceKind: "supply_request",
  resourceIdParam: "supplyRequestId",
} as const;

export function registerSupplyRequestRoutes(
  app: FastifyInstance,
  deps: SupplyRequestRouteDeps,
): void {
  const { readService, writeService } = deps;

  // 1 — create a supply / DME / comfort-kit request.
  app.post(
    "/api/v1/supplies/supply-requests",
    {
      preHandler: [
        P("supplies.request.create"),
        ABAC_DISPATCHER_ON_KIND("supplies.request.create"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(CreateSupplyRequestBody, request.body);
      const created = await writeService.createSupplyRequest(writeActorOf(request), {
        patientId: body.patientId,
        admissionId: body.admissionId,
        locationId: body.locationId,
        sourceOrderId: body.sourceOrderId,
        deliveryAddress: body.deliveryAddress,
        deliveryInstructions: body.deliveryInstructions,
        kindPayload: body.kindPayload,
      });
      return reply.code(201).send(created);
    },
  );

  // 2 — the supply-team dashboard worklist (cursor-paginated; `openOnly` is the default view).
  app.get(
    "/api/v1/supplies/supply-requests",
    {
      preHandler: [P("supplies.request.read"), NO_OFFSET],
      config: { auditRead: { resourceKind: "supply_request", list: true } },
    },
    async (request) =>
      readService.listSupplyRequests(
        actorOf(request),
        parseQuery(ListSupplyRequestsQuery, request.query),
      ),
  );

  // 3 — request detail (carries the D13 delivery instructions and the frozen D4 routing record).
  app.get(
    "/api/v1/supplies/supply-requests/:supplyRequestId",
    {
      preHandler: [P("supplies.request.read")],
      config: { auditRead: REQUEST_READ },
    },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      return readService.getSupplyRequest(actorOf(request), supplyRequestId);
    },
  );

  // 4 — D4 vendor override. The ladder still runs; the override is recorded ON TOP of its trace, so the
  //     record shows both the rules evaluated and the human decision that overrode them.
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/assign-vendor",
    { preHandler: [P("supplies.request.assign_vendor"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(AssignVendorBody, request.body);
      return writeService.assignVendor(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 5 — the vendor accepted (Phase-1 portal/email/fax entry; Phase-2 the EDI 855 ack).
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/mark-ordered",
    { preHandler: [P("supplies.request.mark_ordered"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(MarkOrderedBody, request.body);
      return writeService.markOrdered(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 5b — GAP-063 / D16 — the vendor's actual invoice, matched against the quote accrued at mark-ordered (Phase-1
  //      manual entry; Phase-2 the EDI 810). Not a §2.2 transition; emits `invoice_reconciled` to M27.
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/vendor-invoice",
    { preHandler: [P("supplies.request.invoice_reconcile"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(RecordVendorInvoiceBody, request.body);
      return writeService.recordVendorInvoice(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        invoiceTotalCents: body.invoiceTotalCents,
      });
    },
  );

  // 6 — shipment identifiers (Phase-1 manual, Phase-2 the EDI 856 ASN).
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/mark-in-transit",
    { preHandler: [P("supplies.request.mark_in_transit"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(MarkInTransitBody, request.body);
      return writeService.markInTransit(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 7 — D7 courier attestation. `deliveredByMembershipId` is stamped from the SESSION, never the body:
  //     a courier who could name someone else has attested to nothing (routes/actor.ts).
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/mark-delivered",
    { preHandler: [P("supplies.request.mark_delivered"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(MarkDeliveredBody, request.body);
      return writeService.markDelivered(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 7b — F-193 (#248) — M21's own caregiver-signature capture. NOT a §2.2 transition (status does not
  //      move); `If-Match` is still required because this is a real mutation of the row and the same
  //      §7.2 lost-update race a status transition guards against applies here too. `captureMethod`
  //      picks the branch; `../lifecycle/caregiver-signature.ts` enforces the per-method evidence floor
  //      and refuses a second capture (`M21_CAREGIVER_SIGNATURE_ALREADY_CAPTURED`, 409) rather than
  //      overwriting or appending — the capture is a one-time evidentiary act.
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/caregiver-signature",
    { preHandler: [P("supplies.request.caregiver_signature"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(CaptureCaregiverSignatureBody, request.body);
      return writeService.captureCaregiverSignature(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 7c — COP27 (42 CFR 418.24(c)) — the hospice coverage determination (covered_related |
  //      not_covered_unrelated | not_covered_other + reason) the M6 election addendum lists. NOT a §2.2
  //      transition; `If-Match` still required (a real mutation — the §7.2 lost-update race applies).
  //      `dme` / `supply` kinds only; the determining membership is the SESSION's.
  app.put(
    "/api/v1/supplies/supply-requests/:supplyRequestId/coverage-determination",
    { preHandler: [P("supplies.request.coverage_determine"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(SetCoverageDeterminationBody, request.body);
      return writeService.setCoverageDetermination(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        hospiceCoverage: body.hospiceCoverage,
        reason: body.reason ?? null,
      });
    },
  );

  // 8 — caregiver / clinician confirms receipt. `system_auto_confirm` is NOT reachable here: it is the
  //     72h fallback the §4.6 worker writes, and letting a caller claim it would erase the distinction
  //     the screen renders (see the TypeBox union).
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/confirm-received",
    { preHandler: [P("supplies.request.confirm_received"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(ConfirmReceivedBody, request.body);
      return writeService.confirmReceived(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 9 — cancel. ONE route for both §2.2 cancellation edges: the service picks the immediate edge before
  //     `ordered` and the two-phase one after, so a caller never has to know which side of the vendor
  //     handshake the row sits on. The machine refuses either edge if the status disagrees.
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/cancel",
    { preHandler: [P("supplies.request.cancel"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(CancelRequestBody, request.body);
      return writeService.cancelSupplyRequest(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 10 — initiate an equipment return (the §2.2 kit-only `returned` branch; the DME pickup path).
  app.post(
    "/api/v1/supplies/supply-requests/:supplyRequestId/return",
    { preHandler: [P("supplies.request.return"), IDEMPOTENT] },
    async (request) => {
      const { supplyRequestId } = parse(RequestIdParams, request.params);
      const body = parse(ReturnRequestBody, request.body);
      return writeService.returnSupplyRequest(writeActorOf(request), supplyRequestId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );
}
