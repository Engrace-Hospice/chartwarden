// packages/auth/__tests__/two-factor-adapter.test.ts — ADR-0034 §1 encrypting adapter decorator.
// Infra-free: a fake inner adapter records what it receives + returns canned rows, so we can assert the
// security-critical transform (encrypt-on-write, decrypt-on-read, twoFactor-only). The real composition
// over Better Auth's drizzle adapter is verified in the live-PG lane.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTwoFactorEncryption } from "../src/identity/two-factor-adapter";
import { isSealed, seal } from "../src/identity/two-factor-crypto";

const KEY = randomBytes(32);

function fake(rows: Record<string, unknown> = {}): { inner: any; seen: any } {
  const seen: any = {};
  const inner = {
    id: "fake",
    async create(d: any) {
      seen.create = d;
      return { id: "x", ...d.data };
    },
    async update(d: any) {
      seen.update = d;
      return { id: "x", ...d.update };
    },
    async updateMany(d: any) {
      seen.updateMany = d;
      return 1;
    },
    async findOne() {
      return { id: "x", ...rows };
    },
    async findMany() {
      return [{ id: "x", ...rows }];
    },
    async count() {
      return 7;
    },
  };
  return { inner, seen };
}

describe("withTwoFactorEncryption (ADR-0034)", () => {
  it("encrypts secret + backupCodes on create, returns plaintext to the caller", async () => {
    const { inner, seen } = fake();
    const a = withTwoFactorEncryption(inner, () => KEY);
    const out = await a.create({
      model: "twoFactor",
      data: { userId: "u", secret: "TOTPSECRET", backupCodes: "1,2,3" },
    });
    expect(isSealed(seen.create.data.secret as string)).toBe(true);
    expect(seen.create.data.secret).not.toBe("TOTPSECRET");
    expect(isSealed(seen.create.data.backupCodes as string)).toBe(true);
    expect(out.secret).toBe("TOTPSECRET");
    expect(out.backupCodes).toBe("1,2,3");
  });

  it("encrypts secret on update", async () => {
    const { inner, seen } = fake();
    const a = withTwoFactorEncryption(inner, () => KEY);
    await a.update({ model: "twoFactor", where: [], update: { secret: "NEWSECRET" } });
    expect(isSealed(seen.update.update.secret as string)).toBe(true);
  });

  it("decrypts secret + backupCodes on findOne / findMany", async () => {
    const { inner } = fake({ secret: seal("S", KEY), backupCodes: seal("BC", KEY) });
    const a = withTwoFactorEncryption(inner, () => KEY);
    const one = await a.findOne({ model: "twoFactor", where: [] });
    expect(one?.secret).toBe("S");
    expect(one?.backupCodes).toBe("BC");
    const many = await a.findMany({ model: "twoFactor" });
    expect(many[0]?.secret).toBe("S");
  });

  it("passes non-twoFactor models through untouched (no spurious encryption)", async () => {
    const { inner, seen } = fake();
    const a = withTwoFactorEncryption(inner, () => KEY);
    await a.create({ model: "user", data: { email: "e", secret: "verbatim" } });
    expect(seen.create.data.secret).toBe("verbatim");
  });

  it("preserves pass-through methods + properties", async () => {
    const { inner } = fake();
    const a = withTwoFactorEncryption(inner, () => KEY);
    expect(await (a as unknown as { count: () => Promise<number> }).count()).toBe(7);
    expect((a as unknown as { id: string }).id).toBe("fake");
  });
});
