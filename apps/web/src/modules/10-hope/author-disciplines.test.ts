import { describe, expect, it } from "vitest";
import { authorDisciplinesForRoles } from "./hope-api";

describe("authorDisciplinesForRoles (CMS HOPE Guidance Manual v1.03)", () => {
  it("offers LPN/LVN for an SFV only", () => {
    expect(authorDisciplinesForRoles(["lpn"], { sfv: true })).toEqual(["LPN"]);
    expect(authorDisciplinesForRoles(["lvn"], { sfv: true })).toEqual(["LVN"]);
    expect(authorDisciplinesForRoles(["lpn"])).toEqual([]);
  });
  it("still excludes MD and other disciplines from an SFV", () => {
    expect(authorDisciplinesForRoles(["md", "social_worker"], { sfv: true })).toEqual([]);
  });
});
