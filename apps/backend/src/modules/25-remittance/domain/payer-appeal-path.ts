// M25 milestone 12a-1 - the PAYER APPEAL PATH (hospice ADR/TPE/QIC PRD, milestone 12). PURE.
//
// A path is DATA a person writes from the customer's own contract or the payer's denial notice: which levels exist, who
// files, and (optionally) each level's filing window. Nothing here knows any payer's, Medicare Advantage plan's or external
// reviewer's level, clock or form, and nothing is seeded: a payer with no path resolves to `{ kind: "none" }` and the screen
// says so. External review is a LABEL on a level (`level_kind`), never a process. The only numbers in this file are
// input-validation bounds (marked `bound`), which belong to no payer.
import { isRealDay } from "./recorded-deadline";

export const PAYER_PROGRAMS = ["commercial", "medicare_advantage"] as const;
export type PayerProgram = (typeof PAYER_PROGRAMS)[number];

export const PATH_STATUSES = ["draft", "active", "retired"] as const;
export type PathStatus = (typeof PATH_STATUSES)[number];

export const LEVEL_KINDS = ["internal", "external_review", "other"] as const;
export type LevelKind = (typeof LEVEL_KINDS)[number];

export const WHO_FILES = ["provider", "member", "either", "unknown"] as const;
export type WhoFiles = (typeof WHO_FILES)[number];

export const ANCHOR_KINDS = [
  "notice_date",
  "notice_receipt",
  "remittance_date",
  "prior_decision_date",
  "other_typed",
] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const DAY_BASES = ["calendar", "business_us_federal"] as const;
export type DayBasis = (typeof DAY_BASES)[number];

export const ROLLS = ["none", "back", "forward"] as const;
export type Roll = (typeof ROLLS)[number];

/** Input-validation bounds only (mirrored by the 1206 CHECKs). They are not a payer's rule. */
export const PATH_BOUNDS = {
  windowDaysMax: 730, // bound
  receiptDaysMax: 60, // bound
  decisionDaysMax: 730, // bound
  levelsMax: 12, // bound
  labelMax: 120, // bound
  noteMax: 500, // bound
} as const;

/** A level's filing window as stored: complete, or absent. */
export interface LevelWindow {
  readonly windowDays: number;
  readonly anchorKind: AnchorKind;
  /** null = the row states no presumption (none is applied). */
  readonly receiptPresumptionDays: number | null;
  readonly dayBasis: DayBasis;
  /** Present exactly when `dayBasis` is the business one. */
  readonly roll: Roll | null;
}

export interface PathHeaderInput {
  readonly payerId: string;
  readonly program: string;
  readonly contractLabel: string | null;
  readonly effectiveFrom: string;
  readonly sourceNote: string;
}

export interface PathLevelInput {
  readonly levelKind: LevelKind;
  readonly levelLabel: string;
  readonly whoFiles: WhoFiles;
  readonly filingWindowDays: number | null;
  readonly anchorKind: AnchorKind | null;
  readonly receiptPresumptionDays: number | null;
  readonly dayBasis: DayBasis | null;
  readonly roll: Roll | null;
  readonly decisionDays: number | null;
  readonly formLabel: string | null;
  readonly channelNote: string | null;
  readonly sourceNote: string;
}

export type PathRefusal =
  | "PROGRAM_INVALID"
  | "EFFECTIVE_DATE_INVALID"
  | "SOURCE_NOTE_REQUIRED"
  | "NO_LEVELS"
  | "TOO_MANY_LEVELS"
  | "LEVEL_KIND_INVALID"
  | "LEVEL_LABEL_REQUIRED"
  | "WHO_FILES_INVALID"
  | "LEVEL_SOURCE_NOTE_REQUIRED"
  | "WINDOW_INCOMPLETE"
  | "WINDOW_OUT_OF_RANGE"
  | "ANCHOR_INVALID"
  | "BASIS_INVALID"
  | "ROLL_REQUIRED"
  | "ROLL_NOT_ALLOWED"
  | "ROLL_INVALID"
  | "RECEIPT_OUT_OF_RANGE"
  | "DECISION_DAYS_OUT_OF_RANGE"
  | "TEXT_TOO_LONG";

export type PathVerifyRefusal = "VERIFIER_IS_AUTHOR" | "NOT_DRAFT" | "NO_LEVELS";

const inSet = <T extends string>(set: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (set as readonly string[]).includes(v);
const blank = (s: string | null | undefined): boolean =>
  s === null || s === undefined || s.trim() === "";
const wholeBetween = (n: number, min: number, max: number): boolean =>
  Number.isInteger(n) && n >= min && n <= max;

/** The window a level states, or null when it states none or an incomplete one (nothing is computed from it). */
export function levelWindow(level: {
  readonly filingWindowDays: number | null;
  readonly anchorKind: AnchorKind | null;
  readonly receiptPresumptionDays: number | null;
  readonly dayBasis: DayBasis | null;
  readonly roll: Roll | null;
}): LevelWindow | null {
  const { filingWindowDays, anchorKind, dayBasis, roll } = level;
  if (filingWindowDays === null || anchorKind === null || dayBasis === null) return null;
  if ((dayBasis === "business_us_federal") !== (roll !== null)) return null;
  return {
    windowDays: filingWindowDays,
    anchorKind,
    receiptPresumptionDays: level.receiptPresumptionDays,
    dayBasis,
    roll,
  };
}

export const isWindowComplete = (level: Parameters<typeof levelWindow>[0]): boolean =>
  levelWindow(level) !== null;

function checkLevel(l: PathLevelInput): PathRefusal | null {
  if (!inSet(LEVEL_KINDS, l.levelKind)) return "LEVEL_KIND_INVALID";
  if (blank(l.levelLabel)) return "LEVEL_LABEL_REQUIRED";
  if (!inSet(WHO_FILES, l.whoFiles)) return "WHO_FILES_INVALID";
  if (blank(l.sourceNote)) return "LEVEL_SOURCE_NOTE_REQUIRED";
  const texts = [l.levelLabel, l.formLabel, l.channelNote, l.sourceNote];
  if (texts.some((t) => (t?.length ?? 0) > PATH_BOUNDS.noteMax)) return "TEXT_TOO_LONG";
  const anyWindow = [
    l.filingWindowDays,
    l.anchorKind,
    l.dayBasis,
    l.roll,
    l.receiptPresumptionDays,
  ];
  const stated = anyWindow.some((v) => v !== null);
  if (stated && (l.filingWindowDays === null || l.anchorKind === null || l.dayBasis === null)) {
    return "WINDOW_INCOMPLETE";
  }
  if (
    l.filingWindowDays !== null &&
    !wholeBetween(l.filingWindowDays, 1, PATH_BOUNDS.windowDaysMax)
  ) {
    return "WINDOW_OUT_OF_RANGE";
  }
  if (l.anchorKind !== null && !inSet(ANCHOR_KINDS, l.anchorKind)) return "ANCHOR_INVALID";
  if (l.dayBasis !== null && !inSet(DAY_BASES, l.dayBasis)) return "BASIS_INVALID";
  if (l.dayBasis === "business_us_federal") {
    if (l.roll === null) return "ROLL_REQUIRED";
    if (!inSet(ROLLS, l.roll)) return "ROLL_INVALID";
  } else if (l.roll !== null) {
    return "ROLL_NOT_ALLOWED";
  }
  if (
    l.receiptPresumptionDays !== null &&
    !wholeBetween(l.receiptPresumptionDays, 0, PATH_BOUNDS.receiptDaysMax)
  ) {
    return "RECEIPT_OUT_OF_RANGE";
  }
  if (l.decisionDays !== null && !wholeBetween(l.decisionDays, 1, PATH_BOUNDS.decisionDaysMax)) {
    return "DECISION_DAYS_OUT_OF_RANGE";
  }
  return null;
}

/** Validate a path header and its ordered levels. The first refusal wins; null = acceptable. */
export function checkPathInput(
  header: PathHeaderInput,
  levels: readonly PathLevelInput[],
): PathRefusal | null {
  if (!inSet(PAYER_PROGRAMS, header.program)) return "PROGRAM_INVALID";
  if (!isRealDay(header.effectiveFrom)) return "EFFECTIVE_DATE_INVALID";
  if (blank(header.sourceNote)) return "SOURCE_NOTE_REQUIRED";
  if (header.sourceNote.length > PATH_BOUNDS.noteMax) return "TEXT_TOO_LONG";
  if ((header.contractLabel?.length ?? 0) > PATH_BOUNDS.labelMax) return "TEXT_TOO_LONG";
  if (levels.length === 0) return "NO_LEVELS";
  if (levels.length > PATH_BOUNDS.levelsMax) return "TOO_MANY_LEVELS";
  for (const l of levels) {
    const refusal = checkLevel(l);
    if (refusal) return refusal;
  }
  return null;
}

export const normalizeContractLabel = (label: string | null | undefined): string =>
  (label ?? "").trim().toLowerCase();

export interface ResolvablePath {
  readonly payerId: string;
  readonly program: string;
  readonly contractLabel: string | null;
  readonly status: string;
  readonly effectiveFrom: string;
}

export type PathResolution<P extends ResolvablePath> =
  | { readonly kind: "path"; readonly path: P; readonly verified: boolean }
  | { readonly kind: "none" };

const newest = <P extends ResolvablePath>(rows: readonly P[]): P | undefined =>
  rows.reduce<P | undefined>(
    (best, r) => (best === undefined || r.effectiveFrom > best.effectiveFrom ? r : best),
    undefined,
  );

/**
 * The path in force for a payer, program and contract label on `asOf` (YYYY-MM-DD): the newest ACTIVE one, else the newest
 * DRAFT (flagged unverified), else `none`. There is never a default, and the contract label must match (case-insensitively):
 * a case that names no label matches only a label-less path.
 */
export function resolvePayerPath<P extends ResolvablePath>(
  paths: readonly P[],
  query: {
    readonly payerId: string;
    readonly program: string;
    readonly contractLabel: string | null;
    readonly asOf: string;
  },
): PathResolution<P> {
  const wanted = normalizeContractLabel(query.contractLabel);
  const inScope = paths.filter(
    (p) =>
      p.payerId === query.payerId &&
      p.program === query.program &&
      normalizeContractLabel(p.contractLabel) === wanted &&
      p.status !== "retired" &&
      p.effectiveFrom <= query.asOf,
  );
  const active = newest(inScope.filter((p) => p.status === "active"));
  if (active) return { kind: "path", path: active, verified: true };
  const draft = newest(inScope.filter((p) => p.status === "draft"));
  return draft ? { kind: "path", path: draft, verified: false } : { kind: "none" };
}

/** Verification makes a draft active: a person other than the author checks it, and it must have levels. */
export function checkPathVerify(input: {
  readonly status: string;
  readonly authorMembershipId: string;
  readonly verifierMembershipId: string;
  readonly levelCount: number;
}): PathVerifyRefusal | null {
  if (input.verifierMembershipId === input.authorMembershipId) return "VERIFIER_IS_AUTHOR";
  if (input.status !== "draft") return "NOT_DRAFT";
  if (input.levelCount < 1) return "NO_LEVELS";
  return null;
}
