// S1 PR E2b - the cosignature workflow for the request an AMENDING addendum opened (ADR-0114 VN-D30): who may cosign it (the §4.6 predicate reads the
// addendum too) and the route layer (one implementation, two subjects, literal paths). The workflow itself is proven live (m8-visit-note-draft-routes.live).
import type { AbacContext } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { buildEncounterAbacPredicates } from "../src/modules/08-encounters/abac-predicates";
import type { EncounterAbacResolver } from "../src/modules/08-encounters/routes/service";

const ORG = "00000000-0000-4000-8000-000000000001";
const ENCOUNTER = "00000000-0000-4000-8000-000000000004";
const ADDENDUM = "00000000-0000-4000-8000-0000000000ad";
const NOTE_AUTHOR = "membership-note-author";
const ADDENDUM_AUTHOR = "membership-addendum-author";
const COSIGNER = "membership-rn-cosigner";

const resolver: EncounterAbacResolver = {
  loadEncounter: async (_org, id) =>
    id === ENCOUNTER
      ? {
          encounterId: ENCOUNTER,
          patientId: "patient-1",
          discipline: "lpn",
          authoredByUserId: NOTE_AUTHOR,
        }
      : null,
  loadAddendumAuthor: async (_org, encounterId, addendumId) =>
    encounterId === ENCOUNTER && addendumId === ADDENDUM ? ADDENDUM_AUTHOR : null,
};
const predicate = buildEncounterAbacPredicates({ resolver, isInCaseload: async () => true })[
  "m8.cosigner_role_match"
] as (context: AbacContext, target: Record<string, unknown>) => Promise<boolean>;

const as = (membershipId: string | null, roles: string[] = ["rn"]): AbacContext =>
  ({
    organizationId: ORG,
    userId: `user-of-${membershipId}`,
    roles,
    attributes: membershipId === null ? {} : { membershipId },
  }) as unknown as AbacContext;

describe("m8.cosigner_role_match for the request of an amendment", () => {
  it("an RN who authored neither the note nor the addendum may cosign it", async () => {
    expect(await predicate(as(COSIGNER), { encounterId: ENCOUNTER, addendumId: ADDENDUM })).toBe(
      true,
    );
  });

  it("the addendum's author may not cosign their own amendment, even as an RN who did not author the note", async () => {
    expect(
      await predicate(as(ADDENDUM_AUTHOR), { encounterId: ENCOUNTER, addendumId: ADDENDUM }),
    ).toBe(false);
  });

  it("the note's author may not cosign an amendment of their note either", async () => {
    expect(await predicate(as(NOTE_AUTHOR), { encounterId: ENCOUNTER, addendumId: ADDENDUM })).toBe(
      false,
    );
  });

  it("fails closed for an addendum that is absent or another encounter's, and for a caller with no membership or no RN role", async () => {
    const other = "00000000-0000-4000-8000-0000000000ff";
    expect(await predicate(as(COSIGNER), { encounterId: ENCOUNTER, addendumId: other })).toBe(
      false,
    );
    expect(await predicate(as(null), { encounterId: ENCOUNTER, addendumId: ADDENDUM })).toBe(false);
    expect(
      await predicate(as(COSIGNER, ["lpn"]), { encounterId: ENCOUNTER, addendumId: ADDENDUM }),
    ).toBe(false);
  });

  it("a note's own request is decided exactly as before: no addendum is named, none is read", async () => {
    expect(await predicate(as(COSIGNER), { encounterId: ENCOUNTER })).toBe(true);
    expect(await predicate(as(NOTE_AUTHOR), { encounterId: ENCOUNTER })).toBe(false);
  });
});
