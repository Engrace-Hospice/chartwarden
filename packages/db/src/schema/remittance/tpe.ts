// @chartwarden/db — M25 milestone 5 (migration 1118): the TPE program tracker. tpe_mac_rule (per-organization exit
// thresholds, NO seed) ─ tpe_program ─ tpe_round ─ tpe_round_claim. NON-partitioned; organization_id NOT NULL on all four
// (canonical app.org_id RLS). States, results and referral kinds are text + CHECK (closed sets mirrored in
// domain/tpe.ts), so there is no new pgEnum. provider_entity_id and claim_id (M23) are LOGICAL uuid FKs;
// tpe_program_id, tpe_round_id and adr_case_id are intra-M25 real FKs. A closed program is frozen by trigger.
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { adrCase } from "./adr";

export const tpeMacRule = pgTable(
  "tpe_mac_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    macName: text("mac_name").notNull(),
    exitErrorRatePct: numeric("exit_error_rate_pct", { precision: 5, scale: 2 }).notNull(),
    sourceNote: text("source_note"),
    verifiedOn: date("verified_on"),
    effectiveFrom: date("effective_from").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("tpe_mac_rule_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const tpeProgram = pgTable(
  "tpe_program",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    macName: text("mac_name").notNull(),
    openedOn: date("opened_on").notNull(),
    state: text("state").notNull().default("active"),
    outcomeOn: date("outcome_on"),
    reliefUntil: date("relief_until"),
    referralKinds: text("referral_kinds").array().notNull().default([]),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byProvider: index("ix_tpe_program_provider").on(t.providerEntityId),
    byOrg: index("tpe_program_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const tpeRound = pgTable(
  "tpe_round",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    tpeProgramId: uuid("tpe_program_id")
      .notNull()
      .references(() => tpeProgram.id, { onDelete: "restrict" }),
    roundNumber: integer("round_number").notNull(),
    noticeOn: date("notice_on").notNull(),
    resultsOn: date("results_on"),
    macErrorRatePct: numeric("mac_error_rate_pct", { precision: 5, scale: 2 }),
    macResult: text("mac_result"),
    thresholdPct: numeric("threshold_pct", { precision: 5, scale: 2 }),
    thresholdSource: text("threshold_source"),
    thresholdVerified: boolean("threshold_verified").notNull().default(false),
    educationOn: date("education_on"),
    educationNote: text("education_note"), // denylisted free text (§3.6)
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("tpe_round_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const tpeRoundClaim = pgTable(
  "tpe_round_claim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    tpeRoundId: uuid("tpe_round_id")
      .notNull()
      .references(() => tpeRound.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(), // M23 logical FK
    adrCaseId: uuid("adr_case_id").references(() => adrCase.id, { onDelete: "restrict" }),
    result: text("result").notNull().default("pending"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("tpe_round_claim_org_ix").on(t.organizationId, t.createdAt),
  }),
);
