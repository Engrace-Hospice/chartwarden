import { describe, expect, it } from "vitest";
import { type PerOrgBinding, resolveBinding, withOrgBinding } from "./org-binding";

interface Binding extends PerOrgBinding<Binding> {
  readonly vendor: string | null;
}

describe("org-binding", () => {
  const stedi: Binding = { vendor: "stedi" };

  it("returns a static binding (no forOrg) unchanged, for any organization", async () => {
    expect(await resolveBinding(stedi, "org-1")).toBe(stedi);
    const deps = { binding: stedi, other: 1 };
    expect(await withOrgBinding(deps, "org-1")).toBe(deps);
  });

  it("resolves a per-organization binding for the organization asked, and the resolved one resolves to itself", async () => {
    const perOrg: Binding = {
      vendor: null,
      forOrg: async (organizationId) => ({ vendor: organizationId === "org-1" ? "claimmd" : null }),
    };

    const one = await resolveBinding(perOrg, "org-1");
    const none = await resolveBinding(perOrg, "org-2");

    expect([one.vendor, none.vendor]).toEqual(["claimmd", null]);
    expect(await resolveBinding(one, "org-2")).toBe(one);
  });

  it("swaps only the binding in the deps and leaves the original deps alone", async () => {
    const perOrg: Binding = { vendor: null, forOrg: async () => ({ vendor: "stedi" }) };
    const deps = { binding: perOrg, db: "db" };

    const scoped = await withOrgBinding(deps, "org-1");

    expect(scoped.binding.vendor).toBe("stedi");
    expect(scoped.db).toBe("db");
    expect(deps.binding).toBe(perOrg);
  });

  it("lets a resolution failure reach the caller (each loop turns it into that org's failure)", async () => {
    const perOrg: Binding = {
      vendor: null,
      forOrg: async () => {
        throw new Error("config unreadable");
      },
    };

    await expect(resolveBinding(perOrg, "org-1")).rejects.toThrow("config unreadable");
  });
});
