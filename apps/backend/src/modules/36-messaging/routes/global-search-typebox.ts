// apps/backend/src/modules/36-messaging/routes/global-search-typebox.ts - WP 2.7b global search schemas (ADR-0058, Proposed).
import { Type } from "@sinclair/typebox";
import { ResolvedMessageSchema } from "./messaging-typebox";

/**
 * `q` and `cursor` are lengths only here: the term rules (3+ letters, at most 8 distinct words, no ids or numbers) and the
 * cursor shape are the service's, so every bad query answers the one 422 INVALID_SEARCH_QUERY.
 */
export const GlobalSearchQuerySchema = Type.Object({
  q: Type.String({ maxLength: 256 }),
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const GlobalSearchHitSchema = Type.Intersect([
  ResolvedMessageSchema,
  Type.Object({ archived: Type.Boolean() }),
]);

// `results` stays the FIRST property: the read-audit hook records the count of the first array it finds.
export const GlobalSearchResponseSchema = Type.Object({
  results: Type.Array(GlobalSearchHitSchema),
  nextCursor: Type.Optional(Type.String()),
  scanned: Type.Integer({ minimum: 0 }),
  scanCapped: Type.Boolean(),
  refine: Type.Boolean(),
});
