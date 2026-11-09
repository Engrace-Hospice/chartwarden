// apps/backend/src/modules/16-bereavement/routes/library-typebox.ts — M16 grief library (ADR-0109 D10, PR 3) request + response schemas, routes
// 77-81. `If-Match` and `Idempotency-Key` ride the headers. The response DTOs are pinned to the service views by `m16-response-dtos.ts`.
import { BEREAVEMENT_LIBRARY_CATEGORIES } from "@chartwarden/types";
import { type TSchema, Type } from "@sinclair/typebox";

const Uuid = Type.String({ format: "uuid" });
const Str = Type.String();
const Int = Type.Integer();
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const literals = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));

export const LibraryCategory = literals(BEREAVEMENT_LIBRARY_CATEGORIES);
export const LibraryKind = literals(["pdf", "video", "other"] as const);
const LibraryStatus = literals(["draft", "published", "archived"] as const);

// ── requests ────────────────────────────────────────────────────────────────────────────────────────

export const LibraryItemParams = Type.Object({ itemId: Uuid });
const LibraryFields = {
  title: Type.String({ minLength: 1, maxLength: 160 }),
  summary: Nullable(Type.String({ maxLength: 1000 })),
  category: LibraryCategory,
  transcriptDocumentId: Nullable(Uuid),
  sortOrder: Type.Integer({ minimum: 0, maximum: 10000 }),
};
/** Route 78 — register an uploaded M22 `bereavement_library_item` document. */
export const CreateLibraryItemBody = Type.Object({ ...LibraryFields, documentId: Uuid });
/** Route 79. */
export const UpdateLibraryItemBody = Type.Object(LibraryFields);
/** Route 80. */
export const SetLibraryStatusBody = Type.Object({ status: LibraryStatus });
export const LibraryListQuerySchema = Type.Object({ status: Type.Optional(LibraryStatus) });
/** Route 81 — the file or its transcript. */
export const LibraryUrlQuerySchema = Type.Object({
  part: Type.Optional(literals(["document", "transcript"] as const)),
});

// ── responses ───────────────────────────────────────────────────────────────────────────────────────

export const LibraryItemResponseSchema = Type.Object({
  itemId: Str,
  title: Str,
  summary: Nullable(Str),
  category: LibraryCategory,
  kind: LibraryKind,
  mimeType: Str,
  documentId: Str,
  transcriptDocumentId: Nullable(Str),
  status: LibraryStatus,
  sortOrder: Int,
  publishedAt: Nullable(Str),
  version: Int,
  createdAt: Str,
  updatedAt: Str,
});
export const LibraryItemListResponseSchema = Type.Array(LibraryItemResponseSchema);
export const LibraryItemUrlResponseSchema = Type.Object({ itemId: Str, url: Str, expiresAt: Str });
