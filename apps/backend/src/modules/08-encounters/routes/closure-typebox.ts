// apps/backend/src/modules/08-encounters/routes/closure-typebox.ts — TypeBox request/response schemas for the visit-note closure
// routes (ADR-0113). Named `*-typebox` (not `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import for a
// Drizzle one. Validation runs through `parse` from encounters-typebox (M1's VALIDATION_FAILED envelope).
import { pageLimit } from "@chartwarden/shared/route-kit";
import {
  CLOSURE_OVERRIDE_MAX_HOURS,
  CLOSURE_OVERRIDE_MIN_REASON_CHARS,
  DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS,
} from "@chartwarden/types";
import { Type } from "@sinclair/typebox";

/** The board returns the oldest rows first and never more than this many in one answer. */
export const OVERDUE_NOTES_MAX_LIMIT = 200;
export const OVERDUE_NOTES_DEFAULT_LIMIT = 50;
/** A supervisor's typed reason; the lower bound mirrors the table CHECK, the upper bound keeps the row sane. */
const OVERRIDE_REASON_MAX_CHARS = 2_000;

const Mode = Type.Union([Type.Literal("off"), Type.Literal("warn"), Type.Literal("block")]);
const Stage = Type.Union([
  Type.Literal("ok"),
  Type.Literal("at_risk"),
  Type.Literal("overdue"),
  Type.Literal("escalated"),
]);
const Verdict = Type.Union([Type.Literal("clear"), Type.Literal("warn"), Type.Literal("blocked")]);
const Instant = Type.String({ format: "date-time" });
const NullableInstant = Type.Union([Instant, Type.Null()]);

// ── requests ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const OverdueNotesQuerySchema = Type.Object({
  limit: pageLimit({ max: OVERDUE_NOTES_MAX_LIMIT, defaultSize: OVERDUE_NOTES_DEFAULT_LIMIT }),
});

export const GrantClosureOverrideSchema = Type.Object({
  subjectMembershipId: Type.String({ format: "uuid" }),
  reason: Type.String({
    minLength: CLOSURE_OVERRIDE_MIN_REASON_CHARS,
    maxLength: OVERRIDE_REASON_MAX_CHARS,
  }),
  hours: Type.Optional(Type.Integer({ minimum: 1, maximum: CLOSURE_OVERRIDE_MAX_HOURS })),
});

export const ClosureOverrideParamsSchema = Type.Object({
  overrideId: Type.String({ format: "uuid" }),
});

export const PutClosurePolicySchema = Type.Object({
  mode: Mode,
  thresholdHours: Type.Integer({
    minimum: DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS,
    maximum: DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS,
  }),
});

// ── responses ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const ClosureStatusResponseSchema = Type.Object({
  mode: Mode,
  thresholdHours: Type.Integer(),
  verdict: Verdict,
  stage: Stage,
  /** The caller's oldest clocked open note, or null. */
  encounterId: Type.Union([Type.String(), Type.Null()]),
  deadlineAt: NullableInstant,
  hoursOverdue: Type.Number(),
  overdueCount: Type.Integer(),
  /** Set while a supervisor override is lifting the block. */
  overrideExpiresAt: NullableInstant,
});

export const OverdueNoteItemSchema = Type.Object({
  encounterId: Type.String(),
  authoredByMembershipId: Type.String(),
  patientId: Type.String(),
  encounterType: Type.String(),
  discipline: Type.String(),
  serviceDate: Type.String(),
  status: Type.String(),
  clockStartedAt: Instant,
  deadlineAt: Instant,
  stage: Type.Union([Type.Literal("at_risk"), Type.Literal("overdue"), Type.Literal("escalated")]),
  hoursOverdue: Type.Number(),
});

export const OverdueNotesResponseSchema = Type.Object({
  mode: Mode,
  thresholdHours: Type.Integer(),
  items: Type.Array(OverdueNoteItemSchema),
  truncated: Type.Boolean(),
});

export const ClosureOverrideResponseSchema = Type.Object({
  id: Type.String(),
  subjectMembershipId: Type.String(),
  grantedByMembershipId: Type.String(),
  obligationKind: Type.String(),
  grantedAt: Instant,
  expiresAt: Instant,
  revokedAt: NullableInstant,
});

export const ClosurePolicyResponseSchema = Type.Object({
  obligationKind: Type.Literal("visit_note"),
  mode: Mode,
  thresholdHours: Type.Integer(),
  /** Set whenever the mode moves to block: notes already overdue get a fresh window from this instant. */
  enforceFrom: NullableInstant,
});
