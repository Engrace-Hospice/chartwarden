// @wardenx/reporting — drilldown CONSENT-NARROWING + AUDIT-WRITER FAIL-CLOSED UNIT TESTS
// (M33 §4.4 / §3.6 / §4.10 / W-R-05 / D16).
//
// The drilldown emit is fail-closed at every layer that could surface a patient identifier. These PURE
// port-injected suites (the M34 `shred-worker.test.ts` template — in-memory recording fakes + a `calls[]`
// trail) prove the two load-bearing fail-closed invariants:
//   1. CONSENT — when the M39 `ConsentEvaluator` port is UNAVAILABLE (unbound/down/throws), the narrowing
//      NARROWS MAXIMALLY: it excludes the ENTIRE candidate cohort and stamps `consent_evaluation_unavailable`.
//      It NEVER widens (an evaluated subset only ever excludes the disallowed ids — allowed ids pass untouched).
//   2. DEK — when the per-tenant DEK encrypt port is UNAVAILABLE, the audit writer THROWS and writes NOTHING:
//      no plaintext filter context is ever persisted (the drilldown is DENIED, not stored un-protected).
//   3. on the happy path the audit row carries the envelope-encrypted `query_filters_cipher` + the
//      `is_consent_narrowed` posture decided upstream.
import {
  CONSENT_UNAVAILABLE_REASON,
  type ConsentEvaluation,
  type DrilldownAuditInput,
  type DrilldownAuditPorts,
  DrilldownDekUnavailable,
  decideConsentNarrowing,
  narrowDrilldownForConsent,
  writeDrilldownAudit,
} from "@wardenx/reporting";
import { describe, expect, it } from "vitest";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const ACTOR = "membership_clinician_1";
const FIXED_NOW = new Date("2026-06-25T12:00:00.000Z");
const COHORT = ["pt_a", "pt_b", "pt_c"];
const BASE_URL = "/app/m8/late-entry-register";

// ── (1) consent narrowing — FAIL-CLOSED to the whole cohort, NEVER widens ────────────────────────────────────

function makeConsentPorts(opts: {
  throws?: boolean;
  result?: { allowedPatientIds: readonly string[]; isNarrowed: boolean; reason: string | null };
}) {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      consent: {
        evaluateForReporting: async () => {
          calls.push("evaluateForReporting");
          if (opts.throws) throw new Error("M39 ConsentEvaluator unbound");
          return opts.result ?? { allowedPatientIds: [], isNarrowed: false, reason: null };
        },
      },
    },
  };
}

describe("M33 §4.4 / W-R-05 consent narrowing — FAIL-CLOSED when M39 is unavailable", () => {
  it("★ an UNAVAILABLE M39 port narrows the ENTIRE cohort (maximal narrow), never widens", async () => {
    const { ports } = makeConsentPorts({ throws: true });
    const result = await narrowDrilldownForConsent(
      { organizationId: ORG, actorMembershipId: ACTOR, patientIds: COHORT, url: BASE_URL },
      ports,
    );
    // EVERY candidate identifier is excluded — no patient passes when consent cannot be evaluated.
    expect([...result.excludedPatientIds].sort()).toEqual([...COHORT].sort());
    expect(result.excludedPatientIds).toHaveLength(COHORT.length);
    expect(result.isConsentNarrowed).toBe(true);
    expect(result.reason).toBe(CONSENT_UNAVAILABLE_REASON);
    expect(result.url).toContain("consentNarrowed=true");
  });

  it("★ the pure decider with the `unavailable` sentinel excludes the whole cohort", () => {
    const evaluation: ConsentEvaluation = { kind: "unavailable" };
    const decision = decideConsentNarrowing(COHORT, evaluation);
    expect(decision.excludedPatientIds).toEqual(COHORT);
    expect(decision.isConsentNarrowed).toBe(true);
    expect(decision.reason).toBe(CONSENT_UNAVAILABLE_REASON);
  });

  it("an evaluated subset NARROWS but NEVER WIDENS — only the disallowed ids are excluded, allowed ids pass", async () => {
    const { ports } = makeConsentPorts({
      result: { allowedPatientIds: ["pt_a", "pt_c"], isNarrowed: true, reason: "sud_redaction" },
    });
    const result = await narrowDrilldownForConsent(
      { organizationId: ORG, actorMembershipId: ACTOR, patientIds: COHORT, url: BASE_URL },
      ports,
    );
    expect(result.excludedPatientIds).toEqual(["pt_b"]); // ONLY the redacted patient is dropped
    expect(result.excludedPatientIds).not.toContain("pt_a"); // an allowed id is NEVER excluded (no widening)
    expect(result.isConsentNarrowed).toBe(true);
    expect(result.reason).toBe("sud_redaction");
  });

  it("a fully-allowed cohort is returned UN-narrowed (no params appended)", async () => {
    const { ports } = makeConsentPorts({
      result: { allowedPatientIds: COHORT, isNarrowed: false, reason: null },
    });
    const result = await narrowDrilldownForConsent(
      { organizationId: ORG, actorMembershipId: ACTOR, patientIds: COHORT, url: BASE_URL },
      ports,
    );
    expect(result.isConsentNarrowed).toBe(false);
    expect(result.excludedPatientIds).toEqual([]);
    expect(result.url).toBe(BASE_URL);
  });

  it("a pure-aggregate drilldown (no patient ids) skips the consent call entirely", async () => {
    const { ports, calls } = makeConsentPorts({ throws: true });
    const result = await narrowDrilldownForConsent(
      { organizationId: ORG, actorMembershipId: ACTOR, patientIds: [], url: BASE_URL },
      ports,
    );
    expect(result.isConsentNarrowed).toBe(false);
    expect(calls).not.toContain("evaluateForReporting"); // no cohort → no M39 hop
  });
});

// ── (2) audit writer — FAIL-CLOSED on the DEK; writes NOTHING ─────────────────────────────────────────────────

// The audit row exactly as the PORT declares it. Restating a narrower shape here (the three fields this
// suite asserts on) made the double reject the port's own argument type: `isConsentNarrowed` is optional
// on the row and was pinned to `boolean` in the copy.
type DrilldownAuditRow = Parameters<DrilldownAuditPorts["audit"]["append"]>[0];

function makeAuditPorts(opts: { dekThrows?: boolean } = {}) {
  const calls: string[] = [];
  const appended: DrilldownAuditRow[] = [];
  const emitted: unknown[] = [];
  return {
    calls,
    appended,
    emitted,
    ports: {
      encryption: {
        encryptFilters: async ({ plaintext }: { organizationId: string; plaintext: string }) => {
          calls.push("encrypt");
          if (opts.dekThrows) throw new Error("per-tenant DEK unbound");
          return `cipher(${plaintext})`;
        },
      },
      audit: {
        append: async (row: DrilldownAuditRow) => {
          calls.push("append");
          appended.push(row);
        },
      },
      outbox: {
        emitDrilldown: async (p: unknown) => {
          calls.push("emit");
          emitted.push(p);
        },
      },
      newRowId: () => "row_1",
      newTraceId: () => "trace_1",
      now: () => FIXED_NOW,
    },
  };
}

const AUDIT_INPUT: DrilldownAuditInput = {
  organizationId: ORG,
  actorMembershipId: ACTOR,
  reportViewId: "view_1",
  sourceTileKey: "tile.census_by_team",
  drilldownTargetModule: 8,
  drilldownTargetSurface: "late_entry_register",
  queryFilters: { team: "north", patientIdHash: "h_abc" },
  isConsentNarrowed: true,
  consentNarrowingReason: "sud_redaction",
};

describe("M33 §3.6 / W-R-05 audit writer — FAIL-CLOSED when the per-tenant DEK is unavailable", () => {
  it("★ a DEK-port throw DENIES the drilldown and writes NOTHING (no plaintext fallback)", async () => {
    const { ports, calls, appended, emitted } = makeAuditPorts({ dekThrows: true });
    await expect(writeDrilldownAudit(AUDIT_INPUT, ports)).rejects.toBeInstanceOf(
      DrilldownDekUnavailable,
    );
    // The encrypt was attempted, but NOTHING was persisted or emitted — fail-closed, never plaintext at rest.
    expect(calls).toEqual(["encrypt"]);
    expect(appended).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("★ on success the audit row carries the envelope-encrypted query_filters_cipher + the narrowing posture", async () => {
    const { ports, calls, appended } = makeAuditPorts();
    const result = await writeDrilldownAudit(AUDIT_INPUT, ports);
    expect(result).toEqual({ drilldownTraceId: "trace_1", outcome: "emitted" });
    // Encrypt happens BEFORE the insert; the cipher (never the plaintext) lands on the row.
    expect(calls).toEqual(["encrypt", "append", "emit"]);
    expect(appended).toHaveLength(1);
    const row = appended[0]!;
    // The row stores the ENCRYPT PORT's output, never the raw filter object — the cipher is what lands at rest.
    expect(row.queryFiltersCipher).toBe(`cipher(${JSON.stringify(AUDIT_INPUT.queryFilters)})`);
    expect(row).not.toHaveProperty("queryFilters"); // the plaintext object is never persisted on the row
    expect(row.isConsentNarrowed).toBe(true);
    expect(row.consentNarrowingReason).toBe("sud_redaction");
  });

  it("an un-narrowed drilldown still records the row, with a null narrowing reason", async () => {
    const { ports, appended } = makeAuditPorts();
    await writeDrilldownAudit(
      { ...AUDIT_INPUT, isConsentNarrowed: false, consentNarrowingReason: null },
      ports,
    );
    expect(appended[0]!.isConsentNarrowed).toBe(false);
    expect(appended[0]!.consentNarrowingReason).toBeNull();
  });
});
