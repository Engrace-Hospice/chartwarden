// WP 5.7 - the artefact envelope (round trip, tamper, wrong tenant/job/key), the wrap helper over the real KEK adapter, and the reader's refusals.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPlatformKekAdapter } from "../../../bootstrap/tenant-kek";
import {
  ExportCryptoError,
  createExportKeyWrap,
  openArtefact,
  sealArtefact,
  sha256Hex,
} from "./export-crypto";
import { createExportArtefactReader } from "./export-reader";

const ORG = "00000000-0000-4000-8000-00000000000a";
const OTHER_ORG = "00000000-0000-4000-8000-00000000000c";
const JOB = "00000000-0000-4000-8000-0000000000b1";
const ctx = { organizationId: ORG, jobId: JOB };
const plain = Buffer.from(JSON.stringify({ manifest: {}, messages: [{ body: "hello" }] }));

const kekAdapter = () => {
  const active = { kekId: "kek-1", key: randomBytes(32) };
  return createPlatformKekAdapter({ active, byId: new Map([[active.kekId, active.key]]) } as never);
};

describe("artefact envelope", () => {
  it("round-trips and never stores the plaintext", () => {
    const dek = randomBytes(32);
    const sealed = sealArtefact(plain, dek, ctx);
    expect(sealed.includes(Buffer.from("hello"))).toBe(false);
    expect(openArtefact(sealed, dek, ctx).equals(plain)).toBe(true);
  });

  it("detects a flipped byte, a wrong key, another tenant and another job", () => {
    const dek = randomBytes(32);
    const sealed = sealArtefact(plain, dek, ctx);
    const flipped = Buffer.from(sealed);
    flipped[20] = (flipped[20] ?? 0) ^ 0xff;
    expect(() => openArtefact(flipped, dek, ctx)).toThrow(ExportCryptoError);
    expect(() => openArtefact(sealed, randomBytes(32), ctx)).toThrow(ExportCryptoError);
    expect(() => openArtefact(sealed, dek, { ...ctx, organizationId: OTHER_ORG })).toThrow(
      ExportCryptoError,
    );
    expect(() => openArtefact(sealed, dek, { ...ctx, jobId: OTHER_ORG })).toThrow(
      ExportCryptoError,
    );
    expect(() => openArtefact(Buffer.from([9, 9]), dek, ctx)).toThrow(ExportCryptoError);
  });
});

describe("tenant key wrap", () => {
  it("mints a data key the stored wrapped form opens, and refuses another tenant", async () => {
    const keys = createExportKeyWrap(kekAdapter());
    const { dek, wrapped } = await keys.mint(ORG);
    expect(dek).toHaveLength(32);
    expect((await keys.unwrap(ORG, wrapped)).equals(dek)).toBe(true);
    await expect(keys.unwrap(OTHER_ORG, wrapped)).rejects.toThrow();
  });
});

describe("artefact reader", () => {
  async function stored() {
    const keys = createExportKeyWrap(kekAdapter());
    const { dek, wrapped } = await keys.mint(ORG);
    const sealed = sealArtefact(plain, dek, ctx);
    const ref = {
      jobId: JOB,
      organizationId: ORG,
      artefactKey: `messaging-export/${JOB}.enc`,
      wrappedDek: wrapped,
      artefactSha256: sha256Hex(plain),
      artefactBytes: sealed.length,
    };
    return { keys, sealed, ref };
  }

  it("returns the verified plaintext", async () => {
    const { keys, sealed, ref } = await stored();
    const read = createExportArtefactReader({ get: async () => sealed, keys });
    expect(Buffer.from(await read(ref)).equals(plain)).toBe(true);
  });

  it("refuses when the wrapped key is gone (expired)", async () => {
    const { keys, sealed, ref } = await stored();
    const read = createExportArtefactReader({ get: async () => sealed, keys });
    await expect(read({ ...ref, wrappedDek: null as unknown as string })).rejects.toThrow(
      /expired/,
    );
  });

  it("refuses a missing object, a flipped byte and a wrong digest", async () => {
    const { keys, sealed, ref } = await stored();
    await expect(createExportArtefactReader({ get: async () => null, keys })(ref)).rejects.toThrow(
      /missing/,
    );
    const flipped = Buffer.from(sealed);
    flipped[30] = (flipped[30] ?? 0) ^ 1;
    await expect(
      createExportArtefactReader({ get: async () => flipped, keys })(ref),
    ).rejects.toThrow(ExportCryptoError);
    await expect(
      createExportArtefactReader({ get: async () => sealed, keys })({
        ...ref,
        artefactSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/digest/);
  });
});
