// @wardenx/db — `ai_invocation` (M32 §3.2.8). The disclosure ledger: one row per attempt to invoke an AI
// capability, INCLUDING the attempts that were refused.
//
// THIS ROW IS THE §164.528 EVIDENCE. When a patient asks for an accounting of disclosures, the answer to
// "did any of my chart go to a model vendor, when, which model, and under whose hand" is reconstructed
// from here — which is why `status = 'capability_unavailable'` is a RECORDED outcome and not an absent
// row: a gate refusal is itself the evidence that no PHI left the platform, and only a written row can
// prove a negative. It is also why §3.7's eraser SHREDS THE DEK rather than deleting these rows.
//
// TENANT-SCOPED + THE THREE-COLUMN RULE. §3.2.8 gives the table organization_id and patient_id only;
// ARCH-011 (architecture, which wins over a module spec) requires provider_entity_id + location_id on a
// PHI-bearing table, and this one is PHI-bearing by definition. provider_entity_id is NOT NULL because a
// disclosure accounting has to name WHICH certified provider entity disclosed the PHI — "the tenant" is
// not an answer a surveyor accepts, and leaving it nullable would let the invocation pipeline (T04) ship
// without ever resolving it. location_id is nullable: an invocation is made from wherever the clinician
// is, which is frequently not a Location the org has on file.
//
// PARTITIONED MONTHLY on `invoked_at`, so the composite primary key `(id, invoked_at)` — declared in
// migration 0114, because Drizzle cannot express a partitioned table and PostgreSQL requires the
// partition key in every unique constraint. The `.primaryKey()` below is the ORM's view of row identity.
// Retention is 7 years (§3.8, the §164.528 + audit-control floor) and runs at the partition level.
//
// THE PAYLOADS ARE OPAQUE. All three cipher columns are per-tenant-DEK envelope-encrypted BEFORE the
// insert (§3.6) and §3.4-denylisted out of the audit capture. `error_message` is denylisted too even
// though the pipeline strips PHI from it — "stripped" is an assertion about a code path, and an
// immutable audit ledger is not the place to discover the assertion was wrong.
//
// WHAT IS DELIBERATELY *NOT* DENYLISTED: `routing_decision`, `routing_reason`, `model_version_pin`,
// `zdr_confirmed`, `status` and `hitl_outcome` are captured VERBATIM. They are exactly the fields the
// accounting, an FDA inquiry or a deposition reads; `zdr_confirmed` in particular is the entire D19
// claim, and a scrubbed marker would make the ledger useless for the purpose it exists to serve.
//
// COLUMN-RESTRICTED IMMUTABILITY (§3.5, trigger in 0116), not append-only. The frozen set is §3.5's
// verbatim: the request side plus the provenance plus BOTH token counts and BOTH response ciphers. What
// stays writable is `status`, `completed_at`, `duration_ms`, `error_*` and `hitl_outcome` — the last
// being the one the consumer module writes later, recording the human's accept/edit/reject. DELETE is
// refused outright.
//
// THAT FROZEN SET DECIDES THE PIPELINE'S SHAPE, so it is worth saying out loud: because
// `input_token_count`, `output_token_count` and `response_payload_cipher` cannot be UPDATEd, the row
// CANNOT be opened before dispatch and closed after it. M32-T04's pipeline therefore writes it ONCE,
// when the outcome is known — completed, failed, timed out, or refused at a gate. The cost is that a
// process killed between a vendor answering and the insert leaves a disclosure with no row; the pipeline
// narrows that to a single `await` by funnelling every terminal outcome through one write, and cannot
// close it without the two-phase row §3.5 forbids.
//
// FKs: organization / provider_entity / location (M1 spine), `ai_capability` and `ai_model_backend`
// (platform-shared, unpartitioned) are REAL. `actor_membership_id` (M2), `patient_id` (M5),
// `prompt_template_id` and the consumer's correlation id are LOGICAL uuid — cross-module ids validated at
// the write boundary, per the corpus-wide FK policy.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { aiInvocationHitlOutcome, aiInvocationStatus, aiRoutingDecision, aiRoutingReason } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { aiCapability } from "./ai-capabilities";
import { aiModelBackend } from "./ai-model-backends";
import { bytea } from "./cipher-column";

export const aiInvocation = pgTable(
  "ai_invocation",
  {
    // Composite PK (id, invoked_at) declared in SQL (0114) — see header.
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),
    /** Denormalized so the capability-scoped ledger scan never joins under RLS. */
    capabilityKey: text("capability_key").notNull(),

    /** Logical uuid → `ai_prompt_template`; absent when the call never reached a template. */
    promptTemplateId: uuid("prompt_template_id"),
    promptTemplateVersion: text("prompt_template_version"),

    backendId: uuid("backend_id")
      .notNull()
      .references(() => aiModelBackend.id, { onDelete: "restrict" }),
    backendKey: text("backend_key").notNull(),
    /** The EXACT model that ran. Frozen by the 0116 trigger; never scrubbed from the audit capture. */
    modelVersionPin: text("model_version_pin").notNull(),

    /** Logical FK → M2 membership. */
    actorMembershipId: uuid("actor_membership_id").notNull(),
    actorRole: text("actor_role").notNull(),

    /** Logical FK → M5 patient. NULL means the invocation touched no chart — the PHI indicator. */
    patientId: uuid("patient_id"),
    consumerCorrelationId: uuid("consumer_correlation_id"),
    /** Typed AiConsumerContextRef — WHICH consumer entity's handling caused the disclosure. */
    consumerContextRef: jsonb("consumer_context_ref").notNull(),

    routingDecision: aiRoutingDecision("routing_decision").notNull(),
    routingReason: aiRoutingReason("routing_reason").notNull(),

    /** DEK envelope-encrypted (§3.6) and §3.4-denylisted. */
    promptPayloadCipher: bytea("prompt_payload_cipher").notNull(),
    responsePayloadCipher: bytea("response_payload_cipher"),
    chartContextCipher: bytea("chart_context_cipher"),

    inputTokenCount: integer("input_token_count").notNull(),
    outputTokenCount: integer("output_token_count").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),

    status: aiInvocationStatus("status").notNull(),
    errorClass: text("error_class"),
    /** Denylisted despite being PHI-stripped upstream (see header). */
    errorMessage: text("error_message"),

    /** Written later by the consumer module when the human accepts / edits / rejects the output. */
    hitlOutcome: aiInvocationHitlOutcome("hitl_outcome").notNull().default("pending"),
    /** The whole D19 claim, per row. Frozen and never scrubbed. */
    zdrConfirmed: boolean("zdr_confirmed").notNull(),

    invokedAt: timestamp("invoked_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgInvokedIdx: index("ai_invocation_org_invoked_idx").on(t.organizationId, t.invokedAt.desc()),
    capabilityInvokedIdx: index("ai_invocation_capability_invoked_idx").on(
      t.capabilityKey,
      t.invokedAt.desc(),
    ),
    // The accounting-of-disclosures lookup. Partial: an invocation with no patient is not part of any
    // patient's accounting, and excluding those keeps the index to the rows the request actually reads.
    patientInvokedIdx: index("ai_invocation_patient_invoked_idx")
      .on(t.patientId, t.invokedAt.desc())
      .where(sql`patient_id IS NOT NULL`),

    // D19 at the row level: an Anthropic-routed invocation cannot be recorded without ZDR confirmed.
    // The backend registry's `cloudBaaCheck` guards REGISTRATION; this guards the individual call, so a
    // backend whose ZDR status was flipped after registration cannot leave unmarked rows behind it.
    zdrCheck: check(
      "ai_invocation_zdr_check",
      sql`zdr_confirmed = true OR backend_key NOT LIKE 'anthropic-%'`,
    ),
  }),
);

export type AiInvocationRow = typeof aiInvocation.$inferSelect;
export type NewAiInvocationRow = typeof aiInvocation.$inferInsert;
