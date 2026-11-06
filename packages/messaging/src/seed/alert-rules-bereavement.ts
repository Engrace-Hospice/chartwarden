// @chartwarden/messaging — platform-default alert rules for the M16 bereavement program (ADR-0110 D7).
//
// Each event type is raised by M16 through its `AlertPort` adapter (`16-bereavement/alert-port.ts`), which
// routes only the kinds seeded here; a kind with no rule there never reaches `AlertEmitter.emit`. The
// audience is the organization-scoped bereavement oversight set (M16 spec §4.8), by role key. The role keys
// are mirrored, not imported: this package is a leaf. The `m16-alert-port` test pins the mirror against
// `BEREAVEMENT_OVERSIGHT_ROLES`, so a rename on either side fails there.
import type { PlatformAlertRuleSeed } from "./alert-rule-seed-type";

const BEREAVEMENT_OVERSIGHT_ROLE_KEYS = [
  "clinical_supervisor",
  "director_of_nursing",
  "bereavement_coordinator",
  "compliance_officer",
] as const;

function rule(
  eventType: string,
  category: PlatformAlertRuleSeed["category"],
  severityFloor: PlatformAlertRuleSeed["severityFloor"],
): PlatformAlertRuleSeed {
  return {
    eventType,
    category,
    severityFloor,
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: BEREAVEMENT_OVERSIGHT_ROLE_KEYS },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  };
}

export const BEREAVEMENT_ALERT_RULES: readonly PlatformAlertRuleSeed[] = [
  // A death opened an `eligible` plan: oversight assigns a counselor (counselor auto-assignment does not exist).
  rule("m16.bereavement.death_intake", "clinical_routine", "warn"),
  // The condolence letter to the attending clinician awaits a human review (due death + 2 days).
  rule("m16.bereavement.physician_letter_pending_review", "administrative", "info"),
  // An assessment checkpoint (initial d28 / midpoint d180) passed its late grace and is now `missed`.
  rule("m16.bereavement.risk_assessment_overdue", "clinical_routine", "warn"),
];
