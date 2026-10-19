// Module 19 (On-Call Triage) — M19-T01 contract drift guards.
//
// `packages/types/src/oncall.ts` says its enum mirrors are "kept in lock-step with
// `packages/db/src/enums.ts`". A comment does not keep anything in lock-step. These tests are where the
// claim is actually enforced: `@wardenx/types` is a LEAF and cannot import `@wardenx/db`, so the two
// sides can only be compared somewhere that already depends on both — the backend, which is exactly the
// consumer that would ship the drift. The failure mode being prevented is the one M30 already paid for:
// a wire type that says one thing while the column accepts another, with every gate green.

import { describe, expect, it } from "vitest";

import {
  oncallModel,
  oncallShiftDiscipline,
  oncallShiftStatus,
  triageAiConfidence,
  triageCallCallerKind,
  triageCallInboundChannel,
  triageCallSource,
  triageCallState,
  triageDisposition,
  triageEscalationTier,
  triageEscalationTrigger,
  triageProtocolAnswerType,
  triageRiskBand,
} from "@wardenx/db/schema";
import {
  M19_AUDIT_DENYLIST,
  M19_AUDIT_RETENTION_CLASS,
  M19_EVENT_NAMES,
  M19_SUBSCRIBED_EVENT_NAMES,
  M19_SYSTEM_LOCKED_ALERT_TYPES,
  M19_TABLE_NAMES,
  type OncallModel,
  type OncallShiftDiscipline,
  type OncallShiftStatus,
  TRIAGE_CALL_OPEN_STATES,
  TRIAGE_CALL_TERMINAL_STATES,
  type TriageAiConfidence,
  type TriageCallCallerKind,
  type TriageCallInboundChannel,
  type TriageCallSource,
  type TriageCallState,
  type TriageDisposition,
  type TriageEscalationTier,
  type TriageEscalationTrigger,
  type TriageProtocolAnswerType,
  type TriageRiskBand,
} from "@wardenx/types";
import { MODULES } from "../../../architecture/module-manifest";

/** Each pair is (the pgEnum's runtime values, the leaf union's members). The second element is written
 *  as a `satisfies`-checked literal array so a member added to the TS union without being added here is
 *  a COMPILE error, and a member added to the pgEnum without the union is a RUNTIME failure. Neither
 *  side can drift alone. */
const MIRRORS = [
  [
    "oncall_model",
    oncallModel.enumValues,
    ["direct", "hybrid", "centralized"] satisfies OncallModel[],
  ],
  [
    "oncall_shift_status",
    oncallShiftStatus.enumValues,
    ["scheduled", "active", "completed", "cancelled"] satisfies OncallShiftStatus[],
  ],
  [
    "oncall_shift_discipline",
    oncallShiftDiscipline.enumValues,
    [
      "clinical_rn",
      "clinical_lpn",
      "medical_director",
      "msw",
      "chaplain",
      "external",
    ] satisfies OncallShiftDiscipline[],
  ],
  [
    "triage_call_state",
    triageCallState.enumValues,
    [
      "open",
      "protocol_in_progress",
      "awaiting_callback",
      "disposition_pending",
      "documented_pending_encounter",
      "documented",
      "escalated_unresolved",
      "abandoned",
      "closed",
    ] satisfies TriageCallState[],
  ],
  [
    "triage_call_caller_kind",
    triageCallCallerKind.enumValues,
    [
      "patient",
      "caregiver",
      "external_clinician",
      "portal_session",
      "system_inbound",
      "bereaved_family",
    ] satisfies TriageCallCallerKind[],
  ],
  [
    "triage_call_inbound_channel",
    triageCallInboundChannel.enumValues,
    [
      "phone",
      "sms",
      "email",
      "portal_message",
      "inbound_visit_failure",
      "inbound_evv_anomaly",
      "inbound_alert_failure",
      "inbound_afterhours_request",
    ] satisfies TriageCallInboundChannel[],
  ],
  [
    "triage_call_source",
    triageCallSource.enumValues,
    [
      "manual",
      "no_show",
      "late_checkout",
      "geofence_anomaly",
      "m36_delivery_failure",
      "paper_origin",
      "m36_afterhours_request",
    ] satisfies TriageCallSource[],
  ],
  [
    "triage_disposition",
    triageDisposition.enumValues,
    [
      "caregiver_education_only",
      "prn_intervention_authorized",
      "verbal_order_recorded",
      "visit_dispatched_now",
      "visit_scheduled_first_light",
      "gip_admission_proposed",
      "ed_transfer_acknowledged",
      "pronouncement_scheduled",
      "escalated_unresolved",
      "abandoned",
    ] satisfies TriageDisposition[],
  ],
  [
    "triage_escalation_tier",
    triageEscalationTier.enumValues,
    [
      "tier_1_rn_supervisor",
      "tier_2_clinical_manager",
      "tier_3_medical_director",
      "tier_4_compliance_officer",
      "tier_5_external",
    ] satisfies TriageEscalationTier[],
  ],
  [
    "triage_escalation_trigger",
    triageEscalationTrigger.enumValues,
    [
      "manual",
      "red_flag_question",
      "mandatory_protocol",
      "sla_breach",
    ] satisfies TriageEscalationTrigger[],
  ],
  [
    "triage_protocol_answer_type",
    triageProtocolAnswerType.enumValues,
    ["boolean", "integer", "scale_0_10", "free_text", "enum"] satisfies TriageProtocolAnswerType[],
  ],
  [
    "triage_risk_band",
    triageRiskBand.enumValues,
    ["low", "medium", "high"] satisfies TriageRiskBand[],
  ],
  [
    "triage_ai_confidence",
    triageAiConfidence.enumValues,
    ["low", "medium", "high"] satisfies TriageAiConfidence[],
  ],
] as const;

describe("§3.2 enum mirrors — pgEnum ↔ @wardenx/types", () => {
  it.each(MIRRORS.map(([name, pg, ts]) => [name, pg, ts] as const))(
    "%s carries the same members in the same order on both sides",
    (_name, pgValues, tsValues) => {
      expect([...pgValues]).toEqual([...tsValues]);
    },
  );

  it("covers all thirteen §3.2 Phase-A types", () => {
    expect(MIRRORS).toHaveLength(13);
  });

  it("carries `paper_origin`, without which §2.7's BCP re-entry cannot be written", () => {
    // The §3.2 CREATE TYPE block omits it; §2.7 step 1 requires it. The M19-F08 amendment updated §3.3
    // and missed the enum, so this is the one place the resolution is pinned.
    expect(triageCallSource.enumValues).toContain("paper_origin");
  });

  it("keeps `documented_pending_encounter` between disposition and documented (M19-F06/ADR-0022)", () => {
    const states = [...triageCallState.enumValues];
    expect(states.indexOf("documented_pending_encounter")).toBeGreaterThan(
      states.indexOf("disposition_pending"),
    );
    expect(states.indexOf("documented_pending_encounter")).toBeLessThan(
      states.indexOf("documented"),
    );
  });
});

describe("§3.3 owned tables ↔ the manifest", () => {
  const m19 = MODULES.find((m) => m.id === 19);

  it("mirrors the manifest's ownedTables exactly — the manifest is the source of truth", () => {
    expect(m19).toBeDefined();
    expect([...M19_TABLE_NAMES].sort()).toEqual([...(m19?.ownedTables ?? [])].sort());
  });

  it("owns eleven tables, not the nine §12/§13 still claim", () => {
    // §12/§13 predate the M19-F08 BCP amendment that added `triage_paper_reentry_worklist`, and
    // neither mentions `on_call_roster_sync_queue` (F-165, #248).
    expect(M19_TABLE_NAMES).toHaveLength(11);
    expect(M19_TABLE_NAMES).toContain("triage_paper_reentry_worklist");
    expect(M19_TABLE_NAMES).toContain("on_call_roster_sync_queue");
  });

  it("declares a denylist and a retention class for every owned table", () => {
    for (const table of M19_TABLE_NAMES) {
      expect(M19_AUDIT_DENYLIST[table]).toBeDefined();
      expect(M19_AUDIT_RETENTION_CLASS[table]).toBeDefined();
    }
  });

  it("denylists every §3.6 column, and keeps `red_flag_hit` OUT of the denylist", () => {
    expect([...M19_AUDIT_DENYLIST.triage_call].sort()).toEqual([
      "caller_phone_e164",
      "caller_quote_cipher",
      "chief_complaint_text",
      "transcript_cipher",
    ]);
    expect(M19_AUDIT_DENYLIST.triage_escalation).toEqual(["trigger_detail", "resolution"]);
    expect(M19_AUDIT_DENYLIST.on_call_shift).toEqual([
      "cancellation_reason",
      "compensation_metadata",
    ]);
    // D5 tamper-evidence: scrubbing this would erase the only proof the server evaluated the red flag.
    expect(M19_AUDIT_DENYLIST.triage_call_answer).not.toContain("red_flag_hit");
  });

  it("uses real `audit_retention_class` members, not prose labels", () => {
    for (const table of M19_TABLE_NAMES) {
      expect(["operational", "compliance", "legal_hold"]).toContain(
        M19_AUDIT_RETENTION_CLASS[table],
      );
    }
  });
});

describe("§4.10 outbox catalog", () => {
  it("uses the three-segment `mN.<resource>.<verb>` names `arch:gaps` enforces", () => {
    for (const name of M19_EVENT_NAMES) {
      expect(name.split(".")).toHaveLength(3);
      expect(name.startsWith("m19.")).toBe(true);
    }
  });

  it("publishes seventeen topics with no duplicates", () => {
    expect(M19_EVENT_NAMES).toHaveLength(17);
    expect(new Set(M19_EVENT_NAMES).size).toBe(17);
  });

  it("keeps the two topics M33's reporting catalog ALREADY subscribes to", () => {
    // `packages/reporting/src/catalog/outbox-subscription-map.ts` names these today; renaming either
    // would orphan a live consumer, not a hypothetical one.
    expect(M19_EVENT_NAMES).toContain("m19.triage_call.opened");
    expect(M19_EVENT_NAMES).toContain("m19.triage_call.closed");
  });

  it("keeps `m19.oncall_shift.activated` as the single canonical shift-open topic (M19-F12)", () => {
    expect(M19_EVENT_NAMES).toContain("m19.oncall_shift.activated");
    expect(M19_EVENT_NAMES as readonly string[]).not.toContain("m19.on_call_shift.opened");
  });

  it("subscribes to the D10 inbound triggers under their producers' real names", () => {
    expect(M19_SUBSCRIBED_EVENT_NAMES).toContain("m17.visit.no_show_detected");
    expect(M19_SUBSCRIBED_EVENT_NAMES).toContain("m18.evv.late_check_out_detected");
    // §4.8's queue table spells this two-segment; M36 emits the three-segment form.
    expect(M19_SUBSCRIBED_EVENT_NAMES).toContain("m36.notification.delivery_failed");
    expect(M19_SUBSCRIBED_EVENT_NAMES as readonly string[]).not.toContain("m36.delivery_failed");
  });
});

describe("§2.2.1 state vocabulary", () => {
  it("keeps a call stranded by a down M8 seam ON the supervisor board", () => {
    // The whole reason `documented_pending_encounter` is in the open set (M19-F06 / ADR-0022).
    expect(TRIAGE_CALL_OPEN_STATES).toContain("documented_pending_encounter");
  });

  it("does not treat `documented` as terminal — the close cron still has to run", () => {
    expect(TRIAGE_CALL_TERMINAL_STATES as readonly string[]).not.toContain("documented");
    expect([...TRIAGE_CALL_TERMINAL_STATES].sort()).toEqual(["abandoned", "closed"]);
  });

  it("keeps the open and terminal sets disjoint", () => {
    const terminal = new Set<string>(TRIAGE_CALL_TERMINAL_STATES);
    expect(TRIAGE_CALL_OPEN_STATES.filter((s) => terminal.has(s))).toEqual([]);
  });
});

describe("§4.9 alert rules", () => {
  it("locks the three alerts a short-staffed org would most want to silence", () => {
    expect([...M19_SYSTEM_LOCKED_ALERT_TYPES].sort()).toEqual([
      "m19.oncall.coverage_gap_detected",
      "m19.triage.mandatory_escalation_triggered",
      "m19.triage.protocol_red_flag_hit",
    ]);
  });
});
