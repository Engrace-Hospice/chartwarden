// Slice 4 — the prescriber's own confirmation of the physician record a roster administrator linked them to. The administrator's link
// says who the member is; the DoseSpot enrolment sends that record's NPI and name, so the member confirms it, shown the name and NPI,
// from their own account, pinned to the link and NPI they were shown. Synthetic NPIs and invented names only.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { createPractitionerLinkService } from "./practitioner-link";
import {
  type NppesDirectoryPort,
  type PractitionerDirectoryPort,
  createPractitionerProfileSource,
} from "./practitioner-profile";
import type { RosterRow, RosterStore } from "./prescriber-enrollment";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "33333333-3333-4333-8333-333333333333";
const SOMEONE_ELSE = "44444444-4444-4444-8444-444444444444";
const MDM = "55555555-5555-4555-8555-555555555555";
const OTHER_MDM = "66666666-6666-4666-8666-666666666666";
const NPI = "1234567893"; // synthetic, passes the check digit
const RECORD = { identifierValue: NPI, firstName: "Orrin", lastName: "Delacroix" };

function build(
  opts: {
    row?: Partial<RosterRow> | null;
    record?: { status: string; canonical: Partial<typeof RECORD> } | null;
    nppesLastName?: string;
  } = {},
) {
  let roster: RosterRow | null =
    opts.row === null
      ? null
      : {
          id: "roster-1",
          membershipId: ME,
          dosespotPrescriberId: null,
          revokedAt: null,
          vendorEnrollmentRequestedAt: null,
          npi: null,
          externalPhysicianMdmId: MDM,
          linkConfirmedMdmId: null,
          linkConfirmedNpi: null,
          linkConfirmedByMembershipId: null,
          linkedByMembershipId: null,
          ...opts.row,
        };
  const audits: {
    eventType: string;
    resourceId: string;
    changedFields: readonly string[];
    detail?: unknown;
  }[] = [];
  const confirmed: { by: string; mdmId: string; npi: string }[] = [];
  const store = {
    rosterRow: async (_org: string, membershipId: string) =>
      roster && roster.membershipId === membershipId ? roster : null,
    async confirmLink(
      _org: string,
      membershipId: string,
      input: { mdmId: string; npi: string; at: Date },
    ) {
      if (!roster || roster.membershipId !== membershipId) return null;
      if (roster.revokedAt !== null || roster.externalPhysicianMdmId !== input.mdmId) return null;
      confirmed.push({ by: membershipId, mdmId: input.mdmId, npi: input.npi });
      roster = {
        ...roster,
        linkConfirmedMdmId: input.mdmId,
        linkConfirmedNpi: input.npi,
        linkConfirmedByMembershipId: membershipId,
      };
      return roster;
    },
  } as unknown as RosterStore;
  const directory: PractitionerDirectoryPort = {
    resolvePhysician: async () =>
      opts.record === null
        ? null
        : {
            status: opts.record?.status ?? "active",
            canonical: { ...RECORD, ...opts.record?.canonical },
          },
  };
  const nppes: NppesDirectoryPort = {
    getByNpi: async () => ({
      enumerationType: "NPI-1",
      status: "active",
      basic: { lastName: opts.nppesLastName ?? "DELACROIX" },
    }),
  };
  const service = createPractitionerLinkService({
    inTx: async (_o, _u, fn) => fn(store, {} as DbClient),
    directory,
    profiles: createPractitionerProfileSource({ directory, nppes }),
    audit: {
      record: async (_tx, entry) => {
        audits.push({
          eventType: entry.eventType,
          resourceId: entry.resourceId,
          changedFields: entry.changedFields,
          detail: entry.detail,
        });
      },
    },
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  });
  return {
    service,
    audits,
    confirmed,
    roster: () => roster,
    setRoster: (r: RosterRow | null) => {
      roster = r;
    },
  };
}
const actor = (membershipId = ME) => ({ organizationId: ORG, userId: "u-1", membershipId });
const pinned = { externalPhysicianMdmId: MDM, npi: NPI };

describe("what the prescriber is shown", () => {
  it("their linked record's name and NPI, and that it is not confirmed yet", async () => {
    const h = build();
    expect(await h.service.view(actor())).toEqual({
      membershipId: ME,
      linked: true,
      externalPhysicianMdmId: MDM,
      physician: { firstName: "Orrin", lastName: "Delacroix", npi: NPI },
      confirmed: false,
    });
  });

  it("nothing to confirm for a member who is not on the roster, whose row links no record, or who was revoked", async () => {
    for (const row of [
      null,
      { externalPhysicianMdmId: null },
      { revokedAt: new Date() },
    ] as const) {
      expect(await build({ row }).service.view(actor())).toMatchObject({
        linked: false,
        physician: null,
        confirmed: false,
      });
    }
  });

  it("a record that is not active is shown as no physician: there is nothing to confirm", async () => {
    const h = build({ record: { status: "deactivated", canonical: {} } });
    expect(await h.service.view(actor())).toMatchObject({
      linked: true,
      physician: null,
      confirmed: false,
    });
  });

  it("is confirmed only while the confirmation matches the CURRENT link and the record's CURRENT NPI", async () => {
    const h = build({
      row: { linkConfirmedMdmId: MDM, linkConfirmedNpi: NPI, linkConfirmedByMembershipId: ME },
    });
    expect((await h.service.view(actor())).confirmed).toBe(true);
    h.setRoster({ ...(h.roster() as RosterRow), externalPhysicianMdmId: OTHER_MDM }); // re-linked: the old confirmation is no longer this link's
    expect((await h.service.view(actor())).confirmed).toBe(false);
    const changedNpi = build({
      row: {
        linkConfirmedMdmId: MDM,
        linkConfirmedNpi: "1000000004",
        linkConfirmedByMembershipId: ME,
      },
    });
    expect((await changedNpi.service.view(actor())).confirmed).toBe(false); // the record's NPI is no longer the one they confirmed
    // a confirmation recorded as made by SOMEONE ELSE does not count, whatever else matches
    const byAnother = build({
      row: {
        linkConfirmedMdmId: MDM,
        linkConfirmedNpi: NPI,
        linkConfirmedByMembershipId: SOMEONE_ELSE,
      },
    });
    expect((await byAnother.service.view(actor())).confirmed).toBe(false);
  });
});

describe("confirming", () => {
  it("is refused (409 DOSESPOT_LINK_SELF_CONFIRM) when the member made the link themself; another linker's link is confirmable", async () => {
    const self = build({ row: { linkedByMembershipId: ME } });
    await expect(self.service.confirm(actor(), pinned)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_LINK_SELF_CONFIRM",
    });
    expect(self.confirmed).toEqual([]);
    expect(self.audits).toEqual([]);
    const byAnother = build({ row: { linkedByMembershipId: SOMEONE_ELSE } });
    expect((await byAnother.service.confirm(actor(), pinned)).confirmed).toBe(true);
    // and a link confirmed by its own maker (written around the service) is never shown as confirmed
    const both = build({
      row: {
        linkedByMembershipId: ME,
        linkConfirmedMdmId: MDM,
        linkConfirmedNpi: NPI,
        linkConfirmedByMembershipId: ME,
      },
    });
    expect((await both.service.view(actor())).confirmed).toBe(false);
  });

  it("records the confirmation for the member's OWN row, and audits ids only (no NPI, no name)", async () => {
    const h = build();
    const out = await h.service.confirm(actor(), pinned);
    expect(out.confirmed).toBe(true);
    expect(h.confirmed).toEqual([{ by: ME, mdmId: MDM, npi: NPI }]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      eventType: "m12.dosespot_clinic.prescriber_link_confirmed",
      resourceId: "roster-1",
      changedFields: ["linkConfirmation"],
      detail: { physicianMdmId: MDM },
    });
    const logged = JSON.stringify(h.audits);
    expect(logged).not.toContain(NPI);
    expect(logged).not.toContain("Orrin");
    expect(logged).not.toContain("Delacroix");
  });

  it("is pinned to the link and NPI the prescriber was shown: a link that moved, or a record whose NPI changed, is a 409 and confirms nothing", async () => {
    const moved = build({ row: { externalPhysicianMdmId: OTHER_MDM } });
    await expect(moved.service.confirm(actor(), pinned)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_ROSTER_CHANGED",
    });
    const stale = build();
    await expect(
      stale.service.confirm(actor(), { externalPhysicianMdmId: MDM, npi: "1000000004" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DOSESPOT_ROSTER_CHANGED" });
    expect(moved.confirmed).toEqual([]);
    expect(stale.confirmed).toEqual([]);
  });

  it("a re-link between reading and writing is refused at the write (the update matches the link it was pinned to)", async () => {
    const h = build();
    h.setRoster({ ...(h.roster() as RosterRow), externalPhysicianMdmId: OTHER_MDM });
    await expect(h.service.confirm(actor(), pinned)).rejects.toMatchObject({
      code: "DOSESPOT_ROSTER_CHANGED",
    });
    expect(h.confirmed).toEqual([]);
  });

  it("only the member can confirm their own link: someone else has no roster row to confirm, and the member's row is untouched", async () => {
    const h = build();
    await expect(h.service.confirm(actor(SOMEONE_ELSE), pinned)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_PRACTITIONER_NOT_LINKED",
    });
    expect(h.confirmed).toEqual([]);
    expect(h.roster()?.linkConfirmedMdmId).toBeNull();
  });

  it("refuses a member who is not on the roster, a revoked one, a row that links nothing, and a record that is not active (nothing is confirmed)", async () => {
    for (const row of [
      null,
      { revokedAt: new Date() },
      { externalPhysicianMdmId: null },
    ] as const) {
      const h = build({ row });
      await expect(h.service.confirm(actor(), pinned)).rejects.toMatchObject({
        code: "DOSESPOT_PRACTITIONER_NOT_LINKED",
      });
      expect(h.confirmed).toEqual([]);
    }
    const inactive = build({ record: { status: "deactivated", canonical: {} } });
    await expect(inactive.service.confirm(actor(), pinned)).rejects.toMatchObject({
      code: "DOSESPOT_PRACTITIONER_NOT_ACTIVE",
    });
  });

  it("will not let the prescriber confirm a record NPPES contradicts", async () => {
    const h = build({ nppesLastName: "SOMEONEELSE" });
    await expect(h.service.confirm(actor(), pinned)).rejects.toMatchObject({
      code: "DOSESPOT_NPPES_MISMATCH",
    });
    expect(h.confirmed).toEqual([]);
  });
});
