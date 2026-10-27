// @chartwarden/auth · identity — encrypting Better Auth adapter decorator (M2, ADR-0034 §1).
//
// Wraps the Drizzle adapter so the `twoFactor` model's `secret` + `backupCodes` are sealed (AES-256-GCM,
// two-factor-crypto.ts) on write and opened on read — at-rest encryption Better Auth's plugin doesn't do
// itself. Every OTHER method + model passes through untouched (spread of `inner`). The decorator operates
// on Better Auth MODEL field names (`secret`/`backupCodes`); the Drizzle field-map (in createIdentityAuth)
// routes those to M1's `secret_encrypted`/`backup_codes_encrypted` columns.
//
// SECURITY: it must cover EVERY twoFactor read/write path — a missed one would store/return plaintext.
// The covered paths are create/update/updateMany/incrementOne (write) + findOne/findMany (read); delete/
// deleteMany/count/consumeOne carry no secret payload. The live lane asserts ciphertext-at-rest (ADR-0034 §4).
//
// incrementOne matters since better-auth 1.7: /two-factor/verify-backup-code redeems a code with a
// compare-and-swap, `where backupCodes = <what findOne returned>` + `set backupCodes = <new list>`. That
// where-value is the opened plaintext, but the column holds ciphertext (a fresh seal never equals it — random
// IV), so the swap is made against the STORED ciphertext after checking it opens to the plaintext sent.
import { isSealed, open, seal } from "./two-factor-crypto";

const MODEL = "twoFactor";
const FIELDS = ["secret", "backupCodes"] as const;

/** Minimal slice of Better Auth's adapter the decorator touches; the rest passes through via spread. */
export interface EncryptableAdapter {
  create(data: { model: string; data: Record<string, unknown>; [k: string]: unknown }): Promise<
    Record<string, unknown>
  >;
  update(data: {
    model: string;
    update: Record<string, unknown>;
    [k: string]: unknown;
  }): Promise<Record<string, unknown> | null>;
  updateMany(data: {
    model: string;
    update: Record<string, unknown>;
    [k: string]: unknown;
  }): Promise<number>;
  /** Better Auth ≥ 1.7's atomic compare-and-swap; absent on an adapter that predates it. */
  incrementOne?(data: {
    model: string;
    where: { field: string; value: unknown; [k: string]: unknown }[];
    set?: Record<string, unknown>;
    [k: string]: unknown;
  }): Promise<Record<string, unknown> | null>;
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

/**
 * Decorate an adapter so the `twoFactor` secret + backup codes are encrypted at rest. `getKey` is called
 * LAZILY (memoized) on the first twoFactor operation — so creating the auth instance never requires the
 * key (the config test / password sign-in don't touch 2FA); fail-closed happens at 2FA-enrollment time.
 */
export function withTwoFactorEncryption<A extends EncryptableAdapter>(
  inner: A,
  getKey: () => Buffer,
): A {
  let cached: Buffer | undefined;
  const key = (): Buffer => {
    cached ??= getKey();
    return cached;
  };
  return {
    ...inner,
    async create(data) {
      if (data.model !== MODEL) return inner.create(data);
      const r = await inner.create({ ...data, data: encryptFields(data.data, key()) });
      return decryptFields(r, key());
    },
    async update(data) {
      if (data.model !== MODEL) return inner.update(data);
      const r = await inner.update({ ...data, update: encryptFields(data.update, key()) });
      return decryptFields(r, key());
    },
    async updateMany(data) {
      if (data.model !== MODEL) return inner.updateMany(data);
      return inner.updateMany({ ...data, update: encryptFields(data.update, key()) });
    },
    async incrementOne(data) {
      const run = inner.incrementOne;
      if (!run) throw new Error("withTwoFactorEncryption: the inner adapter has no incrementOne");
      if (data.model !== MODEL) return run.call(inner, data);
      const isSecretField = (field: string): boolean =>
        (FIELDS as readonly string[]).includes(field);
      const plainWhere = data.where.filter((w) => !isSecretField(w.field));
      const secretWhere = data.where.filter((w) => isSecretField(w.field));
      let where = data.where;
      if (secretWhere.length > 0) {
        const stored = await inner.findOne({ model: MODEL, where: plainWhere });
        if (!stored) return null;
        // Compare in plaintext, but swap against the stored ciphertext so the update stays atomic.
        where = [...plainWhere];
        for (const w of secretWhere) {
          const cell = stored[w.field];
          if (typeof cell === "string" && isSealed(cell)) {
            if (open(cell, key()) !== w.value) return null;
            where.push({ ...w, value: cell });
          } else {
            if (cell !== w.value) return null;
            where.push(w);
          }
        }
      }
      const r = await run.call(inner, {
        ...data,
        where,
        ...(data.set ? { set: encryptFields(data.set, key()) } : {}),
      });
      return decryptFields(r, key());
    },
    async findOne(data) {
      const r = await inner.findOne(data);
      return data.model === MODEL ? decryptFields(r, key()) : r;
    },
    async findMany(data) {
      const rs = await inner.findMany(data);
      if (data.model === MODEL) for (const r of rs) decryptFields(r, key());
      return rs;
    },
  } as A;
}
