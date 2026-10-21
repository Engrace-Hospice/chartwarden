// GAP-091 follow-up — (1) the M30-specific org-wide READ arm (spec §6.5 / §6.6 ✓ cells) for
// qapi_coordinator / infection_control_lead, never applied to writes; (2) incident LIFECYCLE writes are
// caseload-scoped at the service layer with an own-record arm (reporter / triager / assigned investigator).
import { NotFoundError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { type M30WriteActor, m30SystemWriteActor } from "../routes/actor";
import { incidentOwnedBy } from "../routes/incident-ownership";
import {
  type CaseloadLookup,
  type QualityReadSurface,
  hasM30OrgReadScope,
  resolveQualityPatientScope,
} from "../routes/patient-scope";
import { buildDrizzleM30WriteService } from "../routes/write-service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const IN_SCOPE = "22222222-2222-4222-8222-222222222221";
const OUT_OF_SCOPE = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const INCIDENT_ID = "55555555-5555-4555-8555-555555555555";

const readActor = (roles: readonly string[]) => ({ organizationId: ORG, userId: "u1", roles });
const caseload =
  (ids: readonly string[]): (() => CaseloadLookup) =>
  () => ({
    caseloadPatientIds: async () => ids,
  });
const throwingSeam = (): CaseloadLookup => {
  throw new Error("seam not bound");
};

// The exact ✓ cells of spec §6.5 (incident.read) / §6.6 (mortality.read, infection.read).
const MATRIX: ReadonlyArray<readonly [string, QualityReadSurface, boolean]> = [
  ["qapi_coordinator", "incident", true],
  ["qapi_coordinator", "mortality", true],
  ["qapi_coordinator", "infection", true],
  ["infection_control_lead", "incident", true],
  ["infection_control_lead", "mortality", false], // mortality.read ICL = ✗
  ["infection_control_lead", "infection", true],
  ["rn_case_manager", "incident", false], // ◎ caseload
  ["rn_case_manager", "infection", false],
];

describe("M30 org-wide READ arm — role x surface matrix", () => {
  for (const [role, surface, expected] of MATRIX) {
    it(`${role} on ${surface} read => ${expected ? "org" : "caseload"}`, async () => {
      expect(hasM30OrgReadScope([role], surface)).toBe(expected);
      const scope = await resolveQualityPatientScope(
        readActor([role]),
        caseload([IN_SCOPE]),
        surface,
      );
      expect(scope).toEqual(
        expected ? { kind: "org" } : { kind: "caseload", patientIds: [IN_SCOPE] },
      );
    });
  }

  it("never grants the arm when no read surface is passed (the write path)", async () => {
    const scope = await resolveQualityPatientScope(
      readActor(["qapi_coordinator", "infection_control_lead"]),
      caseload([IN_SCOPE]),
    );
    expect(scope).toEqual({ kind: "caseload", patientIds: [IN_SCOPE] });
  });

  it("the arm does not consult the seam; a non-arm role with a throwing seam fails closed", async () => {
    expect(
      await resolveQualityPatientScope(readActor(["qapi_coordinator"]), throwingSeam, "incident"),
    ).toEqual({ kind: "org" });
    expect(
      await resolveQualityPatientScope(readActor(["rn_case_manager"]), throwingSeam, "incident"),
    ).toEqual({ kind: "caseload", patientIds: [] });
    // ICL has no mortality arm, so a seam failure there denies.
    expect(
      await resolveQualityPatientScope(
        readActor(["infection_control_lead"]),
        throwingSeam,
        "mortality",
      ),
    ).toEqual({ kind: "caseload", patientIds: [] });
  });

  it("is keyed on the exact role string, not a substring or look-alike", () => {
    expect(hasM30OrgReadScope(["qapi_coordinator_assistant", "QAPI_COORDINATOR"], "incident")).toBe(
      false,
    );
    expect(hasM30OrgReadScope([], "incident")).toBe(false);
  });
});

describe("incidentOwnedBy", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    reportedByMembershipId: OTHER,
    triagedByMembershipId: null,
    kindData: {},
    ...over,
  });
  it("matches reporter, triager and the assigned investigator only", () => {
    expect(incidentOwnedBy(row({ reportedByMembershipId: ME }), ME)).toBe(true);
    expect(incidentOwnedBy(row({ triagedByMembershipId: ME }), ME)).toBe(true);
    expect(incidentOwnedBy(row({ kindData: { _m30: { assignedToMembershipId: ME } } }), ME)).toBe(
      true,
    );
    expect(incidentOwnedBy(row(), ME)).toBe(false);
    expect(
      incidentOwnedBy(row({ kindData: { _m30: { assignedToMembershipId: OTHER } } }), ME),
    ).toBe(false);
    expect(incidentOwnedBy(row(), undefined)).toBe(false);
    expect(incidentOwnedBy(row({ kindData: null }), ME)).toBe(false);
  });
});

// ── lifecycle writes are scoped by loadIncident ───────────────────────────────────────────────────────

const incidentRow = (over: Record<string, unknown> = {}) => ({
  id: INCIDENT_ID,
  organizationId: ORG,
  patientId: OUT_OF_SCOPE,
  reportedByMembershipId: OTHER,
  triagedByMembershipId: null,
  kindData: {},
  ...over,
});
/** A db whose only working statement is the point-load; anything past it throws a non-NotFound error. */
const dbReturning = (row: unknown) => ({
  transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      execute: async () => [],
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    }),
});
const buildWith = (
  row: unknown,
  scope: "throw" | { kind: "org" } | { kind: "caseload"; patientIds: readonly string[] },
) =>
  buildDrizzleM30WriteService(dbReturning(row) as never, {
    patientScope: async () => {
      if (scope === "throw") throw new Error("seam down");
      return scope;
    },
  });
const user = (roles: readonly string[]): M30WriteActor => ({
  organizationId: ORG,
  userId: "u1",
  roles,
  membershipId: ME,
});

const LIFECYCLE: ReadonlyArray<
  readonly [string, (s: ReturnType<typeof buildWith>, a: M30WriteActor) => Promise<unknown>]
> = [
  ["updateIncident", (s, a) => s.updateIncident(a, INCIDENT_ID, {} as never)],
  ["submitIncident", (s, a) => s.submitIncident(a, INCIDENT_ID)],
  ["triageIncident", (s, a) => s.triageIncident(a, INCIDENT_ID, {} as never)],
  [
    "addIncidentInvestigationNote",
    (s, a) => s.addIncidentInvestigationNote(a, INCIDENT_ID, {} as never),
  ],
  ["openIncidentInvestigation", (s, a) => s.openIncidentInvestigation(a, INCIDENT_ID, {} as never)],
  ["resolveIncident", (s, a) => s.resolveIncident(a, INCIDENT_ID, {} as never)],
  ["closeIncident", (s, a) => s.closeIncident(a, INCIDENT_ID)],
  ["reopenIncident", (s, a) => s.reopenIncident(a, INCIDENT_ID, {} as never)],
];

const outcome = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
};
const caseloadScope = { kind: "caseload", patientIds: [IN_SCOPE] } as const;

describe("incident lifecycle writes are caseload-scoped at the service (loadIncident)", () => {
  for (const [name, call] of LIFECYCLE) {
    describe(name, () => {
      it("404s an out-of-caseload patient, even for qapi_coordinator / infection_control_lead (read arm is read-only)", async () => {
        for (const role of ["rn", "qapi_coordinator", "infection_control_lead"]) {
          const err = await outcome(call(buildWith(incidentRow(), caseloadScope), user([role])));
          expect(err, `${role}`).toBeInstanceOf(NotFoundError);
        }
      });
      it("denies when the caseload seam throws", async () => {
        const err = await outcome(call(buildWith(incidentRow(), "throw"), user(["rn"])));
        expect(err).toBeInstanceOf(NotFoundError);
      });
      it("is not refused for an in-caseload patient, an org scope, a patient-less row, or an own-record arm", async () => {
        const allowed = [
          buildWith(incidentRow({ patientId: IN_SCOPE }), caseloadScope),
          buildWith(incidentRow(), { kind: "org" }),
          buildWith(incidentRow({ patientId: null }), caseloadScope),
          buildWith(incidentRow({ reportedByMembershipId: ME }), caseloadScope),
          buildWith(incidentRow({ triagedByMembershipId: ME }), caseloadScope),
          buildWith(
            incidentRow({ kindData: { _m30: { assignedToMembershipId: ME } } }),
            caseloadScope,
          ),
        ];
        for (const svc of allowed) {
          expect(await outcome(call(svc, user(["rn"])))).not.toBeInstanceOf(NotFoundError);
        }
      });
      it("keeps a typed system actor working", async () => {
        const system = m30SystemWriteActor({ organizationId: ORG, userId: ME, membershipId: ME });
        expect(await outcome(call(buildWith(incidentRow(), "throw"), system))).not.toBeInstanceOf(
          NotFoundError,
        );
      });
    });
  }
});
