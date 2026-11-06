import { ChartWardenError } from "@chartwarden/types";
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

  // A route that resolves the binding must answer a typed 503, never a bare 500, when the org's clearinghouse cannot be resolved.
  it("passes a typed resolver refusal through unchanged (the unreadable credential stays a 503 with its own code)", async () => {
    const unreadable = new ChartWardenError(
      "CLEARINGHOUSE_CREDENTIAL_UNREADABLE",
      "this organization's clearinghouse credential could not be opened",
      503,
    );
    const perOrg: Binding = {
      vendor: null,
      forOrg: async () => {
        throw unreadable;
      },
    };
    await expect(resolveBinding(perOrg, "org-1")).rejects.toBe(unreadable);
    await expect(withOrgBinding({ binding: perOrg }, "org-1")).rejects.toBe(unreadable);
  });

  it("turns any other resolution failure into a typed 503 that names nothing of the cause", async () => {
    const perOrg: Binding = {
      vendor: null,
      forOrg: async () => {
        throw new Error("connection refused while reading config for key sk_live_DO_NOT_LEAK");
      },
    };
    for (const attempt of [
      resolveBinding(perOrg, "org-1"),
      withOrgBinding({ binding: perOrg }, "org-1"),
    ]) {
      const err = await attempt.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChartWardenError);
      expect(err).toMatchObject({ code: "CLEARINGHOUSE_UNAVAILABLE", statusCode: 503 });
      expect((err as Error).message).not.toContain("sk_live");
    }
  });
});
