// apps/backend/src/modules/39-consent/scoped-consent-service.ts — GAP-109, the SERVICE-layer half.
//
// The route guards (`./routes/consent-guards.ts`) are the first line; this decorator is the second, so a
// future caller that reaches the service WITHOUT the route preHandlers (a new route, a controller, a job)
// still cannot read or act on a patient outside its scope. Every method of `ConsentRouteService` takes
// an explicit {@link ConsentAccessActor} first:
//   - a `staff` actor is checked against the SAME decisions the registered predicates use
//     (`./access-scope.ts`), over facts read from the STORED consent row;
//   - an internal caller passes {@link CONSENT_SYSTEM_ACTOR} — a typed marker, never inferred from a role.
// A denial is `ConsentRouteError('not_found')` (→ 404): off-scope is indistinguishable from absent.
// Break-glass opens READS only; no write rule consults it. The §4.11 read rules add a discipline scope
// and an on-call window (reads only — never a write, never the post-mortem surface).
//
// The rule table is a mapped type over `ConsentRouteService`, so adding a service method without
// deciding its access rule is a compile error rather than a silently open endpoint.
import { ConsentRouteError } from "@chartwarden/consent";
import type { ConsentRecordView, ConsentRouteService } from "@chartwarden/consent";
import {
  type ConsentAccessActor,
  type ConsentAccessDeps,
  type ConsentDisciplineScope,
  type ConsentStaffActor,
  decideBereavementWindow,
  decideCaseloadOrScope,
  decideConsentReadScope,
  decideDisciplineScope,
  decideIsDrafter,
  decideOwnerOrCompliance,
  isComplianceOfficer,
  isComplianceOrPrivacyOfficer,
  isOrgAdminOrCompliance,
  seamCaseloadPort,
} from "./access-scope";

type Fn = (...args: never[]) => unknown;

/** `ConsentRouteService` with an access actor prepended to every method. */
export type ScopedConsentRouteService = {
  [K in keyof ConsentRouteService]: ConsentRouteService[K] extends (...args: infer A) => infer R
    ? (actor: ConsentAccessActor, ...args: A) => Promise<Awaited<R>>
    : never;
};

const NOT_FOUND = "consent not found";
const deny = (): never => {
  throw new ConsentRouteError("not_found", NOT_FOUND);
};

interface Gate {
  /** Patient-keyed READ: caseload/scope; break-glass also opens it. */
  readonly patientRead: (
    actor: ConsentAccessActor,
    org: string,
    patientId: string,
    scope?: ConsentDisciplineScope,
  ) => Promise<void>;
  /** Patient-keyed WRITE: caseload/scope only. */
  readonly patientWrite: (
    actor: ConsentAccessActor,
    org: string,
    patientId: string,
  ) => Promise<void>;
  readonly role: (
    actor: ConsentAccessActor,
    allowed: (roles: readonly string[]) => boolean,
  ) => void;
  /** Load the stored consent (org-scoped) or deny. */
  readonly load: (org: string, consentId: string) => Promise<ConsentRecordView>;
  readonly consentRead: (
    actor: ConsentAccessActor,
    org: string,
    id: string,
    scope?: ConsentDisciplineScope,
  ) => Promise<void>;
  readonly consentWrite: (actor: ConsentAccessActor, org: string, id: string) => Promise<void>;
  readonly drafter: (actor: ConsentAccessActor, org: string, id: string) => Promise<void>;
  readonly drafterOrScope: (actor: ConsentAccessActor, org: string, id: string) => Promise<void>;
  readonly bereavement: (
    actor: ConsentAccessActor,
    org: string,
    patientId: string,
  ) => Promise<void>;
  /** Route 28: discipline scope, then caseload / scope OR the bereavement window. */
  readonly patientReadOrBereavement: (
    actor: ConsentAccessActor,
    org: string,
    patientId: string,
  ) => Promise<void>;
}

const isStaff = (actor: ConsentAccessActor): actor is ConsentStaffActor => actor.kind === "staff";

function buildGate(inner: ConsentRouteService, deps: ConsentAccessDeps): Gate {
  const caseload = deps.caseload ?? seamCaseloadPort;
  const staffOrDeny = (actor: ConsentAccessActor, org: string): ConsentStaffActor | null => {
    if (!isStaff(actor)) return null;
    if (actor.organizationId !== org) deny(); // a session never reaches another tenant's rows
    return actor;
  };
  const load = async (org: string, consentId: string): Promise<ConsentRecordView> =>
    (await inner.getConsent(org, consentId)) ?? deny();

  const patientRead: Gate["patientRead"] = async (actor, org, patientId, scope) => {
    if (actor.kind === "system") return;
    const staff = staffOrDeny(actor, org);
    if (!staff) return deny();
    if (staff.breakGlassEventId) return;
    const allowed = scope
      ? await decideConsentReadScope(staff, patientId, scope, { ...deps, caseload })
      : await decideCaseloadOrScope(staff, patientId, caseload);
    if (!allowed) deny();
  };
  const patientWrite: Gate["patientWrite"] = async (actor, org, patientId) => {
    if (actor.kind === "system") return;
    const staff = staffOrDeny(actor, org);
    if (!staff || !(await decideCaseloadOrScope(staff, patientId, caseload))) deny();
  };
  const bereavement: Gate["bereavement"] = async (actor, org, patientId) => {
    if (actor.kind === "system") return;
    const staff = staffOrDeny(actor, org);
    if (!staff) return deny();
    if (!(await decideBereavementWindow(staff, patientId, deps.bereavementWindow))) deny();
  };

  return {
    patientRead,
    patientWrite,
    load,
    bereavement,
    role(actor, allowed) {
      if (actor.kind === "system") return;
      if (!allowed(actor.roles)) deny();
    },
    async consentRead(actor, org, id, scope) {
      const record = await load(org, id);
      if (actor.kind === "system") return;
      const staff = staffOrDeny(actor, org);
      if (!staff) return deny();
      if (staff.breakGlassEventId) return;
      const allowed = scope
        ? await decideConsentReadScope(staff, record.patientId, scope, { ...deps, caseload })
        : await decideOwnerOrCompliance(staff, record.patientId, caseload);
      if (!allowed) deny();
    },
    async consentWrite(actor, org, id) {
      const record = await load(org, id);
      await patientWrite(actor, org, record.patientId);
    },
    async drafter(actor, org, id) {
      const record = await load(org, id);
      if (actor.kind === "system") return;
      const staff = staffOrDeny(actor, org);
      if (!staff || !decideIsDrafter(staff, record.createdById)) deny();
    },
    async drafterOrScope(actor, org, id) {
      const record = await load(org, id);
      if (actor.kind === "system") return;
      const staff = staffOrDeny(actor, org);
      if (!staff) return deny();
      if (decideIsDrafter(staff, record.createdById)) return;
      if (!(await decideCaseloadOrScope(staff, record.patientId, caseload))) deny();
    },
    async patientReadOrBereavement(actor, org, patientId) {
      if (actor.kind === "staff") {
        const staff = staffOrDeny(actor, org);
        const pinned = staff?.sessionPatientId === patientId;
        if (!staff) return deny();
        if (
          !staff.breakGlassEventId &&
          !pinned &&
          !decideDisciplineScope(staff.roles, "post_mortem")
        )
          deny();
      }
      try {
        await patientRead(actor, org, patientId);
      } catch (e) {
        if (!(e instanceof ConsentRouteError)) throw e;
        await bereavement(actor, org, patientId);
      }
    },
  };
}

type Rule<K extends keyof ConsentRouteService> = ConsentRouteService[K] extends (
  ...args: infer A
) => unknown
  ? (g: Gate, actor: ConsentAccessActor, args: A) => Promise<void> | void
  : never;

/** One access rule per service method (§4.1). Exhaustive by construction. */
const RULES: { [K in keyof ConsentRouteService]: Rule<K> } = {
  readCatalog: () => undefined, // org-level catalog; no consent record and no patient
  upsertTenantOverlay: (g, a) => g.role(a, isOrgAdminOrCompliance),
  listConsentsForPatient: (g, a, [org, patientId]) =>
    g.patientRead(a, org, patientId, "consent_management"),
  getConsent: (g, a, [org, id]) => g.consentRead(a, org, id, "consent_management"),
  getVersionChain: (g, a, [org, id]) => g.consentRead(a, org, id),
  createDraft: (g, a, [org, input]) => g.patientWrite(a, org, input.patientId),
  updateDraft: (g, a, [org, id]) => g.drafter(a, org, id),
  signConsent: (g, a, [org, id]) => g.drafterOrScope(a, org, id),
  supersedeConsent: (g, a, [org, id]) => g.consentWrite(a, org, id),
  revokeConsent: (g, a, [org, id]) => g.consentWrite(a, org, id),
  renewConsent: (g, a, [org, id]) => g.consentWrite(a, org, id),
  listRecipients: (g, a, [org, id]) => g.consentRead(a, org, id, "consent_management"),
  addRecipient: (g, a, [org, id]) => g.consentWrite(a, org, id),
  removeRecipient: (g, a, [org, id]) => g.consentWrite(a, org, id),
  listDpoaAgents: (g, a, [org, id]) => g.consentRead(a, org, id, "consent_management"),
  addDpoaAgent: (g, a, [org, id]) => g.consentWrite(a, org, id),
  updateDpoaAgent: (g, a, [org, id]) => g.consentWrite(a, org, id),
  activePrimaryDpoa: (g, a, [org, patientId]) => g.patientRead(a, org, patientId, "dpoa_clinical"),
  listExpiringConsents: (g, a, [org, patientId]) => g.patientRead(a, org, patientId),
  listRenewalCycles: (g, a, [org, id]) => g.consentRead(a, org, id),
  listDelegatedAccess: (g, a, [org, patientId]) =>
    g.patientRead(a, org, patientId, "delegated_access"),
  listEvalAudit: (g, a) => g.role(a, isComplianceOrPrivacyOfficer),
  requestDocumentReRender: (g, a) => g.role(a, isComplianceOfficer),
  listPostMortemEligible: (g, a, [org, patientId]) => g.patientReadOrBereavement(a, org, patientId),
  createBereavementOutreachDraft: (g, a, [org, input]) => g.bereavement(a, org, input.patientId),
  retryRevocationCascade: (g, a) => g.role(a, isComplianceOfficer),
};

/**
 * Wrap a `ConsentRouteService` so every call is access-checked against the actor. `getConsent` answers
 * `null` for an absent OR out-of-scope consent (the route turns that into one 404).
 */
export function createScopedConsentRouteService(
  inner: ConsentRouteService,
  deps: ConsentAccessDeps = {},
): ScopedConsentRouteService {
  const gate = buildGate(inner, deps);
  const entries = (Object.keys(RULES) as Array<keyof ConsentRouteService>).map((name) => {
    const rule = RULES[name] as unknown as (
      g: Gate,
      actor: ConsentAccessActor,
      args: unknown[],
    ) => Promise<void> | void;
    const method = inner[name] as unknown as Fn;
    const scoped = async (actor: ConsentAccessActor, ...args: unknown[]): Promise<unknown> => {
      if (name === "getConsent") {
        try {
          await rule(gate, actor, args);
        } catch (e) {
          if (e instanceof ConsentRouteError && e.code === "not_found") return null;
          throw e;
        }
      } else {
        await rule(gate, actor, args);
      }
      return (method as unknown as (...a: unknown[]) => unknown).apply(inner, args);
    };
    return [name, scoped] as const;
  });
  return Object.fromEntries(entries) as unknown as ScopedConsentRouteService;
}
