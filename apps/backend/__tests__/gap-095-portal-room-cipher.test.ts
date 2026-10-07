/**
 * GAP-095 — the telehealth room cipher can now OPEN what it seals (the join route hands the caller the real
 * vendor url; `end` addresses the vendor room by its real id). Binds org + column through the AAD.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPortalRoomCipher } from "../src/modules/31-portal/portal-crypto";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function keys() {
  const ring = new Map<string, Buffer>([
    ["k1", randomBytes(32)],
    ["k2", randomBytes(32)],
  ]);
  let current = "k1";
  return {
    rotate: () => {
      current = "k2";
    },
    provider: {
      async dekForOrg() {
        return { version: current, key: ring.get(current) as Buffer };
      },
      async dekForOrgVersion(_org: string, version: string) {
        const key = ring.get(version);
        if (!key) throw new Error("unknown DEK version");
        return { version, key };
      },
    },
  };
}

describe("createPortalRoomCipher.decrypt (GAP-095)", () => {
  it("round-trips a room url", async () => {
    const cipher = createPortalRoomCipher(keys().provider);
    const sealed = await cipher.encrypt(ORG_A, "vendor_room_url", "https://vendor.example/room-1");
    expect(sealed).not.toContain("vendor.example");
    await expect(cipher.decrypt(ORG_A, "vendor_room_url", sealed)).resolves.toBe(
      "https://vendor.example/room-1",
    );
  });

  it("still opens a blob sealed under a rotated-out DEK", async () => {
    const k = keys();
    const cipher = createPortalRoomCipher(k.provider);
    const sealed = await cipher.encrypt(ORG_A, "vendor_room_id", "room-1");
    k.rotate();
    await expect(cipher.decrypt(ORG_A, "vendor_room_id", sealed)).resolves.toBe("room-1");
  });

  it("refuses a blob lifted into another column or another org", async () => {
    const cipher = createPortalRoomCipher(keys().provider);
    const sealed = await cipher.encrypt(ORG_A, "vendor_room_id", "room-1");
    await expect(cipher.decrypt(ORG_A, "vendor_room_url", sealed)).rejects.toThrow();
    await expect(cipher.decrypt(ORG_B, "vendor_room_id", sealed)).rejects.toThrow();
  });

  it("refuses a malformed envelope and a provider that cannot open versioned DEKs", async () => {
    const k = keys();
    const cipher = createPortalRoomCipher(k.provider);
    await expect(cipher.decrypt(ORG_A, "vendor_room_id", "garbage")).rejects.toThrow(
      /unrecognised/,
    );
    const encryptOnly = createPortalRoomCipher({ dekForOrg: k.provider.dekForOrg });
    const sealed = await encryptOnly.encrypt(ORG_A, "vendor_room_id", "room-1");
    await expect(encryptOnly.decrypt(ORG_A, "vendor_room_id", sealed)).rejects.toThrow(
      /versioned DEK/,
    );
  });
});
