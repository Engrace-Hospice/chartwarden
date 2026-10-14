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
  compliance("m2.user.provisioned", "An administrator directly provisioned a staff identity."),
  compliance(
    "m2.platform_staff.bound",
    "A platform operator was bound into a tenant org with the zero-permission alert-audience role.",
  ),
  compliance("m2.user.password_reset", "An administrator reset a global password credential."),
  compliance(
    "m2.user.password_change_completed",
    "A user replaced a temporary password and the mandatory-rotation state was cleared.",
  ),
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
  // M2 §7.7 - the auditor enrolment ceremony (BAA / engagement terms + second factor) between link redemption
  // and the read-only session. Never carries a code, a secret or a recovery code - only the step and its outcome.
  compliance(
    "m2.auditor_enrolment.baa_accepted",
    "An auditor accepted the versioned BAA / engagement terms (version and sha-256 recorded).",
  ),
  compliance("m2.auditor_enrolment.totp_started", "An auditor began authenticator (TOTP) setup."),
  compliance(
    "m2.auditor_enrolment.totp_enrolled",
    "An auditor confirmed an authenticator and was issued recovery codes (shown once, stored hashed).",
  ),
  compliance(
    "m2.auditor_enrolment.factor_verified",
    "An auditor proved an enrolled second factor (TOTP code or single-use recovery code).",
  ),
  compliance(
    "m2.auditor_enrolment.recovery_code_used",
    "An auditor spent a single-use recovery code.",
  ),
  compliance(
    "m2.auditor_enrolment.factor_failed",
    "An auditor presented a wrong or replayed second-factor code.",
  ),
  compliance(
    "m2.auditor_enrolment.locked",
    "An auditor's second factor locked after consecutive wrong codes.",
  ),
  compliance(
    "m2.auditor_enrolment.refused",
    "An enrolment step was refused (stale terms, locked factor, engagement no longer live, ...).",
  ),
  compliance(
    "m2.auditor_enrolment.activated",
    "An auditor session completed enrolment: the least-privilege role was granted and the session became the read-only engagement session.",
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
  // GAP-115 follow-up — redemption of a collaborator / funeral-home link, and portal invitee sign-in. Ids only: the
  // token, the hash and the invitee's address never enter a payload.
  compliance("m2.link.redeemed", "A collaborator / funeral-home link was redeemed into a scoped session."),
  compliance(
    "m2.link.redemption_refused",
    "A redemption of a known collaborator / funeral-home link was refused (expired, spent, revoked or no longer eligible).",
  ),
  compliance(
    "m2.portal.session_established",
    "A pre-org session was bound to a portal account (portal invitee sign-in).",
  ),
  compliance(
    "m2.portal.session_refused",
    "A portal sign-in bind was refused for a known portal account (suspended, unverified, no live grant, ...).",
  ),
  // ADR-0023 D2 / SecHardening §12.4 — device attestation. The FAILED event is as load-bearing as the
  // passing one: §12.4 names the server-side audit as the complement to on-device detection, and a
  // handset that repeatedly fails the posture check is exactly the pattern it is asking to surface.
  compliance("m2.device.attested", "A device passed the §12.4 posture check and was attested."),
  compliance("m2.device.attestation_failed", "A device failed the §12.4 posture check."),
  compliance("m2.device.attestation_revoked", "A device attestation was revoked by an administrator."),
  // GAP-002 / GAP-004 - the M2 section 8.1 authentication trail. Payloads carry hashes and ip prefixes only:
  // never a password, token, TOTP / backup code or raw email.
  compliance("m2.auth.login_succeeded", "A sign-in completed (password, passkey or second factor)."),
  compliance("m2.auth.login_failed", "A sign-in credential or second factor was refused."),
  compliance("m2.auth.account_locked", "A sign-in was refused because the failed-attempt budget is spent."),
  compliance("m2.auth.logout", "A user signed out."),
  compliance("m2.auth.password_reset", "A password was reset through the single-use reset link."),
  compliance("m2.auth.2fa_enrolled", "A user began or completed authenticator (TOTP) enrolment."),
  compliance("m2.auth.2fa_disabled", "A user disabled their authenticator (TOTP) second factor."),
  compliance("m2.auth.backup_code_used", "A single-use backup code was spent to sign in."),
  compliance("m2.passkey.registered", "A passkey was registered."),
  compliance("m2.passkey.removed", "A passkey was removed."),
  compliance("m2.session.revoked", "One or more sessions were revoked by their owner."),
];
