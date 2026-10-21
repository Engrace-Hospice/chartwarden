// @chartwarden/db — `triage_call` (M19 §3.3 / §2.2.1). THE after-hours clinical record: one row per call,
// D6's nine-state lifecycle, D10's inbound-trigger provenance, and the M19-F08 BCP paper-origin path.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id + provider_entity_id NOT NULL; location_id NULLABLE. The
// §3.3 block omits location_id entirely, but the three-column rule is architecture and architecture wins
// over a module spec. It is nullable because a call is opened BEFORE the caller is identified — patient_id
// is itself nullable at intake, and a Location cannot be resolved for a caller who has not yet been
// matched to a patient. RLS pivots on organization_id ALONE.
//
// NOT PARTITIONED — a documented deviation from §10 task 3 / §12, which ask for a monthly RANGE partition
// on `opened_at`. PostgreSQL forces a choice here and the constraints win, for three reasons:
//   1. A partitioned table's UNIQUE index must include the partition key, so `triage_call_source_dedupe_uq`
//      would become UNIQUE (source_outbox_event_id, opened_at) — which dedupes NOTHING, because two rows
//      born of the same M17 no-show event carry different `opened_at` values. That index IS §2.6's D10
//      idempotency guarantee: it is what stops a redelivered `m17.visit.no_show_detected` from opening a
//      second call for the same event. The §2.7 paper-origin path makes it worse — it writes `opened_at`
//      as the ORIGINAL call time, so a re-entry deliberately lands in a past partition.
//   2. Three intra-module children (`triage_call_answer`, `triage_escalation`,
//      `triage_call_state_history`) hang off this row. Against a partitioned parent none of them could
//      carry a real FK (the corpus rule: no FK references a partitioned parent — M11's `order_record`
//      children are all logical), so the referential integrity of the answer ledger would become a
//      convention.
//   3. The volume argument that justified partitioning `administration_record` / `document_access_log` /
//      `consent_eval_audit` does not hold: a triage call is a human-answered phone call at after-hours
//      volume (tens per agency per night), not a machine-generated event stream.
// If volume ever justifies it, the corpus has a well-worn conversion path (0033/0035/0037 each dropped and
// recreated a plain table as partitioned in a later migration) — and by then the dedupe guard can move to
// the M1 outbox-consumer ledger, which is where a redelivery guard belongs once the row is partitioned.
//
// CROSS-MODULE FK POLICY: only organization_id / provider_entity_id / location_id (M1 core) and the
// unpartitioned intra-M19 parents (`on_call_shift`, `triage_protocol`) carry real FKs. patient_id (M5),
// admission_id (M6), caller_caregiver_id (M5), caller_portal_session_id (M31), source_outbox_event_id
// (M1 outbox), linked_encounter_id (M8), linked_verbal_order_ids (M11) and linked_visit_proposal_id (M17)
// are LOGICAL uuids validated at the write boundary through the owner's seam.
//
// §3.6 DENYLIST (audit value-capture): caller_phone_e164, caller_quote_cipher, transcript_cipher,
// chief_complaint_text. The two cipher columns additionally ride the per-tenant DEK envelope (D14), so a
// tenant-offboarding crypto-shred makes them unreadable without a per-row delete.
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  triageAiConfidence,
  triageCallCallerKind,
  triageCallInboundChannel,
  triageCallSource,
  triageCallState,
  triageDisposition,
  triageRiskBand,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { onCallShift } from "./on-call-shifts";
import { triageProtocol } from "./triage-protocols";

export const triageCall = pgTable(
  "triage_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    /** Resolved once the caller is matched to a served person; NULL on an unidentified inbound call. */
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    onCallShiftId: uuid("on_call_shift_id")
      .notNull()
      .references(() => onCallShift.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id"), // logical FK → M5; NULL until the caller is matched
    admissionId: uuid("admission_id"), // logical FK → M6
    callerCaregiverId: uuid("caller_caregiver_id"), // logical FK → M5 caregiver
    callerKind: triageCallCallerKind("caller_kind").notNull(),
    callerPortalSessionId: uuid("caller_portal_session_id"), // logical FK → M31
    callerDisplayName: text("caller_display_name"),
    /** DENYLISTED (§3.6). */
    callerPhoneE164: text("caller_phone_e164"),
    callerRelationshipLabel: text("caller_relationship_label"),

    inboundChannel: triageCallInboundChannel("inbound_channel").notNull(),
    /** D10 — what caused the row to exist; `paper_origin` is the §2.7 BCP re-entry. */
    source: triageCallSource("source").notNull().default("manual"),
    /** The M1 outbox event id that triggered this call — the D10 dedupe key. */
    sourceOutboxEventId: uuid("source_outbox_event_id"),

    /** DENYLISTED (§3.6) — the caller's own words about why they rang. */
    chiefComplaintText: text("chief_complaint_text"),
    chiefComplaintSnomed: text("chief_complaint_snomed"),

    /** D12 — ADVISORY M32 suggestion. Never auto-applied; the clinician selects. */
    suggestedProtocolId: uuid("suggested_protocol_id").references(() => triageProtocol.id, {
      onDelete: "set null",
    }),
    suggestedProtocolConfidence: triageAiConfidence("suggested_protocol_confidence"),
    selectedProtocolId: uuid("selected_protocol_id").references(() => triageProtocol.id, {
      onDelete: "set null",
    }),
    /** Frozen at selection so a protocol revision cannot rewrite a past call (D4). */
    selectedProtocolVersion: text("selected_protocol_version"),
    /** D11 — ADVISORY M32 band. Gates nothing; excluded from the M31 portal projection. */
    hospitalizationRiskBand: triageRiskBand("hospitalization_risk_band"),

    /** DENYLISTED (§3.6) + per-tenant DEK envelope (D14). */
    callerQuoteCipher: text("caller_quote_cipher"),
    /** DENYLISTED (§3.6) + per-tenant DEK envelope. D14: M19 captures NO call audio. */
    transcriptCipher: text("transcript_cipher"),

    state: triageCallState("state").notNull().default("open"),
    disposition: triageDisposition("disposition"),
    /** D6 — the per-disposition discriminated payload (`TriageDispositionData` in @chartwarden/types). */
    dispositionData: jsonb("disposition_data"),
    linkedEncounterId: uuid("linked_encounter_id"), // logical FK → M8
    linkedVerbalOrderIds: jsonb("linked_verbal_order_ids").notNull().default(sql`'[]'::jsonb`),
    linkedVisitProposalId: uuid("linked_visit_proposal_id"), // logical FK → M17

    /** §2.7 step 2: for a paper-origin re-entry this is the ORIGINAL call time, not the re-entry clock. */
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    documentedAt: timestamp("documented_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** §4.8 `callback-sla.cron` — when the breach was last published. Re-armed by comparing it with the
     *  call's latest `awaiting_callback` entry, so a call that resumes and waits again is judged afresh. */
    callbackSlaBreachedAt: timestamp("callback_sla_breached_at", { withTimezone: true }),

    // BCP re-entry (M19-F08 / DR-013 / DR-066).
    paperOriginFlag: boolean("paper_origin_flag").notNull().default(false),
    paperOriginalOpenedAt: timestamp("paper_original_opened_at", { withTimezone: true }),

    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byShiftIdx: index("triage_call_shift_idx").on(t.onCallShiftId, t.state),
    // §3.4 — chart context: "every after-hours contact for this person, newest first".
    byPatientIdx: index("triage_call_patient_idx").on(t.organizationId, t.patientId, t.openedAt),
    // §3.4 — the supervisor "all open cases right now" board. `documented_pending_encounter` is included
    // (M19-F06 / ADR-0022) so a call stranded by the §2.7 D-B degraded path stays visible.
    openByProviderEntityIdx: index("triage_call_open_pe_idx")
      .on(t.providerEntityId, t.state)
      .where(
        sql`state IN ('open','protocol_in_progress','awaiting_callback','disposition_pending','documented_pending_encounter','escalated_unresolved')`,
      ),
    // D10 / §2.6 — the redelivery guard: one call per inbound outbox event, forever.
    sourceDedupeUq: uniqueIndex("triage_call_source_dedupe_uq")
      .on(t.sourceOutboxEventId)
      .where(sql`source_outbox_event_id IS NOT NULL`),

    // §2.7 — the flag and the enum value cannot disagree. M19-T01 added `paper_origin` to the §3.2 enum
    // precisely so this pairing is expressible; without the CHECK a re-entry could carry the audit-visible
    // flag while the event payload downstream consumers order by says `manual`.
    paperOriginPair: check(
      "m19_triage_call_paper_origin_pair",
      sql`("source" = 'paper_origin') = "paper_origin_flag"`,
    ),
    // §2.7 step 5 — the outbox payload carries `original_opened_at`; a paper-origin row that does not
    // record it leaves M14/M30 ordering the call by its re-entry clock.
    paperOriginalAtPair: check(
      "m19_triage_call_paper_original_at",
      sql`("paper_origin_flag" = true) = ("paper_original_opened_at" IS NOT NULL)`,
    ),
    // §2.2.1 — a disposition exists only from the moment it is selected, and every documented/closed call
    // has one. The two escalation/abandon values are dispositions AND states, so they appear in both lists.
    dispositionRequiresState: check(
      "m19_triage_call_disposition_state",
      sql`"disposition" IS NULL
          OR "state" IN ('documented_pending_encounter','documented','closed','escalated_unresolved','abandoned')`,
    ),
    documentedRequiresDisposition: check(
      "m19_triage_call_documented_disposition",
      sql`"state" NOT IN ('documented_pending_encounter','documented','closed') OR "disposition" IS NOT NULL`,
    ),
    closedAtWhenClosed: check(
      "m19_triage_call_closed_at",
      sql`"state" <> 'closed' OR "closed_at" IS NOT NULL`,
    ),
  }),
);

export type TriageCallRow = typeof triageCall.$inferSelect;
export type NewTriageCallRow = typeof triageCall.$inferInsert;
