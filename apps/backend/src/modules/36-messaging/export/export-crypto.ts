// M36 WP 5.7 (ADR-0089, PROPOSED), D6 - the artefact's encryption at rest. One fresh random 256-bit data key per job (AES-256-GCM, node:crypto),
// wrapped by the tenant KEK through the SAME adapter M34 uses for tenant data keys (`PlatformKekAdapter`: mint + wrap, then unwrap; no new key
// format). The wrapped key is stored on the job row and dropped at expiry, which makes the stored object unreadable even if the delete fails.
//   envelope = version(1)=1 | nonce(12) | ciphertext | tag(16);  AAD = "chartwarden-m36-export:v1:<orgId>:<jobId>"
// so an artefact cannot be opened under another tenant or another job. Nothing here logs or throws a plaintext byte.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PlatformKekAdapter } from "../../../bootstrap/tenant-kek";

const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const AAD_LABEL = "chartwarden-m36-export:v1";

export class ExportCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportCryptoError";
  }
}

/** Mint a data key and wrap it under the tenant KEK; unwrap a stored one. */
export interface ExportKeyWrap {
  /** A fresh data key and its wrapped form (`<kekId>:<base64>`). The caller zeroizes `dek` after use. */
  mint(organizationId: string): Promise<{ readonly dek: Buffer; readonly wrapped: string }>;
  unwrap(organizationId: string, wrapped: string): Promise<Buffer>;
}

export function createExportKeyWrap(kek: PlatformKekAdapter): ExportKeyWrap {
  const unwrap = async (organizationId: string, wrapped: string): Promise<Buffer> => {
    const split = wrapped.lastIndexOf(":");
    if (split < 1) throw new ExportCryptoError("export: malformed wrapped key");
    const dek = await kek.unwrap({
      organizationId,
      kekId: wrapped.slice(0, split),
      kekWrappedCiphertext: Buffer.from(wrapped.slice(split + 1), "base64"),
    });
    if (dek.length !== KEY_LEN)
      throw new ExportCryptoError("export: unwrapped key has a bad length");
    return dek;
  };
  return {
    async mint(organizationId) {
      // The adapter zeroizes the key it mints, so open the wrapped copy: the one place the plaintext key exists is this call's result.
      const { wrappedCiphertextB64, kekId } = await kek.mintAndWrapDek({ organizationId });
      const wrapped = `${kekId}:${wrappedCiphertextB64}`;
      return { dek: await unwrap(organizationId, wrapped), wrapped };
    },
    unwrap,
  };
}

function aad(organizationId: string, jobId: string): Buffer {
  return Buffer.from(`${AAD_LABEL}:${organizationId}:${jobId}`, "utf8");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sealArtefact(
  plaintext: Uint8Array,
  dek: Buffer,
  ctx: { readonly organizationId: string; readonly jobId: string },
): Buffer {
  if (dek.length !== KEY_LEN) throw new ExportCryptoError("export: data key must be 32 bytes");
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  cipher.setAAD(aad(ctx.organizationId, ctx.jobId));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, cipher.getAuthTag()]);
}

/** Open an envelope. Throws `ExportCryptoError` (never the plaintext, never the cause) on a wrong key, wrong tenant/job, tamper or bad format. */
export function openArtefact(
  envelope: Uint8Array,
  dek: Buffer,
  ctx: { readonly organizationId: string; readonly jobId: string },
): Buffer {
  const buf = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  if (buf.length < 1 + NONCE_LEN + TAG_LEN || buf[0] !== VERSION) {
    throw new ExportCryptoError("export: malformed artefact");
  }
  const nonce = buf.subarray(1, 1 + NONCE_LEN);
  const ct = buf.subarray(1 + NONCE_LEN, buf.length - TAG_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
    decipher.setAAD(aad(ctx.organizationId, ctx.jobId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new ExportCryptoError("export: artefact failed authentication");
  }
}
