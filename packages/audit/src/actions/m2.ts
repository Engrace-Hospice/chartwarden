// @wardenx/audit — Module 2 (Identity & Org) action catalog (M4-T10; M4 spec §4.6.1 `m2.ts`).
//
// The `m2.*` actions M2's identity/membership routes and the session step-up flow emit through
// the mandated audit() surface (apps/backend/src/modules/02-identity/audit/*). All are security-
// relevant identity events filed under `compliance` (7-yr); none carry PHI or are Part 2-eligible.
import type { ModuleActionCatalog } from "./types";

const compliance = (action: string, description: string) =>
  ({
    action,
    moduleOwner: "m2",
    defaultRetentionClass: "compliance",
    description,
    denylistCategories: [],
    isPartTwoEligible: false,
  }) as const;

/** `m2` Identity & Org actions (identity-audit.ts + step-up-audit.ts). */
export const M2_ACTION_CATALOG: ModuleActionCatalog = [
  compliance("m2.user.invited", "A user was invited to an organization."),
  compliance("m2.invitation.rescinded", "A pending organization invitation was rescinded."),
  compliance("m2.membership.accepted", "An invitee accepted a membership."),
  compliance("m2.membership.suspended", "A membership was suspended."),
  compliance("m2.membership.reinstated", "A suspended membership was reinstated."),
  compliance("m2.membership.updated", "A membership's default scope was edited."),
  compliance("m2.membership.revoked", "A membership was revoked."),
  compliance("m2.user.deactivated", "A user was fully offboarded (credentials disabled)."),
  compliance("m2.collaborator.invited", "A per-patient collaborator magic-link was issued."),
  compliance("m2.collaborator.session_started", "A collaborator magic-link session began."),
  compliance(
    "m2.auditor_link.redeemed",
    "An auditor magic link was redeemed into a scoped read-only auditor session.",
  ),
  compliance(
    "m2.auditor_link.refused",
    "Redemption of an auditor magic link was refused (replayed, expired, revoked, engagement not live, identity is a member, ...).",
  ),
  compliance("m2.session.step_up.completed", "A step-up (re-auth) challenge was completed."),
  compliance("m2.session.step_up.failed", "A step-up (re-auth) challenge failed."),
  compliance(
    "m2.session.terminated_step_up_lockout",
    "A session was terminated after step-up lockout.",
  ),
  // GAP-115 — the M2 org-admin surface (organization / provider-entity / location management, the tenant
  // step-up override registry, the funeral-home link). Field NAMES only in the trail, never values.
  compliance("m2.organization.created", "An organization spine row was created (platform operator)."),
  compliance("m2.organization.updated", "An organization's name was edited."),
  compliance("m2.provider_entity.created", "A provider entity (Medicare-certified provider) was created."),
  compliance("m2.provider_entity.updated", "A provider entity was edited."),
  compliance("m2.location.created", "A service location was created."),
  compliance("m2.location.updated", "A service location was edited."),
  compliance(
    "m2.session.step_up_policy_override.configured",
    "A tenant step-up policy override (tighten-only) was set for an operation.",
  ),
  compliance(
    "m2.session.step_up_policy_override.removed",
    "A tenant step-up policy override was removed (the platform floor applies again).",
  ),
  compliance("m2.funeral.invited", "A per-deceased funeral-home magic-link was issued."),
  // ADR-0023 D2 / SecHardening §12.4 — device attestation. The FAILED event is as load-bearing as the
  // passing one: §12.4 names the server-side audit as the complement to on-device detection, and a
  // handset that repeatedly fails the posture check is exactly the pattern it is asking to surface.
  compliance("m2.device.attested", "A device passed the §12.4 posture check and was attested."),
  compliance("m2.device.attestation_failed", "A device failed the §12.4 posture check."),
  compliance("m2.device.attestation_revoked", "A device attestation was revoked by an administrator."),
];
