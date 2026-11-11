// apps/backend/src/modules/16-bereavement/routes/library-service.ts — the grief-library service interface (ADR-0109 D10, PR 3, routes 77-81).
//
// Owner decision (2026-11-05): library items are uploaded via M22 and are PORTAL-ONLY (families see them in the bereaved portal). Staff upload the
// file through M22's verified upload (aggregate type `bereavement_library_item`, org-level; `video/mp4` allowed for this type only), then register
// it here with its title, summary and category. Only `published` items reach the portal. Every staff route is bereavement oversight.
import type {
  BereavementLibraryCategory,
  BereavementLibraryKind,
  BereavementLibraryStatus,
} from "@chartwarden/types";
import type { M16ReadActor, M16WriteActor } from "./actor";

export interface LibraryItemView {
  readonly itemId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly category: BereavementLibraryCategory;
  readonly kind: BereavementLibraryKind;
  readonly mimeType: string;
  readonly documentId: string;
  readonly transcriptDocumentId: string | null;
  readonly status: BereavementLibraryStatus;
  readonly sortOrder: number;
  readonly publishedAt: string | null;
  /** The `If-Match` token. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LibraryItemFieldsInput {
  readonly title: string;
  readonly summary: string | null;
  readonly category: BereavementLibraryCategory;
  readonly transcriptDocumentId: string | null;
  readonly sortOrder: number;
}

/** A short-lived URL for one library file. Never logged. */
export interface LibraryItemUrlView {
  readonly itemId: string;
  readonly url: string;
  readonly expiresAt: string;
}

export interface M16LibraryService {
  /** Route 77 — every item (any status), portal order. */
  listItems(
    actor: M16ReadActor,
    input: { readonly status?: BereavementLibraryStatus | undefined },
  ): Promise<LibraryItemView[]>;
  /** Route 78 — register an uploaded M22 document as a DRAFT item (kind and MIME come from the document). */
  createItem(
    actor: M16WriteActor,
    input: LibraryItemFieldsInput & { readonly documentId: string },
  ): Promise<LibraryItemView>;
  /** Route 79 — edit an item's metadata. */
  updateItem(
    actor: M16WriteActor,
    itemId: string,
    input: LibraryItemFieldsInput & { readonly expectedVersion: number },
  ): Promise<LibraryItemView>;
  /** Route 80 — draft / published / archived. */
  setStatus(
    actor: M16WriteActor,
    itemId: string,
    input: { readonly status: BereavementLibraryStatus; readonly expectedVersion: number },
  ): Promise<LibraryItemView>;
  /** Route 81 — a staff preview URL for the item's file or its transcript (M22 records the access). */
  itemUrl(
    actor: M16WriteActor,
    itemId: string,
    part: "document" | "transcript",
  ): Promise<LibraryItemUrlView>;
}
