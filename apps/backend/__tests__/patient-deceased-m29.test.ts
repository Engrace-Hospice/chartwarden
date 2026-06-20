// apps/backend/__tests__/patient-deceased-m29.test.ts — M5-T11 deceased cascade (§7.8) + the M29
// proposal-accept consumer as a forward-seam/deny-stub (§4.10, W-M5-17 SSN ignore).
import {
  DECEASED_CASCADE_TARGETS,
  InvalidDeceasedDateError,
  M29_PROPOSAL_CONSUMER,
  M29_PROPOSAL_CONSUMER_DEFERRED,
  decideProposalApply,
  recordDeath,
  type DeceasedCascadePorts,
  type ProposalAcceptedPayload,
} from "../src/modules/05-patient/index";
import { describe, expect, it } from "vitest";

describe("§7.8 record-death cascade", () => {
  function ports() {
    const marked: Array<{ patientId: string; date: string }> = [];
    const emitted: Array<{ patientId: string; date: string }> = [];
    const p: DeceasedCascadePorts = {
      markDeceased: async (_o, patientId, date) => void marked.push({ patientId, date }),
      emitDeceased: async (_o, patientId, date) => void emitted.push({ patientId, date }),
    };
    return { p, marked, emitted };
  }

  it("flips status→deceased, sets deceased_date, emits the cascade to M16/M23/M28/M36", async () => {
    const { p, marked, emitted } = ports();
    const result = await recordDeath(
      { organizationId: "org_a", patientId: "p1", deceasedDate: "2026-06-15", today: "2026-06-20" },
      p,
    );
    expect(result.status).toBe("deceased");
    expect(result.deceasedDate).toBe("2026-06-15");
    expect(result.cascadeTargets).toEqual(["m16", "m23", "m28", "m36"]);
    expect(DECEASED_CASCADE_TARGETS).toEqual(["m16", "m23", "m28", "m36"]);
    expect(marked).toEqual([{ patientId: "p1", date: "2026-06-15" }]);
    expect(emitted).toEqual([{ patientId: "p1", date: "2026-06-15" }]); // same outbox-published txn
  });

  it("rejects a future deceased_date", async () => {
    const { p } = ports();
    await expect(
      recordDeath({ organizationId: "org_a", patientId: "p1", deceasedDate: "2027-01-01", today: "2026-06-20" }, p),
    ).rejects.toBeInstanceOf(InvalidDeceasedDateError);
  });
});

describe("§4.10 M29 proposal-accept consumer (forward-seam / deny-stub)", () => {
  const base: ProposalAcceptedPayload = {
    proposalId: "prop-1",
    organizationId: "org_a",
    resourceKind: "patient_demographic_update",
    ownerModule: "m5",
    matchedPatientId: "p1",
    decidedByMembershipId: "mem-1",
    appliedFields: null,
    proposedPatientCandidate: {
      names: [{ familyName: "Byron", givenName: "Ada" }],
      dateOfBirth: "1990-01-01",
      ssnNumber: "123456789", // chatty partner — must never be applied (W-M5-17)
    },
  };

  it("is declared but DEFERRED in Phase 1 (M29 is Wave H)", () => {
    expect(M29_PROPOSAL_CONSUMER.eventName).toBe("m29.hl7_inbound_proposal.accepted");
    expect(M29_PROPOSAL_CONSUMER.consumerName.startsWith("m5.")).toBe(true);
    expect(M29_PROPOSAL_CONSUMER_DEFERRED).toBe(true);
  });

  it("a demographic update maps the PID candidate to a patch with NO ssn (W-M5-17)", () => {
    const decision = decideProposalApply(base);
    expect(decision.action).toBe("apply_demographics");
    if (decision.action === "apply_demographics") {
      expect(decision.patientId).toBe("p1");
      expect(decision.patch.legalLastName).toBe("Byron");
      expect("ssn" in decision.patch).toBe(false); // SSN never mapped (mutator would strip it anyway)
    }
  });

  it("partial accept keeps only the selected fields", () => {
    const decision = decideProposalApply({ ...base, appliedFields: ["legalLastName"] });
    if (decision.action === "apply_demographics") {
      expect(decision.patch.legalLastName).toBe("Byron");
      expect(decision.patch.dateOfBirth).toBeUndefined();
    }
  });

  it("new_patient → create; demographic update with no match → skip (D10 no auto-create)", () => {
    expect(decideProposalApply({ ...base, resourceKind: "new_patient" }).action).toBe("create_patient");
    expect(decideProposalApply({ ...base, matchedPatientId: null }).action).toBe("skip");
  });
});
