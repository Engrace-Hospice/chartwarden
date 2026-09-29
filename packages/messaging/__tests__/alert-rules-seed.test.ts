// @wardenx/messaging — M36-T05 platform-default alert-rule seed tests (spec §3.10, §7.4).
//
// §7.4 "tenant cannot disable system_locked rules": the seed is the source of WHICH rules carry
// the flag (the DB RLS in M36-T03 enforces the can't-disable at runtime). These tests lock the
// boot-validation invariant: the three life-/data-safety floors (SOS, NOE late-risk,
// backup-failure) are always present, system_locked, and enabled; loosening any of them is caught.
import { describe, expect, it } from "vitest";
import {
  PLATFORM_DEFAULT_ALERT_RULES,
  SYSTEM_LOCKED_EVENT_TYPES,
  assertAlertRuleSeedValid,
  toNewAlertRuleRows,
  validateAlertRuleSeed,
} from "../src/index";

describe("M36-T05 platform-default alert rule seed (§3.10)", () => {
  it("seeds exactly the platform-default rule set, all org-less (organization_id NULL)", () => {
    // The §3.10 eighteen, grown by the HOPE (680a27db: m10.hope.sfv_overdue / sfv_missed /
    // timepoint_expired, and hope.sfv_triggered renamed to the catalog's m10.hope.sfv_created) and the
    // admission/scheduling/encounter alert work (c3886b68: m6.admission.discharged, the four m17 visit
    // alerts, and the six m8 encounter sign/cosignature alerts). Every added type is a real emitter:
    // an M6/M10/M17/M8 outbox catalog event, or an alert the M8 cron workers raise directly
    // (m8.encounter.unsigned / documentation_late). The full set is pinned so a rule cannot be added
    // or dropped silently.
    expect(PLATFORM_DEFAULT_ALERT_RULES.map((r) => r.eventType)).toEqual([
      "field_safety.sos",
      "m10.hope.sfv_created",
      "m10.hope.sfv_overdue",
      "m10.hope.sfv_missed",
      "m10.hope.timepoint_expired",
      "emar.dose_missed",
      "patient.hospitalization_risk_high",
      "patient.pps_drop_20",
      "admission.recert_window_opening",
      "admission.f2f_due",
      "m6.admission.discharged",
      "visit.late",
      "m17.visit.cancelled",
      "m17.visit.rescheduled",
      "m17.visit.no_show_detected",
      "m17.stale_visit_detected",
      // F-187 (#248) — a lab order superseded after its ORM may already be at the laboratory (T-29.08 defines no
      // outbound cancel, so this alert is the only signal). A real emitter: M11's `lab-cancellation-required`.
      "m11.order.lab_cancellation_required",
      "m8.encounter.unsigned",
      "m8.encounter.documentation_late",
      "m8.encounter.cosignature_routed",
      "m8.encounter.cosignature_overdue",
      "m8.encounter.cosignature_escalated",
      "m8.encounter.cosignature_hard_cap_reached",
      "evv.geofence_violation",
      "claim.denied",
      "cap.approaching",
      "noe.late_risk",
      "system.integration_failure",
      "system.ai_cost_threshold",
      "system.backup_failure",
      // F-188 (#248) — M29's outbound operator alerts (spec §5.3); previously rule-less, so they reached nobody.
      "hl7_outbound.transmission_failed",
      "external_feed.baa_expired",
      "external_feed.baa_missing",
    ]);
    for (const row of toNewAlertRuleRows()) {
      expect(row.organizationId).toBeNull();
    }
  });

  it("has no duplicate event types and is valid out of the box", () => {
    expect(validateAlertRuleSeed()).toEqual([]);
    expect(() => assertAlertRuleSeedValid()).not.toThrow();
  });

  it("SOS routes on_call with the voice channel (§2.5 voice is SOS-only)", () => {
    const sos = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === "field_safety.sos");
    expect(sos?.recipientResolver).toBe("on_call");
    expect(sos?.channelsOverride).toContain("voice");
  });

  it("seeds HOPE transition alerts using the M10 event catalog names", () => {
    expect(PLATFORM_DEFAULT_ALERT_RULES).toEqual(
      expect.arrayContaining([
        // c3886b68 routes a new SFV obligation to the roles that staff it (clinical lead + scheduler:
        // the follow-up visit must be scheduled within its due window), not the patient's care team.
        expect.objectContaining({
          eventType: "m10.hope.sfv_created",
          recipientResolver: "role_set",
          resolverArgs: { roleKeys: ["clinical_lead", "scheduler"] },
        }),
        expect.objectContaining({ eventType: "m10.hope.sfv_overdue", severityFloor: "critical" }),
        expect.objectContaining({ eventType: "m10.hope.sfv_missed", severityFloor: "critical" }),
        expect.objectContaining({
          eventType: "m10.hope.timepoint_expired",
          severityFloor: "critical",
        }),
      ]),
    );
  });
});

describe("M36-T05 §7.4 system_locked floors", () => {
  it("SOS, NOE late-risk, and backup-failure are the system_locked set, all enabled", () => {
    expect([...SYSTEM_LOCKED_EVENT_TYPES].sort()).toEqual(
      ["field_safety.sos", "noe.late_risk", "system.backup_failure"].sort(),
    );
    for (const eventType of SYSTEM_LOCKED_EVENT_TYPES) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
      expect(rule, `${eventType} must be seeded`).toBeDefined();
      expect(rule!.systemLocked).toBe(true);
      expect(rule!.enabled).toBe(true);
    }
  });

  it("no non-system_locked rule masquerades with a system_locked event type", () => {
    const locked = new Set<string>(SYSTEM_LOCKED_EVENT_TYPES);
    for (const r of PLATFORM_DEFAULT_ALERT_RULES) {
      if (r.systemLocked) expect(locked.has(r.eventType)).toBe(true);
    }
  });

  it("validateAlertRuleSeed catches a loosened (disabled) system_locked floor", () => {
    const tampered = PLATFORM_DEFAULT_ALERT_RULES.map((r) =>
      r.eventType === "field_safety.sos" ? { ...r, enabled: false } : r,
    );
    const v = validateAlertRuleSeed(tampered);
    expect(v.map((x) => x.type)).toContain("system_locked_disabled");
    expect(() => assertAlertRuleSeedValid(tampered)).toThrow(/refuses to start/);
  });

  it("validateAlertRuleSeed catches a missing system_locked floor", () => {
    const missing = PLATFORM_DEFAULT_ALERT_RULES.filter(
      (r) => r.eventType !== "system.backup_failure",
    );
    expect(validateAlertRuleSeed(missing).map((x) => x.type)).toContain("missing_system_locked");
  });
});
