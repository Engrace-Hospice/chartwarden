// apps/backend/src/modules/36-messaging/routes/clinical-link-typebox.ts - WP 3.2 schemas (params + OpenAPI response).
import { Type } from "@sinclair/typebox";
import { CLINICAL_LINK_KINDS } from "@chartwarden/types";

const KindSchema = Type.Union(CLINICAL_LINK_KINDS.map((kind) => Type.Literal(kind)));

/**
 * `ok`: the live state of the linked record as THIS caller may see it. `unavailable`: no reason, by design identical for
 * a missing, forbidden, erased or failing source.
 */
export const ClinicalLinkResolveResponseSchema = Type.Union([
  Type.Object({
    state: Type.Literal("ok"),
    kind: KindSchema,
    status: Type.String(),
    occurred_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    as_of: Type.String({ format: "date-time" }),
    link: Type.String(),
    patient_id: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  }),
  Type.Object({ state: Type.Literal("unavailable") }),
]);

/** One link on a message read: ids and kind only (no status or label; the client calls resolve per chip). */
export const ClinicalLinkViewSchema = Type.Object({
  link_id: Type.String({ format: "uuid" }),
  kind: KindSchema,
  entity_id: Type.String({ format: "uuid" }),
});
