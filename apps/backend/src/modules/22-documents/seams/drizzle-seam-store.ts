// apps/backend/src/modules/22-documents/seams/drizzle-seam-store.ts — GAP-095. The Drizzle-backed
// {@link DocumentSeamStore}: the REAL write side of the §7.2 W2 render handshake, closing the gap the
// in-memory default (store.ts's `createInMemoryDocumentSeamStore`) left open in every production boot.
//
// Until this file, `registerDocumentSeams`'s ONE production call site (index.ts) passed `readers` (a real
// Drizzle store over `document`/`document_version`) and `objects` (a real S3 client) but never `store:` —
// so every render's resulting row landed in a private per-process Map the Drizzle-backed reader seams
// (built over a DIFFERENT port instance querying the real tables) could never see. This store closes that
// gap by writing the SAME tables `createDrizzleDocumentReaderStore` reads — a render is now visible to
// every reader seam the moment the transaction commits, not "after someone builds this file."
//
// TENANCY (mirrors `createDrizzleDocumentEraseStore`'s `inOrg` precedent EXACTLY): renders happen from
// BACKGROUND WORKERS (GAP-048 DSAR, GAP-094 tenant-export) as often as from an inbound request, and
// `DocumentRenderer`/this store are constructed ONCE at boot over the base pool — there is no ambient
// per-request context to read here (unlike `createDrizzleDocumentReaderStore`'s `withOrgContextFromRequest`
// reads). Each method opens its OWN `withOrgContext(db, {organizationId, userId: ""}, fn)` from the
// explicit `organizationId` the caller already carries (RenderUpsert.organizationId / the read args) — the
// M4 write-audit trigger NULLIFs the empty `userId` (a system-driven write, not a user action).
//
// ACTOR SENTINEL: `document.created_by_membership_id` is NOT NULL but carries no SQL FK (a plain
// app-validated uuid) — and the render handshake (`DocumentRenderer.render(scope, templateKey, payload)`)
// carries no actor identity at all today (no source module's render call threads one through). Rather than
// widen that leaf-typed seam contract for every caller, this store uses the SAME all-zero sentinel
// convention already established for "no real actor" uuid columns elsewhere (`DEIDENTIFIED_UUID`,
// `ERASED_PATIENT_SENTINEL`). `document_version.uploaded_by_membership_id` stays genuinely NULL
// (`uploaded_by_kind = 'system_render'`, satisfying the table's own CHECK constraint) — the honest value,
// not a sentinel, since that column IS nullable for exactly this case.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, desc, eq } from "drizzle-orm";
import type { DocumentSeamStore, RenderUpsert, RenderedDocumentRow } from "./store";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** `document.created_by_membership_id`'s "no real actor" sentinel (a system render, not a user action) —
 *  the same all-zero convention `DEIDENTIFIED_UUID`/`ERASED_PATIENT_SENTINEL` already use elsewhere. */
export const RENDER_SYSTEM_MEMBERSHIP_ID = "00000000-0000-0000-0000-000000000000";

export function createDrizzleDocumentSeamStore(db: DbClient): DocumentSeamStore {
  const DOC = schema.documents;
  const VER = schema.documentVersions;

  const inOrg = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, fn);

  return {
    async upsertRenderedDocument(input: RenderUpsert): Promise<RenderedDocumentRow> {
      return inOrg(input.organizationId, async (tx) => {
        const renderedAt = new Date(input.renderedAt);

        // Lock the existing document (if any) for the duration of the version-append race window —
        // mirrors verified-upload.ts's `for update` precedent for the identical document/version shape.
        const [existing] = await tx
          .select({ id: DOC.id, status: DOC.status })
          .from(DOC)
          .where(
            and(
              eq(DOC.organizationId, input.organizationId),
              eq(DOC.aggregateType, input.aggregateType),
              eq(DOC.aggregateId, input.aggregateId),
            ),
          )
          .limit(1)
          .for("update");

        if (existing) {
          // Mirrors verified-upload.ts's immutability guard for the identical document/version shape — a
          // held/destroyed document's active version must never move underneath a legal hold or tombstone.
          if (existing.status === "legal_hold" || existing.status === "destroyed_tombstone") {
            throw new ChartWardenError(
              "DOCUMENT_IMMUTABLE",
              `document ${existing.id} cannot accept a new rendered version (status: ${existing.status})`,
              409,
            );
          }
          // W2 addendum/correction: a NEW immutable version on the SAME document, never a new document.
          const versions = await tx
            .select({ versionNumber: VER.versionNumber })
            .from(VER)
            .where(eq(VER.documentId, existing.id));
          const versionNumber =
            versions.reduce((max, v) => Math.max(max, Number(v.versionNumber)), 0) + 1;

          const [version] = await tx
            .insert(VER)
            .values({
              organizationId: input.organizationId,
              documentId: existing.id,
              versionNumber: String(versionNumber),
              minioObjectKey: input.objectKey,
              mimeType: input.mimeType,
              byteSize: String(input.byteSize),
              sha256Hex: input.sha256Hex,
              uploadedByMembershipId: null,
              uploadedByKind: "system_render",
              sourceEventId: input.sourceEventId ?? null,
              createdAt: renderedAt,
            })
            .returning({ id: VER.id });
          if (!version) throw new Error("document_version insert returned no row");

          await tx
            .update(DOC)
            .set({ activeVersionId: version.id, title: input.title, updatedAt: renderedAt })
            .where(eq(DOC.id, existing.id));

          return {
            documentId: existing.id,
            versionId: version.id,
            versionNumber,
            isFirstVersion: false,
            renderedAt: input.renderedAt,
          };
        }

        const [doc] = await tx
          .insert(DOC)
          .values({
            organizationId: input.organizationId,
            patientId: input.patientId,
            retentionClass: input.retentionClass,
            sourceKind: "form_render",
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            title: input.title,
            createdByMembershipId: RENDER_SYSTEM_MEMBERSHIP_ID,
            createdAt: renderedAt,
            updatedAt: renderedAt,
          })
          .returning({ id: DOC.id });
        if (!doc) throw new Error("document insert returned no row");

        const [version] = await tx
          .insert(VER)
          .values({
            organizationId: input.organizationId,
            documentId: doc.id,
            versionNumber: "1",
            minioObjectKey: input.objectKey,
            mimeType: input.mimeType,
            byteSize: String(input.byteSize),
            sha256Hex: input.sha256Hex,
            uploadedByMembershipId: null,
            uploadedByKind: "system_render",
            sourceEventId: input.sourceEventId ?? null,
            createdAt: renderedAt,
          })
          .returning({ id: VER.id });
        if (!version) throw new Error("document_version insert returned no row");

        await tx.update(DOC).set({ activeVersionId: version.id }).where(eq(DOC.id, doc.id));

        return {
          documentId: doc.id,
          versionId: version.id,
          versionNumber: 1,
          isFirstVersion: true,
          renderedAt: input.renderedAt,
        };
      });
    },

    async renderedDocumentForAggregate(args) {
      return inOrg(args.organizationId, async (tx) => {
        const [doc] = await tx
          .select({ id: DOC.id, activeVersionId: DOC.activeVersionId })
          .from(DOC)
          .where(
            and(
              eq(DOC.organizationId, args.organizationId),
              eq(DOC.aggregateType, args.aggregateType),
              eq(DOC.aggregateId, args.aggregateId),
            ),
          )
          .limit(1);
        if (!doc || !doc.activeVersionId) return null;

        const [version] = await tx
          .select({ id: VER.id, versionNumber: VER.versionNumber, createdAt: VER.createdAt })
          .from(VER)
          .where(eq(VER.id, doc.activeVersionId))
          .orderBy(desc(VER.createdAt))
          .limit(1);
        if (!version) return null;

        return {
          documentId: doc.id,
          versionId: version.id,
          // `document_version.version_number` is a TEXT column ("app-side serial"), and
          // `RenderedDocumentRow.versionNumber` is a number — the upsert path already narrows the same
          // way, so the read must too or the two halves of this port disagree on the type.
          versionNumber: Number(version.versionNumber),
          renderedAt: version.createdAt.toISOString(),
        };
      });
    },

    async documentVersionForSourceEvent(args) {
      return inOrg(args.organizationId, async (tx) => {
        const [version] = await tx
          .select({
            id: VER.id,
            documentId: VER.documentId,
            versionNumber: VER.versionNumber,
            createdAt: VER.createdAt,
          })
          .from(VER)
          .where(
            and(
              eq(VER.organizationId, args.organizationId),
              eq(VER.sourceEventId, args.sourceEventId),
            ),
          )
          .limit(1);
        if (!version) return null;
        return {
          documentId: version.documentId,
          versionId: version.id,
          versionNumber: Number(version.versionNumber),
          renderedAt: version.createdAt.toISOString(),
        };
      });
    },
  };
}
