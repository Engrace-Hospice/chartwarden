// apps/backend/src/modules/36-messaging/routes/idg-discussion-typebox.ts - WP 3.6 request/response schemas.
import { pageLimit } from "@chartwarden/shared/route-kit";
import { Type } from "@sinclair/typebox";
import { ResolvedMessageSchema } from "./messaging-typebox";

export const IdgDiscussionQuerySchema = Type.Object({
  limit: pageLimit({ max: 100 }),
});

export const IdgDiscussionListResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  discussions: Type.Array(ResolvedMessageSchema),
  patientId: Type.Union([Type.String(), Type.Null()]),
});
