// @chartwarden/types - the typed M22 render payloads of M16's plan-level bereavement documents (ADR-0109 D6 / D9): the physician
// condolence letter to the internal attending clinician and the internal discharge summary an auditor reads. M16 builds them at the
// producer (inside the transaction that approves the letter or closes the plan) and ships them on
// `m16.bereavement.document_requested` as `payloadJsonb`; M22 draws only the declared fields.
//
// WHAT THE DISCHARGE SUMMARY HOLDS AND DOES NOT. It states what the program OFFERED and what it DELIVERED, per contact and per cadence
// mark (the touchpoint kind, when it was due, its status, when it was completed), the assessment checkpoints done and missed, the
// contacts it could not reach (attempt count and the last attempt), each contact's opt-out and mailing scope, the tier trajectory and
// why the program closed. It carries NO counselor contact notes, NO care goals, NO risk-factor vectors and NO substance-use data: those
// are not in this schema at all, so there is no field a producer bug could fill.
import { type Static, Type } from "@sinclair/typebox";
import { assertRenderPayload } from "./common";

/** The M22 template keys for the two documents (the renderer table keys). */
export const BEREAVEMENT_PHYSICIAN_CONDOLENCE_TEMPLATE_KEY =
  "bereavement_physician_condolence_letter" as const;
export const BEREAVEMENT_DISCHARGE_SUMMARY_TEMPLATE_KEY =
  "bereavement_discharge_summary_internal" as const;
/** The day-390 `closeout_letter` floor item's own template (family-facing; not the generic `bereavement_letter`). */
export const BEREAVEMENT_CLOSEOUT_LETTER_TEMPLATE_KEY = "bereavement_closeout_letter" as const;

const text = Type.String({ minLength: 1 });
const nullableInstant = Type.Union([text, Type.Null()]);
const count = Type.Integer({ minimum: 0 });

/**
 * What travels on `m16.bereavement.document_requested` for the physician condolence letter: the death date and NOTHING else. The reviewer's
 * note is sealed in M16 (an outbox payload is a plaintext copy no eraser reaches); M22 pulls it at render time through a port the
 * composition root binds and merges it into {@link BereavementPhysicianLetterRenderPayload}, the shape the template draws.
 */
export const BereavementPhysicianLetterRequestPayload = Type.Object(
  { deathDate: text },
  { additionalProperties: false },
);
export type BereavementPhysicianLetterRequestPayload = Static<
  typeof BereavementPhysicianLetterRequestPayload
>;
export const assertBereavementPhysicianLetterRequestPayload = (
  p: unknown,
): BereavementPhysicianLetterRequestPayload =>
  assertRenderPayload(
    BEREAVEMENT_PHYSICIAN_CONDOLENCE_TEMPLATE_KEY,
    BereavementPhysicianLetterRequestPayload,
    p,
  );

/** The physician condolence letter AS RENDERED: the death date and the reviewer's optional note. Names no one (the wording is compliance's). */
export const BereavementPhysicianLetterRenderPayload = Type.Object({
  deathDate: text,
  personalNote: Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()]),
});
export type BereavementPhysicianLetterRenderPayload = Static<
  typeof BereavementPhysicianLetterRenderPayload
>;
export const assertBereavementPhysicianLetterRenderPayload = (
  p: unknown,
): BereavementPhysicianLetterRenderPayload =>
  assertRenderPayload(
    BEREAVEMENT_PHYSICIAN_CONDOLENCE_TEMPLATE_KEY,
    BereavementPhysicianLetterRenderPayload,
    p,
  );

/**
 * The closeout letter that ends the 13-month program (the `closeout_letter` cadence mark, day 390). It names no one: the closing wording
 * is compliance's to supply (as for the ABN), so the payload carries only the facts the letter is dated from.
 */
export const BereavementCloseoutLetterRenderPayload = Type.Object({
  cadenceMark: Type.Literal("closeout_letter"),
  outreachKind: text,
  deathDate: text,
  dueAt: text,
});
export type BereavementCloseoutLetterRenderPayload = Static<
  typeof BereavementCloseoutLetterRenderPayload
>;
export const assertBereavementCloseoutLetterRenderPayload = (
  p: unknown,
): BereavementCloseoutLetterRenderPayload =>
  assertRenderPayload(
    BEREAVEMENT_CLOSEOUT_LETTER_TEMPLATE_KEY,
    BereavementCloseoutLetterRenderPayload,
    p,
  );

const RiskTier = Type.Union([
  Type.Literal("low"),
  Type.Literal("moderate"),
  Type.Literal("high"),
  Type.Literal("complicated"),
]);

/** One cadence item: what was offered (`kind`, `dueAt`) and what became of it (`status`, `completedAt`). */
export const DischargeSummaryTouchpoint = Type.Object({
  cadenceMark: text,
  kind: text,
  dueAt: text,
  status: Type.Union([
    Type.Literal("scheduled"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("declined"),
    Type.Literal("no_response"),
    Type.Literal("missed"),
    Type.Literal("cancelled"),
  ]),
  completedAt: nullableInstant,
});
export type DischargeSummaryTouchpoint = Static<typeof DischargeSummaryTouchpoint>;

/** One assessment checkpoint (the initial d28 and the midpoint d180): done, or missed. */
export const DischargeSummaryAssessmentTask = Type.Object({
  taskKind: Type.Union([Type.Literal("initial_assessment"), Type.Literal("midpoint_reassessment")]),
  status: Type.Union([
    Type.Literal("scheduled"),
    Type.Literal("completed"),
    Type.Literal("missed"),
    Type.Literal("cancelled"),
  ]),
  dueAt: text,
  completedAt: nullableInstant,
});
export type DischargeSummaryAssessmentTask = Static<typeof DischargeSummaryAssessmentTask>;

/** A contact the program could not reach: how many attempts failed and when the last one was. */
export const DischargeSummaryUnreachable = Type.Object({
  attemptCount: count,
  lastAttemptAt: nullableInstant,
  markedUnreachableAt: nullableInstant,
});
export type DischargeSummaryUnreachable = Static<typeof DischargeSummaryUnreachable>;

/** The scope of a contact's opt-out: which kind, when, and (for `channel_specific`) which channels. Never the reason. */
export const DischargeSummaryOptOut = Type.Object({
  optOutKind: Type.Union([
    Type.Literal("full"),
    Type.Literal("channel_specific"),
    Type.Literal("pause_temporarily"),
    Type.Literal("no_mailings"),
  ]),
  channelKinds: Type.Array(text),
  optedOutAt: text,
});
export type DischargeSummaryOptOut = Static<typeof DischargeSummaryOptOut>;

export const DischargeSummaryTierPoint = Type.Object({ at: text, tier: RiskTier });
export type DischargeSummaryTierPoint = Static<typeof DischargeSummaryTierPoint>;

export const DischargeSummaryContact = Type.Object({
  /** "Contact N": a stable ordinal (roster order by creation), never the contact's name — the payload crosses the outbox in plaintext. */
  label: text,
  relationship: text,
  status: Type.Union([
    Type.Literal("proposed"),
    Type.Literal("active"),
    Type.Literal("opted_out"),
    Type.Literal("deceased"),
    Type.Literal("unreachable"),
    Type.Literal("ineligible_post_review"),
  ]),
  /** False when the contact has an open `no_mailings` (or full) opt-out: mailed items were converted to calls or cancelled. */
  mailingsAllowed: Type.Boolean(),
  tierTrajectory: Type.Array(DischargeSummaryTierPoint),
  touchpoints: Type.Array(DischargeSummaryTouchpoint),
  assessmentTasks: Type.Array(DischargeSummaryAssessmentTask),
  /** The OPEN opt-outs (a rescinded one is history, not scope). */
  optOuts: Type.Array(DischargeSummaryOptOut),
  unreachable: Type.Union([DischargeSummaryUnreachable, Type.Null()]),
});
export type DischargeSummaryContact = Static<typeof DischargeSummaryContact>;

export const DischargeSummaryTotals = Type.Object({
  offered: count,
  delivered: count,
  missed: count,
  cancelled: count,
  outstanding: count,
});
export type DischargeSummaryTotals = Static<typeof DischargeSummaryTotals>;

export const BereavementDischargeSummaryRenderPayload = Type.Object({
  deathDate: text,
  closedAt: text,
  closureReason: Type.Union([
    Type.Literal("thirteen_month_completion"),
    Type.Literal("all_contacts_declined"),
    Type.Literal("patient_opt_out_pre_death"),
    Type.Literal("patient_opt_out_post_creation"),
    Type.Literal("tenant_offboarding"),
    Type.Literal("all_bereaved_deceased"),
    Type.Literal("geographic_relocation"),
    Type.Literal("family_legal_action"),
    Type.Literal("other_early"),
  ]),
  closeKind: Type.Union([Type.Literal("auto"), Type.Literal("manual"), Type.Literal("cascade")]),
  /** The plan-level tier over time (the rubric's plan score ledger). */
  planTierTrajectory: Type.Array(DischargeSummaryTierPoint),
  contacts: Type.Array(DischargeSummaryContact),
  totals: DischargeSummaryTotals,
});
export type BereavementDischargeSummaryRenderPayload = Static<
  typeof BereavementDischargeSummaryRenderPayload
>;
export const assertBereavementDischargeSummaryRenderPayload = (
  p: unknown,
): BereavementDischargeSummaryRenderPayload =>
  assertRenderPayload(
    BEREAVEMENT_DISCHARGE_SUMMARY_TEMPLATE_KEY,
    BereavementDischargeSummaryRenderPayload,
    p,
  );

// ── ADR-0109 D10 — the mailing BATCH (one letter per recipient) ─────────────────────────────────────────────────────────────────────
// Rendered by M16's `m16-mailing-generate` worker through `getSeam("DocumentRenderer").render(...)` DIRECTLY (not over the outbox): the recipient
// names and mailing addresses are decrypted in-process in the worker and handed to the renderer in memory, and they exist in no other place.
// The PDF therefore holds EVERY addressee, and the document is filed under the INTERNAL-only aggregate type `bereavement_mailing_batch`.

/** The M22 template key of the batch (the renderer table key). */
export const BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY = "bereavement_mailing_batch" as const;

/** Size limits of a mailing's agency-authored wording (the route bodies, the generate guard and the batch payload share them). */
export const BEREAVEMENT_MAILING_CONTENT_LIMITS = {
  title: 200,
  greeting: 200,
  paragraph: 2000,
  paragraphs: 12,
  signoff: 400,
} as const;

/** The wording of ONE mailing in one language: a greeting (`{name}` is replaced by the recipient's display name), paragraphs and a sign-off. */
export const BereavementMailingLocaleContent = Type.Object({
  title: Type.String({ maxLength: BEREAVEMENT_MAILING_CONTENT_LIMITS.title }),
  greeting: Type.String({ maxLength: BEREAVEMENT_MAILING_CONTENT_LIMITS.greeting }),
  paragraphs: Type.Array(Type.String({ maxLength: BEREAVEMENT_MAILING_CONTENT_LIMITS.paragraph }), {
    maxItems: BEREAVEMENT_MAILING_CONTENT_LIMITS.paragraphs,
  }),
  signoff: Type.String({ maxLength: BEREAVEMENT_MAILING_CONTENT_LIMITS.signoff }),
});
export type BereavementMailingLocaleContent = Static<typeof BereavementMailingLocaleContent>;

/** `content_jsonb` of a config / run: `{ en: {...} }` (one language today; multi-language wording is deferred). Empty `{}` = nothing written yet. */
export const BereavementMailingContent = Type.Object({
  en: Type.Optional(BereavementMailingLocaleContent),
});
export type BereavementMailingContent = Static<typeof BereavementMailingContent>;

/** One letter of the batch: the addressee, the address block (one string per line) and the already-personalized greeting. */
export const BereavementMailingBatchLetter = Type.Object({
  recipientName: text,
  addressLines: Type.Array(text, { minItems: 1, maxItems: 8 }),
  greeting: text,
});
export type BereavementMailingBatchLetter = Static<typeof BereavementMailingBatchLetter>;

export const BereavementMailingBatchRenderPayload = Type.Object({
  /** The run id: the aggregate the document is filed against and the back-reference names. */
  aggregateId: text,
  /** The letter's heading (the agency's own wording). Deliberately NOT named `title`: the renderer reads `title` as the document row's title, which stays the generic default. */
  heading: text,
  paragraphs: Type.Array(text, { minItems: 1 }),
  signoff: text,
  letters: Type.Array(BereavementMailingBatchLetter, { minItems: 1 }),
});
export type BereavementMailingBatchRenderPayload = Static<
  typeof BereavementMailingBatchRenderPayload
>;
export const assertBereavementMailingBatchRenderPayload = (
  p: unknown,
): BereavementMailingBatchRenderPayload =>
  assertRenderPayload(BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY, BereavementMailingBatchRenderPayload, p);
