// S2 - only the author of a signed note or a supervisor may name its sections to amend (ADR-0114 VN-D30): a signed amendment replaces the note's
// current text for every reader, so the addendum permission alone is not enough. A free addendum (no section named) is anyone's. Pure.
import { describe, expect, it } from "vitest";
import { assertMayAmendSectionsOf } from "../src/modules/08-encounters/drafting/amendment-author";

const AUTHOR = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000cc";

const names = (membershipId: string, roles: readonly string[], namesSections = true) =>
  assertMayAmendSectionsOf(AUTHOR, { membershipId, roles, namesSections });

describe("assertMayAmendSectionsOf", () => {
  it("lets the note's author name sections", () => {
    expect(() => names(AUTHOR, ["rn"])).not.toThrow();
  });

  it("lets a supervisor name sections of anyone's note, whichever supervisor key the session holds", () => {
    for (const role of ["clinical_supervisor", "director_of_nursing", "don", "clinical_lead"]) {
      expect(() => names(OTHER, [role]), role).not.toThrow();
    }
  });

  it("refuses another clinician with the addendum permission: 403 FORBIDDEN", () => {
    const error = (() => {
      try {
        names(OTHER, ["rn", "admin"]);
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("org-wide scope or an admin role alone is not enough (the supervisor set is the one the other author-or-supervisor guards use)", () => {
    expect(() => names(OTHER, ["admin", "org_admin"])).toThrow();
  });

  it("asks nothing of a free addendum: anyone with the permission writes one", () => {
    expect(() => names(OTHER, ["rn"], false)).not.toThrow();
  });
});
