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
      "m13.prn_reassessment.overdue",
      "m13.reconciliation.due_at_warning",
      "m13.reconciliation.overdue",
      "m13.comfort_kit.return_overdue",
      "m20.safety.check_in_overdue",
      "m20.safety.check_in_escalated",
      "m20.safety.check_in_escalated_oncall",
      "m20.safety.coverage_gap_detected",
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
      // GAP-071 — M24 eligibility-stale-watchdog alert.
      "medicaid.eligibility.stale_at_assembly",
      // M23 — the MAC rejected a Notice of Election / Termination-Revocation (999 or 277CA); raised by the
      // ack-pull crons. Before, a rejected NOE looked valid and a rejected NOTR counted as filed.
      "m23.noe.rejected",
      "m23.notr.rejected",
      "cap.approaching",
      "noe.late_risk",
      "system.integration_failure",
      "system.ai_cost_threshold",
      "system.backup_failure",
      // F-188 (#248) — M29's outbound operator alerts (spec §5.3); previously rule-less, so they reached nobody.
      "hl7_outbound.transmission_failed",
      // F-199 — the failure-storm escalation.
      "hl7_outbound.transmission_storm",
      "external_feed.baa_expired",
      "external_feed.baa_missing",
      // GAP-010 — M3 break-glass Compliance notification (M36 consumer `breakglass-alert`).
      "m3.breakglass.invoked",
      // F-201 (#248) — M11's stuck lab-order recovery: a held order aging past its thresholds, and the auto-retry
      // sweep giving up.
      "m11.order.transmission_held_aging",
      "m11.order.transmission_auto_retry_exhausted",
      // F-202 (#248) — the two-person lab-recovery control's compliance alerts.
      "m11.order.recovery_executed",
      "m11.order.recovery_expired",
      "m11.order.recovery_cancelled",
      // F-203 (#248) — the collusion / rate signal on that control (critical, deduplicated per window).
      "m11.order.recovery_anomaly",
      "m14.action_item.carry_forward.compliance",
      "m14.packets.ready",
      "m14.action_item.created",
      "m14.decision.non_quorate",
      "m14.review_clock.escalated",
      "m14.review_floor.override_recorded",
    ]);
    for (const row of toNewAlertRuleRows()) {
      expect(row.organizationId).toBeNull();
    }
  });

  it("has no duplicate event types and is valid out of the box", () => {
    expect(validateAlertRuleSeed()).toEqual([]);
    expect(() => assertAlertRuleSeedValid()).not.toThrow();
  });

  it("seeds the M20 check-in watchdog rules (GAP-061) with the spec severities and recipients", () => {
    const rule = (t: string) => PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === t);
    expect(rule("m20.safety.check_in_overdue")).toMatchObject({ severityFloor: "warn" });
    expect(rule("m20.safety.check_in_escalated")).toMatchObject({ severityFloor: "critical" });
    expect(rule("m20.safety.coverage_gap_detected")).toMatchObject({
      severityFloor: "critical",
      recipientResolver: "role_set",
      resolverArgs: { roleKeys: ["don", "org_admin"] },
      systemLocked: true,
      enabled: true,
    });
    // The M19 on-call roster page: a second, separately keyed rule (one resolver per rule).
    expect(rule("m20.safety.check_in_escalated_oncall")).toMatchObject({
      severityFloor: "critical",
      recipientResolver: "on_call",
      resolverArgs: { providerEntityIdPath: "providerEntityId" },
      systemLocked: false,
    });
  });

  it("seeds the M24 stale-eligibility alert PE-scoped to billers, org-wide billing_manager only as fallback", () => {
    const rule = PLATFORM_DEFAULT_ALERT_RULES.find(
      (r) => r.eventType === "medicaid.eligibility.stale_at_assembly",
    );
    expect(rule).toMatchObject({
      severityFloor: "warn",
      recipientResolver: "role_set",
      resolverArgs: {
        providerEntityIdPath: "providerEntityId",
        providerEntityScopedRoleKeys: ["billing_manager", "biller"],
        providerEntityFallbackRoleKeys: ["billing_manager"],
      },
    });
    // No org-wide biller audience: an unscoped roleKeys would page every biller in the org.
    expect(rule?.resolverArgs).not.toHaveProperty("roleKeys");
  });

  it("seeds the M23 NOE / NOTR rejection alerts critical and PE-scoped to billers", () => {
    for (const eventType of ["m23.noe.rejected", "m23.notr.rejected"]) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
      expect(rule).toMatchObject({
        category: "administrative",
        severityFloor: "critical",
        recipientResolver: "role_set",
        resolverArgs: {
          providerEntityIdPath: "providerEntityId",
          providerEntityScopedRoleKeys: ["billing_manager", "biller"],
          providerEntityFallbackRoleKeys: ["billing_manager"],
        },
        systemLocked: false,
        enabled: true,
      });
      expect(rule?.resolverArgs).not.toHaveProperty("roleKeys");
    }
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
      [
        "field_safety.sos",
        "m20.safety.coverage_gap_detected",
        "m3.breakglass.invoked",
        "noe.late_risk",
        "system.backup_failure",
      ].sort(),
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
