// @wardenx/db — `safety_high_risk_area` (M20 §3.3 / §2.2.7, D12). An advisory polygon: it never blocks a
// visit, it surfaces a warning and — per tenant policy — makes the pre-visit check-in mandatory or flags a
// buddy visit for M17 to route. Every category is advisory; there is no blocking category by design.
//
// M20-F07 — NO PostGIS. §3.2 Phase F struck the `geometry(Polygon, 4326)` column and the GIST index: the
// architecture DB stack is pgvector + pgcrypto only (ARCH-027), M1 is frozen (ARCH-232), and the claim that
// `CREATE EXTENSION postgis` "is in the M1 migration" was false. The polygon is stored as **jsonb rings**
// and point-in-polygon membership is an even-odd ray-cast in app code (`high-risk-area-evaluator.ts`,
// M20-T03) — sufficient at field-safety advisory scale. A `geometry`/GIST/`ST_Within` path for Phase-2 scale
// needs its own architecture ADR (DR-restore drills, pgBackRest, CIS image baseline), so §2.3's
// "PostGIS `ST_IsValid`" enforcement row is likewise app-side: the CHECK below asserts the jsonb SHAPE (a
// non-empty array of rings), and ring closure + winding + the ≥4-point minimum are the evaluator's.
//
// M20-F03 — `organization_id` IS NOT NULL. §3.3 sketches `organization_id` nullable with "NULL =
// platform-seeded", and §3.2 Phase E overrules it in the same document: platform polygons live in a
// SEPARATE pattern-2 platform-shared table (`safety_high_risk_area_platform`, `USING (true)` SELECT,
// mutations via `wardenx_admin`), never as NULL-org rows here, because a NULL-org row in a tenant-scoped
// table is invisible to its own tenant under RLS and reachable by an `OR organization_id IS NULL` policy
// that ADR-0010 D3 forbids. That platform table is NOT in the manifest's thirteen `ownedTables`, so it is
// not created here — adding a fourteenth owned table is a manifest change, and Wave P2-2 acceptance #1
// governs those. Platform polygons therefore ship as tenant rows seeded per org (the M20-F03 policy-floor
// pattern) until a reviewed manifest edit lands the platform-shared table.
//
// TENANCY: organization_id NOT NULL. No PE, no Location: an area is a geography, and pinning it to one
// ProviderEntity would make the advisory invisible to the other PE whose clinician is standing in it.
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { safetyHighRiskCategory } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const safetyHighRiskArea = pgTable(
  "safety_high_risk_area",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    riskCategory: safetyHighRiskCategory("risk_category").notNull(),
    /** ≤200 chars — §3.6 audit-denylisted (it may name a street or a household). */
    advisoryMessage: text("advisory_message").notNull(),

    /** M20-F07 — GeoJSON-shaped polygon RINGS as jsonb: `[[[lng,lat], …], …]`, WGS-84 (EPSG:4326)
     *  coordinate order. The ray-cast evaluator owns validity; the CHECK owns the shape. */
    polygon: jsonb("polygon").notNull(),

    /** `SafetyHighRiskAreaPolicy` — vocabulary CHECK below. `requires_buddy_visit` is a FLAG M20 emits;
     *  enforcing it is M17's routing concern, and M20 blocks nothing either way. */
    policyForVisitsToArea: text("policy_for_visits_to_area").notNull().default("advisory_only"),
    /** M22 document refs, encrypted at the application layer before the write. */
    evidenceDocumentsCipher: jsonb("evidence_documents_cipher"),

    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgEffectiveIdx: index("shra_org_effective_idx").on(
      t.organizationId,
      t.effectiveFrom,
      t.effectiveTo,
    ),
    // The evaluator loads every ACTIVE area for the org and ray-casts in app code (M20-F07), so the
    // hot path is "the org's live polygons", not a spatial index.
    activeScanIdx: index("shra_active_idx")
      .on(t.organizationId, t.riskCategory)
      .where(sql`effective_to IS NULL`),

    windowIntegrity: check(
      "m20_shra_window",
      sql`"effective_to" IS NULL OR "effective_to" > "effective_from"`,
    ),
    advisoryMessageBounds: check(
      "m20_shra_message_bounds",
      sql`length(btrim("advisory_message")) BETWEEN 1 AND 200`,
    ),
    policyVocabulary: check(
      "m20_shra_policy_vocab",
      sql`"policy_for_visits_to_area" IN ('advisory_only','requires_pre_visit_check_in','requires_buddy_visit')`,
    ),
    // Shape only — an empty array here is a polygon that matches nothing, which is an advisory that
    // silently never fires.
    polygonShape: check(
      "m20_shra_polygon_shape",
      sql`jsonb_typeof("polygon") = 'array' AND jsonb_array_length("polygon") >= 1`,
    ),
  }),
);

export type SafetyHighRiskAreaRow = typeof safetyHighRiskArea.$inferSelect;
export type NewSafetyHighRiskAreaRow = typeof safetyHighRiskArea.$inferInsert;
