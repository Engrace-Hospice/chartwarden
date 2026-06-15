// @wardenx/audit — Module 3 (Authorization) action catalog (M4-T10; M4 spec §4.6.1 `m3.ts`).
//
// The `m3.*` authorization-decision actions M3's route inventory emits through the audit() surface
// (apps/backend/src/modules/03-authorization/audit/authz-audit.ts, §8.1). Role/break-glass/
// engagement governance events, all filed under `compliance` (7-yr); none carry PHI.
import type { ModuleActionCatalog } from "./types";

const compliance = (action: string, description: string) =>
  ({
    action,
    moduleOwner: "m3",
    defaultRetentionClass: "compliance",
    description,
    denylistCategories: [],
    isPartTwoEligible: false,
  }) as const;

/** `m3` Authorization actions (authz-audit.ts AUTHZ_AUDIT_EVENTS). */
export const M3_ACTION_CATALOG: ModuleActionCatalog = [
  compliance("m3.authz.denied", "A sampled authorization denial (D5)."),
  compliance("m3.authz.escalation_blocked", "A privilege-escalation attempt was blocked (§7.2)."),
  compliance("m3.role.created", "A custom role was created (cloned/extended from a template)."),
  compliance("m3.role.updated", "A role's permission set was edited."),
  compliance("m3.role.deleted", "A custom role was deleted."),
  compliance("m3.role.assigned", "A role was assigned to a membership."),
  compliance("m3.role.revoked", "A role was revoked from a membership."),
  compliance("m3.breakglass.invoked", "Emergency break-glass access was invoked (§7.4)."),
  compliance("m3.breakglass.access", "A break-glass-elevated access occurred."),
  compliance("m3.breakglass.cosigned", "A break-glass event was co-signed."),
  compliance("m3.breakglass.revoked", "A break-glass grant was revoked."),
  compliance("m3.engagement.created", "An auditor engagement was created (§7.5)."),
  compliance("m3.engagement.updated", "An auditor engagement was edited."),
  compliance("m3.engagement.cancelled", "An auditor engagement was cancelled."),
  compliance("m3.engagement.auditor_enrolled", "An auditor was enrolled into an engagement."),
];
