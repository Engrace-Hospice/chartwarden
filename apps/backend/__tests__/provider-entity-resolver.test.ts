// #107 item 3 — the primary-provider-entity resolver: prefers the org's active provider entity, falls back
// to the earliest-created, and fails closed (PROVIDER_ENTITY_UNRESOLVED 503) only when the org has none.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { buildPrimaryProviderEntityResolver } from "../src/bootstrap/provider-entity-resolver";

/** A fake org-context tx whose query chain resolves to the seeded provider_entity rows (already org-ordered). */
function fakeTx(rows: { id: string; status: string }[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as never;
}

const resolver = buildPrimaryProviderEntityResolver();

describe("buildPrimaryProviderEntityResolver", () => {
  it("prefers the active provider entity over an earlier created one", async () => {
    const tx = fakeTx([
      { id: "pe-created", status: "created" },
      { id: "pe-active", status: "active" },
    ]);
    expect(await resolver.primaryProviderEntityId(tx, "org-1")).toBe("pe-active");
  });

  it("falls back to the earliest-created when none is active (dev/seed data)", async () => {
    const tx = fakeTx([
      { id: "pe-first", status: "created" },
      { id: "pe-second", status: "suspended" },
    ]);
    expect(await resolver.primaryProviderEntityId(tx, "org-1")).toBe("pe-first");
  });

  it("fails closed (503) when the org has no provider entity", async () => {
    const tx = fakeTx([]);
    await expect(resolver.primaryProviderEntityId(tx, "org-1")).rejects.toMatchObject({
      code: "PROVIDER_ENTITY_UNRESOLVED",
      statusCode: 503,
    });
    await expect(resolver.primaryProviderEntityId(tx, "org-1")).rejects.toBeInstanceOf(
      ChartWardenError,
    );
  });
});
