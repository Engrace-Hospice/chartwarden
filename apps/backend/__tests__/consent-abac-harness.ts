// apps/backend/__tests__/consent-abac-harness.ts — GAP-109 test support (not a test file).
//
// The M39 route inventory is now gated by the §4.1 ABAC column, which resolves through the shared named-
// predicate registry. Suites that exercise route BEHAVIOUR (not access scope) install permissive stand-ins
// for the two ports the access rules consult, so those suites keep testing what they test. The access
// rules themselves are pinned against the REAL caseload resolver in `consent-routes-abac.test.ts`.
import { abacRegistry, registerAbacRegistry, registerPredicateIdempotent } from "@wardenx/auth";
import { registerSeam } from "../src/bootstrap/seams/registry";
import {
  type ConsentAccessDeps,
  registerConsentAbacPredicates,
} from "../src/modules/39-consent/index";

const ALLOW = async (): Promise<boolean> => true;

/** The same permissive ports for the SERVICE-layer decorator (`registerConsentRoutes({ access })`). */
export const PERMISSIVE_ACCESS: ConsentAccessDeps = {
  caseload: { isInCaseload: ALLOW },
  bereavementWindow: { isAssignedInWindow: ALLOW },
  onCallWindow: { isOnCallNow: ALLOW },
};

/**
 * The role a harness user carries unless `ROLE_FOR_TEST_USER` names one. It sits inside every §4.11
 * discipline set (consent management, DPOA, delegated access, post-mortem), so behaviour suites keep
 * exercising route behaviour; the discipline rules themselves are pinned in `consent-routes-abac.test.ts`.
 */
export const DEFAULT_TEST_ROLE = "msw";

/** Install the ABAC registry + permissive caseload / bereavement ports + M39's route predicates. */
export function installPermissiveConsentAbac(): void {
  registerAbacRegistry();
  // M7 owns `caseload_or_scope`: a suite that booted the real wiring already has it, and it resolves
  // through the `CaseloadProvider` seam bound permissively below.
  if (!abacRegistry.has("caseload_or_scope"))
    registerPredicateIdempotent("caseload_or_scope", ALLOW);
  registerSeam("CaseloadProvider", {
    isInCaseload: ALLOW,
    caseloadPatientIds: async () => [],
  } as never);
  registerConsentAbacPredicates(PERMISSIVE_ACCESS);
}

/** The roles a test user carries, by the consent permission set it is seeded with. */
export const ROLE_FOR_TEST_USER: Readonly<Record<string, string>> = {
  compliance: "compliance_officer",
  re_render_admin: "compliance_officer",
  cascade_admin: "compliance_officer",
  overlay_admin: "org_admin",
  bereavement: "bereavement_program_coordinator",
};
