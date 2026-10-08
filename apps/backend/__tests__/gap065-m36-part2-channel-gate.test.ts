// GAP-065 — M36 spec §7.13: a SUD-flagged patient's care_team channel is gated per member by M39's
// ConsentEvaluator (42 CFR Part 2). Unit tests over injected ports; every uncertainty fails closed.
import { describe, expect, it } from "vitest";
import {
  type Part2GatePorts,
  allowAllPart2ChannelGate,
  createPart2ChannelGate,
} from "../src/modules/36-messaging/part2-channel-gate";

const ORG = "org_a";
const PATIENT = "patient_x";

const MEMBERSHIPS: Record<string, string> = { u_named: "m_named", u_other: "m_other" };

function ports(over: Partial<Part2GatePorts> = {}): Part2GatePorts & { evaluated: string[] } {
  const evaluated: string[] = [];
  return {
    evaluated,
    async privacyFlags() {
      return ["sud"];
    },
    async membershipIds(_org, userIds) {
      return new Map(userIds.flatMap((u) => (MEMBERSHIPS[u] ? [[u, MEMBERSHIPS[u]] as const] : [])));
    },
    async evaluateInternalAccess({ membershipId }) {
      evaluated.push(membershipId);
      return { redactSubstanceUseDisorderFields: membershipId !== "m_named" };
    },
    ...over,
  };
}

describe("createPart2ChannelGate", () => {
  it("lets everyone through (and never consults M39) when the patient has no SUD flag", async () => {
    const p = ports({ privacyFlags: async () => ["hiv"] });
    const gate = createPart2ChannelGate(p);
    const allowed = await gate.allowedUserIds({
      organizationId: ORG,
      patientId: PATIENT,
      userIds: ["u_named", "u_other"],
    });
    expect([...allowed].sort()).toEqual(["u_named", "u_other"]);
    expect(p.evaluated).toEqual([]);
  });

  it("for a SUD-flagged patient admits only members the Part 2 release covers", async () => {
    const gate = createPart2ChannelGate(ports());
    const allowed = await gate.allowedUserIds({
      organizationId: ORG,
      patientId: PATIENT,
      userIds: ["u_named", "u_other"],
    });
    expect([...allowed]).toEqual(["u_named"]);
  });

  it("excludes a user with no active membership (cannot be named against a release)", async () => {
    const gate = createPart2ChannelGate(ports());
    const allowed = await gate.allowedUserIds({
      organizationId: ORG,
      patientId: PATIENT,
      userIds: ["u_ghost"],
    });
    expect(allowed.size).toBe(0);
  });

  it("fails closed for a SUD-flagged patient when M39 throws (member excluded, not admitted)", async () => {
    const gate = createPart2ChannelGate(
      ports({
        evaluateInternalAccess: async () => {
          throw new Error("m39 down");
        },
      }),
    );
    const allowed = await gate.allowedUserIds({
      organizationId: ORG,
      patientId: PATIENT,
      userIds: ["u_named"],
    });
    expect(allowed.size).toBe(0);
  });

  it("propagates an unreadable privacy flag read (the caller must not guess 'not SUD')", async () => {
    const gate = createPart2ChannelGate(
      ports({
        privacyFlags: async () => {
          throw new Error("m5 down");
        },
      }),
    );
    await expect(
      gate.allowedUserIds({ organizationId: ORG, patientId: PATIENT, userIds: ["u_named"] }),
    ).rejects.toThrow("m5 down");
  });

  it("an empty candidate list needs no lookups", async () => {
    const gate = createPart2ChannelGate(
      ports({
        privacyFlags: async () => {
          throw new Error("must not be called");
        },
      }),
    );
    const allowed = await gate.allowedUserIds({
      organizationId: ORG,
      patientId: PATIENT,
      userIds: [],
    });
    expect(allowed.size).toBe(0);
  });

  it("allowAllPart2ChannelGate admits every candidate (test/slice wiring only)", async () => {
    const allowed = await allowAllPart2ChannelGate.allowedUserIds({
      organizationId: ORG,
      patientId: PATIENT,
      userIds: ["a", "b"],
    });
    expect([...allowed]).toEqual(["a", "b"]);
  });
});
