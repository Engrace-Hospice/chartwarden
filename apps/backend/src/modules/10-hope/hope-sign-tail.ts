// apps/backend/src/modules/10-hope/hope-sign-tail.ts — what `signTimepoint` records AFTER the draft->signed UPDATE, on
// the same transaction: the §D8 compensating finding and the `m10.hope.*` events. Split out of
// `hope-route-service-db.ts`. Every id used here is the SIGNED ROW's (`signed.id`), never the URL parameter: the
// finding, the outbox aggregate and both event payloads must carry the canonical id however the caller cased or
// formatted the path.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";

const FINDING = schema.hopeValidationFindings;
const SFV = schema.symptomFollowUpVisits;

/** The §D8 rule id the compensating warning finding carries (spec §D8 / M10 §7.13). */
const D8_MISSING_PPS_RULE = "D8_CLINICAL_CONTEXT_PPS_MISSING";

type AssessmentRow = typeof schema.hopeAssessments.$inferSelect;

export type HopeSignEmit = (
  tx: unknown,
  organizationId: string,
  eventName: string,
  aggregateKind: string,
  aggregateId: string,
  payload: Record<string, unknown>,
) => Promise<void>;

interface SignedTailInput {
  readonly organizationId: string;
  readonly membershipId: string;
  /** The draft as it was when locked (its RFA kind, lateness and J2051 fields). */
  readonly draft: AssessmentRow;
  /** The signed row the UPDATE returned. */
  readonly signed: AssessmentRow;
  readonly at: Date;
  /** The D8 context: no PPS reading on file at signing (or the M9 seam could not answer at all). */
  readonly ppsMissing: boolean;
  /** `null` when the M9 seam could not be reached, so no clinical-context snapshot was taken. */
  readonly snapshotTaken: boolean;
  /** The finding's NOT NULL siting, or `null` when it could not be resolved. */
  readonly siting: { readonly providerEntityId: string; readonly locationId: string } | null;
  readonly admissionId: string;
}

/**
 * §D8's compensating control (GAP-019): the missing-PPS gap must be VISIBLE to compliance / HQRP review, not merely "not
 * blocking". Without the finding row the gap was invisible — the assessment signed clean and nothing anywhere recorded
 * that its clinical context was absent.
 */
async function recordD8Finding(t: DbClient, input: SignedTailInput): Promise<void> {
  if (!input.ppsMissing) return;
  if (!input.siting) {
    // NOT NULL siting could not be resolved, so the finding row is impossible. Say so — a compliance control that
    // silently declines to record itself is the defect this closes.
    console.warn(
      `m10: HOPE assessment ${input.signed.id} signed with no PPS clinical context and the D8 warning finding could not be written (admission ${input.admissionId} has no resolvable provider entity / location).`,
    );
    return;
  }
  await t.insert(FINDING).values({
    organizationId: input.organizationId,
    providerEntityId: input.siting.providerEntityId,
    locationId: input.siting.locationId,
    hopeAssessmentId: input.signed.id,
    ruleId: D8_MISSING_PPS_RULE,
    severity: "warning",
    section: "J",
    message: input.snapshotTaken
      ? "No PPS on file at signing: the clinical-context snapshot was taken and contains no PPS score (D8)."
      : "No PPS on file at signing: the M9 assessment seam could not be reached, so no clinical-context snapshot was taken (D8).",
    evaluatedAt: input.at,
    resolved: false,
  });
}

/**
 * §2.4 / §4.9 — a signed record whose server-authoritative J2051 verdict fired announces it (M11's order-suggestion
 * banner, M30 Timely Follow-Up, M33). The SFV obligation it references was opened while the draft was answered
 * (readiness refuses to sign a fired trigger without one), so it is read here rather than created.
 */
async function emitJ2051Trigger(
  t: DbClient,
  input: SignedTailInput,
  emit: HopeSignEmit,
): Promise<void> {
  const { organizationId, signed } = input;
  if (!signed.j2051TriggerFired) return;
  const [sfv] = await t
    .select()
    .from(SFV)
    .where(and(eq(SFV.organizationId, organizationId), eq(SFV.triggeringAssessmentId, signed.id)))
    .limit(1);
  if (!sfv) return;
  await emit(t, organizationId, "m10.hope.j2051_trigger_fired", "hope_assessment", signed.id, {
    assessmentId: signed.id,
    sfvId: sfv.id,
    maxSeverity: signed.j2051MaxSeverity ?? "none",
    triggeredAt: sfv.triggeredAt.toISOString(),
    dueAt: sfv.dueAt.toISOString(),
  });
}

/** The D8 finding, the `timepoint_signed` event and (when the J2051 trigger fired) its announcement. */
export async function recordSignedTail(
  t: DbClient,
  input: SignedTailInput,
  emit: HopeSignEmit,
): Promise<void> {
  await recordD8Finding(t, input);
  await emit(
    t,
    input.organizationId,
    "m10.hope.timepoint_signed",
    "hope_assessment",
    input.signed.id,
    {
      assessmentId: input.signed.id,
      rfaKind: input.draft.rfaKind,
      signedAt: input.at.toISOString(),
      signedBy: input.membershipId,
      j2051TriggerFired: input.signed.j2051TriggerFired,
      wasLate: input.draft.wasLate,
    },
  );
  await emitJ2051Trigger(t, input, emit);
}
