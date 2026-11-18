// @chartwarden/types — documentation obligations (M8, ADR-0113, migration 1514): the leaf contracts for the visit-note closure
// clock. A clinical note must be closed within N hours of the clinician's arrival; a per-tenant policy says what an overdue
// note does, and a supervisor can lift the block for one clinician for a short time. These are the value mirrors of the three
// pgEnums and the bounds migration 1514 pins as CHECKs (a pin test in apps/backend/__tests__ keeps them equal to the SQL).
// packages/types cannot import @chartwarden/db, so the enums are restated here.

/** Which signal started an encounter's documentation clock; the first to arrive wins (mirrors `encounter_clock_start_source`). */
export const ENCOUNTER_CLOCK_START_SOURCES = [
  "evv_check_in",
  "visit_started",
  "draft_opened",
  "draft_created",
] as const;
export type EncounterClockStartSource = (typeof ENCOUNTER_CLOCK_START_SOURCES)[number];

/** The documentation duties the engine is generic over (mirrors `documentation_obligation_kind`). */
export const DOCUMENTATION_OBLIGATION_KINDS = [
  "visit_note",
  "hope_window",
  "cti",
  "face_to_face",
] as const;
export type DocumentationObligationKind = (typeof DOCUMENTATION_OBLIGATION_KINDS)[number];

/** What an overdue obligation does (mirrors `documentation_obligation_mode`): nothing, alerts and a banner, or a block. */
export const DOCUMENTATION_OBLIGATION_MODES = ["off", "warn", "block"] as const;
export type DocumentationObligationMode = (typeof DOCUMENTATION_OBLIGATION_MODES)[number];

/** Slice 1 accepts only visit notes at the API; the other kinds are reserved (HOPE / CTI / face-to-face come later). */
export const ACTIVE_DOCUMENTATION_OBLIGATION_KINDS: readonly DocumentationObligationKind[] = [
  "visit_note",
];

/** An organization with no policy row is warned, not blocked (main auto-deploys, so the default must be safe). */
export const DOCUMENTATION_OBLIGATION_DEFAULT_MODE: DocumentationObligationMode = "warn";
export const DOCUMENTATION_OBLIGATION_DEFAULT_THRESHOLD_HOURS = 24;
/** The `threshold_hours` CHECK (1..168). */
export const DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS = 1;
export const DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS = 168;

/**
 * The override CHECKs: a reason of at least 40 and at most 500 characters, and a window of at most 24 hours (4 by default). The cap
 * is low on purpose: the reason is free text next to a clinician's name, it is stored on the override row AND copied into the audit
 * event, and both are append-only, so what a supervisor types stays for good.
 */
export const CLOSURE_OVERRIDE_MIN_REASON_CHARS = 40;
export const CLOSURE_OVERRIDE_MAX_REASON_CHARS = 500;
export const CLOSURE_OVERRIDE_MAX_HOURS = 24;
export const CLOSURE_OVERRIDE_DEFAULT_HOURS = 4;
