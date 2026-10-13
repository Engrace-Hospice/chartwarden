// apps/backend/src/modules/36-messaging/routes/template-typebox.ts - M36 WP 2.8 route schemas for message templates and
// saved replies. Named `*-typebox` (not `*schema*`) so the table-ownership import heuristic never mistakes it for Drizzle.
// Coarse payload caps live here; the precise bounds, the PHI lint and the platform floor are the service's (field-level
// 422s), so a refusal always names the field and never echoes the text.
import { type Static, Type } from "@sinclair/typebox";
import { TEMPLATE_CATEGORIES } from "@wardenx/messaging";

const Id = Type.String({ minLength: 1, maxLength: 64 });
const CategorySchema = Type.Union(TEMPLATE_CATEGORIES.map((c) => Type.Literal(c)));
// Generous transport caps (well above TEMPLATE_LIMITS) so an oversize body is a 422 naming the field, not a parse error.
const TitleText = Type.String({ maxLength: 1_000 });
const BodyText = Type.String({ maxLength: 20_000 });

export const TemplateParamsSchema = Type.Object({ id: Id });

export const CreateTemplateBodySchema = Type.Object(
  { title: TitleText, body: BodyText, category: CategorySchema },
  { additionalProperties: false },
);

export const UpdateTemplateBodySchema = Type.Object(
  {
    title: Type.Optional(TitleText),
    body: Type.Optional(BodyText),
    category: Type.Optional(CategorySchema),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const PutOverlayBodySchema = Type.Object(
  {
    title: Type.Union([TitleText, Type.Null()]),
    body: Type.Union([BodyText, Type.Null()]),
    isEnabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const TemplateViewSchema = Type.Object({
  id: Type.String(),
  scope: Type.Union([Type.Literal("platform"), Type.Literal("org"), Type.Literal("personal")]),
  templateKey: Type.Union([Type.String(), Type.Null()]),
  category: CategorySchema,
  title: Type.String(),
  body: Type.String(),
  customized: Type.Boolean(),
});

export const TemplateListResponseSchema = Type.Object({ items: Type.Array(TemplateViewSchema) });

export const PlatformTemplateAdminViewSchema = Type.Object({
  id: Type.String(),
  templateKey: Type.String(),
  category: CategorySchema,
  floorTitle: Type.String(),
  floorBody: Type.String(),
  requiredPhrases: Type.Array(Type.String()),
  overlay: Type.Union([
    Type.Object({
      title: Type.Union([Type.String(), Type.Null()]),
      body: Type.Union([Type.String(), Type.Null()]),
      isEnabled: Type.Boolean(),
      updatedAt: Type.String(),
    }),
    Type.Null(),
  ]),
});

export const TemplateAdminResponseSchema = Type.Object({
  platform: Type.Array(PlatformTemplateAdminViewSchema),
  shared: Type.Array(TemplateViewSchema),
});

export type CreateTemplateBody = Static<typeof CreateTemplateBodySchema>;
