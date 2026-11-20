// apps/backend/__tests__/m15-aide-supervision-roster.test.ts — the two pure halves of the Aide POC supervisory-visit
// pickers: M15's split of the reader's rows into `{ aides, supervisors }`, and M3's reduction of live grants to the
// staff whose EFFECTIVE location reach covers the plan's location. The tenant / RLS / audit proof is the live suite
// (`m15-aide-supervision-roster.live.test.ts`); this file pins the rules that need no database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LiveGrantRow,
  reduceToStaff,
} from "../src/modules/03-authorization/staff-at-location-for-org";
import {
  AIDE_ROLE_KEYS,
  AIDE_SUPERVISOR_ROLE_KEYS,
  assembleAideSupervisionRoster,
} from "../src/modules/15-discipline-care-plans/routes/aide-supervision-roster";

const ORG = "11111111-1111-4111-8111-111111111111";
const LOC_MAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const LOC_OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const M_AIDE = "bbbbbbbb-0000-4000-8000-000000000001";
const M_RN = "bbbbbbbb-0000-4000-8000-000000000002";
const M_NAMELESS = "cccccccc-1111-4111-8111-111111111111";

describe("assembleAideSupervisionRoster", () => {
  it("offers chha as the aide and rn / rn_case_manager as supervisors, and nobody else", () => {
    const roster = assembleAideSupervisionRoster([
      { membershipId: M_AIDE, displayName: "Avery Aide", roleKey: "chha" },
      { membershipId: M_RN, displayName: "Riley Nurse", roleKey: "rn" },
      { membershipId: "m-cm", displayName: "Casey Manager", roleKey: "rn_case_manager" },
      { membershipId: "m-lpn", displayName: "Lee LPN", roleKey: "lpn" },
      { membershipId: "m-msw", displayName: "Max SW", roleKey: "msw" },
    ]);
    expect(roster.aides.map((m) => m.roleKey)).toEqual(["chha"]);
    expect(roster.supervisors.map((m) => m.roleKey).sort()).toEqual(["rn", "rn_case_manager"]);
    expect(AIDE_ROLE_KEYS).toEqual(["chha"]);
    expect(AIDE_SUPERVISOR_ROLE_KEYS).toEqual(["rn", "rn_case_manager"]);
  });

  it("lists a member once even when they hold both supervisor roles, ordered by name", () => {
    const roster = assembleAideSupervisionRoster([
      { membershipId: "m-z", displayName: "Zed Nurse", roleKey: "rn" },
      { membershipId: "m-a", displayName: "Ann Nurse", roleKey: "rn_case_manager" },
      { membershipId: "m-a", displayName: "Ann Nurse", roleKey: "rn" },
    ]);
    expect(roster.supervisors.map((m) => m.displayName)).toEqual(["Ann Nurse", "Zed Nurse"]);
  });

  it("labels a member with no name on file by a short id, never leaving the label blank", () => {
    const roster = assembleAideSupervisionRoster([
      { membershipId: M_NAMELESS, displayName: null, roleKey: "chha" },
      { membershipId: "m-blank", displayName: "   ", roleKey: "chha" },
    ]);
    expect(roster.aides.map((m) => m.displayName).sort()).toEqual([
      "Member cccccccc",
      "Member m-blank",
    ]);
  });

  it("emits exactly membershipId, displayName and roleKey per member", () => {
    const roster = assembleAideSupervisionRoster([
      {
        membershipId: M_AIDE,
        displayName: "Avery Aide",
        roleKey: "chha",
        email: "avery@example.test",
      } as never,
    ]);
    expect(Object.keys(roster.aides[0] ?? {}).sort()).toEqual([
      "displayName",
      "membershipId",
      "roleKey",
    ]);
  });
});

const grant = (over: Partial<LiveGrantRow> & Pick<LiveGrantRow, "membershipId" | "roleKey">) =>
  ({
    defaultProviderEntityId: null,
    defaultLocationIds: [LOC_MAIN],
    name: "Pat Staff",
    roleOrganizationId: ORG,
    roleCategory: "clinical_staff",
    scope: {},
    ...over,
  }) satisfies LiveGrantRow;

describe("reduceToStaff — effective location reach", () => {
  const keys = ["chha", "rn", "rn_case_manager"];

  it("includes a member whose siting contains the plan location", () => {
    const rows = reduceToStaff([grant({ membershipId: M_AIDE, roleKey: "chha" })], LOC_MAIN, keys);
    expect(rows).toEqual([{ membershipId: M_AIDE, displayName: "Pat Staff", roleKey: "chha" }]);
  });

  it("excludes a member sited elsewhere or with no siting at all (an empty reach contains no location)", () => {
    expect(
      reduceToStaff(
        [grant({ membershipId: M_AIDE, roleKey: "chha", defaultLocationIds: [LOC_OTHER] })],
        LOC_MAIN,
        keys,
      ),
    ).toEqual([]);
    expect(
      reduceToStaff(
        [grant({ membershipId: M_AIDE, roleKey: "chha", defaultLocationIds: [] })],
        LOC_MAIN,
        keys,
      ),
    ).toEqual([]);
  });

  it("honours a grant scope that narrows the role to another location", () => {
    const narrowed = grant({
      membershipId: M_RN,
      roleKey: "rn",
      defaultLocationIds: [LOC_MAIN, LOC_OTHER],
      scope: { locationIds: [LOC_OTHER] },
    });
    expect(reduceToStaff([narrowed], LOC_MAIN, keys)).toEqual([]);
    expect(reduceToStaff([narrowed], LOC_OTHER, keys)).toHaveLength(1);
  });

  it("takes the union over ALL live roles: another unscoped role restores the default reach", () => {
    const rows = reduceToStaff(
      [
        grant({
          membershipId: M_RN,
          roleKey: "rn",
          defaultLocationIds: [LOC_MAIN, LOC_OTHER],
          scope: { locationIds: [LOC_OTHER] },
        }),
        grant({
          membershipId: M_RN,
          roleKey: "clinician",
          defaultLocationIds: [LOC_MAIN, LOC_OTHER],
        }),
      ],
      LOC_MAIN,
      keys,
    );
    expect(rows.map((r) => r.roleKey)).toEqual(["rn"]);
  });

  it("returns only the requested roles of a member, not their other grants", () => {
    const rows = reduceToStaff(
      [
        grant({ membershipId: M_RN, roleKey: "rn" }),
        grant({ membershipId: M_RN, roleKey: "clinician" }),
      ],
      LOC_MAIN,
      keys,
    );
    expect(rows.map((r) => r.roleKey)).toEqual(["rn"]);
  });

  it("ignores a tenant-owned row squatting a reserved platform key", () => {
    const rows = reduceToStaff(
      [
        grant({
          membershipId: M_AIDE,
          roleKey: "platform_owner",
          roleCategory: "platform_staff",
        }),
      ],
      LOC_MAIN,
      ["platform_owner"],
    );
    expect(rows).toEqual([]);
  });

  it("reaches nothing when every live grant scope is unreadable (fail closed)", () => {
    const rows = reduceToStaff(
      [grant({ membershipId: M_AIDE, roleKey: "chha", scope: { patientIds: ["x"] } })],
      LOC_MAIN,
      keys,
    );
    expect(rows).toEqual([]);
  });
});

describe("composition root", () => {
  it("binds M3's staff reader into the M15 read service (an unbound port serves an empty roster)", () => {
    const root = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    expect(root).toMatch(/buildDrizzleM15ReadService\(dbHandle\.db, \{[^}]*aideRoster:/s);
    expect(root).toContain("staffAtLocationForOrg(dbHandle.db, query)");
  });
});
