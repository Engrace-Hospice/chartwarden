// apps/backend/src/modules/05-patient/identifiers/identifier-cipher.ts — GAP-010: the per-tenant DEK envelope
// over `patient_identifier.value_encrypted` (M5 §2.2: ssn / state_id) plus the SSN BLIND INDEX that lets the §2.3
// matcher test "is this SSN already on file?" without decrypting a single row.
//
// ENVELOPE (bytea, because the column is bytea):
//     0x01 | verLen(1) | dekVersion (utf8) | nonce(12) | tag(16) | ciphertext
// AES-256-GCM under the tenant's M34 DEK. The key provider is INJECTED (structural, the M22 / M18 / M20 precedent:
// M5 has no edge on M34; the composition root binds `getTenantKeyProvider()` lazily). The DEK VERSION travels inside
// the envelope, so a rotated key ring still opens historical rows (`dekForOrgVersion`).
//
// AAD = (module, table, column, org, IDENTIFIER ROW ID, kind). Binding the row id stops a ciphertext being moved
// between rows or tenants; binding the kind stops an ssn blob being presented as a state_id. It binds the row and
// NOT the patient, so a future merge repoint of `patient_id` does not break decryption.
//
// FAIL CLOSED. With no bound / active key ring, `seal` throws `IdentifierCipherUnboundError`: there is no plaintext
// fallback (the CHECK `patient_identifier_sensitive_encrypted` forbids it too). On read, a missing / destroyed key,
// an unknown version, or an envelope that fails GCM authentication all THROW — never return a guess.
//
// BLIND INDEX. token = HMAC-SHA256(indexKey, "ssn:" + nineDigits), indexKey = HKDF-SHA256(ikm = tenant DEK at
// version v, info = INDEX_LABEL + orgId; see the label constants below). It is keyed by a secret that is not in the database,
// so a DB-only compromise or a restored backup yields tokens that cannot be brute-forced over the 10^9 SSN space,
// and it derives from the DEK, so the M34 cryptographic shred destroys the index together with the ciphertext (a
// platform-wide index key would survive a shred). Per tenant: equal SSNs in two tenants give different tokens.
// Inherent, accepted leak: inside one tenant equal SSNs have equal tokens (RLS scopes it, the audit trigger scrubs it).
//
// NEVER LOGGED. Plaintext is only ever a local argument; every error carries ids / versions, never a value.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/** The slice of M34's `TenantKeyProvider` this cipher needs (structural — M5 has no M34 edge). */
export interface IdentifierKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

/** The identifier kinds that are envelope-encrypted (mirrors `SENSITIVE_KINDS` on the read side). */
export type SensitiveIdentifierKind = "ssn" | "state_id";

export interface SealedIdentifier {
  readonly ciphertext: Buffer;
  readonly dekVersion: string;
}

export interface BlindIndexToken {
  readonly token: Buffer;
  readonly dekVersion: string;
}

export interface PatientIdentifierCipher {
  /** Encrypt under the org's CURRENT DEK. Throws `IdentifierCipherUnboundError` when no key is bound. */
  seal(
    organizationId: string,
    identifierId: string,
    kind: SensitiveIdentifierKind,
    plaintext: string,
  ): Promise<SealedIdentifier>;
  /** Decrypt. Throws on a missing key, an unknown version, or an envelope that fails authentication. */
  open(
    organizationId: string,
    identifierId: string,
    kind: SensitiveIdentifierKind,
    ciphertext: Buffer,
  ): Promise<string>;
  /** The SSN blind-index token under the current DEK (or under `dekVersion` when given). */
  blindIndex(
    organizationId: string,
    ssnDigits: string,
    dekVersion?: string,
  ): Promise<BlindIndexToken>;
  /** Every token a stored row could carry, for each listed DEK version (the multi-version matcher probe). */
  blindIndexesForVersions(
    organizationId: string,
    ssnDigits: string,
    versions: readonly string[],
  ): Promise<Map<string, readonly Buffer[]>>;
}

/** No usable per-tenant DEK: unbound platform KEK, absent or destroyed key ring. The route maps it to 503. */
export class IdentifierCipherUnboundError extends Error {
  constructor(action: "seal" | "open" | "index") {
    super(
      `no per-tenant DEK is available for M5 sensitive identifiers, so the identifier cannot be ${
        action === "seal"
          ? "stored encrypted (refused rather than written in the clear)"
          : action === "open"
            ? "decrypted"
            : "indexed"
      }`,
    );
    this.name = "IdentifierCipherUnboundError";
  }
}

/** A stored envelope that is malformed or fails GCM authentication (tampering, a moved row, a wrong tenant). */
export class IdentifierCipherIntegrityError extends Error {
  constructor() {
    super("the stored identifier envelope could not be authenticated");
    this.name = "IdentifierCipherIntegrityError";
  }
}

const ENVELOPE_SCHEME = 0x01;
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
/** GCM tag length, pinned on decrypt: without it Node accepts a truncated (4-15 byte) tag. */
const TAG_BYTES = 16;
const MAX_VERSION_BYTES = 255;
const INDEX_KEY_BYTES = 32;

// Cryptographic context labels (the ChartWarden rename is complete: the legacy `wardenx:` labels are no longer readable).
const AAD_LABEL = "chartwarden:m5:patient_identifier:value_encrypted:v1:";
const INDEX_LABEL = "chartwarden:m5:ssn-blind-index:v1:";

const aadFor = (
  label: string,
  organizationId: string,
  identifierId: string,
  kind: SensitiveIdentifierKind,
): Buffer => Buffer.from(`${label}${organizationId}:${identifierId}:${kind}`, "utf8");

async function currentDek(
  keys: IdentifierKeyProvider,
  organizationId: string,
  action: "seal" | "index",
): Promise<{ version: string; key: Buffer }> {
  try {
    return await keys.dekForOrg(organizationId);
  } catch {
    throw new IdentifierCipherUnboundError(action);
  }
}

async function dekAtVersion(
  keys: IdentifierKeyProvider,
  organizationId: string,
  version: string,
  action: "open" | "index",
): Promise<{ version: string; key: Buffer }> {
  try {
    return await keys.dekForOrgVersion(organizationId, version);
  } catch {
    throw new IdentifierCipherUnboundError(action);
  }
}

function assertDek(key: Buffer): void {
  if (key.byteLength !== DEK_BYTES) throw new Error("tenant DEK must be 32 bytes");
}

function tokenFor(key: Buffer, organizationId: string, ssnDigits: string, label: string): Buffer {
  assertDek(key);
  const indexKey = Buffer.from(
    hkdfSync(
      "sha256",
      key,
      Buffer.alloc(0),
      Buffer.from(`${label}${organizationId}`, "utf8"),
      INDEX_KEY_BYTES,
    ),
  );
  return createHmac("sha256", indexKey).update(`ssn:${ssnDigits}`, "utf8").digest();
}

function packEnvelope(version: string, nonce: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const versionBytes = Buffer.from(version, "utf8");
  if (versionBytes.byteLength === 0 || versionBytes.byteLength > MAX_VERSION_BYTES) {
    throw new Error("tenant DEK version must be 1-255 bytes");
  }
  return Buffer.concat([
    Buffer.from([ENVELOPE_SCHEME, versionBytes.byteLength]),
    versionBytes,
    nonce,
    tag,
    ct,
  ]);
}

interface ParsedEnvelope {
  readonly version: string;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ct: Buffer;
}

function parseEnvelope(envelope: Buffer): ParsedEnvelope {
  if (envelope.byteLength < 2 || envelope[0] !== ENVELOPE_SCHEME) {
    throw new IdentifierCipherIntegrityError();
  }
  const versionLength = envelope[1] as number;
  const nonceStart = 2 + versionLength;
  const tagStart = nonceStart + NONCE_BYTES;
  const ctStart = tagStart + TAG_BYTES;
  if (versionLength === 0 || envelope.byteLength < ctStart) {
    throw new IdentifierCipherIntegrityError();
  }
  return {
    version: envelope.subarray(2, nonceStart).toString("utf8"),
    nonce: envelope.subarray(nonceStart, tagStart),
    tag: envelope.subarray(tagStart, ctStart),
    ct: envelope.subarray(ctStart),
  };
}

/** Build the M5 identifier cipher over one tenant key provider. */
export function createPatientIdentifierCipher(
  keys: IdentifierKeyProvider,
): PatientIdentifierCipher {
  return {
    async seal(organizationId, identifierId, kind, plaintext) {
      const { version, key } = await currentDek(keys, organizationId, "seal");
      assertDek(key);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadFor(AAD_LABEL, organizationId, identifierId, kind));
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        ciphertext: packEnvelope(version, nonce, cipher.getAuthTag(), ct),
        dekVersion: version,
      };
    },

    async open(organizationId, identifierId, kind, ciphertext) {
      const parsed = parseEnvelope(ciphertext);
      const { key } = await dekAtVersion(keys, organizationId, parsed.version, "open");
      assertDek(key);
      // A failure is one generic integrity error that names no label.
      const decipher = createDecipheriv("aes-256-gcm", key, parsed.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aadFor(AAD_LABEL, organizationId, identifierId, kind));
      decipher.setAuthTag(parsed.tag);
      try {
        return Buffer.concat([decipher.update(parsed.ct), decipher.final()]).toString("utf8");
      } catch {
        throw new IdentifierCipherIntegrityError();
      }
    },

    async blindIndex(organizationId, ssnDigits, dekVersion) {
      const { version, key } =
        dekVersion === undefined
          ? await currentDek(keys, organizationId, "index")
          : await dekAtVersion(keys, organizationId, dekVersion, "index");
      return {
        token: tokenFor(key, organizationId, ssnDigits, INDEX_LABEL),
        dekVersion: version,
      };
    },

    async blindIndexesForVersions(organizationId, ssnDigits, versions) {
      const tokens = new Map<string, readonly Buffer[]>();
      for (const version of new Set(versions)) {
        const { key } = await dekAtVersion(keys, organizationId, version, "index");
        tokens.set(version, [tokenFor(key, organizationId, ssnDigits, INDEX_LABEL)]);
      }
      return tokens;
    },
  };
}

/** Resolves `getTenantKeyProvider()` lazily (M34 registers it during boot, after the routes are mounted). */
export function lazyIdentifierKeys(resolve: () => IdentifierKeyProvider): IdentifierKeyProvider {
  return {
    dekForOrg: (organizationId) => resolve().dekForOrg(organizationId),
    dekForOrgVersion: (organizationId, version) =>
      resolve().dekForOrgVersion(organizationId, version),
  };
}

/** A cipher that refuses everything — the default until the composition root binds a real one. */
export const UNBOUND_IDENTIFIER_CIPHER: PatientIdentifierCipher = {
  async seal() {
    throw new IdentifierCipherUnboundError("seal");
  },
  async open() {
    throw new IdentifierCipherUnboundError("open");
  },
  async blindIndex() {
    throw new IdentifierCipherUnboundError("index");
  },
  async blindIndexesForVersions() {
    throw new IdentifierCipherUnboundError("index");
  },
};
