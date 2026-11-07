// apps/backend/src/modules/16-bereavement/routes/library-service-drizzle.ts — the Drizzle-backed grief-library service (ADR-0109 D10, PR 3).
//
// M16 holds the METADATA; the file is an M22 document. Registering checks, through M22's `OrgDocumentAccessProvider.describeOrgDocument`, that the
// document is an active, org-level `bereavement_library_item` (M16 never reads M22's tables), and copies its MIME type: `application/pdf` -> pdf,
// `video/mp4` -> video, anything else -> other. A transcript must be a PDF of the same type. One item per document (409 otherwise). Status changes
// are compare-and-set on `version`; `If-Match` names the version read. A preview URL is minted through the same seam (M22 writes the ledger row).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  BereavementLibraryCategory,
  BereavementLibraryKind,
  BereavementLibraryStatus,
  OrgDocumentAccessProvider,
} from "@chartwarden/types";
import { and, asc, eq } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import { BereavementStateError, checkVersion } from "../lifecycle/index";
import type { M16ReadActor } from "./actor";
import type { LibraryItemFieldsInput, LibraryItemView, M16LibraryService } from "./library-service";

type ItemRow = typeof schema.bereavementLibraryItem.$inferSelect;
const MAX_ITEMS = 500;
const LIBRARY_TYPE = "bereavement_library_item" as const;

export interface M16LibraryDeps {
  /** M22's org-level document seam; defaults to the registry's `OrgDocumentAccessProvider`. */
  readonly orgDocuments?: () => OrgDocumentAccessProvider;
  readonly now?: () => Date;
}

/** Pure: the library kind of a verified MIME type. */
export function libraryKindOf(mimeType: string): BereavementLibraryKind {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "video/mp4") return "video";
  return "other";
}

export function libraryItemView(row: ItemRow): LibraryItemView {
  return {
    itemId: row.id,
    title: row.title,
    summary: row.summary ?? null,
    category: row.category as BereavementLibraryCategory,
    kind: row.kind as BereavementLibraryKind,
    mimeType: row.mimeType,
    documentId: row.documentId,
    transcriptDocumentId: row.transcriptDocumentId ?? null,
    status: row.status as BereavementLibraryStatus,
    sortOrder: row.sortOrder,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Translate an unbound seam into the module's 503. */
async function viaSeam<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && error.name === "NotImplementedError") {
      throw new BereavementStateError(
        "LIBRARY_UNAVAILABLE",
        "the grief library is not available: no document store is bound",
      );
    }
    throw error;
  }
}

export function buildDrizzleM16LibraryService(
  db: DbClient,
  deps: M16LibraryDeps = {},
): M16LibraryService {
  const ITEM = schema.bereavementLibraryItem;
  const now = deps.now ?? (() => new Date());
  const orgDocuments = deps.orgDocuments ?? (() => getSeam("OrgDocumentAccessProvider"));
  const scope = (actor: M16ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });
  const stale = () =>
    new BereavementStateError(
      "STALE_VERSION",
      "the library item has moved on; re-read it and retry",
    );

  async function describe(organizationId: string, documentId: string) {
    const out = await viaSeam(() =>
      orgDocuments().describeOrgDocument({
        organizationId: organizationId as never,
        documentId: documentId as never,
        allowedAggregateTypes: [LIBRARY_TYPE],
      }),
    );
    if ("denied" in out) {
      throw new BereavementStateError(
        "LIBRARY_DOCUMENT_INVALID",
        "that file is not an uploaded grief-library document",
      );
    }
    return out;
  }

  async function assertTranscript(organizationId: string, transcriptId: string | null) {
    if (transcriptId === null) return;
    const t = await describe(organizationId, transcriptId);
    if (t.mimeType !== "application/pdf") {
      throw new BereavementStateError("LIBRARY_DOCUMENT_INVALID", "a transcript must be a PDF");
    }
  }

  async function itemOr404(tx: DbClient, itemId: string): Promise<ItemRow> {
    const [row] = await tx.select().from(ITEM).where(eq(ITEM.id, itemId)).limit(1);
    if (!row) throw new BereavementStateError("LIBRARY_ITEM_NOT_FOUND", "library item not found");
    return row;
  }

  const fields = (input: LibraryItemFieldsInput) => ({
    title: input.title,
    summary: input.summary,
    category: input.category,
    transcriptDocumentId: input.transcriptDocumentId,
    sortOrder: input.sortOrder,
  });

  return {
    async listItems(actor, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const rows = await (scoped as DbClient)
          .select()
          .from(ITEM)
          .where(input.status === undefined ? undefined : eq(ITEM.status, input.status))
          .orderBy(asc(ITEM.sortOrder), asc(ITEM.title), asc(ITEM.id))
          .limit(MAX_ITEMS);
        return rows.map(libraryItemView);
      });
    },

    async createItem(actor, input) {
      if (input.transcriptDocumentId === input.documentId) {
        throw new BereavementStateError(
          "LIBRARY_DOCUMENT_INVALID",
          "a file cannot be its own transcript",
        );
      }
      const doc = await describe(actor.organizationId, input.documentId);
      await assertTranscript(actor.organizationId, input.transcriptDocumentId);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const [row] = await (scoped as DbClient)
          .insert(ITEM)
          .values({
            organizationId: actor.organizationId,
            ...fields(input),
            documentId: input.documentId,
            kind: libraryKindOf(doc.mimeType),
            mimeType: doc.mimeType,
            createdByMembershipId: actor.membershipId,
            version: 1,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) {
          throw new BereavementStateError(
            "LIBRARY_DOCUMENT_TAKEN",
            "that file is already in the library",
          );
        }
        return libraryItemView(row);
      });
    },

    async updateItem(actor, itemId, input) {
      await assertTranscript(actor.organizationId, input.transcriptDocumentId);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = scoped as DbClient;
        const item = await itemOr404(tx, itemId);
        checkVersion(input.expectedVersion, item.version);
        if (input.transcriptDocumentId === item.documentId) {
          throw new BereavementStateError(
            "LIBRARY_DOCUMENT_INVALID",
            "a file cannot be its own transcript",
          );
        }
        const [row] = await tx
          .update(ITEM)
          .set({ ...fields(input), version: item.version + 1, updatedAt: now() })
          .where(and(eq(ITEM.id, item.id), eq(ITEM.version, item.version)))
          .returning();
        if (!row) throw stale();
        return libraryItemView(row);
      });
    },

    async setStatus(actor, itemId, input) {
      // Publishing re-checks the file through the M22 seam (still an active org-level library document; kind and MIME refreshed), requires a
      // transcript for a video (families who cannot hear it are not left out), and re-checks the transcript.
      let refreshed: { readonly mimeType: string } | null = null;
      if (input.status === "published") {
        const current = await withOrgContext(db, scope(actor), (scoped) =>
          itemOr404(scoped as DbClient, itemId),
        );
        refreshed = await describe(actor.organizationId, current.documentId);
        if (
          libraryKindOf(refreshed.mimeType) === "video" &&
          current.transcriptDocumentId === null
        ) {
          throw new BereavementStateError(
            "LIBRARY_TRANSCRIPT_REQUIRED",
            "a video needs a PDF transcript before it can be published",
          );
        }
        await assertTranscript(actor.organizationId, current.transcriptDocumentId);
      }
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = scoped as DbClient;
        const item = await itemOr404(tx, itemId);
        checkVersion(input.expectedVersion, item.version);
        const at = now();
        const [row] = await tx
          .update(ITEM)
          .set({
            ...(refreshed === null
              ? {}
              : { mimeType: refreshed.mimeType, kind: libraryKindOf(refreshed.mimeType) }),
            status: input.status,
            publishedAt: input.status === "published" ? (item.publishedAt ?? at) : item.publishedAt,
            version: item.version + 1,
            updatedAt: at,
          })
          .where(and(eq(ITEM.id, item.id), eq(ITEM.version, item.version)))
          .returning();
        if (!row) throw stale();
        return libraryItemView(row);
      });
    },

    async itemUrl(actor, itemId, part) {
      const item = await withOrgContext(db, scope(actor), (scoped) =>
        itemOr404(scoped as DbClient, itemId),
      );
      const documentId = part === "transcript" ? item.transcriptDocumentId : item.documentId;
      if (documentId === null) {
        throw new BereavementStateError("LIBRARY_ITEM_NOT_FOUND", "this item has no transcript");
      }
      const minted = await viaSeam(() =>
        orgDocuments().mintOrgDownloadUrl({
          organizationId: actor.organizationId as never,
          documentId: documentId as never,
          allowedAggregateTypes: [LIBRARY_TYPE],
        }),
      );
      if ("denied" in minted) {
        throw new BereavementStateError("LIBRARY_DOCUMENT_INVALID", "the file is not available");
      }
      return { itemId: item.id, url: minted.url, expiresAt: minted.expiresAt };
    },
  };
}
