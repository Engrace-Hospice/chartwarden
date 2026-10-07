// apps/backend/__tests__/bereavement-notes-storable.test.ts — GAP-129 (M16): contact channels and counselor notes are
// sealed with the tenant DEK (round-trip), refused (503) while no cipher is bound — never discarded or stored in
// plaintext — and a bereavement plan's roster is seeded from M5's caregivers.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBereavementCipher } from "../src/modules/16-bereavement/bereavement-crypto";
import {
  bereavedRelationshipFromCaregiver,
  planCaregiverSeeds,
} from "../src/modules/16-bereavement/roster-seed";
import {
  CHANNEL_STORAGE_UNAVAILABLE,
  assertSensitiveStorable,
} from "../src/modules/16-bereavement/routes/write-service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

function keyProvider() {
  const keys = new Map<string, Buffer>();
  const dek = (org: string) => {
    if (!keys.has(org)) keys.set(org, randomBytes(32));
    return keys.get(org) as Buffer;
  };
  return {
    dekForOrg: async (org: string) => ({ version: "7", key: dek(org) }),
    dekForOrgVersion: async (org: string) => ({ version: "7", key: dek(org) }),
  };
}

describe("assertSensitiveStorable", () => {
  it("refuses a request that carries a value while no cipher is bound (503)", () => {
    expect(() => assertSensitiveStorable(["spoke with the daughter"], false)).toThrow(
      expect.objectContaining({ code: CHANNEL_STORAGE_UNAVAILABLE, statusCode: 503 }),
    );
    expect(() => assertSensitiveStorable([undefined, "555-0100"], false)).toThrow(
      expect.objectContaining({ statusCode: 503 }),
    );
  });

  it("allows a request with nothing to store, or any request once a cipher is bound", () => {
    expect(() => assertSensitiveStorable([undefined, null, "   "], false)).not.toThrow();
    expect(() => assertSensitiveStorable(["555-0100"], true)).not.toThrow();
  });
});

describe("createBereavementCipher", () => {
  it("round-trips a phone number and never stores it as plaintext", async () => {
    const cipher = createBereavementCipher(keyProvider());
    const blob = await cipher.encrypt(ORG, "bereaved_contact.phone", "+1 555 010 0199");
    expect(blob.startsWith("v1.7.")).toBe(true);
    expect(blob).not.toContain("555");
    expect(await cipher.decrypt(ORG, "bereaved_contact.phone", blob)).toBe("+1 555 010 0199");
  });

  it("will not open a blob in another column or another tenant (AAD binding)", async () => {
    const cipher = createBereavementCipher(keyProvider());
    const blob = await cipher.encrypt(ORG, "bereaved_contact.phone", "5550100");
    await expect(cipher.decrypt(ORG, "bereaved_contact.email", blob)).rejects.toThrow();
    await expect(cipher.decrypt(OTHER_ORG, "bereaved_contact.phone", blob)).rejects.toThrow();
  });

  it("rejects a blob it did not write", async () => {
    const cipher = createBereavementCipher(keyProvider());
    await expect(cipher.decrypt(ORG, "bereaved_contact.phone", "plain")).rejects.toThrow();
  });
});

describe("caregiver roster seed", () => {
  const entry = (n: string, relationship: string) => ({
    caregiverId: `cg-${n}`,
    patientCaregiverId: `pc-${n}`,
    displayName: `Person ${n}`,
    relationship,
    isPrimary: n === "1",
    email: `${n}@example.test`,
    phone: null,
    preferredLanguageCode: n === "2" ? "es" : null,
  });

  it("maps M5 relationships onto the M16 value set (unknown -> other)", () => {
    expect(bereavedRelationshipFromCaregiver("spouse")).toBe("spouse");
    expect(bereavedRelationshipFromCaregiver("paid_caregiver")).toBe("caregiver_non_family");
    expect(bereavedRelationshipFromCaregiver("guardian")).toBe("other");
    expect(bereavedRelationshipFromCaregiver("something_new")).toBe("other");
  });

  it("seeds every caregiver not already on the plan, keeping language and channels", () => {
    const seeds = planCaregiverSeeds(
      [entry("1", "spouse"), entry("2", "child"), entry("3", "friend")],
      new Set(["pc-3"]),
    );
    expect(seeds.map((s) => s.patientCaregiverId)).toEqual(["pc-1", "pc-2"]);
    expect(seeds[1]).toMatchObject({ relationshipCode: "child", preferredLanguageIso639: "es" });
    expect(seeds[0]).toMatchObject({ email: "1@example.test", preferredLanguageIso639: "en" });
  });

  it("seeds nothing from an empty roster or when every link is already seeded", () => {
    expect(planCaregiverSeeds([], new Set())).toEqual([]);
    expect(planCaregiverSeeds([entry("1", "spouse")], new Set(["pc-1"]))).toEqual([]);
  });
});
