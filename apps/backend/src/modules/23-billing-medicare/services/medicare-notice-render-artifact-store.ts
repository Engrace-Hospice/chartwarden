import { createHash } from "node:crypto";
import { auditRead } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import {
  MedicareNoticeRenderHold,
  type MedicareNoticeArtifactStore,
  type MedicareNoticeKind,
  type MedicareNoticeRenderReservation,
  type RenderedMedicareNotice,
} from "./medicare-notice-renderer";

/** Structural subset of M36's established tenant ring cipher; artifacts require identity-bound AAD. */
export interface MedicareNoticeArtifactCipher {
  sealRing(orgId: string, plaintext: string, aadContext: string): Promise<{ cipher: Buffer; sha256: string; keyVersion: string }>;
  open(orgId: string, cipher: Buffer, aadContext: string, expectedKeyVersion: string): Promise<string>;
}

/** A tenant DEK could not be obtained. This is an availability hold, not evidence of corrupt ciphertext. */
export class MedicareNoticeArtifactKeyUnavailableError extends Error {
  public override readonly name = "MedicareNoticeArtifactKeyUnavailableError";
  constructor() {
    super("Medicare notice artifact key is unavailable");
  }
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const aad = (orgId: string, identityId: string) => `m23-medicare-notice-x12:v1:${orgId}:${identityId}`;

function renderResult(
  row: typeof schema.medicareNoticeRenderIdentity.$inferSelect,
  artifact: typeof schema.medicareNoticeRenderArtifact.$inferSelect,
  x12: string,
): RenderedMedicareNotice {
  return {
    organizationId: row.organizationId,
    noticeId: row.noticeId,
    submissionId: row.submissionId,
    kind: row.noticeKind as MedicareNoticeKind,
    transactionSet: "837",
    usage: row.usage as "test" | "production",
    sourceFingerprint: row.fingerprint,
    routeFingerprint: row.routeFingerprint,
    interchangeControlNumber: row.isa13,
    renderedAt: row.renderedAt,
    renderIdentityId: row.id,
    artifactId: artifact.id,
    artifactSha256: artifact.contentSha256,
    x12,
  };
}

/**
 * Durable PostgreSQL ciphertext store. Encryption happens before the scoped insert; ciphertext + digest + identity
 * reference commit atomically. The unique identity constraint makes concurrent writers converge; conflicting bytes
 * fail closed. Only tenant ring envelopes are accepted, and AAD binds org + render identity.
 */
export function buildDrizzleMedicareNoticeRenderArtifactStore(
  db: DbClient,
  cipher: MedicareNoticeArtifactCipher,
  reportIntegrityFailure?: (input: { organizationId: string; renderIdentityId: string }) => Promise<void>,
): MedicareNoticeArtifactStore {
  const artifacts = schema.medicareNoticeRenderArtifact;
  const identities = schema.medicareNoticeRenderIdentity;

  async function markCorrupt(organizationId: string, artifactId: string): Promise<void> {
    await withOrgContext(db, { organizationId, userId: "" }, (tx) => tx.update(artifacts)
      .set({ state: "corrupt" })
      .where(and(eq(artifacts.organizationId, organizationId), eq(artifacts.id, artifactId))));
  }

  async function decryptAndVerify(input: {
    organizationId: string;
    identity: typeof schema.medicareNoticeRenderIdentity.$inferSelect;
    artifact: typeof schema.medicareNoticeRenderArtifact.$inferSelect;
  }): Promise<RenderedMedicareNotice> {
    const holdIntegrity = async () => {
      if (input.artifact.state === "finalized") await markCorrupt(input.organizationId, input.artifact.id);
      try {
        await reportIntegrityFailure?.({ organizationId: input.organizationId, renderIdentityId: input.identity.id });
      } catch {
        // Preserve the typed dispatch hold even if alert delivery is temporarily unavailable.
      }
      throw new MedicareNoticeRenderHold("NOTICE_ARTIFACT_INTEGRITY_FAILED");
    };
    if (input.artifact.state !== "finalized" || input.artifact.artifactVersion !== "m23-notice-x12-v1") {
      await holdIntegrity();
    }
    let x12: string;
    try {
      x12 = await cipher.open(input.organizationId, input.artifact.ciphertext, aad(input.organizationId, input.identity.id), input.artifact.encryptionKeyVersion);
    } catch (error) {
      if (error instanceof MedicareNoticeArtifactKeyUnavailableError) {
        throw new MedicareNoticeRenderHold("NOTICE_ARTIFACT_KEY_UNAVAILABLE");
      }
      await holdIntegrity();
      throw new MedicareNoticeRenderHold("NOTICE_ARTIFACT_INTEGRITY_FAILED");
    }
    const bytes = Buffer.from(x12, "utf8");
    if (bytes.toString("utf8") !== x12 || bytes.length !== input.artifact.plaintextByteLength ||
        digest(bytes) !== input.artifact.contentSha256) {
      await holdIntegrity();
    }
    return renderResult(input.identity, input.artifact, x12);
  }

  return {
    async recover(request) {
      const found = await withOrgContext(db, { organizationId: request.organizationId, userId: "" }, async (tx) => {
        const identityRows = await tx.select().from(identities).where(and(
          eq(identities.organizationId, request.organizationId),
          eq(identities.noticeId, request.noticeId),
          eq(identities.submissionId, request.submissionId),
          eq(identities.noticeKind, request.kind),
        )).limit(2);
        if (!identityRows.length) return null;
        if (identityRows.length !== 1) throw new MedicareNoticeRenderHold("NOTICE_ARTIFACT_INTEGRITY_FAILED");
        const identity = identityRows[0];
        if (!identity) return null;
        const artifactRows = await tx.select().from(artifacts).where(and(
          eq(artifacts.organizationId, request.organizationId),
          eq(artifacts.renderIdentityId, identity.id),
        )).limit(2);
        if (!artifactRows.length) return null;
        if (artifactRows.length !== 1) throw new MedicareNoticeRenderHold("NOTICE_ARTIFACT_INTEGRITY_FAILED");
        await auditRead(tx, { organizationId: request.organizationId, userId: null, actorKind: "system", correlationId: `m23-notice-artifact:${identity.id}` }, {
          eventType: "m23.medicare_notice_artifact.retrieved",
          resourceKind: "medicare_notice_render_artifact",
          resourceId: artifactRows[0]!.id,
          outcome: "success",
          context: { renderIdentityId: identity.id, noticeKind: identity.noticeKind },
        });
        return { identity, artifact: artifactRows[0]! };
      });
      if (!found) return null;
      return decryptAndVerify({ organizationId: request.organizationId, ...found });
    },

    async persist(input: { reservation: MedicareNoticeRenderReservation; sourceFingerprint: string; x12: string }) {
      const { identity } = input.reservation;
      const bytes = Buffer.from(input.x12, "utf8");
      if (bytes.toString("utf8") !== input.x12 || bytes.length === 0) throw new MedicareNoticeRenderHold("NOTICE_BUILD_REJECTED");
      const rows = await withOrgContext(db, { organizationId: identity.organizationId, userId: "" }, async (tx) => {
        const [storedIdentity] = await tx.select().from(identities).where(and(
          eq(identities.organizationId, identity.organizationId),
          eq(identities.submissionId, identity.submissionId),
        )).limit(1);
        if (!storedIdentity || storedIdentity.noticeId !== identity.noticeId || storedIdentity.noticeKind !== identity.kind ||
            storedIdentity.fingerprint !== input.sourceFingerprint || storedIdentity.providerEntityId !== identity.providerEntityId ||
            storedIdentity.vendor !== identity.vendor || storedIdentity.accountReference !== identity.accountReference ||
            storedIdentity.usage !== identity.usage) {
          throw new MedicareNoticeRenderHold("NOTICE_IDENTITY_CHANGED");
        }
        const identityAad = aad(identity.organizationId, storedIdentity.id);
        // Reseal with the immutable row identity as AAD; no ciphertext is persisted without this binding.
        const bound = await cipher.sealRing(identity.organizationId, input.x12, identityAad);
        await tx.insert(artifacts).values({
          organizationId: identity.organizationId,
          renderIdentityId: storedIdentity.id,
          ciphertext: bound.cipher,
          contentSha256: digest(bytes),
          plaintextByteLength: bytes.length,
          encryptionKeyVersion: bound.keyVersion,
          state: "finalized",
        }).onConflictDoNothing();
        const artifactRows = await tx.select().from(artifacts).where(and(
          eq(artifacts.organizationId, identity.organizationId),
          eq(artifacts.renderIdentityId, storedIdentity.id),
        )).limit(2);
        if (artifactRows.length !== 1) throw new MedicareNoticeRenderHold("NOTICE_ARTIFACT_CONFLICT");
        return { identity: storedIdentity, artifact: artifactRows[0]! };
      });
      const recovered = await decryptAndVerify({ organizationId: identity.organizationId, ...rows });
      if (digest(Buffer.from(recovered.x12, "utf8")) !== digest(bytes)) throw new MedicareNoticeRenderHold("NOTICE_ARTIFACT_CONFLICT");
      return recovered;
    },
  };
}
