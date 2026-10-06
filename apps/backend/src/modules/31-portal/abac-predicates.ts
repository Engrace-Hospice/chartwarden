// apps/backend/src/modules/31-portal/abac-predicates.ts — M31-T07 (§4.7 / §8.2).
//
// The SIX named ABAC predicate resolvers M31 registers into M3's named-predicate registry. Each is a typed
// `(context, target) => boolean` evaluated server-side AFTER RBAC passes; every subject fact is loaded
// through the injected {@link PortalAbacResolver} (M31's three owned tables, org-scoped + RLS-backstopped)
// or an upstream seam resolved OPAQUELY through the M1 registry (M39 consent / M16 bereaved window /
// M5 caregiver + address / M38 state matrix) — never read off the request body.
//
//   portal_account_active            — §4.7: the acting portal account is `active` (or `bereaved`, still a
//        live account with a narrowed scope). The account id rides on the portal SESSION.
//   portal_grant_active_for_patient  — §4.7: an ACTIVE `portal_access_grant` pairs the session's account
//        with the target patient AND the backing M39 consent is live (§8.2 — a portal read is refused the
//        instant the consent is withdrawn, before any byte crosses).
//   portal_caregiver_is_primary_or_dpoa — §4.7: gates the caregiver-attested-administration route (M13
//        D10). A DPOA agent or the patient-self always passes; a family caregiver passes only when M5's
//        `PatientCaregiverReader` confirms she is the PRIMARY caregiver bound to this account's user.
//   bereaved_portal_window_open      — §4.7: the M16 13-month bereavement window (or state-extended) is open
//        for this account+patient.
//   telehealth_consent_active        — §4.7: M39 `telehealth_consent` is live for the visit's patient.
//   portal_engagement_scope          — GAP-093: the auditor-engagement view. The acting session is an `auditor`
//        session whose OWN engagement (stamped server-side) is the one the route names, and M3's
//        `AuditorEngagementReader` confirms that engagement is active now. M3 registers no shared
//        `engagement_scope` predicate, so M31 owns this one (a distinct name — the registry is single-owner).
//   state_two_party_recording_consent_present — §4.7 / D9: reads the patient's residence state (M5
//        `PatientAddressReader`) against the §3.8 two-party matrix; in a two-party state the visit's
//        patient must carry an explicit recording consent, else the Record button is refused.
//
// PORTAL SESSION IS THE SUBJECT ANCHOR. The portal predicates take `portalAccountId` / `patientId` from
// the SERVER-assembled session (`context.attributes.portalAccountId` / `.sessionPatientId`), never from the
// query string — §8.3.1's threat (b) is exactly a caregiver with a valid session naming another patient's
// id, and sourcing both ids from the session makes the mismatch unrepresentable rather than merely refused.
// The telehealth predicates take a `telehealthVisitId` and resolve the patient from the visit row, so a
// staff caller cannot name a patient it has no visit with.
//
// THE FAIL DIRECTION IS UNIFORM. An unreadable resolver, an unknown target, an absent row, a cross-tenant
// id, a non-portal session class, an unbound/erroring M39 and a thrown error all DENY. §8.2 makes the
// consent read fail CLOSED: a portal surface that cannot prove consent must refuse, never disclose.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has`.
import {
  PORTAL_SESSION_CLASSES as AUTH_PORTAL_SESSION_CLASSES,
  type AbacContext,
  type AbacTarget,
  registerPredicateIdempotent,
} from "@wardenx/auth";
import type { PortalAccessGrantKind, PortalAccountStatus } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";
import { consentTypeForGrantKind, portalSessionClass } from "./lifecycle/portal-access-gate";
import { isTwoPartyRecordingState } from "./telehealth/state-matrix";

/** The §4.7 predicate names M31 OWNS (registered into M3). Single-owner across the platform registry. */
export const M31_ABAC_PREDICATES = [
  "portal_account_active",
  "portal_grant_active_for_patient",
  "portal_caregiver_is_primary_or_dpoa",
  "bereaved_portal_window_open",
  "telehealth_consent_active",
  "state_two_party_recording_consent_present",
  "portal_engagement_scope",
] as const;

export type M31RegisteredAbacPredicate = (typeof M31_ABAC_PREDICATES)[number];

/**
 * The three portal session classes M2 mints; a non-portal class denies every `portal.*` predicate.
 *
 * Re-exported from @wardenx/auth rather than redefined. M16, M19 and M31 each kept their own copy of
 * this list, all three comparing against `session_class` values the enum did not contain until
 * migration 0219 (F-030) — three independent copies of a vocabulary that matched nothing, which is
 * exactly how a fourth copy would have drifted once the enum finally gained the values.
 */
export const PORTAL_SESSION_CLASSES = AUTH_PORTAL_SESSION_CLASSES;

// ── the facts the six predicates decide over (M31's three owned tables) ────────────────────────────────

/** The `portal_account` facts the account predicate reads. */
export interface PortalAccountAbacFacts {
  readonly portalAccountId: string;
  readonly userId: string;
  readonly status: PortalAccountStatus;
}

/** One ACTIVE `portal_access_grant` row (revoked_at IS NULL) as the grant predicates read it. */
export interface PortalGrantAbacFacts {
  readonly grantId: string;
  readonly portalAccountId: string;
  readonly patientId: string;
  readonly grantKind: PortalAccessGrantKind;
}

/** The `telehealth_visit` facts the telehealth predicates read (patient resolved from the visit, not the wire). */
export interface TelehealthVisitAbacFacts {
  readonly telehealthVisitId: string;
  readonly patientId: string;
}

/** The read surface M31's predicates resolve against (Drizzle in prod; in-memory in tests). */
export interface PortalAbacResolver {
  /** Account facts for an id, or null when absent / cross-tenant / unreadable (fail-closed). */
  loadAccount(orgId: string, portalAccountId: string): Promise<PortalAccountAbacFacts | null>;
  /** The ACTIVE grant pairing an account with a patient, or null. */
  activeGrant(
    orgId: string,
    portalAccountId: string,
    patientId: string,
  ): Promise<PortalGrantAbacFacts | null>;
  /** Telehealth visit facts for an id, or null. */
  loadTelehealthVisit(
    orgId: string,
    telehealthVisitId: string,
  ): Promise<TelehealthVisitAbacFacts | null>;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubPortalAbacResolver: PortalAbacResolver = {
  async loadAccount() {
    return null;
  },
  async activeGrant() {
    return null;
  },
  async loadTelehealthVisit() {
    return null;
  },
};

// ── the cross-module reads the predicates make (through the M1 registry, never a schema import) ──────────

/** The upstream seam reach the portal predicates take, injectable so §9 unit-tests the RULES with no seams. */
export interface PortalAbacPorts {
  /** M39 `ConsentEvaluator.evaluate` — is `consentType` live for this patient? Fail-closed on error. */
  consentActive(input: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionClass: string;
  }): Promise<boolean>;
  /** M16 `BereavedPortalScopeProvider.isWindowOpen` — is the bereavement window open? Fail-closed. */
  bereavedWindowOpen(input: {
    organizationId: string;
    portalAccountId: string;
    patientId: string;
    asOf: string;
  }): Promise<boolean>;
  /** M5 `PatientCaregiverReader` — the M2 user id of the patient's PRIMARY caregiver, or null. */
  primaryCaregiverUserId(orgId: string, patientId: string): Promise<string | null>;
  /** M5 `PatientAddressReader` — the patient's residence state code (2-letter), or null. */
  patientResidenceState(orgId: string, patientId: string): Promise<string | null>;
  /** M3 `AuditorEngagementReader` — is this engagement active now for this auditor? Fail-closed on error. */
  engagementActive(input: {
    organizationId: string;
    engagementId: string;
    auditorUserId: string;
    at: string;
  }): Promise<boolean>;
}

// Structural shapes for the seams this file calls — no `@wardenx/*/seams` import edge is taken.
interface ConsentEvaluatorShape {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string };
    callerModule: string;
  }): Promise<{ allowed: boolean }>;
}
interface BereavedPortalScopeShape {
  isWindowOpen(args: {
    organizationId: string;
    portalAccountId: string;
    patientId: string;
    asOf: string;
  }): Promise<boolean>;
}
/** The production ports — every seam resolved LAZILY at call time through the M1 registry, so registration
 *  order is irrelevant and an unregistered seam denies at its own deny-stub rather than at boot. */
export const seamPortalAbacPorts: PortalAbacPorts = {
  async consentActive({ organizationId, patientId, consentType, sessionClass }) {
    try {
      const evaluator = getSeam("ConsentEvaluator") as unknown as ConsentEvaluatorShape;
      const verdict = await evaluator.evaluate({
        organizationId,
        patientId,
        consentType,
        sessionContext: { sessionClass },
        callerModule: "m31",
      });
      return verdict.allowed === true;
    } catch {
      return false; // §8.2 — an unbound / erroring M39 DENIES the portal read
    }
  },
  async bereavedWindowOpen(input) {
    try {
      const provider = getSeam(
        "BereavedPortalScopeProvider",
      ) as unknown as BereavedPortalScopeShape;
      return await provider.isWindowOpen(input);
    } catch {
      return false;
    }
  },
  async primaryCaregiverUserId(orgId, patientId) {
    try {
      return await getSeam("PatientCaregiverReader").primaryCaregiverUserId(orgId, patientId);
    } catch {
      return null;
    }
  },
  async patientResidenceState(orgId, patientId) {
    try {
      return await getSeam("PatientAddressReader").primaryResidenceState(orgId, patientId);
    } catch {
      return null;
    }
  },
  async engagementActive(input) {
    try {
      return (
        (await getSeam("AuditorEngagementReader").isEngagementActiveForAuditor(input)) === true
      );
    } catch {
      return false; // an unbound / erroring M3 DENIES the auditor view
    }
  },
};

/** Deps for M31's §4.7 predicate resolvers. */
export interface PortalAbacDeps {
  readonly resolver: PortalAbacResolver;
  readonly ports?: PortalAbacPorts;
  /** Injected clock (the `asOf` the bereavement-window path compares against). */
  readonly now?: () => Date;
}

const targetStr = (target: AbacTarget, ...fields: string[]): string | null => {
  for (const field of fields) {
    const value = target[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

/** The SERVER-assembled session class (M2). Never a header, body or query field. */
export function portalSessionClassOf(context: AbacContext): string {
  const value = context.attributes.sessionClass;
  return typeof value === "string" && value.length > 0 ? value : "staff";
}

/** True iff the acting session is one of the three portal classes. */
export function isPortalSession(context: AbacContext): boolean {
  return (PORTAL_SESSION_CLASSES as readonly string[]).includes(portalSessionClassOf(context));
}

// ── the pure rules (unit-testable with no resolver, no seams, no clock) ────────────────────────────────

/** §4.7 `portal_account_active`, decided over already-resolved facts. `bereaved` is still a live account. */
export function decidePortalAccountActive(account: PortalAccountAbacFacts | null): boolean {
  return account !== null && (account.status === "active" || account.status === "bereaved");
}

/** §4.7 `portal_caregiver_is_primary_or_dpoa`, decided over already-resolved facts. */
export function decideCaregiverPrimaryOrDpoa(input: {
  readonly grant: PortalGrantAbacFacts | null;
  readonly account: PortalAccountAbacFacts | null;
  readonly primaryCaregiverUserId: string | null;
}): boolean {
  const { grant, account } = input;
  if (grant === null || account === null) return false;
  if (grant.grantKind === "dpoa_healthcare" || grant.grantKind === "patient_self") return true;
  if (grant.grantKind !== "family_caregiver") return false;
  // A family caregiver may attest only when she is the PRIMARY caregiver bound to this account's user.
  return input.primaryCaregiverUserId !== null && input.primaryCaregiverUserId === account.userId;
}

// ── the registry closures ──────────────────────────────────────────────────────────────────────────────

/**
 * Build M31's six §4.7 predicate resolvers over injected deps (pure factory — unit-tested against a fresh
 * registry; the boot path registers them via {@link registerPortalAbacPredicates}).
 */
export function buildPortalAbacPredicates(
  deps: PortalAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const ports = deps.ports ?? seamPortalAbacPorts;
  const now = deps.now ?? (() => new Date());

  /** Resolve the visit's patient (never the wire) for the telehealth predicates. */
  const visitPatient = async (orgId: string, target: AbacTarget): Promise<string | null> => {
    const directPatient = targetStr(target, "patientId");
    if (directPatient !== null) return directPatient;
    const visitId = targetStr(target, "telehealthVisitId", "visitId");
    if (visitId === null) return null;
    const visit = await resolver.loadTelehealthVisit(orgId, visitId).catch(() => null);
    return visit?.patientId ?? null;
  };

  return {
    /** §4.1 — the session's own account is a live one. Account id from the SESSION. */
    portal_account_active: async (context, target) => {
      if (!context.organizationId || !isPortalSession(context)) return false;
      const portalAccountId = targetStr(target, "portalAccountId");
      if (portalAccountId === null) return false;
      const account = await resolver
        .loadAccount(context.organizationId, portalAccountId)
        .catch(() => null);
      return decidePortalAccountActive(account);
    },

    /** §4.1 — an active grant pairs this account with the patient AND the backing consent is live. */
    portal_grant_active_for_patient: async (context, target) => {
      if (!context.organizationId || !isPortalSession(context)) return false;
      const portalAccountId = targetStr(target, "portalAccountId");
      const patientId = targetStr(target, "patientId");
      if (portalAccountId === null || patientId === null) return false;
      const grant = await resolver
        .activeGrant(context.organizationId, portalAccountId, patientId)
        .catch(() => null);
      if (grant === null) return false;
      return ports.consentActive({
        organizationId: context.organizationId,
        patientId,
        consentType: consentTypeForGrantKind(grant.grantKind),
        sessionClass: portalSessionClassOf(context),
      });
    },

    /** §4.1 caregiver-attested administration (M13 D10) — DPOA / self, or the PRIMARY family caregiver. */
    portal_caregiver_is_primary_or_dpoa: async (context, target) => {
      if (!context.organizationId || !isPortalSession(context)) return false;
      const portalAccountId = targetStr(target, "portalAccountId");
      const patientId = targetStr(target, "patientId");
      if (portalAccountId === null || patientId === null) return false;
      const [account, grant] = await Promise.all([
        resolver.loadAccount(context.organizationId, portalAccountId).catch(() => null),
        resolver.activeGrant(context.organizationId, portalAccountId, patientId).catch(() => null),
      ]);
      if (grant === null || account === null) return false;
      // Only reach M5 when the family-caregiver arm needs the primary check.
      const primaryCaregiverUserId =
        grant.grantKind === "family_caregiver"
          ? await ports.primaryCaregiverUserId(context.organizationId, patientId).catch(() => null)
          : null;
      return decideCaregiverPrimaryOrDpoa({ grant, account, primaryCaregiverUserId });
    },

    /** §4.1 bereavement surface — the M16 13-month window is open for this account+patient. */
    bereaved_portal_window_open: async (context, target) => {
      if (!context.organizationId || !isPortalSession(context)) return false;
      const portalAccountId = targetStr(target, "portalAccountId");
      const patientId = targetStr(target, "patientId");
      if (portalAccountId === null || patientId === null) return false;
      return ports.bereavedWindowOpen({
        organizationId: context.organizationId,
        portalAccountId,
        patientId,
        asOf: now().toISOString(),
      });
    },

    /** §4.1 telehealth join — M39 `telehealth_consent` is live for the visit's patient. */
    telehealth_consent_active: async (context, target) => {
      if (!context.organizationId) return false;
      const patientId = await visitPatient(context.organizationId, target);
      if (patientId === null) return false;
      // GAP-094: when the guard supplies the session's patient (every portal route), it must be the visit's.
      const sessionPatientId = targetStr(target, "sessionPatientId");
      if (isPortalSession(context) && sessionPatientId !== patientId) return false;
      return ports.consentActive({
        organizationId: context.organizationId,
        patientId,
        consentType: "telehealth_consent",
        sessionClass: portalSessionClassOf(context),
      });
    },

    /** GAP-093 — the auditor's session engagement is the one the route names, and it is active now. */
    portal_engagement_scope: async (context, target) => {
      try {
        if (!context.organizationId || !context.userId) return false;
        if (portalSessionClassOf(context) !== "auditor") return false;
        const engagementId = targetStr(target, "engagementId");
        // The session's OWN engagement (server-stamped), never the route's claim of it.
        const sessionEngagementId = targetStr(target, "sessionEngagementId");
        if (engagementId === null || engagementId !== sessionEngagementId) return false;
        return await ports.engagementActive({
          organizationId: context.organizationId,
          engagementId,
          auditorUserId: context.userId,
          at: now().toISOString(),
        });
      } catch {
        return false;
      }
    },

    /** §4.1 recording start (D9) — a two-party state demands an explicit recording consent. */
    state_two_party_recording_consent_present: async (context, target) => {
      if (!context.organizationId) return false;
      const patientId = await visitPatient(context.organizationId, target);
      if (patientId === null) return false;
      const stateCode = await ports.patientResidenceState(context.organizationId, patientId);
      // An unknown residence fails CLOSED to two-party (isTwoPartyRecordingState), so a missing address
      // never becomes a silent one-party recording.
      if (!isTwoPartyRecordingState(stateCode)) return true; // one-party state — clinician's session suffices
      return ports.consentActive({
        organizationId: context.organizationId,
        patientId,
        consentType: "telehealth_consent",
        sessionClass: portalSessionClassOf(context),
      });
    },
  };
}

/**
 * Register M31's six §4.7 ABAC predicate resolvers into M3's shared registry (M31-T07; idempotent). Call at
 * boot after the M31 route services are constructed (the resolver reads the same tables). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerPortalAbacPredicates(deps: PortalAbacDeps): void {
  const predicates = buildPortalAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}

// Re-export so the route guards can name the portal session class without a second import.
export { portalSessionClass };
