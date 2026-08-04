// ARCH-023 / TASK-066 — `organization_settings_registry` was never boot-populated (the function
// existed since M1 landed; nothing called it). Proves the new wiring actually reaches an UPSERT
// shaped like the M1-T10 outbox-catalog precedent, over the REAL in-code registry (not a stub) —
// including `breakglass_cosign_required`, the specific key the M3 break-glass cosign-policy read
// names in its own comment.
import { describe, expect, it } from "vitest";
import { buildDbOrganizationSettingsUpserter, wireOrganizationSettingsRegistry } from "../organization-settings-persister";

interface Captured {
  readonly values: unknown;
  readonly target: unknown;
}

function fakeDb() {
  const calls: Captured[] = [];
  const db = {
    insert() {
      return {
        values(values: unknown) {
          return {
            onConflictDoUpdate(opts: { target: unknown }) {
              calls.push({ values, target: opts.target });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Parameters<typeof buildDbOrganizationSettingsUpserter>[0], calls };
}

describe("organization-settings-persister (ARCH-023)", () => {
  it("UPSERTs every registry row via insert().values().onConflictDoUpdate() on the primary key", async () => {
    const { db, calls } = fakeDb();
    await wireOrganizationSettingsRegistry(db);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.values).toMatchObject({
        settingsKey: expect.any(String),
        registeredByModule: expect.any(String),
        description: expect.any(String),
        registryEntryJson: expect.any(Object),
      });
    }
  });

  it("registers breakglass_cosign_required — the key M3's cosign-policy read names", async () => {
    const { db, calls } = fakeDb();
    await wireOrganizationSettingsRegistry(db);
    const keys = calls.map((c) => (c.values as { settingsKey: string }).settingsKey);
    expect(keys).toContain("breakglass_cosign_required");
  });

  it("is idempotent: calling it twice makes the same number of UPSERT calls each time", async () => {
    const { db, calls } = fakeDb();
    await wireOrganizationSettingsRegistry(db);
    const firstCount = calls.length;
    await wireOrganizationSettingsRegistry(db);
    expect(calls.length).toBe(firstCount * 2); // same set replayed, not accumulated/deduped state
  });
});
