// @wardenx/billing · repositories — `mac_submitter_credential` (per-ProviderEntity MAC trading-partner
// identifiers + portal credentials, §3.3; non-partitioned; retention class `operational`). ORG-SCOPED;
// VERSIONED (§3.5 "carries `version`; rare-edit; the M34 wizard's upsert serializes via version"); 1:1 per
// provider entity (the `mac_submitter_credential_pe_uq` unique index).
//
// SECRET-CIPHER HANDLING (D13 / §3.6 / M1 §6): `client_secret_cipher` is the portal client secret encrypted
// under the per-tenant DEK; the PLAINTEXT secret NEVER enters this repo — the service encrypts before
// `create`/`updateWithVersion` and the column is denylisted from the M4 audit value stream. To keep the
// ciphertext from leaking into casual read paths, the secret flows through EXACTLY ONE door:
//   * `findById` / `findByProviderEntity` / `listByOrgPage` return the SAFE projection
//     ({@link MacSubmitterCredentialSafeRecord}) — every column EXCEPT `client_secret_cipher`.
//   * `readSecretMaterial` is the ONLY method that returns the cipher (+ DEK version + client id) — the
//     submission/x12-worker auth path that must wrap a portal token. Centralizing it means "the secret has
//     one exit" is enforceable by inspection.
// `mac_jurisdiction` is a DB-native lowercase enum (`ngs_j6` … `noridian_je`) with no domain divergence, so
// it passes through unmapped (the contract types `macJurisdiction` as plain `string`). No PHI / MBI (D13/D18).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq } from "drizzle-orm";
import {
  type BillingDb,
  buildCursorPage,
  type CursorPage,
  decodeCursor,
  keysetBefore,
  pageSizeOf,
  type VersionedUpdateResult,
  versionConflict,
  versionOk,
} from "./db";

const M = schema.macSubmitterCredential;

/** The cipher-free projection: every `mac_submitter_credential` column EXCEPT `client_secret_cipher`. */
export type MacSubmitterCredentialSafeRecord = Omit<schema.MacSubmitterCredential, "clientSecretCipher">;

/** The encrypted-secret material — the ONLY shape that carries the cipher out of this repo. */
export interface MacCredentialSecretMaterial {
  readonly id: string;
  readonly clientId: string;
  readonly clientSecretCipher: string;
  readonly clientSecretDekVersion: number;
}

/** The columns a version-checked edit may set (identifiers, rotated secret, BAA + lifecycle metadata). */
export type MacCredentialUpdatePatch = Partial<
  Pick<
    schema.NewMacSubmitterCredential,
    | "submitterId"
    | "tradingPartnerId"
    | "clientId"
    | "clientSecretCipher"
    | "clientSecretDekVersion"
    | "baaRecordRef"
    | "credentialExpiresAt"
    | "lastSandboxTestAt"
  >
>;

/** Drop the cipher column from a DB row → the safe projection (the single read-boundary redaction). */
function toSafe(row: schema.MacSubmitterCredential): MacSubmitterCredentialSafeRecord {
  const { clientSecretCipher: _omit, ...safe } = row;
  return safe;
}

/** Data port for `mac_submitter_credential` (versioned upsert; secret exits via ONE door only). */
export class MacSubmitterCredentialRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Insert a credential set (the service has already encrypted the client secret to `clientSecretCipher`
   * under the per-tenant DEK). Returns the SAFE projection — never echoes the cipher back.
   */
  async create(values: schema.NewMacSubmitterCredential): Promise<MacSubmitterCredentialSafeRecord> {
    const [row] = await this.db.insert(M).values(values).returning();
    if (!row) throw new Error("mac_submitter_credential insert returned no row");
    return toSafe(row);
  }

  /** Point read by id (SAFE projection — no cipher), or `null`. */
  async findById(id: string): Promise<MacSubmitterCredentialSafeRecord | null> {
    const [row] = await this.db.select().from(M).where(eq(M.id, id)).limit(1);
    return row ? toSafe(row) : null;
  }

  /** The 1:1 credential for a provider entity (SAFE projection — no cipher), or `null`. */
  async findByProviderEntity(
    providerEntityId: string,
  ): Promise<MacSubmitterCredentialSafeRecord | null> {
    const [row] = await this.db
      .select()
      .from(M)
      .where(eq(M.providerEntityId, providerEntityId))
      .limit(1);
    return row ? toSafe(row) : null;
  }

  /**
   * The SECRET door — the ONLY read that returns `client_secret_cipher` (+ DEK version + client id) for the
   * x12-worker / submission auth path to decrypt and exchange for a portal token. Keep callers to the
   * submission path; never surface this to a UI read. Returns `null` if the provider entity has no credential.
   */
  async readSecretMaterial(providerEntityId: string): Promise<MacCredentialSecretMaterial | null> {
    const [row] = await this.db
      .select({
        id: M.id,
        clientId: M.clientId,
        clientSecretCipher: M.clientSecretCipher,
        clientSecretDekVersion: M.clientSecretDekVersion,
      })
      .from(M)
      .where(eq(M.providerEntityId, providerEntityId))
      .limit(1);
    return row ?? null;
  }

  /**
   * One keyset page of an org's credentials (`created_at DESC, id DESC`), SAFE projection — a list view
   * never needs the cipher. Over-fetches `size + 1` rows so {@link buildCursorPage} reveals `hasMore`.
   */
  async listByOrgPage(
    organizationId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<MacSubmitterCredentialSafeRecord>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(M.organizationId, organizationId),
      keysetBefore(M.createdAt, M.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(M)
      .where(where)
      .orderBy(desc(M.createdAt), desc(M.id))
      .limit(size + 1);
    return buildCursorPage(rows.map(toSafe), size, (r) => ({
      createdAt: r.createdAt.toISOString(),
      id: r.id,
    }));
  }

  /**
   * Version-checked edit (§2.5 If-Match / §3.5 wizard upsert serializes via `version`): apply `patch` only
   * when the persisted `version` matches `expectedVersion`, bumping `version` + `updated_at`. A rotated
   * secret arrives pre-encrypted in `patch.clientSecretCipher` (+ `clientSecretDekVersion`). On a version
   * mismatch returns `VERSION_CONFLICT` carrying the current persisted version (or `null` when the row
   * vanished) so the service can surface a 412. Returns the SAFE projection on success.
   */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: MacCredentialUpdatePatch,
  ): Promise<VersionedUpdateResult<MacSubmitterCredentialSafeRecord>> {
    const [row] = await this.db
      .update(M)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(and(eq(M.id, id), eq(M.version, expectedVersion)))
      .returning();
    if (row) return versionOk(toSafe(row));
    const [current] = await this.db
      .select({ version: M.version })
      .from(M)
      .where(eq(M.id, id))
      .limit(1);
    return versionConflict(current?.version ?? null);
  }
}
