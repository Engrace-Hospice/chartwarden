import {
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MAX_SCAN_PER_REQUEST,
} from "@chartwarden/messaging";
// apps/backend/src/modules/36-messaging/routes/search-typebox.ts - WP 2.7a in-conversation search schemas.
import { Type } from "@sinclair/typebox";
import { ResolvedMessageSchema } from "./messaging-typebox";

/** Lengths only here; the word count and minimum are the service's rule (one 422 code for every bad query). */
export const SearchMessagesQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: SEARCH_MAX_QUERY_LENGTH * 2 })),
  senderUserId: Type.Optional(Type.String({ maxLength: 64 })),
  from: Type.Optional(Type.String({ maxLength: 40 })),
  to: Type.Optional(Type.String({ maxLength: 40 })),
  hasAttachment: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_MAX_PAGE_SIZE })),
});

export const SearchMessagesResponseSchema = Type.Object({
  results: Type.Array(ResolvedMessageSchema),
  nextCursor: Type.Optional(Type.String()),
  scanned: Type.Integer({ minimum: 0, maximum: SEARCH_MAX_SCAN_PER_REQUEST }),
  scanCapped: Type.Boolean(),
  patientId: Type.Union([Type.String(), Type.Null()]),
});
