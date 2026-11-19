// apps/backend/src/modules/08-encounters/routes/drafting-typebox.ts — TypeBox request/response schemas for the visit-note draft routes
// (ADR-0114). Named `*-typebox` (not `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import for a Drizzle
// one. Validation runs through `parse` from encounters-typebox (M1's VALIDATION_FAILED envelope).
import { Type } from "@sinclair/typebox";

export const PutDraftPolicySchema = Type.Object({ enabled: Type.Boolean() });

export const DraftPolicyResponseSchema = Type.Object({
  /** Whether the tenant has the visit-note draft and its sign gate switched on (absent row = false). */
  enabled: Type.Boolean(),
  /** The phrase corpus's clinical review state; enabling is refused (409 CORPUS_REVIEW_PENDING) until it is approved. */
  reviewStatus: Type.Union([Type.Literal("pending"), Type.Literal("approved")]),
  /** The named platform-side reviewer of the corpus (VN-D14). */
  reviewer: Type.String(),
});
