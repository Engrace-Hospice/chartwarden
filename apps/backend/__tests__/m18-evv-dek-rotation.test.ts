// §4.8 `m18.dek-rotation` — unit tests for the coordinate re-seal worker's selection, batching, idempotency,
// failure isolation and consumer envelope checks, over an in-memory store that mirrors the SQL contract
// (`staleBatch` = rows of THIS org not sealed under the current version and not legacy, keyset-ordered by
// (event_at, id); `reseal` = the compare-and-swap `evv_reseal_coords`). The DB path (RLS, the definer
// function, the append-only trigger) is `m18-dek-rotation.live.test.ts`.
import { describe, expect, it } from "vitest";
import {
  LEGACY_COORDS_DEK_VERSION,
  type StoredCoordinate,
  createEvvCoordsCipher,
} from "../src/modules/18-evv/coords";
import {
  EvvCoordsResealError,
  type EvvCoordsResealStore,
  type ResealCandidate,
  buildM18DekRotationConsumer,
  needsReseal,
  resealOrgCoords,
} from "../src/modules/18-evv/jobs/dek-rotation";
import { createRotatableTestCoordsKeyRing } from "./_m18-coords-test-cipher";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PORTLAND: StoredCoordinate = { lat: 45.523, lng: -122.6789 };

interface MemRow {
  organizationId: string;
  eventId: string;
  eventAt: Date;
  coordsCipher: string;
  coordsDekVersion: string;
}

/** The SQL contract, in memory. `batchCalls` records each staleBatch limit so batching is observable. */
function memStore(rows: MemRow[], opts: { loseCasFor?: Set<string> } = {}) {
  const batchCalls: number[] = [];
  const store: EvvCoordsResealStore = {
    async inOrg(organizationId, fn) {
      return fn({
        async staleBatch({ currentVersion, after, limit }) {
          batchCalls.push(limit);
          return rows
            .filter(
              (r) =>
                r.organizationId === organizationId &&
                r.coordsDekVersion !== currentVersion &&
                r.coordsDekVersion !== LEGACY_COORDS_DEK_VERSION,
            )
            .filter(
              (r) =>
                !after ||
                r.eventAt.getTime() > after.eventAt.getTime() ||
                (r.eventAt.getTime() === after.eventAt.getTime() && r.eventId > after.eventId),
            )
            .sort(
              (a, b) =>
                a.eventAt.getTime() - b.eventAt.getTime() || (a.eventId < b.eventId ? -1 : 1),
            )
            .slice(0, limit)
            .map(
              (r): ResealCandidate => ({
                eventId: r.eventId,
                eventAt: r.eventAt,
                coordsCipher: r.coordsCipher,
                coordsDekVersion: r.coordsDekVersion,
              }),
            );
        },
        async reseal({ eventId, expectedCipher, cipher, dekVersion }) {
          if (opts.loseCasFor?.has(eventId)) return false;
          const row = rows.find(
            (r) =>
              r.organizationId === organizationId &&
              r.eventId === eventId &&
              r.coordsCipher === expectedCipher,
          );
          if (!row) return false;
          row.coordsCipher = cipher;
          row.coordsDekVersion = dekVersion;
          return true;
        },
      });
    },
  };
  return { store, batchCalls };
}

async function sealedRows(
  keys: ReturnType<typeof createRotatableTestCoordsKeyRing>,
  org: string,
  n: number,
  startMs = Date.UTC(2026, 9, 1),
): Promise<MemRow[]> {
  const cipher = createEvvCoordsCipher(keys);
  const out: MemRow[] = [];
  for (let i = 0; i < n; i++) {
    const sealed = await cipher.seal(org, { lat: PORTLAND.lat + i / 1000, lng: PORTLAND.lng });
    out.push({
      organizationId: org,
      eventId: `${org.slice(0, 8)}-${String(i).padStart(4, "0")}`,
      eventAt: new Date(startMs + i * 60_000),
      coordsCipher: sealed.cipher,
      coordsDekVersion: sealed.dekVersion,
    });
  }
  return out;
}

describe("needsReseal", () => {
  const envelope = "v1.v1.bm9uY2U.dGFn.Y3Q";
  it("selects an envelope sealed under a version other than the current one", () => {
    expect(needsReseal({ coordsCipher: envelope, coordsDekVersion: "v1" }, "v2")).toBe(true);
  });
  it("skips a row already under the current version", () => {
    expect(needsReseal({ coordsCipher: envelope, coordsDekVersion: "v2" }, "v2")).toBe(false);
  });
  it("never selects a legacy-unencrypted row, by stamp or by format", () => {
    expect(
      needsReseal(
        { coordsCipher: "NDUuNSwtMTIyLjY=", coordsDekVersion: LEGACY_COORDS_DEK_VERSION },
        "v2",
      ),
    ).toBe(false);
    expect(needsReseal({ coordsCipher: "NDUuNSwtMTIyLjY=", coordsDekVersion: "v1" }, "v2")).toBe(
      false,
    );
  });
});

describe("resealOrgCoords", () => {
  it("re-seals every row under the new version; the coordinate is unchanged and opens under v2", async () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const rows = await sealedRows(keys, ORG_A, 3);
    const before = await Promise.all(
      rows.map((r) => createEvvCoordsCipher(keys).open(ORG_A, r.coordsCipher)),
    );
    keys.rotateTo("v2");
    const { store } = memStore(rows);

    const result = await resealOrgCoords({ store, keys }, ORG_A);

    expect(result).toMatchObject({ currentVersion: "v2", scanned: 3, resealed: 3, complete: true });
    expect(
      rows.every((r) => r.coordsDekVersion === "v2" && r.coordsCipher.startsWith("v1.v2.")),
    ).toBe(true);
    const after = await Promise.all(
      rows.map((r) => createEvvCoordsCipher(keys).open(ORG_A, r.coordsCipher)),
    );
    expect(after).toEqual(before);
  });

  it("is a no-op on re-run (nothing left under an old version)", async () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const rows = await sealedRows(keys, ORG_A, 2);
    keys.rotateTo("v2");
    const { store } = memStore(rows);
    await resealOrgCoords({ store, keys }, ORG_A);
    const snapshot = rows.map((r) => r.coordsCipher);

    const again = await resealOrgCoords({ store, keys }, ORG_A);

    expect(again).toMatchObject({ scanned: 0, resealed: 0, complete: true });
    expect(rows.map((r) => r.coordsCipher)).toEqual(snapshot);
  });

  it("leaves legacy-unencrypted rows and other tenants' rows untouched", async () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const mine = await sealedRows(keys, ORG_A, 1);
    const theirs = await sealedRows(keys, ORG_B, 1);
    const legacy: MemRow = {
      organizationId: ORG_A,
      eventId: "legacy-0001",
      eventAt: new Date(Date.UTC(2026, 0, 1)),
      coordsCipher: Buffer.from("45.5,-122.6").toString("base64"),
      coordsDekVersion: LEGACY_COORDS_DEK_VERSION,
    };
    const rows = [...mine, ...theirs, legacy];
    const theirsBefore = theirs[0]?.coordsCipher;
    keys.rotateTo("v2");

    const result = await resealOrgCoords({ store: memStore(rows).store, keys }, ORG_A);

    expect(result.resealed).toBe(1);
    expect(legacy.coordsDekVersion).toBe(LEGACY_COORDS_DEK_VERSION);
    expect(theirs[0]?.coordsCipher).toBe(theirsBefore);
    expect(theirs[0]?.coordsDekVersion).toBe("v1");
  });

  it("works in bounded batches and resumes where a capped run stopped", async () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const rows = await sealedRows(keys, ORG_A, 5);
    keys.rotateTo("v2");
    const { store, batchCalls } = memStore(rows);

    const first = await resealOrgCoords({ store, keys, batchSize: 2, maxBatches: 1 }, ORG_A);
    expect(first).toMatchObject({ resealed: 2, complete: false });
    expect(batchCalls).toEqual([2]);

    const rest = await resealOrgCoords({ store, keys, batchSize: 2 }, ORG_A);
    expect(rest).toMatchObject({ resealed: 3, complete: true });
    expect(rows.every((r) => r.coordsDekVersion === "v2")).toBe(true);
  });

  it("counts a lost compare-and-swap as already handled, not as a failure", async () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const rows = await sealedRows(keys, ORG_A, 2);
    keys.rotateTo("v2");
    const lost = new Set([rows[0]?.eventId ?? ""]);

    const result = await resealOrgCoords(
      { store: memStore(rows, { loseCasFor: lost }).store, keys },
      ORG_A,
    );

    expect(result).toMatchObject({ resealed: 1, raced: 1, complete: true });
  });

  it("re-seals the healthy rows, skips past an unopenable one, then fails loud naming only the event id", async () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const rows = await sealedRows(keys, ORG_A, 3);
    const bad = rows[1];
    if (!bad) throw new Error("fixture");
    // A tampered tag: authentication fails, so the row cannot be re-sealed.
    const parts = bad.coordsCipher.split(".");
    parts[3] = Buffer.alloc(16, 7).toString("base64url");
    bad.coordsCipher = parts.join(".");
    keys.rotateTo("v2");

    const err = await resealOrgCoords(
      { store: memStore(rows).store, keys, batchSize: 1 },
      ORG_A,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvvCoordsResealError);
    const e = err as EvvCoordsResealError;
    expect(e.failedEventIds).toEqual([bad.eventId]);
    expect(e.message).toContain(bad.eventId);
    expect(e.message).not.toMatch(/45\.5|122\.6/);
    expect(rows[0]?.coordsDekVersion).toBe("v2");
    expect(rows[2]?.coordsDekVersion).toBe("v2");
    expect(bad.coordsDekVersion).toBe("v1");
  });
});

describe("buildM18DekRotationConsumer", () => {
  it("binds m34.tenant.dek_rotation_completed as module m18", () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const consumer = buildM18DekRotationConsumer({ store: memStore([]).store, keys });
    expect(consumer.consumerModule).toBe("m18");
    expect(consumer.eventTypes).toEqual(["m34.tenant.dek_rotation_completed"]);
  });

  it("refuses a payload whose orgId disagrees with the envelope tenant", async () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const consumer = buildM18DekRotationConsumer({ store: memStore([]).store, keys });
    await expect(
      consumer.handle({ organizationId: ORG_A, payload: { orgId: ORG_B, toVersion: "v2" } }),
    ).rejects.toThrow(/orgId/);
  });

  it("re-seals the envelope tenant only", async () => {
    const keys = createRotatableTestCoordsKeyRing("v1");
    const mine = await sealedRows(keys, ORG_A, 1);
    const theirs = await sealedRows(keys, ORG_B, 1);
    keys.rotateTo("v2");
    const consumer = buildM18DekRotationConsumer({
      store: memStore([...mine, ...theirs]).store,
      keys,
    });

    await consumer.handle({ organizationId: ORG_A, payload: { orgId: ORG_A, toVersion: "v2" } });

    expect(mine[0]?.coordsDekVersion).toBe("v2");
    expect(theirs[0]?.coordsDekVersion).toBe("v1");
  });
});
