// apps/backend/src/modules/05-patient/routes/patient-routes.ts — M5-T09 the patient route inventory
// (§4.2; the §4.7 permission handshake; §7.1 admit-no-dup / §7.4 address cascade / §7.7 right-to-amend).
//
// Every route is gated by the REAL Authorization Contract (`requirePermission` + `requireAbac` from
// @chartwarden/auth, M3) on the §4.7 keys M5 registers into M3's catalog (M5_CONTRIBUTED_PERMISSIONS).
//
// F-092 — THE ABAC HALF WAS MISSING, AND SIX COMMENTS IN THIS FILE SAID OTHERWISE. Nine of M5's keys
// declare `abac: "caseload_or_scope"` in the permission catalog, and M5 was the only clinical module on
// the platform that composed NO `requireAbac` at all: this file imported `requirePermission` and
// nothing else. The catalog's `abac` field is a DECLARATION, not a mechanism — `requirePermission`
// resolves the actor's grant set and asks `granted.has(key)`, and never reads a permission's
// `defaultAbac` (which exists only to mirror into the `permission` table for the admin UI). So the
// caseload control was documented on every key, mirrored into the database, served to the permission
// browser, and enforced by nothing.
//
// The six `§7.5 non-leak` comments below each said "a non-caseload/other-org patient is 404". Only the
// other-org half was true, and RLS was doing it: `service.getPatient(organizationId, id)` takes an org
// and an id and has no caseload input to narrow by. Any holder of `patient.read` read any chart in the
// tenant. The guard now makes the comment true — `notFoundOnDeny` so a refusal is a 404 and not a 403,
// because a 403 on a chart id is itself a disclosure that the chart exists.
//
// F-096 — THE CENSUS LIST IS NOW NARROWED TOO, which is the half F-092 named and left. §7.5 is one
// sentence covering two — "an RN with two patients on her caseload sees only those two in `/patients`,
// even when the tenant has 5,000; the list query SQL contains a `patient_id = ANY(:caseloadIds)`
// filter; attempting `GET /patients/:id` for a third patient yields 404". Until now any holder of
// `patient.read` listed every patient in the tenant, which is the larger disclosure of the two: a chart
// read leaks one patient to someone who guessed an id, a census leaks the identity of every patient the
// agency serves to everyone who can log in.
//
// The list half could not be a guard. A preHandler runs before the handler, sees no rows, and can only
// allow or deny — it can REFUSE a collection but cannot FILTER one. So `list` now takes the narrowing
// set (`censusScope` below), and the org-wide-role determination that used to live inside the predicate
// moved to `hasOrgWideScope` in @chartwarden/auth, where both halves read it. M5 built `caseloadPatientIds`
// for exactly this — its doc comment calls it "the `patient_id = ANY(:ids)` list filter" — and until
// now it had one consumer platform-wide, M12's refill inbox, which is not this list.
//
// Org binding is server-side (`request.context`, never the body). Handlers compose over the injected
// `PatientRouteService` (in-memory slice; Drizzle in prod under withOrgContext so RLS backstops).
// §7.1: admit runs the T06 matcher — a hard duplicate returns 409 with the existing id, no row
// created; a soft match returns 201 + matchReviewIds. §7.4: an address change emits the cascade
// event. §7.7: an amendment opens with a 60-day SLA; accept/deny decides it (deny needs a reason).
import {
  type GuardRequest,
  hasOrgWideScope,
  requireAbac,
  requirePermission,
  requireStepUp,
} from "@chartwarden/auth";
import { ChartWardenError, UnauthorizedError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { IdentifierCipherUnboundError } from "../identifiers/identifier-cipher";
import {
  SelfMergeError,
  SourceAlreadyMergedError,
  TargetAlreadyMergedError,
  UnknownMergeFieldError,
  UnmergeableSourceStatusError,
} from "../merges";
import {
  type MergePatientsInput,
  type MergePatientsResult,
  PatientNotFoundError,
} from "../merges-db";
import {
  AddPatientPayerBodySchema,
  AddressBodySchema,
  AdmitBodySchema,
  AmendmentBodySchema,
  DenyBodySchema,
  LooseIdParamsSchema,
  MergeBodySchema,
  MessagingPatientSearchQuerySchema,
  PatientListQuerySchema,
  parse,
} from "./patient-typebox";
import type { PatientRouteService } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The one real caller of `merges-db.ts`'s `mergePatients` — closed over `db` + the outbox port at
 *  the composition root (`../index.ts`'s `mountPatientRoutes`), mirroring how `deceased-db.ts`'s
 *  `recordDeathFromDischarge` is wired outside `PatientRouteService` entirely (F-171, #248). */
export type MergePatientsFn = (input: MergePatientsInput) => Promise<MergePatientsResult>;

export interface PatientRouteDeps {
  service: PatientRouteService;
  mergePatients: MergePatientsFn;
}

/** Map `merges.ts`/`merges-db.ts`'s typed precondition errors onto the §4.3 route contract's HTTP
 *  shape. `SourceAlreadyMergedError` → `409 ALREADY_MERGED` is the spec's own named error code; the
 *  rest are this route's own (the spec names no code for them). Anything else rethrows unchanged. */
function mapMergeError(err: unknown): unknown {
  if (err instanceof PatientNotFoundError) {
    return new ChartWardenError("NOT_FOUND", `patient '${err.patientId}' not found`, 404);
  }
  if (err instanceof SelfMergeError) {
    return new ChartWardenError("SELF_MERGE", err.message, 422);
  }
  if (err instanceof SourceAlreadyMergedError) {
    return new ChartWardenError("ALREADY_MERGED", err.message, 409);
  }
  if (err instanceof TargetAlreadyMergedError) {
    return new ChartWardenError("MERGE_TARGET_ALREADY_MERGED", err.message, 409);
  }
  if (err instanceof UnmergeableSourceStatusError) {
    return new ChartWardenError("PATIENT_NOT_MERGEABLE", err.message, 409);
  }
  if (err instanceof UnknownMergeFieldError) {
    return new ChartWardenError("UNKNOWN_MERGE_FIELD", err.message, 422);
  }
  return err;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const READ = requirePermission("patient.read") as PreHandler;
const CREATE = requirePermission("patient.create") as PreHandler;

// GAP-009 (§2.3 / §4.2): `bypassMatchReview` skips the whole §7.1 duplicate pipeline, so it is not a
// `patient.create` act. When the body asks for it the actor must ALSO hold the dedicated
// `patient.create_bypass_match` key and prove a fresh step-up; a plain `patient.create` holder is a 403.
// The decision reads the PARSED body (the flag arrives as a client value, so it can only ever add a gate).
const BYPASS_PERMISSION = requirePermission("patient.create_bypass_match") as PreHandler;
const BYPASS_STEP_UP = requireStepUp("patient.create_bypass_match") as PreHandler;
const CREATE_BYPASS_GATE: PreHandler = async (request, reply) => {
  if (parse(AdmitBodySchema, request.body).bypassMatchReview !== true) return;
  await BYPASS_PERMISSION(request, reply);
  await BYPASS_STEP_UP(request, reply);
};
// GAP-010 (§4.7): an admit that carries an SSN is also a `phi.write_ssn` act and needs a fresh step-up. Like the
// bypass gate it reads the PARSED body, so a client value can only ever ADD a gate; the two gates STACK (a bypass
// admit with an SSN must pass both).
const SSN_WRITE_PERMISSION = requirePermission("phi.write_ssn") as PreHandler;
const SSN_WRITE_STEP_UP = requireStepUp("phi.write_ssn") as PreHandler;
const CREATE_SSN_GATE: PreHandler = async (request, reply) => {
  const ssn = parse(AdmitBodySchema, request.body).ssn;
  if (typeof ssn !== "string" || ssn.trim().length === 0) return;
  await SSN_WRITE_PERMISSION(request, reply);
  await SSN_WRITE_STEP_UP(request, reply);
};
const EDIT = requirePermission("patient.edit") as PreHandler;
const EDIT_PAYERS = requirePermission("patient.edit_payers") as PreHandler;
const AMEND_RECORD = requirePermission("patient.amend_request_record") as PreHandler;
const AMEND_REVIEW = requirePermission("patient.amend_review") as PreHandler;

/**
 * §7.5 per-chart scope. The predicate is M7's, bound BY NAME (no import edge — `requireAbac` takes a
 * string, which is how M12/M13/M19/M20/M23 bind the same one). Its `patientId` arm allows an org-wide
 * oversight role, a session pinned to this patient, or an open `patient_assignment`; everything else is
 * refused as a 404 (`notFoundOnDeny`), so a refusal never confirms the chart exists.
 */
const chartTarget = (request: GuardRequest): Record<string, unknown> => ({
  patientId: (request.params as { id?: unknown } | undefined)?.id,
});
const chartScope = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    getTarget: chartTarget,
    notFoundOnDeny: true,
  }) as PreHandler;

const SCOPE_READ = chartScope("patient.read");
const SCOPE_EDIT = chartScope("patient.edit");
const SCOPE_EDIT_PAYERS = chartScope("patient.edit_payers");
const SCOPE_AMEND_RECORD = chartScope("patient.amend_request_record");

// --- §4.3 merge: `patient.merge` (step-up) + `caseload_or_scope` on BOTH source (:id) and target
// (body.targetPatientId) — the spec route table's own "on both source + target" cell. Two separate
// `requireAbac` preHandlers compose by AND (the M16 guards.ts precedent), which is exactly what "on
// both" means; a single combined predicate would need a two-patient target shape `caseload_or_scope`
// does not have. `reauthToken` (the spec's TypeBox body field) is NOT part of `MergeBodySchema` — F-028
// already retired every client-supplied "fresh" claim on this platform in favor of `requireStepUp`,
// which resolves session freshness server-side; repeating the client-claim shape here for one route
// would reopen exactly the hole that finding closed.
const MERGE = requirePermission("patient.merge") as PreHandler;
const MERGE_STEP_UP = requireStepUp("patient.merge") as PreHandler;
const SCOPE_MERGE_SOURCE = chartScope("patient.merge");
const mergeTargetTarget = (request: GuardRequest): Record<string, unknown> => ({
  patientId: (request.body as { targetPatientId?: unknown } | undefined)?.targetPatientId,
});
const SCOPE_MERGE_TARGET = requireAbac("patient.merge", "caseload_or_scope", {
  getTarget: mergeTargetTarget,
  notFoundOnDeny: true,
}) as PreHandler;

/**
 * The §7.5 CENSUS narrowing (F-096): which patient ids this actor's `/api/v1/patients` may contain.
 *
 *   - `null` — an org-wide scope role: no narrowing, the whole tenant's census.
 *   - `[id]` — a session pinned to one patient (collaborator / funeral / portal, §3.6 `scope`).
 *   - the actor's open `patient_assignment` set otherwise, WHICH MAY BE EMPTY — and an empty set is a
 *     census of nothing, not a census of everything.
 *
 * WHY THIS IS NOT A GUARD. §7.5 is one sentence with two halves — "an RN with two patients on her
 * caseload sees only those two in `/patients`, even when the tenant has 5,000 … attempting
 * `GET /patients/:id` for a third patient yields 404". F-092 delivered the second half with a
 * `requireAbac` preHandler and could not deliver the first, because a preHandler can REFUSE a
 * collection but cannot FILTER one: it runs before the handler, sees no rows, and its only outputs are
 * allow and deny. Narrowing a list is a read-path concern, so the determination the predicate makes
 * internally (`hasOrgWideScope`) had to become callable from outside it — which is what F-096 moved
 * into `@chartwarden/auth`, and why both halves now answer from the same derivation rather than from two
 * lists that agree until one is edited.
 *
 * FAIL-CLOSED ON A SEAM THROW. `CaseloadProvider` is a Phase-0 deny-stub that THROWS when its owning
 * module has not registered, and M15's `seamCaseloadPort` already treats that as "not in caseload".
 * The census does the same: an empty narrowing, so an unavailable caseload seam shows a clinician no
 * patients rather than all of them.
 */
async function censusScope(request: FastifyRequest): Promise<readonly string[] | null> {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  if (hasOrgWideScope(ctx.roles ?? [])) return null;

  const pinned = ctx.attributes?.sessionPatientId;
  if (typeof pinned === "string" && pinned.length > 0) return [pinned];

  try {
    return await getSeam("CaseloadProvider").caseloadPatientIds({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    });
  } catch {
    return [];
  }
}

const notFound = (what: string) => new ChartWardenError("NOT_FOUND", `${what} not found`, 404);

// §2.5 read-audit: a single-patient chart read. `patientIdParam: "id"` joins the read to the patient
// for the §164.528 accounting query. Per-tab routes extend this with the field names they surface.
const PATIENT_READ = { resourceKind: "patient", patientIdParam: "id" } as const;

export function registerPatientRoutes(app: FastifyInstance, deps: PatientRouteDeps): void {
  const { service, mergePatients } = deps;

  // --- §4.2 census / list (cursor-paginated; org-scoped server-side) ---------------------------
  app.get(
    "/api/v1/patients",
    { preHandler: [READ], config: { auditRead: { resourceKind: "patient", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const query = parse(PatientListQuerySchema, request.query);
      return service.list(organizationId, query, await censusScope(request));
    },
  );

  // M36 patient picker: same SQL-level tenant/caseload narrowing as the census, but project only
  // the minimum identity fields needed to disambiguate a conversation target. Search visibility is
  // not an authorization grant; M36 revalidates clinical access when the channel is opened.
  app.get(
    "/api/v1/patients/messaging-search",
    { preHandler: [READ], config: { auditRead: { resourceKind: "patient", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const query = parse(MessagingPatientSearchQuerySchema, request.query);
      const result = await service.list(
        organizationId,
        { q: query.q, limit: query.limit ?? 25 },
        await censusScope(request),
      );
      const response = {
        patients: result.items.map((patient) => ({
          patientId: patient.id,
          displayName: `${patient.firstName} ${patient.lastName}`.trim(),
          medicalRecordNumber: patient.mrn,
        })),
      };
      return response;
    },
  );

  // --- §4.2 census KPI metrics (active count + per-status breakdown; static path beats /:id) ------
  app.get(
    "/api/v1/patients/census-metrics",
    {
      preHandler: [READ],
      // Aggregate counts + per-status totals only; no patient-identifying fields surfaced (§2.5 waiver).
      config: {
        auditRead: { none: "aggregate census counts only; no patient-identifying fields surfaced" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.censusMetrics(organizationId);
    },
  );

  // --- §4.2 resolve one ------------------------------------------------------------------------
  app.get(
    "/api/v1/patients/:id",
    { preHandler: [READ, SCOPE_READ], config: { auditRead: PATIENT_READ } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const p = await service.getPatient(organizationId, id);
      if (p === null) throw notFound("patient"); // §7.5: a non-caseload/other-org patient is 404, no leak
      return p;
    },
  );

  // --- §3.3 demographics tab (legal name parts + SOGI/race/ethnicity codes + language + aliases) --
  app.get(
    "/api/v1/patients/:id/demographics",
    {
      preHandler: [READ, SCOPE_READ],
      config: {
        auditRead: {
          ...PATIENT_READ,
          fields: ["legal_name", "sogi", "race", "ethnicity", "language", "aliases"],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const d = await service.getDemographics(organizationId, id);
      if (d === null) throw notFound("patient"); // §7.5 non-leak: other-org / non-existent → 404
      return d;
    },
  );

  // --- §3.3/§2.2 identifiers tab (ssn/state_id MASKED — value_encrypted never serialized) ---------
  app.get(
    "/api/v1/patients/:id/identifiers",
    {
      preHandler: [READ, SCOPE_READ],
      config: { auditRead: { ...PATIENT_READ, fields: ["mrn", "ssn", "state_id", "mbi"] } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const rows = await service.getIdentifiers(organizationId, id);
      if (rows === null) throw notFound("patient");
      return { identifiers: rows };
    },
  );

  // --- §3.4 coverage / payers tab (ranked coverages; payer NAME resolved client-side via M40) -----
  app.get(
    "/api/v1/patients/:id/payers",
    {
      preHandler: [READ, SCOPE_READ],
      config: { auditRead: { ...PATIENT_READ, fields: ["payer", "member_id"] } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const rows = await service.listPayers(organizationId, id);
      if (rows === null) throw notFound("patient"); // §7.5 non-leak
      return { payers: rows };
    },
  );

  app.post(
    "/api/v1/patients/:id/payers",
    {
      // GAP-017: coverage is billing-relevant, so it has its own key (not `patient.edit`) AND the
      // §7.5 caseload scope — an off-caseload actor gets the same non-leaking 404 as every other tab.
      preHandler: [EDIT_PAYERS, SCOPE_EDIT_PAYERS],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);

      const { id } = parse(LooseIdParamsSchema, request.params);

      const body = parse(AddPatientPayerBodySchema, request.body);

      const payer = await service.addPayer(organizationId, id, body, userId);

      return reply.code(201).send(payer);
    },
  );

  // --- §3.4/§3.5 care team & assignments tab (assignment roster + caregivers + emergency contacts) -
  app.get(
    "/api/v1/patients/:id/care-team",
    { preHandler: [READ, SCOPE_READ], config: { auditRead: PATIENT_READ } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const team = await service.getCareTeam(organizationId, id);
      if (team === null) throw notFound("patient"); // §7.5 non-leak
      return team;
    },
  );

  // --- §3.5/§7.6 privacy flags tab (active restrictions snapshot; SUD fail-closed disclosability) --
  app.get(
    "/api/v1/patients/:id/privacy-flags",
    { preHandler: [READ, SCOPE_READ], config: { auditRead: PATIENT_READ } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const flags = await service.getPrivacyFlags(organizationId, id);
      if (flags === null) throw notFound("patient"); // §7.5 non-leak
      return flags;
    },
  );

  // --- §4.2 admit (runs the §7.1 match pipeline; hard dup → 409) --------------------------------
  app.post(
    "/api/v1/patients",
    { preHandler: [CREATE, CREATE_BYPASS_GATE, CREATE_SSN_GATE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(AdmitBodySchema, request.body);
      if (body.bypassMatchReview === true && !body.bypassJustification) {
        throw new ValidationError("a bypass of the duplicate-match review needs a justification", [
          {
            field: "bypassJustification",
            code: "REQUIRED",
            message: "bypassJustification is required with bypassMatchReview",
          },
        ]);
      }
      const result = await service.admit(organizationId, body, userId).catch((e: unknown) => {
        // GAP-010: no tenant key bound / ring destroyed -> 503, not a 500 and not a silent unencrypted write.
        if (e instanceof IdentifierCipherUnboundError) {
          throw new ChartWardenError("IDENTIFIER_CIPHER_UNBOUND", e.message, 503);
        }
        throw e;
      });
      if (result.outcome === "hard_block") {
        // §7.1: no patient row created; surface the existing chart for "Open existing patient".
        throw new ChartWardenError(
          "DUPLICATE_OF",
          `duplicate of ${result.existingPatientId} (matched on ${result.matchedOn})`,
          409,
          [{ field: "existingPatientId", code: "DUPLICATE_OF", message: result.existingPatientId }],
        );
      }
      return reply.code(201).send(result);
    },
  );

  // --- §3.3 addresses tab (D5 append-only history; current rows + history) ----------------------
  app.get(
    "/api/v1/patients/:id/addresses",
    {
      preHandler: [READ, SCOPE_READ],
      config: { auditRead: { ...PATIENT_READ, fields: ["address"], list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const rows = await service.listAddresses(organizationId, id);
      if (rows === null) throw notFound("patient"); // §7.5 non-leak
      return { addresses: rows };
    },
  );

  // --- §4.2 add address (§7.4 cascade) ---------------------------------------------------------
  app.post(
    "/api/v1/patients/:id/addresses",
    { preHandler: [EDIT, SCOPE_EDIT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(AddressBodySchema, request.body);
      const out = await service.addAddress(organizationId, id, body, userId);
      return reply.code(201).send(out);
    },
  );

  // --- §4.3 direct merge (admin-initiated, outside the match-review queue) ----------------------
  // `:id` is the SOURCE (the duplicate being folded away); `targetPatientId` (body) is the survivor.
  // Both scoped by `caseload_or_scope` (SCOPE_MERGE_SOURCE / SCOPE_MERGE_TARGET, composed by AND) plus
  // a fresh step-up. See `merges-db.ts` for the transactional write; `mapMergeError` for the status
  // codes each precondition violation maps to.
  app.post(
    "/api/v1/patients/:id/merge",
    { preHandler: [MERGE, MERGE_STEP_UP, SCOPE_MERGE_SOURCE, SCOPE_MERGE_TARGET] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(MergeBodySchema, request.body);
      try {
        const result = await mergePatients({
          organizationId,
          sourcePatientId: id,
          targetPatientId: body.targetPatientId,
          fieldResolutions: body.fieldResolutions ?? {},
          reason: body.reason,
          actorUserId: userId,
        });
        return reply.code(200).send(result);
      } catch (err) {
        throw mapMergeError(err);
      }
    },
  );

  // --- §4.2 submit amendment (§7.7 60-day SLA) -------------------------------------------------
  app.post(
    "/api/v1/patients/:id/amendments",
    { preHandler: [AMEND_RECORD, SCOPE_AMEND_RECORD] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(AmendmentBodySchema, request.body);
      const out = await service.submitAmendment(organizationId, id, body, userId);
      return reply.code(201).send(out);
    },
  );

  // --- §4.2 accept / deny an amendment (§7.7) --------------------------------------------------
  // NO chart-scope guard, and it is not an omission: `:id` here is an AMENDMENT id, and
  // `caseload_or_scope` resolves a `patientId` or an M7 `planId` — it cannot turn an amendment into the
  // patient it concerns, and a target it cannot resolve falls through to the org-precondition arm,
  // which would look like a guard and allow everyone. `patient.amend_review` is `abac: "none"` in the
  // catalog for the same reason the reviewer is not the clinician: §7.7 review is a records-management
  // decision (the 60-day SLA, HIPAA §164.526), taken by whoever holds the key, not by the care team.
  app.post("/api/v1/amendments/:id/accept", { preHandler: [AMEND_REVIEW] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(LooseIdParamsSchema, request.params);
    return service.decideAmendment(organizationId, id, { accept: true }, userId);
  });

  app.post("/api/v1/amendments/:id/deny", { preHandler: [AMEND_REVIEW] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(LooseIdParamsSchema, request.params);
    const { denialReason } = parse(DenyBodySchema, request.body);
    return service.decideAmendment(organizationId, id, { accept: false, denialReason }, userId);
  });
}
