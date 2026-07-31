// apps/backend/src/modules/19-oncall/routes/protocols.routes.ts — M19 (§4.1) rows 27-35: the protocol
// catalog and the external-vendor bindings.
//
// THE CATALOG IS TWO-LAYERED AND ONLY ONE LAYER IS WRITABLE. The 28 platform-floor protocols migration
// 0109 seeds are org-less and `is_system_locked`; migration 0108's RLS policies make a tenant physically
// unable to write them, and the write service refuses first with the protocol NAMED — because "0 rows
// updated" is not an answer a DON can act on, and §8.3.2 lists lowering a mandatory-escalation floor as
// the tampering threat this pair exists to close. A tenant may RAISE the floor by authoring its own
// protocol; it may never lower the platform's.
//
// THE READS ARE NOT PHI. A protocol is a clinical-decision TEMPLATE — a question list and a red-flag
// predicate — with no patient anywhere in it, which is why §8.7.1 classes the table `operational` rather
// than `compliance` and why the read-audit declarations here are justified waivers.
//
// THE VENDOR ROUTES (33-35) ARE THE §8.5 ADMIN SURFACE, AND THEY PROJECT NO SECRET because none is stored:
// ADR-0026 puts vendor credentials in the platform secret store, and the ABSENCE of a column and of a
// request field is the control. What the list DOES surface is `adapterRegistered` — whether an adapter for
// the configured key is actually loaded — so an admin can see a dead binding before 2 a.m. rather than
// when a call needs handing off.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_IN_ORG, P, STEP_UP } from "./guards";
import {
  CreateProtocolBody,
  CreateVendorBindingBody,
  ListProtocolsQuery,
  PatchProtocolBody,
  PatchProtocolQuestionBody,
  PatchVendorBindingBody,
  ProtocolIdParams,
  ProtocolQuestionBody,
  ProtocolQuestionIdParams,
  VendorIdParams,
  parse,
  parseQuery,
} from "./m19-typebox";
import type { M19ReadService } from "./read-service";
import type { M19WriteService } from "./write-service";

export interface ProtocolRouteDeps {
  readonly readService: M19ReadService;
  readonly writeService: M19WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

const CATALOG_NO_PHI = {
  none: "clinical-decision template (question list, red-flag predicate, discipline floor) — no patient data",
} as const;

export function registerProtocolRoutes(app: FastifyInstance, deps: ProtocolRouteDeps): void {
  const { readService, writeService } = deps;

  // 27 — the catalog: the platform floor plus this tenant's own rows (D4), effective-dated by default.
  app.get(
    "/api/v1/triage-protocols",
    {
      preHandler: [P("triage.read"), ABAC_IN_ORG("triage.read"), NO_OFFSET],
      config: { auditRead: CATALOG_NO_PHI },
    },
    async (request) =>
      readService.listProtocols(actorOf(request), parseQuery(ListProtocolsQuery, request.query)),
  );

  // 28 — one protocol with its ordered questions (what the §5 stepper renders from).
  app.get(
    "/api/v1/triage-protocols/:protocolId",
    {
      preHandler: [P("triage.read"), ABAC_IN_ORG("triage.read")],
      config: { auditRead: CATALOG_NO_PHI },
    },
    async (request) => {
      const { protocolId } = parse(ProtocolIdParams, request.params);
      return readService.getProtocol(actorOf(request), protocolId);
    },
  );

  // 29 — author a TENANT-CUSTOM protocol. `isSystemLocked` is absent from the body: accepting it and
  //      ignoring it would leave the DON believing they had authored a protected question.
  app.post(
    "/api/v1/triage-protocols",
    {
      preHandler: [
        P("triage.admin_protocol"),
        ABAC_IN_ORG("triage.admin_protocol"),
        STEP_UP("triage.admin_protocol"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(CreateProtocolBody, request.body);
      const created = await writeService.createProtocol(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 30 — edit a tenant protocol. A platform-floor row is refused with its key named.
  app.patch(
    "/api/v1/triage-protocols/:protocolId",
    {
      preHandler: [
        P("triage.admin_protocol"),
        ABAC_IN_ORG("triage.admin_protocol"),
        STEP_UP("triage.admin_protocol"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { protocolId } = parse(ProtocolIdParams, request.params);
      const body = parse(PatchProtocolBody, request.body);
      return writeService.patchProtocol(writeActorOf(request), protocolId, body);
    },
  );

  // 31 — add a question. §4.1's "additive only on platform protocols" is NOT implemented as an exception:
  //      a tenant cannot write a child row against an org-less parent (migration 0108's INSERT policy), so
  //      the attempt is refused here with the protocol named rather than failing as a policy violation.
  app.post(
    "/api/v1/triage-protocols/:protocolId/questions",
    {
      preHandler: [
        P("triage.admin_protocol"),
        ABAC_IN_ORG("triage.admin_protocol"),
        STEP_UP("triage.admin_protocol"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { protocolId } = parse(ProtocolIdParams, request.params);
      const body = parse(ProtocolQuestionBody, request.body);
      const updated = await writeService.addProtocolQuestion(
        writeActorOf(request),
        protocolId,
        body,
      );
      return reply.code(201).send(updated);
    },
  );

  // 32 — edit one question. A system-locked question is refused: it is the D5 red-flag predicate behind a
  //      platform-floor mandatory escalation, and editing it is the cheapest way to disable one.
  app.patch(
    "/api/v1/triage-protocol-questions/:questionId",
    {
      preHandler: [
        P("triage.admin_protocol"),
        ABAC_IN_ORG("triage.admin_protocol"),
        STEP_UP("triage.admin_protocol"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { questionId } = parse(ProtocolQuestionIdParams, request.params);
      const body = parse(PatchProtocolQuestionBody, request.body);
      return writeService.patchProtocolQuestion(writeActorOf(request), questionId, body);
    },
  );

  // 33 — the tenant's vendor bindings, each with whether its §8.5 adapter is actually loaded.
  app.get(
    "/api/v1/oncall/external-vendors",
    {
      preHandler: [P("oncall.read_policy"), ABAC_IN_ORG("oncall.read_policy")],
      config: {
        auditRead: {
          none: "vendor binding configuration (name, adapter key, BAA attestation, minimization profile) — no patient data and no credential",
        },
      },
    },
    async (request) => readService.listVendorBindings(actorOf(request)),
  );

  // 34 — create a binding. The BAA attestation is a PRECONDITION (§8.5), so a binding without it is
  //      refused rather than created-and-inert: an inert binding is the worse outcome, because the
  //      tenant's policy would then name a vendor that silently cannot carry a call.
  app.post(
    "/api/v1/oncall/external-vendors",
    {
      preHandler: [
        P("oncall.admin_policy"),
        ABAC_IN_ORG("oncall.admin_policy"),
        STEP_UP("oncall.admin_policy"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(CreateVendorBindingBody, request.body);
      const created = await writeService.createVendorBinding(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 35 — "BAA renewal updates only" (§4.1's own Notes). The narrow request shape IS the rule: neither the
  //      adapter key nor the minimization profile can be changed here, because either would silently
  //      re-point live PHI at a different contract.
  app.patch(
    "/api/v1/oncall/external-vendors/:vendorId",
    {
      preHandler: [
        P("oncall.admin_policy"),
        ABAC_IN_ORG("oncall.admin_policy"),
        STEP_UP("oncall.admin_policy"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { vendorId } = parse(VendorIdParams, request.params);
      const body = parse(PatchVendorBindingBody, request.body);
      return writeService.patchVendorBinding(writeActorOf(request), vendorId, body);
    },
  );
}
