// @wardenx/auth · identity — encrypting Better Auth adapter decorator (M2, ADR-0034 §1).
//
// Wraps the Drizzle adapter so the `twoFactor` model's `secret` + `backupCodes` are sealed (AES-256-GCM,
// two-factor-crypto.ts) on write and opened on read — at-rest encryption Better Auth's plugin doesn't do
// itself. Every OTHER method + model passes through untouched (spread of `inner`). The decorator operates
// on Better Auth MODEL field names (`secret`/`backupCodes`); the Drizzle field-map (in createIdentityAuth)
// routes those to M1's `secret_encrypted`/`backup_codes_encrypted` columns.
//
// SECURITY: it must cover EVERY twoFactor read/write path — a missed one would store/return plaintext.
// The covered paths are create/update/updateMany (write) + findOne/findMany (read); delete/deleteMany/
// count/consumeOne carry no secret payload. The live lane asserts ciphertext-at-rest (ADR-0034 §4).
import { isSealed, open, seal } from "./two-factor-crypto";

const MODEL = "twoFactor";
const FIELDS = ["secret", "backupCodes"] as const;

/** Minimal slice of Better Auth's adapter the decorator touches; the rest passes through via spread. */
export interface EncryptableAdapter {
  create(data: { model: string; data: Record<string, unknown>; [k: string]: unknown }): Promise<Record<string, unknown>>;
  update(data: { model: string; update: Record<string, unknown>; [k: string]: unknown }): Promise<Record<string, unknown> | null>;
  updateMany(data: { model: string; update: Record<string, unknown>; [k: string]: unknown }): Promise<number>;
  findOne(data: { model: string; [k: string]: unknown }): Promise<Record<string, unknown> | null>;
  findMany(data: { model: string; [k: string]: unknown }): Promise<Record<string, unknown>[]>;
  [k: string]: unknown;
}

function encryptFields(obj: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const out = { ...obj };
  for (const f of FIELDS) {
    if (typeof out[f] === "string") out[f] = seal(out[f] as string, key);
  }
  return out;
}

function decryptFields<T extends Record<string, unknown> | null>(row: T, key: Buffer): T {
  if (!row) return row;
  for (const f of FIELDS) {
    const v = row[f];
    if (typeof v === "string" && isSealed(v)) (row as Record<string, unknown>)[f] = open(v, key);
  }
  return row;
}

/** Decorate an adapter so the `twoFactor` secret + backup codes are encrypted at rest. */
export function withTwoFactorEncryption<A extends EncryptableAdapter>(inner: A, key: Buffer): A {
  return {
    ...inner,
    async create(data) {
      if (data.model !== MODEL) return inner.create(data);
      const r = await inner.create({ ...data, data: encryptFields(data.data, key) });
      return decryptFields(r, key);
    },
    async update(data) {
      if (data.model !== MODEL) return inner.update(data);
      const r = await inner.update({ ...data, update: encryptFields(data.update, key) });
      return decryptFields(r, key);
    },
    async updateMany(data) {
      if (data.model !== MODEL) return inner.updateMany(data);
      return inner.updateMany({ ...data, update: encryptFields(data.update, key) });
    },
    async findOne(data) {
      const r = await inner.findOne(data);
      return data.model === MODEL ? decryptFields(r, key) : r;
    },
    async findMany(data) {
      const rs = await inner.findMany(data);
      if (data.model === MODEL) for (const r of rs) decryptFields(r, key);
      return rs;
    },
  } as A;
}
