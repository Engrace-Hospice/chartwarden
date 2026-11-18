// apps/web/src/modules/08-encounters/visit-delivery.ts — the sign ceremony's "how and when was this visit
// delivered" step, as pure rules. The server stays authoritative (422 MODALITY_CONFIRMATION_REQUIRED /
// VISIT_TIME_INVALID); these rules keep a clinician from being bounced and, above all, never put a value in the
// request that the clinician did not actively give: a documented time is never estimated, defaulted, padded or
// adjusted, and a delivery mode is never confirmed on the clinician's behalf. The server treats any `visitModality`
// in a sign body as the signer's explicit confirmation, so the web may only send one the clinician chose (or one a
// clinician already confirmed on this encounter).
import {
  ENCOUNTER_VISIT_MODALITIES,
  type EncounterVisitModality,
  MODALITY_CONFIRMATION_DISCIPLINES,
} from "@chartwarden/types";

const MODALITY_LABELS: Readonly<Record<EncounterVisitModality, string>> = {
  in_person: "In person",
  telephonic: "Telephonic",
  video: "Video",
};

/** The radio options, in the server's order. */
export const MODALITY_OPTIONS: readonly { value: EncounterVisitModality; label: string }[] =
  ENCOUNTER_VISIT_MODALITIES.map((value) => ({ value, label: MODALITY_LABELS[value] }));

/** The label a modality is shown under. */
export function modalityLabel(modality: EncounterVisitModality): string {
  return MODALITY_LABELS[modality];
}

/** What the clinician has chosen/typed so far. Times are `datetime-local` strings ("" = not entered). */
export interface DeliveryDraft {
  readonly modality: EncounterVisitModality | null;
  readonly startedAt: string;
  readonly endedAt: string;
}

/** The facts about the encounter the rules depend on. */
export interface DeliveryRuleContext {
  readonly discipline: string;
  /** An M18 EVV bracket is on file: its times win, so the clinician is not asked for any. */
  readonly evvBracketPresent: boolean;
}

/** The rule context of an encounter as the read DTO describes it. */
export function deliveryContextOf(e: {
  readonly discipline: string;
  readonly evvBracketPresent?: boolean;
}): DeliveryRuleContext {
  return { discipline: e.discipline, evvBracketPresent: e.evvBracketPresent === true };
}

/** The modality is a vocabulary the server also checks; an unknown value reads as "not seeded". */
export function asVisitModality(value: unknown): EncounterVisitModality | null {
  return ENCOUNTER_VISIT_MODALITIES.find((m) => m === value) ?? null;
}

/** Does the server require the clinician to confirm a modality for this discipline? */
export function requiresModality(discipline: string): boolean {
  return MODALITY_CONFIRMATION_DISCIPLINES.some((d) => d === discipline);
}

/**
 * The ceremony's opening draft. A SEEDED modality (the scheduler's guess, from the visit setting) is never
 * pre-selected: selecting it and sending it would record the signer's confirmation of a delivery mode they never
 * chose, and an unconfirmed in-person guess would then be paid as a Medicare add-on. Only a modality a clinician
 * already CONFIRMED on this encounter opens selected.
 */
export function initialDelivery(
  seeded: EncounterVisitModality | null | undefined,
  confirmed = false,
): DeliveryDraft {
  return { modality: confirmed ? (seeded ?? null) : null, startedAt: "", endedAt: "" };
}

/** The scheduler's guess to show as a hint ("Scheduled as: In person"), or null when none or already confirmed. */
export function unconfirmedSeed(
  seeded: EncounterVisitModality | null | undefined,
  confirmed: boolean,
): EncounterVisitModality | null {
  return confirmed ? null : (seeded ?? null);
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A `datetime-local` value as epoch milliseconds in the DEVICE time zone, or null when it is not a real wall-clock
 * time there: malformed, an impossible date, a time the clock skips (a spring-forward gap) or passes through twice (the
 * fall-back hour). `Date` would quietly move or pick one of them; a documented time is never adjusted or guessed, so it
 * is refused instead.
 */
export function parseLocalInstant(local: string): number | null {
  const m = LOCAL_DATE_TIME.exec(local);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(
    Number,
  ) as [number, number, number, number, number, number];
  const at = new Date(year, month - 1, day, hour, minute, second);
  const sameWallClock = (other: Date): boolean =>
    other.getFullYear() === year &&
    other.getMonth() === month - 1 &&
    other.getDate() === day &&
    other.getHours() === hour &&
    other.getMinutes() === minute &&
    other.getSeconds() === second;
  if (!sameWallClock(at)) return null;
  // The hour a daylight-saving change REPEATS names two different instants and a `datetime-local` field cannot say which
  // (`Date` silently takes the first): refuse it rather than guess. Zones shift the clock by 30 or 60 minutes.
  const repeated = [30, 60].some((shiftMinutes) =>
    sameWallClock(new Date(at.getTime() + shiftMinutes * 60_000)),
  );
  return repeated ? null : at.getTime();
}

/** The IANA zone the typed times are read in (the browser's), for the clinician to check against the visit's. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "this device's time zone";
}

export const MODALITY_REQUIRED_PROBLEM = "Choose how this visit was delivered.";
export const TIME_PAIR_PROBLEM = "Enter both the start and end time, or leave both blank.";

/** Why the delivery mode blocks signing, or null. */
export function modalityProblem(draft: DeliveryDraft, ctx: DeliveryRuleContext): string | null {
  return requiresModality(ctx.discipline) && draft.modality === null
    ? MODALITY_REQUIRED_PROBLEM
    : null;
}

/** Why the typed times block signing, or null. Empty is fine (times are optional); EVV times win outright. */
export function timeProblem(
  draft: DeliveryDraft,
  ctx: DeliveryRuleContext,
  nowMs: number = Date.now(),
): string | null {
  if (ctx.evvBracketPresent) return null;
  const hasStart = draft.startedAt !== "";
  const hasEnd = draft.endedAt !== "";
  if (!hasStart && !hasEnd) return null;
  if (hasStart !== hasEnd) return TIME_PAIR_PROBLEM;
  const start = parseLocalInstant(draft.startedAt);
  const end = parseLocalInstant(draft.endedAt);
  if (start === null || end === null) {
    return "Enter a real start and end time (a time inside a daylight-saving change, skipped or repeated, cannot be recorded exactly).";
  }
  if (end <= start) return "The end time must be after the start time.";
  if (end > nowMs) return "The end time cannot be in the future.";
  return null;
}

/** Why the clinician cannot sign yet, in plain words, or null when the step is complete. */
export function deliveryProblem(
  draft: DeliveryDraft,
  ctx: DeliveryRuleContext,
  nowMs: number = Date.now(),
): string | null {
  return modalityProblem(draft, ctx) ?? timeProblem(draft, ctx, nowMs);
}

/** The delivery fields of the sign request body. Only what the clinician actually entered is sent. */
export function deliveryBody(
  draft: DeliveryDraft,
  ctx: DeliveryRuleContext,
): {
  visitModality?: EncounterVisitModality;
  startedAt?: string;
  endedAt?: string;
} {
  const modality =
    requiresModality(ctx.discipline) && draft.modality !== null
      ? { visitModality: draft.modality }
      : {};
  const start = ctx.evvBracketPresent ? null : parseLocalInstant(draft.startedAt);
  const end = ctx.evvBracketPresent ? null : parseLocalInstant(draft.endedAt);
  const times =
    start !== null && end !== null
      ? { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() }
      : {};
  return { ...modality, ...times };
}
