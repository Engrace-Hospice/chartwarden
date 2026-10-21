// @chartwarden/auth · rbac — permissions held by SESSION CLASS, not by membership (M31 §4.6 / M2 §3.6).
//
// WHY THIS EXISTS. The effective-permission resolver (resolve.ts / drizzle-store.ts) answers from
// `membership ⋈ membership_role ⋈ role_permission`. A portal caregiver, a patient-self portal user and a
// funeral-home visitor hold NO membership: they are not staff, they carry no role row, and the spec's "default
// roles" for their keys (`portal_caregiver`, `portal_patient`, ...) were never seeded anywhere. So every
// `requirePermission("portal.*")` answered "no permission" for every real portal session, no matter how
// correctly it had signed in — the sign-in could succeed and the first screen would 403.
//
// A portal session's permission set is a fixed property of its CLASS (the class is server-bound at mint and
// stamped by the authenticate hook; it is never client input). The per-patient and per-account narrowing stays
// where it always was — the §4.7 ABAC predicates composed on each route, which read the account and the patient
// from the SESSION. This module only answers the RBAC half.
//
// FAIL CLOSED, BOTH WAYS:
//   • a portal / funeral session gets ONLY its class set. A person who is a clinician in the same tenant and
//     signs into the portal does not carry clinical keys into a portal session (the base resolver is not even
//     consulted), and a staff session never receives a class set.
//   • a portal-class session whose context carries no `portalAccountId` (a half-bound session) gets nothing.
//   • the sets are an explicit allow-list by key, not a prefix match, so a new `portal.admin.*` key added later
//     is staff-only until someone puts it here on purpose.
import type { HttpRequestContext } from "@chartwarden/types";
import { isPortalSessionClass } from "../identity/session-classes";
import type { EffectivePermissionResolver } from "./require-role";

/** The keys every portal session may hold regardless of relationship (identity, preferences). */
const PORTAL_COMMON_KEYS = [
  "portal.session.select_patient",
  "portal.session.read_own",
  "portal.session.step_up_own",
  "portal.preferences.read_own",
  "portal.preferences.write_own",
] as const;

/** The care-time read surfaces (patient-self and any delegated caregiver; each narrowed by the active-grant ABAC). */
const PORTAL_CARE_READ_KEYS = [
  "portal.care_summary.read",
  "portal.care_plan.read_summary",
  "portal.discipline_plans.read_summary",
  "portal.visits.read_upcoming",
  "portal.visits.read_history",
  "portal.medications.read_summary",
  "portal.administrations.read_summary",
  "portal.assessments.read_trend",
  "portal.hope.read_summary",
  "portal.orders.read_summary",
  "portal.supplies.read_upcoming",
  "portal.triage.read_log",
  "portal.documents.read_list",
  "portal.documents.download",
  "portal.documents.upload",
  "portal.messages.read_channel",
  "portal.messages.send",
  "telehealth.join_patient_or_caregiver",
] as const;

/** The care-time writes any care-time portal session may be offered (further gated by ABAC + step-up). */
const PORTAL_CARE_WRITE_KEYS = ["portal.administration.attest", "portal.triage.read_own"] as const;

/**
 * §164.526 amendment requests are the PATIENT's right (the spec lists portal_patient and portal_dpoa). The route
 * does not yet branch on the grant kind, and a class cannot tell a DPOA agent from a family caregiver, so only the
 * patient-self class holds them: a DPOA agent cannot file an amendment through the portal until a kind-aware check
 * exists, rather than every family caregiver being able to.
 */
const PORTAL_PATIENT_ONLY_KEYS = ["portal.amendment.submit", "portal.amendment.read_own"] as const;

/** The bereaved-family surface: the program, the resources, one's own opt-out, plus documents and messages. */
const PORTAL_BEREAVED_KEYS = [
  "portal.bereavement.read_program",
  "portal.bereavement.read_resources",
  "portal.bereavement.opt_out_own",
  "portal.documents.read_list",
  "portal.documents.download",
  "portal.messages.read_channel",
  "portal.messages.send",
] as const;

/** Permission keys a portal/funeral SESSION CLASS holds. Anything not listed holds nothing. */
export const SESSION_CLASS_PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  {
    patient_portal: [
      ...PORTAL_COMMON_KEYS,
      ...PORTAL_CARE_READ_KEYS,
      ...PORTAL_CARE_WRITE_KEYS,
      ...PORTAL_PATIENT_ONLY_KEYS,
    ],
    caregiver_portal: [...PORTAL_COMMON_KEYS, ...PORTAL_CARE_READ_KEYS, ...PORTAL_CARE_WRITE_KEYS],
    bereaved_portal: [...PORTAL_COMMON_KEYS, ...PORTAL_BEREAVED_KEYS],
    // GAP-115 follow-up — a redeemed funeral-home link reads the one deceased patient's disposition facts, nothing else.
    funeral_home: ["funeral.case_read"],
  },
);

const attr = (context: HttpRequestContext, key: string): string | null => {
  const value = context.attributes?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * The class-held permission set for a request context, or `null` when the session is not of a class-held kind
 * (a staff session falls through to the membership resolver). An empty set is a real answer: it means "this class
 * session holds nothing here".
 */
export function sessionClassPermissions(context: HttpRequestContext): ReadonlySet<string> | null {
  const sessionClass = attr(context, "sessionClass");
  if (sessionClass === null) return null;
  if (isPortalSessionClass(sessionClass)) {
    // A portal class without its account anchor is a half-bound session: grant nothing.
    if (attr(context, "portalAccountId") === null) return new Set();
    return new Set(SESSION_CLASS_PERMISSIONS[sessionClass] ?? []);
  }
  if (sessionClass === "funeral_home") {
    // Pinned to ONE patient by the mint; a funeral session with no pinned patient holds nothing.
    if (attr(context, "sessionPatientId") === null) return new Set();
    return new Set(SESSION_CLASS_PERMISSIONS.funeral_home ?? []);
  }
  return null;
}

/**
 * Wrap a membership-based resolver so portal / funeral-home sessions are answered from their class set.
 * Every other session (staff, auditor, collaborator, vendor) is answered by `base` unchanged.
 */
export function withSessionClassPermissions(
  base: EffectivePermissionResolver,
): EffectivePermissionResolver {
  return (context) => sessionClassPermissions(context) ?? base(context);
}
