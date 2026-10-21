// apps/backend/src/modules/05-patient/identifiers/sensitive-identifiers-db.ts — GAP-010: the envelope-encrypted
// write/read path for `patient_identifier` rows of kind ssn / state_id (M5 §2.2, §4.3, §4.7).
//
// SPLIT IN TWO ON PURPOSE. `prepareSensitiveIdentifier` is the only step that can fail for key reasons (an unbound or
// destroyed key ring answers `IdentifierCipherUnboundError`); it touches NO table, so callers run it BEFORE their first
// insert and a missing key refuses the whole request without a half-written patient. `insertPreparedIdentifier` is the
// plain INSERT of what was prepared.
//
// The plaintext exists only as a local argument here. Nothing in this file logs it, puts it in an error, an audit
// context or an outbox payload; the audit trigger scrubs `value`, `value_encrypted`, `value_last4`,
// `value_blind_index` and `value_dek_version` from the row snapshot.
import { audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { NotFoundError, ValidationError } from "@chartwarden/types";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { PatientIdentifierCipher, SensitiveIdentifierKind } from "./identifier-cipher";
import { lastFour, requireValidSsn } from "./ssn";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const ID = schema.patientIdentifiers;

/** Longest state-id value M5 stores (driver's-licence numbers run well under this). */
const STATE_ID_MAX_LENGTH = 32;
const US_STATE_CODE = /^[A-Za-z]{2}$/;

export const SENSITIVE_IDENTIFIER_KINDS: readonly SensitiveIdentifierKind[] = ["ssn", "state_id"];

export function isSensitiveKind(kind: string): kind is SensitiveIdentifierKind {
  return (SENSITIVE_IDENTIFIER_KINDS as readonly string[]).includes(kind);
}

/** What the caller asked to store (raw, unvalidated). */
export interface SensitiveIdentifierRequest {
  readonly kind: SensitiveIdentifierKind;
  readonly value: string;
  /** state_id only: the issuing state's 2-letter code. */
  readonly issuer?: string | null;
}

/** An identifier validated, sealed and (for ssn) indexed — ready to INSERT. Holds no plaintext. */
export interface PreparedSensitiveIdentifier {
  readonly id: string;
  readonly kind: SensitiveIdentifierKind;
  readonly valueLast4: string;
  readonly valueEncrypted: Buffer;
  readonly valueBlindIndex: Buffer | null;
  readonly valueDekVersion: string;
  readonly issuer: string | null;
}

/** The caller-safe record of a stored sensitive identifier (never the value). */
export interface StoredSensitiveIdentifier {
  readonly id: string;
  readonly kind: SensitiveIdentifierKind;
  readonly valueLast4: string;
}

function invalid(field: string, code: string, message: string): ValidationError {
  return new ValidationError(message, [{ field, code, message }]);
}

/** Validate + normalize a state-id request into its stored value and issuer. Messages never echo the value. */
function normalizeStateId(request: SensitiveIdentifierRequest): { value: string; issuer: string } {
  const issuer = request.issuer?.trim() ?? "";
  if (!US_STATE_CODE.test(issuer)) {
    throw invalid("issuer", "REQUIRED", "a state id needs the issuing state's 2-letter code");
  }
  const value = request.value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (value.length === 0 || value.length > STATE_ID_MAX_LENGTH) {
    throw invalid("value", "STATE_ID_INVALID", "state id is not a valid identifier number");
  }
  return { value, issuer: issuer.toUpperCase() };
}

/**
 * Validate and seal an identifier under the org's current DEK. For an SSN the blind index is computed under the SAME
 * DEK version the ciphertext was sealed under (`value_dek_version` is true for both). Writes nothing.
 */
export async function prepareSensitiveIdentifier(
  cipher: PatientIdentifierCipher,
  organizationId: string,
  request: SensitiveIdentifierRequest,
): Promise<PreparedSensitiveIdentifier> {
  const id = crypto.randomUUID();
  if (request.kind === "ssn") {
    const digits = requireValidSsn(request.value);
    const sealed = await cipher.seal(organizationId, id, "ssn", digits);
    const index = await cipher.blindIndex(organizationId, digits, sealed.dekVersion);
    return {
      id,
      kind: "ssn",
      valueLast4: lastFour(digits),
      valueEncrypted: sealed.ciphertext,
      valueBlindIndex: index.token,
      valueDekVersion: sealed.dekVersion,
      issuer: null,
    };
  }
  const { value, issuer } = normalizeStateId(request);
  const sealed = await cipher.seal(organizationId, id, "state_id", value);
  return {
    id,
    kind: "state_id",
    valueLast4: lastFour(value),
    valueEncrypted: sealed.ciphertext,
    valueBlindIndex: null,
    valueDekVersion: sealed.dekVersion,
    issuer,
  };
}

/** INSERT a prepared identifier (`value` stays NULL: the CHECK `patient_identifier_sensitive_encrypted`). */
export async function insertPreparedIdentifier(
  tx: Tx,
  organizationId: string,
  patientId: string,
  prepared: PreparedSensitiveIdentifier,
  effectiveFrom: string,
): Promise<StoredSensitiveIdentifier> {
  await tx.insert(ID).values({
    id: prepared.id,
    patientId,
    organizationId,
    kind: prepared.kind,
    value: null,
    valueEncrypted: prepared.valueEncrypted,
    valueLast4: prepared.valueLast4,
    valueBlindIndex: prepared.valueBlindIndex,
    valueDekVersion: prepared.valueDekVersion,
    issuer: prepared.issuer,
    effectiveFrom,
  });
  return { id: prepared.id, kind: prepared.kind, valueLast4: prepared.valueLast4 };
}

/** Close the patient's currently-open row of this kind (a new SSN / state id supersedes it). */
export async function supersedeOpenIdentifier(
  tx: Tx,
  patientId: string,
  kind: SensitiveIdentifierKind,
  today: string,
): Promise<void> {
  await tx
    .update(ID)
    .set({ effectiveTo: today })
    .where(and(eq(ID.patientId, patientId), eq(ID.kind, kind), isNull(ID.effectiveTo)));
}

/**
 * The patients (current rows only) whose SSN equals `ssnDigits`, found through the blind index — no row is decrypted.
 * The probe computes the token under EVERY DEK version still on file (usually one), so it is correct after any number
 * of rotations with no re-seal job. Optionally excludes one patient (the one whose SSN was just written).
 */
export async function findSsnHitPatientIds(
  tx: Tx,
  cipher: PatientIdentifierCipher,
  organizationId: string,
  ssnDigits: string,
  excludePatientId?: string,
): Promise<ReadonlySet<string>> {
  const versionRows = (await tx
    .selectDistinct({ version: ID.valueDekVersion })
    .from(ID)
    .where(
      and(eq(ID.kind, "ssn"), isNull(ID.effectiveTo), sql`${ID.valueBlindIndex} IS NOT NULL`),
    )) as Array<{ version: string | null }>;
  const versions = versionRows.flatMap((r) => (r.version ? [r.version] : []));
  if (versions.length === 0) return new Set();
  const tokens = [
    ...(await cipher.blindIndexesForVersions(organizationId, ssnDigits, versions)).values(),
  ];
  const hits = (await tx
    .select({ patientId: ID.patientId })
    .from(ID)
    .where(
      and(
        eq(ID.kind, "ssn"),
        isNull(ID.effectiveTo),
        inArray(ID.valueBlindIndex, tokens),
        excludePatientId ? ne(ID.patientId, excludePatientId) : undefined,
      ),
    )) as Array<{ patientId: string }>;
  return new Set(hits.map((h) => h.patientId));
}

/** The result of a reveal: the cleartext value (the ONLY place it leaves the cipher) and its kind. */
export interface RevealedIdentifier {
  readonly kind: SensitiveIdentifierKind;
  readonly value: string;
}

/** The identifier is not revealable: absent, another patient's, not sensitive, or crypto-shredded. */
export class IdentifierNotRevealableError extends NotFoundError {
  constructor() {
    super("identifier");
    this.name = "IdentifierNotRevealableError";
  }
}

/**
 * Decrypt one sensitive identifier and write the access audit IN THE SAME TRANSACTION as the read. If the audit
 * insert fails the transaction aborts and no value is returned — unlike the best-effort `auditRead` wrapper, which
 * swallows a failed audit insert (so a read could leave no trail). Context carries ids and kind only.
 */
export async function revealSensitiveIdentifier(
  tx: Tx,
  cipher: PatientIdentifierCipher,
  actor: {
    readonly organizationId: string;
    readonly userId: string;
    readonly correlationId: string;
  },
  patientId: string,
  identifierId: string,
): Promise<RevealedIdentifier> {
  const rows = (await tx
    .select({ kind: ID.kind, valueEncrypted: ID.valueEncrypted })
    .from(ID)
    .where(and(eq(ID.id, identifierId), eq(ID.patientId, patientId)))
    .limit(1)) as Array<{ kind: string; valueEncrypted: Buffer | null }>;
  const row = rows[0];
  if (
    !row ||
    !isSensitiveKind(row.kind) ||
    !row.valueEncrypted ||
    row.valueEncrypted.length === 0
  ) {
    throw new IdentifierNotRevealableError();
  }
  // A key that is gone or an envelope that fails authentication THROWS here, before the audit row: no value, no success event.
  const value = await cipher.open(actor.organizationId, identifierId, row.kind, row.valueEncrypted);
  await audit(
    tx,
    {
      organizationId: actor.organizationId,
      userId: actor.userId,
      correlationId: actor.correlationId,
    },
    {
      eventType: "patient_identifier.reveal",
      resourceKind: "patient_identifier",
      resourceId: identifierId,
      outcome: "success",
      severity: "warn",
      context: { patientId, kind: row.kind },
    },
  );
  return { kind: row.kind, value };
}
