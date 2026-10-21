// Attendance trust (0286) — the pure planner matrix + the role-key -> discipline mapping + the quorum consequences.
import {
  IDG_ATTENDANCE_DISCIPLINES,
  IDG_ATTENDANCE_DISCIPLINES_BY_ROLE_KEY,
  IDG_REQUIRED_QUORUM,
  attendableDisciplinesForRoleKeys,
  evaluateQuorum,
} from "@wardenx/idg";
import { ChartWardenError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type AttendancePlanInput,
  planAttendanceRecord,
} from "../src/modules/14-idg/routes/attendance-authority";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const base = (over: Partial<AttendancePlanInput>): AttendancePlanInput => ({
  actorMembershipId: ME,
  actorIsCoordinator: false,
  targetMembershipId: ME,
  discipline: "rn_case_manager",
  coordinatorAttested: false,
  target: { kind: "held", disciplines: ["rn_case_manager"] },
  ...over,
});

const refusal = (input: AttendancePlanInput): { code: string; status: number } => {
  try {
    planAttendanceRecord(input);
  } catch (err) {
    if (err instanceof ChartWardenError) return { code: err.code, status: err.statusCode };
    throw err;
  }
  throw new Error("expected a refusal");
};

describe("planAttendanceRecord — the validation matrix", () => {
  it("self + discipline held => validated (not attested)", () => {
    expect(planAttendanceRecord(base({}))).toEqual({ disciplineAttested: false });
  });
  it("attendee recording someone else => 403 ATTENDANCE_SELF_ONLY (even for a held discipline)", () => {
    expect(refusal(base({ targetMembershipId: OTHER }))).toEqual({
      code: "ATTENDANCE_SELF_ONLY",
      status: 403,
    });
  });
  it("attendee self + discipline NOT held => 422 DISCIPLINE_NOT_HELD", () => {
    expect(refusal(base({ discipline: "chaplain" }))).toEqual({
      code: "DISCIPLINE_NOT_HELD",
      status: 422,
    });
  });
  it("attendee claiming coordinatorAttested => 403 ATTESTATION_REQUIRES_COORDINATOR", () => {
    expect(refusal(base({ discipline: "chaplain", coordinatorAttested: true }))).toEqual({
      code: "ATTESTATION_REQUIRES_COORDINATOR",
      status: 403,
    });
  });
  it("a discipline outside the closed vocabulary => 422 UNKNOWN_DISCIPLINE (for everyone)", () => {
    expect(refusal(base({ discipline: "wizard" })).code).toBe("UNKNOWN_DISCIPLINE");
    expect(
      refusal(base({ actorIsCoordinator: true, targetMembershipId: OTHER, discipline: "Rn" })).code,
    ).toBe("UNKNOWN_DISCIPLINE");
  });
  it("coordinator + other + held => validated", () => {
    expect(
      planAttendanceRecord(base({ actorIsCoordinator: true, targetMembershipId: OTHER })),
    ).toEqual({ disciplineAttested: false });
  });
  it("coordinator + other + NOT held + no attestation => 422 DISCIPLINE_NOT_HELD", () => {
    expect(
      refusal(
        base({
          actorIsCoordinator: true,
          targetMembershipId: OTHER,
          discipline: "msw",
          target: { kind: "held", disciplines: ["rn_case_manager"] },
        }),
      ),
    ).toEqual({ code: "DISCIPLINE_NOT_HELD", status: 422 });
  });
  it("coordinator + other + NOT held + attested => stored FLAGGED", () => {
    expect(
      planAttendanceRecord(
        base({
          actorIsCoordinator: true,
          targetMembershipId: OTHER,
          discipline: "msw",
          coordinatorAttested: true,
          target: { kind: "held", disciplines: [] },
        }),
      ),
    ).toEqual({ disciplineAttested: true });
  });
  it("attested but the discipline IS held => not flagged (attestation is only an override)", () => {
    expect(
      planAttendanceRecord(
        base({ actorIsCoordinator: true, targetMembershipId: OTHER, coordinatorAttested: true }),
      ),
    ).toEqual({ disciplineAttested: false });
  });
  it("coordinator self-attesting an unheld discipline => 403 ATTESTATION_SELF_FORBIDDEN; self + held is fine", () => {
    expect(
      refusal(
        base({
          actorIsCoordinator: true,
          discipline: "chaplain",
          coordinatorAttested: true,
        }),
      ),
    ).toEqual({ code: "ATTESTATION_SELF_FORBIDDEN", status: 403 });
    expect(planAttendanceRecord(base({ actorIsCoordinator: true }))).toEqual({
      disciplineAttested: false,
    });
  });
  it("target unknown => 422; roles unresolvable => 503 (fail closed, even with an attestation)", () => {
    expect(
      refusal(
        base({
          actorIsCoordinator: true,
          targetMembershipId: OTHER,
          target: { kind: "not_found" },
        }),
      ),
    ).toEqual({ code: "ATTENDANCE_MEMBERSHIP_NOT_FOUND", status: 422 });
    expect(
      refusal(
        base({
          actorIsCoordinator: true,
          targetMembershipId: OTHER,
          coordinatorAttested: true,
          target: { kind: "unavailable" },
        }),
      ),
    ).toEqual({ code: "ATTENDANCE_AUTHORITY_UNAVAILABLE", status: 503 });
  });
});

describe("attendableDisciplinesForRoleKeys", () => {
  it("maps the seeded personas' role keys onto the quorum seat strings", () => {
    expect(attendableDisciplinesForRoleKeys(["rn", "rn_case_manager"])).toEqual([
      "rn_case_manager",
    ]);
    expect(
      attendableDisciplinesForRoleKeys(["md", "hospice_physician", "medical_director"]),
    ).toEqual(["hospice_physician", "medical_director"]);
    expect(attendableDisciplinesForRoleKeys(["msw"])).toEqual(["msw"]);
    expect(attendableDisciplinesForRoleKeys(["chaplain"])).toEqual(["chaplain"]);
    expect(attendableDisciplinesForRoleKeys(["chha"])).toEqual(["hospice_aide"]);
  });
  it("admins hold only `administrator`; unmapped keys confer nothing", () => {
    expect(attendableDisciplinesForRoleKeys(["org_admin"])).toEqual(["administrator"]);
    expect(attendableDisciplinesForRoleKeys(["clinician", "auditor", "platform_owner"])).toEqual(
      [],
    );
  });
  it("every mapped discipline is in the closed vocabulary, and every quorum seat is reachable", () => {
    for (const ds of Object.values(IDG_ATTENDANCE_DISCIPLINES_BY_ROLE_KEY)) {
      for (const d of ds) expect(IDG_ATTENDANCE_DISCIPLINES).toContain(d);
    }
    for (const slot of IDG_REQUIRED_QUORUM) {
      for (const seat of slot.role.split("|")) expect(IDG_ATTENDANCE_DISCIPLINES).toContain(seat);
    }
  });
});

describe("quorum consequences", () => {
  it("`administrator` never satisfies a quorum seat", () => {
    expect(evaluateQuorum(["administrator", "administrator"]).met).toBe(false);
    expect(evaluateQuorum(["administrator"]).missingDisciplines).toHaveLength(
      IDG_REQUIRED_QUORUM.length,
    );
  });
  it("the four seats validated from real role keys make quorum; medical_director alone fills the physician seat", () => {
    const present = [["rn"], ["md", "medical_director"], ["msw"], ["chaplain"]].flatMap((keys) =>
      attendableDisciplinesForRoleKeys(keys),
    );
    expect(evaluateQuorum(present).met).toBe(true);
    expect(evaluateQuorum(["rn_case_manager", "msw", "chaplain", "medical_director"]).met).toBe(
      true,
    );
  });
});
