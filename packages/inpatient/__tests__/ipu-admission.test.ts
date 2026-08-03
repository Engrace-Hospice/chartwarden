// @wardenx/inpatient — M37-T04 unit tests for the §2.2 D2 ipu_admission lifecycle machine.
import { describe, expect, it } from "vitest";
import {
  ADMISSION_GRAPH,
  admissionHoldsBed,
  isAdmissionClosed,
  planOpenAdmission,
  transitionAdmission,
} from "../src/machines/ipu-admission";
import { IpuStateError } from "../src/errors";

const effectKinds = (t: { effects: readonly { kind: string }[] }) => t.effects.map((e) => e.kind);
const outboxOf = (t: { effects: readonly { kind: string; event?: string }[] }) =>
  t.effects.filter((e) => e.kind === "outbox").map((e) => e.event);

describe("open (§2.2 [*]→pending)", () => {
  it("opens a GIP admission when RN coverage is active; emits opened", () => {
    const t = planOpenAdmission("gip", { rnCoverageActive: true });
    expect(t.to).toBe("pending");
    expect(t.from).toBeNull();
    expect(outboxOf(t)).toEqual(["m37.ipu_admission.opened"]);
  });

  it("blocks a GIP/IRC open with IPU_RN_COVERAGE_UNAVAILABLE when coverage is inactive (D3)", () => {
    for (const kind of ["gip", "irc"] as const) {
      try {
        planOpenAdmission(kind, { rnCoverageActive: false });
        throw new Error("expected throw");
      } catch (e) {
        expect((e as IpuStateError).code).toBe("IPU_RN_COVERAGE_UNAVAILABLE");
        expect((e as IpuStateError).statusCode).toBe(412);
      }
    }
  });

  it("lets an arranged remote-IPU admission open even without RN coverage (agency doesn't own the unit)", () => {
    expect(planOpenAdmission("arranged", { rnCoverageActive: false }).to).toBe("pending");
  });
});

describe("bed flow pending→bed_pending→bed_assigned→active", () => {
  it("requestBed requires an active unit, RN coverage, and a ready bed", () => {
    const t = transitionAdmission("pending", "gip", {
      type: "requestBed",
      unitActive: true,
      rnCoverageActive: true,
      hasReadyBed: true,
    });
    expect(t.to).toBe("bed_pending");
    expect(outboxOf(t)).toEqual(["m37.ipu_admission.bed_requested"]);
    expect(() =>
      transitionAdmission("pending", "gip", { type: "requestBed", unitActive: false, rnCoverageActive: true, hasReadyBed: true }),
    ).toThrow(/IPU_UNIT_INACTIVE|not active/);
    expect(() =>
      transitionAdmission("pending", "gip", { type: "requestBed", unitActive: true, rnCoverageActive: true, hasReadyBed: false }),
    ).toThrow(/no bed in 'ready'/);
  });

  it("assignBed reserves the source bed + persists the assignment", () => {
    const t = transitionAdmission("bed_pending", "gip", {
      type: "assignBed",
      bedId: "bed-1",
      bedReady: true,
      roomOccupancyAllowed: true,
    });
    expect(t.to).toBe("bed_assigned");
    expect(effectKinds(t)).toContain("persist_bed_assignment");
    expect(t.effects).toContainEqual({ kind: "source_bed_cleaning", event: "reserve" });
  });

  it("assignBed rejects an opposite-sex room occupancy conflict (M5 privacy)", () => {
    try {
      transitionAdmission("bed_pending", "gip", { type: "assignBed", bedId: "b", bedReady: true, roomOccupancyAllowed: false });
    } catch (e) {
      expect((e as IpuStateError).code).toBe("IPU_ROOM_OCCUPANCY_CONFLICT");
    }
  });

  it("confirm activates, occupies the bed, and requires GIP criteria for a GIP admission", () => {
    // GIP without criteria → 412 GIP_CRITERIA_REQUIRED
    try {
      transitionAdmission("bed_assigned", "gip", { type: "confirm", lcpConfirmed: true, gipCriteriaExists: false });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as IpuStateError).code).toBe("GIP_CRITERIA_REQUIRED");
      expect((e as IpuStateError).statusCode).toBe(412);
    }
    const gip = transitionAdmission("bed_assigned", "gip", { type: "confirm", lcpConfirmed: true, gipCriteriaExists: true });
    expect(gip.to).toBe("active");
    expect(gip.effects).toContainEqual({ kind: "source_bed_cleaning", event: "occupy" });
    expect(effectKinds(gip)).not.toContain("open_irc_episode");
    // IRC opens the irc_episode child row on activation.
    const irc = transitionAdmission("bed_assigned", "irc", { type: "confirm", lcpConfirmed: true, gipCriteriaExists: false });
    expect(effectKinds(irc)).toContain("open_irc_episode");
  });

  it("confirm blocks when the M6 LCP ack has not arrived", () => {
    expect(() =>
      transitionAdmission("bed_assigned", "gip", { type: "confirm", lcpConfirmed: false, gipCriteriaExists: true }),
    ).toThrow(/ADMISSION_LCP_NOT_CONFIRMED|ack has not arrived/);
  });
});

describe("terminal flows from active", () => {
  it("discharge dirties the bed and closes the irc_episode for an IRC admission", () => {
    const irc = transitionAdmission("active", "irc", { type: "discharge", dischargeEventExists: true });
    expect(irc.to).toBe("discharged");
    expect(effectKinds(irc)).toContain("close_irc_episode");
    expect(irc.effects).toContainEqual({ kind: "source_bed_cleaning", event: "dischargeDirty" });
    // GIP discharge does not close an irc_episode.
    const gip = transitionAdmission("active", "gip", { type: "discharge", dischargeEventExists: true });
    expect(effectKinds(gip)).not.toContain("close_irc_episode");
  });

  it("recordDeath is system-only, opens body release, and defers the dirty-bed transition", () => {
    try {
      transitionAdmission("active", "gip", { type: "recordDeath", deathEventReferencesAdmission: true, isSystemActor: false });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as IpuStateError).code).toBe("ADMISSION_SYSTEM_ACTOR_REQUIRED");
    }
    const t = transitionAdmission("active", "gip", { type: "recordDeath", deathEventReferencesAdmission: true, isSystemActor: true });
    expect(t.to).toBe("deceased");
    expect(effectKinds(t)).toEqual(
      expect.arrayContaining(["open_body_release", "defer_bed_dirty_until_body_release"]),
    );
    expect(effectKinds(t)).not.toContain("source_bed_cleaning"); // bed stays occupied until release
  });

  it("postCloseSettlement requires system actor + no open child rows", () => {
    expect(() =>
      transitionAdmission("discharged", "gip", { type: "postCloseSettlement", isSystemActor: true, noOpenChildRows: false }),
    ).toThrow(/ADMISSION_OPEN_CHILD_ROWS|open child row/);
    const t = transitionAdmission("discharged", "gip", { type: "postCloseSettlement", isSystemActor: true, noOpenChildRows: true });
    expect(t.to).toBe("closed");
  });
});

describe("graph integrity + classifiers", () => {
  it("rejects illegal transitions; closed is terminal", () => {
    expect(() => transitionAdmission("pending", "gip", { type: "discharge", dischargeEventExists: true })).toThrow(IpuStateError);
    expect(ADMISSION_GRAPH.closed).toEqual([]);
    try {
      transitionAdmission("closed", "gip", { type: "requestBed", unitActive: true, rnCoverageActive: true, hasReadyBed: true });
    } catch (e) {
      expect((e as IpuStateError).code).toBe("ILLEGAL_ADMISSION_TRANSITION");
    }
  });

  it("classifies terminal + bed-holding states", () => {
    expect(isAdmissionClosed("closed")).toBe(true);
    expect(isAdmissionClosed("active")).toBe(false);
    expect(admissionHoldsBed("active")).toBe(true);
    expect(admissionHoldsBed("deceased")).toBe(true);
    expect(admissionHoldsBed("pending")).toBe(false);
    expect(admissionHoldsBed("discharged")).toBe(false);
  });
});
