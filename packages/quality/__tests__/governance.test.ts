import {
  type DischargeDeathEvent,
  M30_ALERTS,
  M30_ALERT_LIST,
  M30_PERMISSIONS,
  buildMortalityReviewFromDeath,
} from "@chartwarden/quality";
// @chartwarden/quality — M30 GOVERNANCE unit tests (§4.6 permission catalog · §4.9 alert catalog ·
// §3.6/§3.8 + W-M30-28 42 CFR Part 2 promotion). PURE: no DB / Valkey / BullMQ.
//
// Proves three pure, boot-catalog / Part-2 invariants the integrator must not let drift:
//
//   (a) the §4.6 permission tuple `M30_PERMISSIONS` is the 34-key source of truth the backend's
//       `M30_CONTRIBUTED_PERMISSIONS` mirrors (the route-key cross-check lives in the backend
//       `m30-abac.test.ts`, which can see the route files).
//   (c) the §4.9 alert catalog has all twelve definitions, each with the severity + channel set the
//       `M30_ALERT_PAYLOADS` payload catalog declares (W-M30-29 boot-catalog presence; severity/channel
//       must mirror the payload floor 1:1 so the def + the catalog never diverge).
//   (c) W-M30-28 — a SUD decedent (or a Part-2 document in chart) auto-promotes the mortality review to
//       the `compliance_42cfr_part2` retention class; a non-SUD decedent stays `phi` (§3.6/§3.8 fail-safe:
//       promotion is positive-only, never silently dropped).
import { M30_ALERT_PAYLOADS } from "@chartwarden/types";
import { describe, expect, it } from "vitest";

// -----------------------------------------------------------------------------
// (a) §4.6 permission tuple — the 34-key source of truth.
// -----------------------------------------------------------------------------
describe("M30 §4.6 permission tuple", () => {
  it("declares exactly 34 keys with no duplicates", () => {
    expect(M30_PERMISSIONS).toHaveLength(34);
    expect(new Set(M30_PERMISSIONS).size).toBe(34);
  });

  it("every key is `resource.action`-shaped under an owned M30 resource prefix", () => {
    const allowedPrefixes = new Set([
      "quality",
      "qapi",
      "sra",
      "incident",
      "mortality",
      "cop",
      "infection",
      "risk",
    ]);
    for (const key of M30_PERMISSIONS) {
      expect(key).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      const prefix = key.split(".")[0];
      expect(allowedPrefixes.has(prefix ?? "")).toBe(true);
    }
  });

  it("includes the two-person co-sign close keys + the service-only CAHPS ingest key", () => {
    // these three keys carry the spec's strongest governance controls — assert they are present
    expect(M30_PERMISSIONS).toContain("qapi.close"); // D12 / V-11 two-actor PIP close
    expect(M30_PERMISSIONS).toContain("sra.close"); // D12 / V-12 two-actor cycle close
    expect(M30_PERMISSIONS).toContain("quality.cahps.system"); // mTLS service-only ingest
  });
});

// -----------------------------------------------------------------------------
// (c) §4.9 alert catalog — W-M30-29 boot-catalog presence + severity/channel mirror.
// -----------------------------------------------------------------------------
describe("M30 §4.9 alert catalog (W-M30-29)", () => {
  // The expected severities, read straight from the §4.9 table (independent of the payload catalog so a
  // shared regression in BOTH files is still caught).
  const EXPECTED_SEVERITY = {
    sraDue90: "info",
    sraDue60: "warn",
    sraDue30: "high",
    sraOverdue: "critical",
    incidentAbuseAllegation: "critical",
    incidentSentinel: "critical",
    outbreakDetected: "high",
    measureThresholdBreached: "warn",
    capOverdue: "high",
    mortalityReviewDue: "info",
    copReviewOverdue: "warn",
    cahpsSampleReady: "info",
  } as const;

  it("ships all twelve §4.9 alert definitions", () => {
    expect(M30_ALERT_LIST).toHaveLength(12);
    expect(Object.keys(M30_ALERTS)).toHaveLength(12);
    expect(Object.keys(M30_ALERTS).sort()).toEqual(Object.keys(EXPECTED_SEVERITY).sort());
  });

  it("each def's `alertKey` equals its catalog map key (no mislabeled entry)", () => {
    for (const [key, def] of Object.entries(M30_ALERTS)) {
      expect(def.alertKey).toBe(key);
    }
  });

  it("each def carries the §4.9 severity expected for its alert", () => {
    for (const [key, def] of Object.entries(M30_ALERTS)) {
      expect(def.severity).toBe(EXPECTED_SEVERITY[key as keyof typeof EXPECTED_SEVERITY]);
    }
  });

  it("severity + channels mirror the M30_ALERT_PAYLOADS payload-catalog floor 1:1 (no drift)", () => {
    const byPayloadType = new Map(M30_ALERT_PAYLOADS.map((p) => [p.payloadType, p]));
    // every alert def points at a real payload-catalog entry...
    expect(M30_ALERT_LIST).toHaveLength(M30_ALERT_PAYLOADS.length);
    for (const def of M30_ALERT_LIST) {
      const payload = byPayloadType.get(def.payloadType);
      expect(payload, `payload catalog must own ${def.payloadType}`).toBeDefined();
      if (!payload) continue;
      // ...and the def's lowercase severity is the lower-cased payload-floor severity.
      expect(def.severity).toBe(payload.severity.toLowerCase());
      // ...and the channel set mirrors the payload's defaultChannels (same order).
      expect([...def.defaultChannels]).toEqual([...payload.defaultChannels]);
    }
  });

  it("the abuse-allegation + sentinel + SRA-overdue alerts are CRITICAL with the email channel (escalation floor)", () => {
    for (const key of ["incidentAbuseAllegation", "incidentSentinel", "sraOverdue"] as const) {
      const def = M30_ALERTS[key];
      expect(def.severity).toBe("critical");
      expect(def.defaultChannels).toContain("email");
    }
  });

  it("outbox-triggered alerts name a concrete m30.* event type; scheduled alerts name a source", () => {
    for (const def of M30_ALERT_LIST) {
      if (def.trigger.kind === "outbox_event") {
        expect(def.trigger.eventType).toMatch(/^m30\./);
      } else {
        expect(def.trigger.source.length).toBeGreaterThan(0);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// (c) §3.6/§3.8 + W-M30-28 — 42 CFR Part 2 promotion in the mortality auto-creator.
// -----------------------------------------------------------------------------
describe("W-M30-28 mortality auto-create Part 2 promotion (§3.6/§3.8)", () => {
  const baseEvent: DischargeDeathEvent = {
    organizationId: "org-1",
    providerEntityId: "pe-1",
    deceasedPatientId: "pat-1",
    admissionId: "adm-1",
    deathAt: new Date("2026-06-01T00:00:00Z"),
    eventIdempotencyKey: "evt-1",
  };

  it("a SUD decedent auto-promotes the review to compliance_42cfr_part2 (W-M30-28 check b)", () => {
    const result = buildMortalityReviewFromDeath({ ...baseEvent, decedentHasSud: true });
    expect(result.retention.part2Promoted).toBe(true);
    expect(result.retention.class).toBe("compliance_42cfr_part2");
    expect(result.retention.basis).toMatch(/has_sud/);
  });

  it("a Part-2 document in chart also promotes (W-M30-28 variant c)", () => {
    const result = buildMortalityReviewFromDeath({
      ...baseEvent,
      decedentHasSud: false,
      hasPart2DocumentInChart: true,
    });
    expect(result.retention.part2Promoted).toBe(true);
    expect(result.retention.class).toBe("compliance_42cfr_part2");
    expect(result.retention.basis).toMatch(/compliance_42cfr_part2/);
  });

  it("a non-SUD decedent with no Part-2 document stays the default `phi` class (no false promotion)", () => {
    const result = buildMortalityReviewFromDeath(baseEvent);
    expect(result.retention.part2Promoted).toBe(false);
    expect(result.retention.class).toBe("phi");
    expect(result.retention.basis).toBeUndefined();
  });

  it("promotion is positive-only: `decedentHasSud: false` does NOT promote (fail-safe, never silently drops PHI class)", () => {
    const result = buildMortalityReviewFromDeath({ ...baseEvent, decedentHasSud: false });
    expect(result.retention.part2Promoted).toBe(false);
    expect(result.retention.class).toBe("phi");
  });

  it("an internal-source death runs an ACTIVE completion clock; an external (hl7) death DEFERS it (W-M30-27)", () => {
    const internal = buildMortalityReviewFromDeath(baseEvent);
    expect(internal.completionClock.deferred).toBe(false);
    expect(internal.completionClock.effectiveTargetCompletionAt).not.toBeNull();

    const external = buildMortalityReviewFromDeath({ ...baseEvent, source: "hl7_external" });
    expect(external.completionClock.deferred).toBe(true);
    expect(external.completionClock.effectiveTargetCompletionAt).toBeNull();
    // the NOT NULL column is still populated with a provisional target (frozen-schema invariant).
    expect(external.row.targetCompletionAt).not.toBeNull();
  });

  it("always emits exactly the m30.mortality_review.created outbox event on auto-create", () => {
    const result = buildMortalityReviewFromDeath({ ...baseEvent, decedentHasSud: true });
    expect(result.outboxEvents).toEqual(["m30.mortality_review.created"]);
    expect(result.row.status).toBe("pending");
    expect(result.row.createdViaEventIdempotencyKey).toBe("evt-1");
  });
});
