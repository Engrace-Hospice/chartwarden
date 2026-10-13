// apps/backend/src/modules/36-messaging/routes/draft-typebox.ts — WP 2.5 draft request/response schemas (kept apart
// from draft-routes.ts so the OpenAPI emitter imports schemas only, not the auth stack).
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Id = Type.String({ minLength: 1, maxLength: 64 });

/** A thread root is a message uuid: a malformed one is a 422 here, never a cast error in the service. */
const RootId = Type.String({ pattern: UUID_PATTERN });

export const DraftQuerySchema = Type.Object({ parentMessageId: Type.Optional(RootId) });

export const SaveDraftBodySchema = Type.Object({
  parentMessageId: Type.Optional(RootId),
  // The service enforces the 8000-character ceiling (422) and treats a blank body as a discard.
  body: Type.String({ maxLength: 100_000 }),
  references: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Union([Type.Literal("staff"), Type.Literal("patient")]),
        entityId: Id,
        start: Type.Integer({ minimum: 0, maximum: 8000 }),
        end: Type.Integer({ minimum: 1, maximum: 8001 }),
      }),
      { maxItems: 25 },
    ),
  ),
  /** Client-minted, stable per browser tab/device (a uuid kept in the tab's session). */
  deviceId: Type.String({ minLength: 1, maxLength: 64 }),
  /** The revision this client last saw; 0 when it has none. */
  baseRevision: Type.Integer({ minimum: 0, maximum: 2_000_000_000 }),
});

export const DraftViewSchema = Type.Object({
  channelId: Type.String(),
  parentMessageId: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  references: Type.Array(
    Type.Object({
      kind: Type.Union([Type.Literal("staff"), Type.Literal("patient")]),
      entityId: Type.String(),
      start: Type.Integer(),
      end: Type.Integer(),
    }),
  ),
  revision: Type.Integer({ minimum: 1 }),
  deviceId: Type.String(),
  updatedAt: Type.String(),
});

export const DraftResponseSchema = Type.Object({
  draft: Type.Union([DraftViewSchema, Type.Null()]),
});
