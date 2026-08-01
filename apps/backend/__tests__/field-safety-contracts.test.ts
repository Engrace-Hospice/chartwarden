// Module 20 (Field Safety) — M20-T01 contract drift guards.
//
// `packages/types/src/safety.ts` says its enum mirrors are "kept in lock-step with
// `packages/db/src/enums.ts`". A comment does not keep anything in lock-step. These tests are where the
// claim is enforced: `@wardenx/types` is a LEAF and cannot import `@wardenx/db`, so the two sides can
// only be compared somewhere that already depends on both — the backend, which is exactly the consumer
// that would ship the drift. Several of the assertions below pin a deliberate DEVIATION from the spec
// body (the added `emergency_terminus` state, the 22-name event catalog, the compliance-stamped
// check-in trigger); each is the kind of decision that quietly reverts the next time someone reads §3.2
// verbatim, so it is asserted rather than commented.

import { describe, expect, it } from "vitest";

import {
  safetyAcknowledgmentTargetKind,
  safetyCheckInKind,
  safetyCheckInState,
  safetyCheckInStatus,
  safetyEmergencyContactConsentStatus,
  safetyHighRiskCategory,
  safetyIncidentCategory,
  safetyIncidentSeverity,
  safetyIncidentState,
  safetySosCancelStatus,
  safetySosLifecycleState,
  safetySubscriptionModel,
} from "@wardenx/db/schema";
import {
  M20_AUDIT_DENYLIST,
  M20_AUDIT_RETENTION_CLASS,
  M20_ERASER_DATA_CLASS,
  M20_EVENT_IDEMPOTENCY_KEYS,
  M20_EVENT_NAMES,
  M20_SUBSCRIBED_EVENT_NAMES,
  M20_SYSTEM_LOCKED_ALERT_TYPES,
  M20_TABLE_NAMES,
  SAFETY_POLICY_BOUNDS,
  SAFETY_POLICY_FLOOR,
  SAFETY_SCHEDULE_ACTIONABLE_STATES,
  SAFETY_SOS_ESCALATION_TIERS,
  SAFETY_SOS_OPEN_STATES,
  SAFETY_SOS_TERMINAL_STATES,
  type SafetyAcknowledgmentTargetKind,
  type SafetyCheckInKind,
  type SafetyCheckInState,
  type SafetyCheckInStatus,
  type SafetyEmergencyContactConsentStatus,
  type SafetyHighRiskCategory,
  type SafetyIncidentCategory,
  type SafetyIncidentSeverity,
  type SafetyIncidentState,
  type SafetySosCancelStatus,
  type SafetySosLifecycleState,
  type SafetySubscriptionModel,
} from "@wardenx/types";
import { MODULES } from "../../../architecture/module-manifest";

/** Each triple is (SQL type name, the pgEnum's runtime values, the leaf union's members). The third
 *  element is a `satisfies`-checked literal array, so a member added to the TS union without being added
 *  here is a COMPILE error and a member added to the pgEnum without the union is a RUNTIME failure.
 *  Neither side can drift alone. */
const MIRRORS = [
  [
    "safety_check_in_kind",
    safetyCheckInKind.enumValues,
    [
      "pre_visit",
      "mid_visit",
      "post_visit",
      "between_visits",
      "ad_hoc",
    ] satisfies SafetyCheckInKind[],
  ],
  [
    "safety_check_in_status",
    safetyCheckInStatus.enumValues,
    ["ok", "concerned_continue", "concerned_stop"] satisfies SafetyCheckInStatus[],
  ],
  [
    "safety_check_in_state",
    safetyCheckInState.enumValues,
    [
      "proposed",
      "recorded",
      "overdue",
      "escalated",
      "superseded",
      "incident_opened",
    ] satisfies SafetyCheckInState[],
  ],
  [
    "safety_sos_lifecycle_state",
    safetySosLifecycleState.enumValues,
    [
      "raised",
      "cancel_window_open",
      "acknowledging",
      "acknowledged",
      "escalation_tier_1",
      "escalation_tier_2",
      "escalation_tier_3",
      "emergency_terminus",
      "resolving",
      "resolved",
      "cancelled_in_window",
      "cancel_attempted_but_rejected",
      "incident_opened",
    ] satisfies SafetySosLifecycleState[],
  ],
  [
    "safety_sos_cancel_status",
    safetySosCancelStatus.enumValues,
    [
      "not_cancelled",
      "cancelled_in_window",
      "cancel_attempted_but_rejected",
    ] satisfies SafetySosCancelStatus[],
  ],
  [
    "safety_incident_category",
    safetyIncidentCategory.enumValues,
    [
      "physical_assault",
      "verbal_assault",
      "threatened",
      "dog_bite",
      "animal_other",
      "vehicle_accident_on_duty",
      "theft_during_visit",
      "medical_emergency_clinician_self",
      "weather_emergency",
      "environmental_hazard",
      "near_miss",
      "other",
    ] satisfies SafetyIncidentCategory[],
  ],
  [
    "safety_incident_severity",
    safetyIncidentSeverity.enumValues,
    ["minor", "moderate", "serious", "life_threatening"] satisfies SafetyIncidentSeverity[],
  ],
  [
    "safety_incident_state",
    safetyIncidentState.enumValues,
    [
      "draft",
      "submitted",
      "under_review",
      "returned_to_clinician",
      "closed_with_action_plan",
      "closed_no_action",
      "reopened",
    ] satisfies SafetyIncidentState[],
  ],
  [
    "safety_high_risk_category",
    safetyHighRiskCategory.enumValues,
    [
      "documented_prior_incident",
      "community_self_reported_unsafe",
      "nighttime_only_advisory",
      "weather_advisory_seasonal",
      "general_caution",
    ] satisfies SafetyHighRiskCategory[],
  ],
  [
    "safety_subscription_model",
    safetySubscriptionModel.enumValues,
    [
      "location_scoped",
      "provider_entity_scoped",
      "role_scoped",
      "explicit_only",
    ] satisfies SafetySubscriptionModel[],
  ],
  [
    "safety_acknowledgment_target_kind",
    safetyAcknowledgmentTargetKind.enumValues,
    ["sos_alert", "incident", "overdue_check_in"] satisfies SafetyAcknowledgmentTargetKind[],
  ],
  [
    "safety_emergency_contact_consent_status",
    safetyEmergencyContactConsentStatus.enumValues,
    ["granted", "revoked", "expired"] satisfies SafetyEmergencyContactConsentStatus[],
  ],
] as const;

describe("§3.2 enum mirrors — pgEnum ↔ @wardenx/types", () => {
  it.each(MIRRORS.map(([name, pg, ts]) => [name, pg, ts] as const))(
    "%s carries the same members in the same order on both sides",
    (_name, pgValues, tsValues) => {
      expect([...pgValues]).toEqual([...tsValues]);
    },
  );

  it("covers all twelve §3.2 Phase-A types", () => {
    expect(MIRRORS).toHaveLength(12);
  });

  it("carries `emergency_terminus`, without which the S13 life-safety chain has no end", () => {
    // The §3.2 CREATE TYPE block omits it; §2.2.2 / M20-F05 / INT-031 require it. Following Phase A
    // verbatim would leave an unacknowledged SOS sitting in escalation_tier_3 forever.
    expect(safetySosLifecycleState.enumValues).toContain("emergency_terminus");
  });

  it("orders `emergency_terminus` after tier 3 — it is what a tier-3 breach enters", () => {
    const states = [...safetySosLifecycleState.enumValues];
    expect(states.indexOf("emergency_terminus")).toBeGreaterThan(
      states.indexOf("escalation_tier_3"),
    );
  });
});

describe("§2.2.2 SOS state vocabulary", () => {
  it("keeps `emergency_terminus` OPEN, not terminal — it re-escalates until acknowledged", () => {
    // Treating the terminus as terminal is exactly how the loop M20-F05 mandates would stop.
    expect(SAFETY_SOS_OPEN_STATES).toContain("emergency_terminus");
    expect(SAFETY_SOS_TERMINAL_STATES).not.toContain("emergency_terminus");
  });

  it("keeps the open and terminal sets disjoint and inside the enum", () => {
    const open = new Set<string>(SAFETY_SOS_OPEN_STATES);
    for (const state of SAFETY_SOS_TERMINAL_STATES) expect(open.has(state)).toBe(false);
    const all = new Set<string>(safetySosLifecycleState.enumValues);
    for (const state of [...SAFETY_SOS_OPEN_STATES, ...SAFETY_SOS_TERMINAL_STATES]) {
      expect(all.has(state)).toBe(true);
    }
  });

  it("has exactly three escalation tiers — the fourth step is the terminus, not tier 4", () => {
    expect(SAFETY_SOS_ESCALATION_TIERS).toHaveLength(3);
    expect(safetySosLifecycleState.enumValues).not.toContain("escalation_tier_4");
  });

  it("treats a rejected cancel as non-terminal — the alert proceeds as if no cancel happened (D5)", () => {
    expect(SAFETY_SOS_TERMINAL_STATES).not.toContain("cancel_attempted_but_rejected");
  });
});

describe("§3.3 owned tables ↔ the manifest", () => {
  const m20 = MODULES.find((m) => m.id === 20);

  it("mirrors the manifest's ownedTables exactly — the manifest is the source of truth", () => {
    expect(m20).toBeDefined();
    expect([...M20_TABLE_NAMES].sort()).toEqual([...(m20?.ownedTables ?? [])].sort());
  });

  it("owns thirteen tables and does NOT claim §3.2 Phase E's platform polygon table", () => {
    expect(M20_TABLE_NAMES).toHaveLength(13);
    // A fourteenth owned table is a manifest change, which Wave P2-2 acceptance #1 governs.
    expect(M20_TABLE_NAMES as readonly string[]).not.toContain("safety_high_risk_area_platform");
  });

  it("declares a denylist and a retention class for every owned table", () => {
    for (const table of M20_TABLE_NAMES) {
      expect(M20_AUDIT_DENYLIST[table]).toBeDefined();
      expect(M20_AUDIT_RETENTION_CLASS[table]).toBeDefined();
    }
  });

  it("denylists every §3.6 column", () => {
    expect([...M20_AUDIT_DENYLIST.safety_sos_alert].sort()).toEqual([
      "acknowledger_dispatch_payload_cipher",
      "posted_coordinates_cipher",
      "resolution_narrative_cipher",
    ]);
    expect([...M20_AUDIT_DENYLIST.safety_incident].sort()).toEqual([
      "action_plan_cipher",
      "location_description",
      "narrative_cipher",
      "reopen_reason",
      "witnesses_cipher",
      "workers_comp_claim_reference",
    ]);
    expect([...M20_AUDIT_DENYLIST.safety_check_in].sort()).toEqual([
      "concern_note",
      "posted_coordinates_accuracy_m",
      "posted_coordinates_cipher",
    ]);
    expect([...M20_AUDIT_DENYLIST.safety_sos_location_stream].sort()).toEqual([
      "coordinates_cipher",
      "device_telemetry",
    ]);
    expect(M20_AUDIT_DENYLIST.safety_acknowledgment).toEqual(["action_taken"]);
    expect(M20_AUDIT_DENYLIST.safety_emergency_contact_consent).toEqual(["consent_scope_detail"]);
  });

  it("captures the surveyor-facing columns VERBATIM (§8.8.1)", () => {
    // These are what an insurer, a deposition or a state agency actually reads; denylisting them would
    // make the ledger useless for the purpose it exists to serve.
    for (const column of ["category", "severity", "osha_reportable", "lifecycle_state"]) {
      expect(M20_AUDIT_DENYLIST.safety_incident).not.toContain(column);
    }
    expect(M20_AUDIT_DENYLIST.safety_sos_alert).not.toContain("lifecycle_state");
    expect(M20_AUDIT_DENYLIST.safety_sos_alert).not.toContain("cancel_status");
    // The retention router itself must be auditable, or the purge cannot be shown to have been lawful.
    expect(M20_AUDIT_DENYLIST.safety_check_in).not.toContain("is_part_of_sos_bracket");
  });

  it("stamps `safety_check_in` compliance — the trigger takes no row predicate (§3.7)", () => {
    // §3.7 splits the class per ROW. The generated trigger is per TABLE, so the safe direction is the
    // only one available: an operational stamp would let the 90-day purge take the check-ins that
    // bracket an SOS. The routine-`ok` purge is an M20 cron predicate instead.
    expect(M20_AUDIT_RETENTION_CLASS.safety_check_in).toBe("compliance");
    expect(M20_AUDIT_RETENTION_CLASS.safety_sos_alert).toBe("compliance");
    expect(M20_AUDIT_RETENTION_CLASS.safety_sos_location_stream).toBe("compliance");
    expect(M20_AUDIT_RETENTION_CLASS.safety_policy_version).toBe("compliance");
  });

  it("uses real `audit_retention_class` members, not prose labels", () => {
    for (const table of M20_TABLE_NAMES) {
      expect(["operational", "compliance", "legal_hold"]).toContain(
        M20_AUDIT_RETENTION_CLASS[table],
      );
    }
  });

  it("registers an eraser data class no other module already owns", () => {
    expect(M20_ERASER_DATA_CLASS).toBe("safety_record");
  });
});

describe("§4.10 outbox catalog", () => {
  it("uses the three-segment `mN.<resource>.<verb>` names `arch:gaps` enforces", () => {
    for (const name of M20_EVENT_NAMES) {
      expect(name.split(".")).toHaveLength(3);
      expect(name.startsWith("m20.safety.")).toBe(true);
    }
  });

  it("publishes the v0.3 changelog's twenty-two topics, not the §4.10 table's seventeen", () => {
    expect(M20_EVENT_NAMES).toHaveLength(22);
    expect(new Set(M20_EVENT_NAMES).size).toBe(22);
  });

  it("carries the five topics the §4.10 table never gained but the rest of the spec depends on", () => {
    for (const name of [
      "m20.safety.sos_terminus_reached", // §2.2.2 / §2.7 / §8.8.3 INT-031 ops page
      "m20.safety.sos_anomaly_volume", // §8.3 flag-not-gate
      "m20.safety.device_attestation_anomaly", // §8.3
      "m20.safety.incident_reported", // D9 — the draft, distinct from incident_submitted
      "m20.safety.policy_violation_recorded", // §8.2
    ]) {
      expect(M20_EVENT_NAMES as readonly string[]).toContain(name);
    }
  });

  it("does NOT give the SOS raise an idempotency key (§2.6 / M20-F10)", () => {
    // Every press records and every press fans out. Collapsing two presses onto one sosAlertId key is
    // the suppression S13 forbids; delivery de-dup happens on the per-emit outbox event_id.
    expect(M20_EVENT_IDEMPOTENCY_KEYS).not.toHaveProperty("m20.safety.sos_alert_raised");
    expect(M20_EVENT_IDEMPOTENCY_KEYS["m20.safety.sos_alert_acknowledged"]).toBe("sosAlertId");
  });

  it("keys the two REPEATING events on a composite (M20-T03)", () => {
    // Same class of finding as the SOS raise, one layer down: a key that collapses a repetition the design
    // REQUIRES. `check_in_escalated` fires once per D4 rung (§7.3 — +15/+30/+60), and the 60-minute rung is
    // the one routed to Tier-1 voice; `sos_terminus_reached` fires on every loop iteration by construction
    // (M20-F05). Keyed on the aggregate id alone, a conforming consumer drops everything after the first.
    expect(M20_EVENT_IDEMPOTENCY_KEYS["m20.safety.check_in_escalated"]).toEqual([
      "scheduleId",
      "tier",
    ]);
    expect(M20_EVENT_IDEMPOTENCY_KEYS["m20.safety.sos_terminus_reached"]).toEqual([
      "sosAlertId",
      "loopIteration",
    ]);
  });

  it("keeps `escalated` in the detector's actionable set — D4 has two rungs above it (M20-T03)", () => {
    const actionable = SAFETY_SCHEDULE_ACTIONABLE_STATES as readonly string[];
    expect(actionable).toContain("escalated");
    // The row leaves the set only when a human resolves it.
    for (const closed of ["recorded", "superseded", "incident_opened"]) {
      expect(actionable).not.toContain(closed);
    }
  });

  it("subscribes to the inbound triggers under their producers' REAL names", () => {
    const subscribed = M20_SUBSCRIBED_EVENT_NAMES as readonly string[];
    // §4.8 spells this `m36.delivery_failed`; M36 emits the three-segment form.
    expect(subscribed).toContain("m36.notification.delivery_failed");
    // §3.1 names the retired M19-F12 pair (`m19.on_call_shift.opened` / `.closed`).
    expect(subscribed).toContain("m19.oncall_shift.activated");
    expect(subscribed).not.toContain("m19.on_call_shift.opened");
    for (const name of subscribed) expect(name.split(".")).toHaveLength(3);
  });

  it("subscribes to both EVV bracket edges — one without the other strands a window", () => {
    const subscribed = M20_SUBSCRIBED_EVENT_NAMES as readonly string[];
    expect(subscribed).toContain("m18.evv.check_in_recorded");
    expect(subscribed).toContain("m18.evv.check_out_recorded");
  });

  it("subscribes to no `m20.` topic — a module does not consume its own outbox", () => {
    for (const name of M20_SUBSCRIBED_EVENT_NAMES) {
      expect(name.startsWith("m20.")).toBe(false);
    }
  });
});

describe("§4.9 alert rules", () => {
  it("locks every rung of the life-safety chain a short-staffed org would want to silence", () => {
    for (const type of [
      "m20.safety.sos_alert_raised",
      "m20.safety.sos_alert_escalated",
      "m20.safety.sos_terminus_reached",
      "m20.safety.check_in_escalated",
      "m20.safety.coverage_gap_detected",
    ]) {
      expect(M20_SYSTEM_LOCKED_ALERT_TYPES as readonly string[]).toContain(type);
    }
  });

  it("names only real §4.10 topics as alert event types", () => {
    const topics = new Set<string>(M20_EVENT_NAMES);
    for (const type of M20_SYSTEM_LOCKED_ALERT_TYPES) expect(topics.has(type)).toBe(true);
  });
});

describe("§3.2 Phase E — the platform policy floor (M20-F03)", () => {
  it("puts the mid-visit cadence floor inside the D4 [30, 120] band", () => {
    expect(SAFETY_POLICY_FLOOR.midVisitCadenceMinutes).toBeGreaterThanOrEqual(
      SAFETY_POLICY_BOUNDS.midVisitCadenceMinutes.min,
    );
    expect(SAFETY_POLICY_FLOOR.midVisitCadenceMinutes).toBeLessThanOrEqual(
      SAFETY_POLICY_BOUNDS.midVisitCadenceMinutes.max,
    );
  });

  it("keeps every bounded floor value inside its own band", () => {
    for (const [field, band] of Object.entries(SAFETY_POLICY_BOUNDS)) {
      const value = (SAFETY_POLICY_FLOOR as Record<string, unknown>)[field];
      expect(typeof value).toBe("number");
      expect(value as number).toBeGreaterThanOrEqual(band.min);
      expect(value as number).toBeLessThanOrEqual(band.max);
    }
  });

  it("ships the D4 overdue tiers in ascending order", () => {
    const { gentleReminderMinutes, supervisorAlertMinutes, escalationMinutes, sosEquivalentMinutes } =
      SAFETY_POLICY_FLOOR;
    expect(gentleReminderMinutes).toBeLessThan(supervisorAlertMinutes);
    expect(supervisorAlertMinutes).toBeLessThan(escalationMinutes);
    expect(escalationMinutes).toBeLessThan(sosEquivalentMinutes);
  });

  it("ships the D7 SOS tier SLAs in ascending order", () => {
    expect(SAFETY_POLICY_FLOOR.sosTier1SlaSeconds).toBeLessThan(
      SAFETY_POLICY_FLOOR.sosTier2SlaSeconds,
    );
    expect(SAFETY_POLICY_FLOOR.sosTier2SlaSeconds).toBeLessThan(
      SAFETY_POLICY_FLOOR.sosTier3SlaSeconds,
    );
  });

  it("defaults continuous location OFF (D6) with a 4-hour forced sunset ceiling (§8.7)", () => {
    expect(SAFETY_POLICY_FLOOR.sosContinuousLocationEnabled).toBe(false);
    expect(SAFETY_POLICY_BOUNDS.sosContinuousLocationMaxDurationHours.max).toBe(4);
  });

  it("lets a tenant lengthen the cancel window but never shorten it below the D5 5 seconds", () => {
    expect(SAFETY_POLICY_BOUNDS.sosCancelWindowSeconds.min).toBe(5);
    expect(SAFETY_POLICY_FLOOR.sosCancelWindowSeconds).toBe(5);
  });

  it("leaves the SOS anomaly threshold out of the tenant-tunable bounds (§8.3 / S13)", () => {
    // A tenant that could tune this could configure away a clinician's safety alert.
    expect(SAFETY_POLICY_BOUNDS).not.toHaveProperty("sosAnomalyVolumePerHour");
  });
});

describe("Track B (ADR-0030) manifest wiring", () => {
  const m20 = MODULES.find((m) => m.id === 20);

  it("carries the web codePath and NOT the unadopted `packages/safety-client`", () => {
    expect(m20?.codePaths).toContain("apps/web/src/modules/20-field-safety");
    expect(m20?.codePaths).not.toContain("packages/safety-client");
  });
});
