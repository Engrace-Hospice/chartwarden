// apps/backend/src/modules/39-consent/routes/consent-guards.ts — GAP-109: the §4.1 ABAC column as
// composed, registered `requireAbac` guards (the M15 `routes/guards.ts` / M17 idiom).
//
// `requireAbac`'s `getTarget` is synchronous, so a CONSENT-keyed route first loads the stored row's
// patient (and drafter) into a per-request slot with a resolver guard, then the predicate runs over that
// stored fact — the patient is never a path/body/query claim on those routes. A consent that cannot be
// resolved (absent / other tenant) maps to a sentinel patient nobody covers, so the answer is a 404
// indistinguishable from "exists but not yours"; org-wide scope roles are exempt inside the predicate and
// the service layer (`../scoped-consent-service.ts`) then 404s the missing row.
//
// Every guard on a MUTATING route opts out of the break-glass bypass (`breakGlassBypassable: false`):
// an emergency grant is proof of emergency access to READ, never to author, sign, revoke or administer.
import { BREAK_GLASS_ATTRIBUTE, requireAbac } from "@chartwarden/auth";
import type { ConsentRouteService } from "@chartwarden/consent";
import { ForbiddenError, NotFoundError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ConsentDisciplineScope, ConsentStaffActor } from "../access-scope";

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** A patient id no one is on the caseload of — what an unresolved consent resolves to (⇒ 404). */
const UNRESOLVED_PATIENT = "00000000-0000-0000-0000-000000000000";

const WRITE = { breakGlassBypassable: false } as const;

const param = (request: FastifyRequest, key: string): string => {
  const value = (request.params as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
};
const bodyString = (request: FastifyRequest, key: string): string => {
  const value = (request.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
};

/** Run guards in order; the first that passes admits. A refusal (403/404) falls through to the next. */
export function anyOf(...guards: PreHandler[]): PreHandler {
  return async (request, reply) => {
    let last: unknown = new ForbiddenError("no alternative admitted the request");
    for (const guard of guards) {
      try {
        await guard(request, reply);
        return;
      } catch (error) {
        if (!(error instanceof ForbiddenError || error instanceof NotFoundError)) throw error;
        last = error;
      }
    }
    throw last;
  };
}

/** The authenticated actor, assembled ONLY from `request.context` (never the body). */
export function accessActorOf(request: FastifyRequest): ConsentStaffActor | null {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) return null;
  const pinned = ctx.attributes?.sessionPatientId;
  const glass = ctx.attributes?.[BREAK_GLASS_ATTRIBUTE];
  const membership = ctx.attributes?.membershipId;
  return {
    kind: "staff",
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles ?? [],
    sessionPatientId: typeof pinned === "string" && pinned.length > 0 ? pinned : null,
    membershipId: typeof membership === "string" && membership.length > 0 ? membership : null,
    breakGlassEventId: typeof glass === "string" && glass.length > 0 ? glass : null,
  };
}

interface ResolvedConsent {
  readonly patientId: string;
  readonly createdById: string;
}

export interface ConsentGuards {
  /** Patient-keyed: `caseload_or_scope` on `:patientId`, 404 on deny. */
  readonly patientScope: (
    key: string,
    access: "read" | "write",
    scope?: ConsentDisciplineScope,
  ) => PreHandler[];
  /** Consent-keyed read: `consent_owner_or_compliance`, 404 on deny. */
  readonly consentRead: (key: string, scope?: ConsentDisciplineScope) => PreHandler[];
  /** Consent-keyed write: `caseload_or_scope` over the STORED patient, 404 on deny. */
  readonly consentScope: (key: string) => PreHandler[];
  /** Route 7: `is_consent_drafter` over the stored drafter. */
  readonly consentDrafter: (key: string) => PreHandler[];
  /** Route 8: `is_consent_drafter` or `caseload_or_scope`. */
  readonly consentDrafterOrScope: (key: string) => PreHandler[];
  readonly complianceOfficer: (key: string) => PreHandler[];
  readonly complianceOrPrivacy: (key: string) => PreHandler[];
  readonly orgAdminOrCompliance: (key: string) => PreHandler[];
  /** Route 28: discipline scope, then `bereavement_window` or `caseload_or_scope` (a read). */
  readonly bereavementOrScopeRead: (key: string) => PreHandler[];
  /** Route 29: `bereavement_window` over the body's `patientId` (a write). */
  readonly bereavementWrite: (key: string) => PreHandler[];
}

export function createConsentGuards(service: ConsentRouteService): ConsentGuards {
  const slots = new WeakMap<object, ResolvedConsent>();
  const unresolved: ResolvedConsent = { patientId: UNRESOLVED_PATIENT, createdById: "" };
  const slotOf = (request: FastifyRequest): ResolvedConsent => slots.get(request) ?? unresolved;

  /** Load the stored consent's patient + drafter (org-scoped). Never throws: absent ⇒ sentinel. */
  const resolve: PreHandler = async (request) => {
    const organizationId = request.context?.organizationId;
    if (!organizationId) return;
    try {
      const record = await service.getConsent(organizationId, param(request, "consentId"));
      if (record) {
        slots.set(request, { patientId: record.patientId, createdById: record.createdById });
      }
    } catch {
      // unresolvable ⇒ sentinel ⇒ denied
    }
  };

  const opts = (
    write: boolean,
    notFoundOnDeny: boolean,
    getTarget: (request: FastifyRequest) => Record<string, unknown>,
  ) => ({
    notFoundOnDeny,
    ...(write ? WRITE : {}),
    getTarget: (request: unknown) => getTarget(request as FastifyRequest),
  });
  const storedPatient = (request: FastifyRequest) => ({ patientId: slotOf(request).patientId });
  const pathPatient = (request: FastifyRequest) => ({ patientId: param(request, "patientId") });
  const withScope =
    (scope: ConsentDisciplineScope, base: (request: FastifyRequest) => Record<string, unknown>) =>
    (request: FastifyRequest) => ({ ...base(request), disciplineScope: scope });

  const caseloadStored = (key: string): PreHandler =>
    requireAbac(key, "caseload_or_scope", opts(true, true, storedPatient)) as PreHandler;
  const ownerStored = (key: string): PreHandler =>
    requireAbac(key, "consent_owner_or_compliance", opts(false, true, storedPatient)) as PreHandler;
  /** §4.11 read chain (discipline, then caseload-or-compliance or on-call) over the STORED patient. */
  const readScopeStored = (key: string, scope: ConsentDisciplineScope): PreHandler =>
    requireAbac(
      key,
      "consent_read_scope",
      opts(false, true, withScope(scope, storedPatient)),
    ) as PreHandler;
  const readScopePath = (key: string, scope: ConsentDisciplineScope): PreHandler =>
    requireAbac(
      key,
      "consent_read_scope",
      opts(false, true, withScope(scope, pathPatient)),
    ) as PreHandler;
  const disciplinePath = (key: string, scope: ConsentDisciplineScope): PreHandler =>
    requireAbac(
      key,
      "consent_discipline_scope",
      opts(false, true, withScope(scope, pathPatient)),
    ) as PreHandler;
  const caseloadPath = (key: string, write: boolean): PreHandler =>
    requireAbac(key, "caseload_or_scope", opts(write, true, pathPatient)) as PreHandler;
  const windowPath = (key: string): PreHandler =>
    requireAbac(key, "consent_bereavement_window", opts(false, true, pathPatient)) as PreHandler;
  const drafter = (key: string): PreHandler =>
    requireAbac(
      key,
      "is_consent_drafter",
      opts(true, false, (request) => ({ createdById: slotOf(request).createdById })),
    ) as PreHandler;

  return {
    patientScope: (key, access, scope) => [
      access === "read" && scope
        ? readScopePath(key, scope)
        : caseloadPath(key, access === "write"),
    ],
    consentRead: (key, scope) => [resolve, scope ? readScopeStored(key, scope) : ownerStored(key)],
    consentScope: (key) => [resolve, caseloadStored(key)],
    consentDrafter: (key) => [resolve, drafter(key)],
    consentDrafterOrScope: (key) => [resolve, anyOf(drafter(key), caseloadStored(key))],
    complianceOfficer: (key) => [
      requireAbac(
        key,
        "consent_compliance_officer",
        opts(true, false, () => ({})),
      ) as PreHandler,
    ],
    complianceOrPrivacy: (key) => [
      // Decision-audit data is compliance-only: an emergency grant does not open it either.
      requireAbac(
        key,
        "consent_compliance_or_privacy_officer",
        opts(true, false, () => ({})),
      ) as PreHandler,
    ],
    orgAdminOrCompliance: (key) => [
      requireAbac(
        key,
        "consent_org_admin_or_compliance",
        opts(true, false, () => ({})),
      ) as PreHandler,
    ],
    bereavementOrScopeRead: (key) => [
      disciplinePath(key, "post_mortem"),
      anyOf(caseloadPath(key, false), windowPath(key)),
    ],
    bereavementWrite: (key) => [
      requireAbac(
        key,
        "consent_bereavement_window",
        opts(true, true, (request) => ({ patientId: bodyString(request, "patientId") })),
      ) as PreHandler,
    ],
  };
}
