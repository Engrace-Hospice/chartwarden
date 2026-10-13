// apps/backend/src/modules/36-messaging/routes/announcement-typebox.ts — M36 WP 2.9 route schemas (announcement
// receipts + department channels). Separate from messaging-typebox.ts to keep that file under the line ceiling.
import { type Static, Type } from "@sinclair/typebox";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export const AnnouncementParamsSchema = Type.Object({
  messageId: Type.String({ minLength: 1, maxLength: 64 }),
});

export const CreateDepartmentChannelBodySchema = Type.Object({
  kind: Type.Union([Type.Literal("discipline"), Type.Literal("location")]),
  subjectId: Type.String({ pattern: UUID_PATTERN }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
});
export type CreateDepartmentChannelBody = Static<typeof CreateDepartmentChannelBodySchema>;

const Person = Type.Object({ userId: Type.String(), displayName: Type.String() });

export const AnnouncementReceiptsResponseSchema = Type.Object({
  messageId: Type.String(),
  channelId: Type.String(),
  sentAt: Type.String(),
  recipientCount: Type.Integer(),
  readCount: Type.Integer(),
  readers: Type.Array(
    Type.Object({ userId: Type.String(), displayName: Type.String(), readAt: Type.String() }),
  ),
  unread: Type.Array(Person),
  truncated: Type.Boolean(),
});

export const CreateDepartmentChannelResponseSchema = Type.Object({
  channelId: Type.String(),
  created: Type.Boolean(),
});
