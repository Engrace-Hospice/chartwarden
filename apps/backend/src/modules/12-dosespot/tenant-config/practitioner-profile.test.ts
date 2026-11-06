// Slice 4 — who a DoseSpot enrolment says the prescriber is. The NPI and legal name come from the practitioner record the roster
// links the membership to, never from the caller; NPPES's public directory is the cross-check. Synthetic NPIs and names only.
import { describe, expect, it } from "vitest";
import {
  type NppesDirectoryPort,
  type PractitionerDirectoryPort,
  createPractitionerProfileSource,
  isValidNpi,
} from "./practitioner-profile";

const ORG = "11111111-1111-4111-8111-111111111111";
const MDM = "55555555-5555-4555-8555-555555555555";
const NPI = "1234567893"; // synthetic, passes the check digit

type Record = {
  status: string;
  canonical: { identifierValue: string | null; firstName: string; lastName: string };
};
type Nppes = { enumerationType: string; status: string; basic: unknown };
const activeRecord = (over: Partial<Record["canonical"]> = {}): Record => ({
  status: "active",
  canonical: { identifierValue: NPI, firstName: "Ada", lastName: "Lovelace", ...over },
});
const nppesRow = (over: Partial<Nppes> = {}): Nppes => ({
  enumerationType: "NPI-1",
  status: "active",
  basic: { firstName: "ADA", lastName: "LOVELACE" },
  ...over,
});

function sourceOver(record: Record | null, nppes: Nppes | null) {
  const asked: string[] = [];
  const directory: PractitionerDirectoryPort = {
    resolvePhysician: async (_org, id) => {
      asked.push(`physician:${id}`);
      return record;
    },
  };
  const directoryNppes: NppesDirectoryPort = {
    getByNpi: async ({ npi }) => {
      asked.push(`nppes:${npi}`);
      return nppes;
    },
  };
  return { source: createPractitionerProfileSource({ directory, nppes: directoryNppes }), asked };
}
const profileFor = (
  record: Record | null,
  nppes: Nppes | null,
  over: { physicianMdmId?: string | null; environment?: string } = {},
) =>
  sourceOver(record, nppes).source.profileFor({
    organizationId: ORG,
    physicianMdmId: over.physicianMdmId === undefined ? MDM : over.physicianMdmId,
    environment: over.environment ?? "sandbox",
  });

describe("isValidNpi", () => {
  it("checks length and the Luhn digit with the 80840 prefix", () => {
    expect(isValidNpi(NPI)).toBe(true);
    for (const bad of ["1234567890", "123456789", "12345678931", "abcdefghij", ""]) {
      expect(isValidNpi(bad)).toBe(false);
    }
  });
});

describe("the practitioner profile", () => {
  it("is the linked record's NPI and name, confirmed by NPPES", async () => {
    const { source, asked } = sourceOver(activeRecord({ firstName: " Ada " }), nppesRow());
    const profile = await source.profileFor({
      organizationId: ORG,
      physicianMdmId: MDM,
      environment: "production",
    });
    expect(profile).toEqual({
      npi: NPI,
      firstName: "Ada",
      lastName: "Lovelace",
      nppesVerified: true,
    });
    expect(asked).toEqual([`physician:${MDM}`, `nppes:${NPI}`]);
  });

  it("a member the roster links to no physician record has no profile (409), and nothing is read", async () => {
    const { source, asked } = sourceOver(activeRecord(), nppesRow());
    await expect(
      source.profileFor({ organizationId: ORG, physicianMdmId: null, environment: "sandbox" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DOSESPOT_PRACTITIONER_NOT_LINKED" });
    expect(asked).toEqual([]);
  });

  it("refuses a record that is unknown or not active", async () => {
    for (const record of [
      null,
      { ...activeRecord(), status: "deactivated" },
      { ...activeRecord(), status: "provisional" },
    ]) {
      await expect(profileFor(record, nppesRow())).rejects.toMatchObject({
        statusCode: 409,
        code: "DOSESPOT_PRACTITIONER_NOT_ACTIVE",
      });
    }
  });

  it("refuses a record with no NPI on file (409) and one whose NPI fails the check digit (422), without asking NPPES", async () => {
    for (const identifierValue of [null, "", "  "]) {
      await expect(profileFor(activeRecord({ identifierValue }), nppesRow())).rejects.toMatchObject(
        {
          statusCode: 409,
          code: "DOSESPOT_PRACTITIONER_NPI_MISSING",
        },
      );
    }
    const { source, asked } = sourceOver(
      activeRecord({ identifierValue: "1234567890" }),
      nppesRow(),
    );
    await expect(
      source.profileFor({ organizationId: ORG, physicianMdmId: MDM, environment: "sandbox" }),
    ).rejects.toMatchObject({ statusCode: 422, code: "DOSESPOT_NPI_INVALID" });
    expect(asked).toEqual([`physician:${MDM}`]);
  });

  it("refuses a record with no legal name on file", async () => {
    for (const over of [{ firstName: "" }, { lastName: "  " }]) {
      await expect(profileFor(activeRecord(over), nppesRow())).rejects.toMatchObject({
        code: "DOSESPOT_PRACTITIONER_NAME_MISSING",
      });
    }
  });

  describe("cross-checked against NPPES", () => {
    it("refuses an NPI NPPES lists as an organization (NPI-2), or as deactivated", async () => {
      for (const over of [{ enumerationType: "NPI-2" }, { status: "deactivated" }]) {
        await expect(profileFor(activeRecord(), nppesRow(over))).rejects.toMatchObject({
          statusCode: 409,
          code: "DOSESPOT_NPPES_MISMATCH",
        });
      }
    });

    it("refuses a different surname, and an NPPES row that carries none", async () => {
      for (const basic of [{ lastName: "BABBAGE" }, {}, null, "LOVELACE"]) {
        await expect(profileFor(activeRecord(), nppesRow({ basic }))).rejects.toMatchObject({
          code: "DOSESPOT_NPPES_MISMATCH",
        });
      }
    });

    it("tolerates case, spacing, hyphens, apostrophes and accents in the surname, and the raw API's snake_case key", async () => {
      const cases: ReadonlyArray<readonly [string, unknown]> = [
        ["Lovelace", { lastName: "LOVELACE" }],
        ["O'Brien-Smith", { lastName: "OBRIEN SMITH" }],
        ["Núñez", { lastName: "NUNEZ" }],
        ["Lovelace", { last_name: "Lovelace" }],
      ];
      for (const [lastName, basic] of cases) {
        const profile = await profileFor(activeRecord({ lastName }), nppesRow({ basic }));
        expect(profile.nppesVerified).toBe(true);
      }
    });

    it("NPPES with no row: a sandbox registration proceeds flagged, a production one is refused", async () => {
      expect(await profileFor(activeRecord(), null, { environment: "sandbox" })).toEqual({
        npi: NPI,
        firstName: "Ada",
        lastName: "Lovelace",
        nppesVerified: false,
      });
      await expect(
        profileFor(activeRecord(), null, { environment: "production" }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "DOSESPOT_NPPES_UNVERIFIED",
      });
    });
  });
});
