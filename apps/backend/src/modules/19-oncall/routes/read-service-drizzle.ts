// apps/backend/src/modules/19-oncall/routes/read-service-drizzle.ts — the Drizzle-backed M19 READ service.
//
// Every method opens its own `withOrgContext` so RLS scopes each statement to `app.org_id`; no query
// compares `organization_id` as its ONLY tenancy control (the eq() clauses that do appear are defence in
// depth behind RLS, never instead of it).
//
// FOUR DECISIONS THAT ARE LOAD-BEARING:
//
//   1. THE VENDOR PROJECTION IS CHOSEN BY SESSION CLASS, NOT BY A FLAG THE HANDLER PASSES. `getTriageCall`
//      branches on `isVendorActor(actor)` and returns a DIFFERENT TYPE (§8.3.1: the projection must not be
//      bypassable by route-level code). There is no parameter a caller can set to get the wide shape.
//   2. THE SUD GATE RUNS BEFORE THE MEDICATION READ, NOT AFTER IT. `readTriageMedicationContext` takes
//      `sudDisclosurePermitted` as a REQUIRED argument (M19-T05), so the unredacted projection never exists
//      as a value in this process. The verdict comes from M39 through `../abac-predicates`' port, and an
//      unbound / erroring M39 yields `false`.
//   3. `nextQuestionId` IS COMPUTED SERVER-SIDE FROM THE ANSWER LEDGER. §7.1's D5 rule is that the client
//      renders the server's cursor and cannot move it; recomputing it on every read (rather than storing
//      it) means a correction row can never leave a stale cursor behind.
//   4. THE PORTAL PROJECTION IS BUILT FROM A NARROW SELECT, NOT FROM THE DETAIL ROW. `PortalTriageSummary`
//      has no field for the AI advisory, the vendor handoff or any clinician free text (D11/D13), and the
//      query below never selects those columns — so a future edit to the DTO cannot start leaking them by
//      accident.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { IsoInstant, OnCallActor, PortalTriageSummary } from "@wardenx/types";
import { type SQL, and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { seamOncallAbacPorts } from "../abac-predicates";
import { readTriageMedicationContext } from "../clinical/medication-context";
import { permittedDispositions } from "../lifecycle/disposition";
import { require_ } from "../lifecycle/errors";
import { hasUnacknowledgedMandatoryEscalation } from "../lifecycle/escalation";
import { nextUnansweredQuestion } from "../lifecycle/protocol";
import { createOnCallProvider } from "../seams/providers";
import { buildDrizzleOncallSeamStore } from "../seams/store-drizzle";
import { triageVendorAdapters } from "../vendor/registry";
import { type M19ReadActor, disciplineOf, isVendorActor } from "./actor";
import {
  type CursorPage,
  M19_PAGE_SIZES,
  clampLimit,
  decodeCursor,
  toCursorPage,
} from "./concurrency";
import type {
  CurrentOnCallView,
  EscalationFilters,
  EscalationInboxItem,
  M19ReadService,
  OnCallShiftView,
  OncallPolicyView,
  PaperReentryWorklistView,
  PortalRecentFilters,
  ProtocolFilters,
  ShiftFilters,
  TriageAnswerView,
  TriageCallDetail,
  TriageCallFilters,
  TriageCallListItem,
  TriageCallReadScope,
  TriageEscalationView,
  TriageProtocolView,
  TriageRedactedCategory,
  TriageStateHistoryView,
  TriageTranscriptView,
  VendorBindingView,
  VendorTriageCallView,
} from "./read-service";

/** The §3.4 "all open cases right now" board — the six non-terminal states in one filter. */
const OPEN_STATES = [
  "open",
  "protocol_in_progress",
  "awaiting_callback",
  "disposition_pending",
  "documented_pending_encounter",
  "escalated_unresolved",
] as const;

const iso = (d: Date | string | null): IsoInstant | null =>
  d === null
    ? null
    : ((d instanceof Date ? d.toISOString() : new Date(d).toISOString()) as IsoInstant);

const isoReq = (d: Date | string): IsoInstant => iso(d) as IsoInstant;

/**
 * The per-tenant DEK envelope (D14) the two cipher columns ride.
 *
 * Phase 1 has no key-management binding for M19, so the decrypt port is INJECTED and the default REFUSES
 * rather than returning the stored bytes. Returning the ciphertext as though it were plaintext would put
 * an unreadable blob on a clinician's screen and — worse — would make the per-access audit row claim a
 * decrypt happened. `null` from the port means "this call carries none"; a throw means "not decryptable
 * here", and the route surfaces that as an error rather than as an empty transcript.
 */
export interface TranscriptCipherPort {
  decrypt(input: {
    readonly organizationId: string;
    readonly cipher: string;
  }): Promise<string>;
}

/** The default port: refuses. See {@link TranscriptCipherPort}. */
export const denyStubTranscriptCipherPort: TranscriptCipherPort = {
  async decrypt() {
    throw new Error(
      "m19: no transcript cipher port is bound; the per-tenant DEK envelope (D14) cannot be opened in this deployment",
    );
  },
};

/** Deps the composition root binds. */
export interface M19ReadDeps {
  readonly cipher?: TranscriptCipherPort;
  readonly now?: () => Date;
  /** M39's 42 CFR Part 2 verdict. Defaults to the seam port (fail-closed on an unbound / erroring M39). */
  readonly sudDisclosurePermitted?: (input: {
    organizationId: string;
    patientId: string;
    sessionClass: string;
  }) => Promise<boolean>;
}

export function buildDrizzleM19ReadService(db: DbClient, deps: M19ReadDeps = {}): M19ReadService {
  const CALL = schema.triageCall;
  const ANSWER = schema.triageCallAnswer;
  const ESCALATION = schema.triageEscalation;
  const HISTORY = schema.triageCallStateHistory;
  const SHIFT = schema.onCallShift;
  const POLICY = schema.tenantOncallPolicy;
  const PROTOCOL = schema.triageProtocol;
  const QUESTION = schema.triageProtocolQuestion;
  const VENDOR = schema.externalTriageVendor;
  const WORKLIST = schema.triagePaperReentryWorklist;

  const now = deps.now ?? (() => new Date());
  const cipher = deps.cipher ?? denyStubTranscriptCipherPort;
  const onCallProvider = createOnCallProvider(buildDrizzleOncallSeamStore(db));

  const ctx = (actor: M19ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  /** §7.13's M16 precedent — the Part 2 verdict, resolved ONCE per read and passed down as a value. */
  const sudAllowed = async (actor: M19ReadActor, patientId: string | null): Promise<boolean> => {
    if (patientId === null) return false;
    if (deps.sudDisclosurePermitted) {
      return deps
        .sudDisclosurePermitted({
          organizationId: actor.organizationId,
          patientId,
          sessionClass: actor.sessionClass,
        })
        .catch(() => false);
    }
    // The default reuses M39's `family_caregiver_access`-shaped port with the Part 2 consent type, through
    // the same lazily-resolved seam the ABAC predicates use.
    return seamOncallAbacPorts
      .familyCaregiverAccessActive({
        organizationId: actor.organizationId,
        patientId,
        sessionClass: `${actor.sessionClass}:42_cfr_part_2_release`,
      })
      .catch(() => false);
  };

  const mapAnswer = (row: {
    id: string;
    triageProtocolQuestionId: string;
    questionOrder: number | null;
    prompt: string | null;
    answerType: string | null;
    answerValueText: string | null;
    answerValueInt: number | null;
    answerValueBool: boolean | null;
    redFlagHit: boolean;
    correctionOfAnswerId: string | null;
    answeredAt: Date;
    answeredByMembershipId: string;
  }): TriageAnswerView => ({
    id: row.id,
    questionId: row.triageProtocolQuestionId,
    questionOrder: row.questionOrder ?? 0,
    prompt: row.prompt ?? "",
    answerType: (row.answerType ?? "free_text") as TriageAnswerView["answerType"],
    valueText: row.answerValueText,
    valueInt: row.answerValueInt,
    valueBool: row.answerValueBool,
    redFlagHit: row.redFlagHit,
    correctionOfAnswerId: row.correctionOfAnswerId,
    answeredAt: isoReq(row.answeredAt),
    answeredByMembershipId: row.answeredByMembershipId,
  });

  const mapEscalation = (row: {
    id: string;
    tier: string;
    triggerKind: string;
    escalatedToMembershipId: string | null;
    escalatedToExternalActorId: string | null;
    escalatedAt: Date;
    acknowledgedAt: Date | null;
    resolvedAt: Date | null;
    resolvedByMembershipId: string | null;
  }): TriageEscalationView => ({
    id: row.id,
    tier: row.tier as TriageEscalationView["tier"],
    triggerKind: row.triggerKind as TriageEscalationView["triggerKind"],
    state:
      row.resolvedAt !== null ? "resolved" : row.acknowledgedAt !== null ? "acknowledged" : "open",
    mandatory: row.triggerKind === "mandatory_protocol",
    escalatedToMembershipId: row.escalatedToMembershipId,
    escalatedToExternalActorId: row.escalatedToExternalActorId,
    escalatedAt: isoReq(row.escalatedAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    resolvedAt: iso(row.resolvedAt),
    resolvedByMembershipId: row.resolvedByMembershipId,
  });

  /**
   * GAP-059 — narrow the list IN SQL (RLS is org-only). Unrestricted scope adds nothing; otherwise a row
   * passes if its patient is on the caseload OR the caller handled it (state-history actor). An empty
   * caseload with no membership yields `false`, i.e. zero rows — fail closed.
   */
  const callScopeConditions = (scope: TriageCallReadScope): SQL[] => {
    if (scope.patientIds === null) return [];
    const arms: SQL[] = [];
    if (scope.patientIds.length > 0) arms.push(inArray(CALL.patientId, [...scope.patientIds]));
    if (scope.membershipId !== null) {
      arms.push(sql`EXISTS (
        SELECT 1 FROM ${HISTORY}
        WHERE ${HISTORY.triageCallId} = ${CALL.id}
          AND ${HISTORY.actorMembershipId} = ${scope.membershipId}
      )`);
    }
    return [arms.length > 0 ? (or(...arms) as SQL) : sql`false`];
  };

  return {
    async listTriageCalls(actor, filters, scope): Promise<CursorPage<TriageCallListItem>> {
      const limit = clampLimit(filters.limit, M19_PAGE_SIZES.triageCalls);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await tx
          .select({
            id: CALL.id,
            providerEntityId: CALL.providerEntityId,
            patientId: CALL.patientId,
            state: CALL.state,
            disposition: CALL.disposition,
            callerKind: CALL.callerKind,
            inboundChannel: CALL.inboundChannel,
            source: CALL.source,
            chiefComplaintSnomed: CALL.chiefComplaintSnomed,
            openedAt: CALL.openedAt,
            firstResponseAt: CALL.firstResponseAt,
            closedAt: CALL.closedAt,
            version: CALL.version,
            protocolLabel: PROTOCOL.chiefComplaintLabel,
            openEscalationCount: sql<number>`(
              SELECT count(*)::int FROM ${ESCALATION}
              WHERE ${ESCALATION.triageCallId} = ${CALL.id} AND ${ESCALATION.resolvedAt} IS NULL
            )`,
            redFlagAnswerCount: sql<number>`(
              SELECT count(*)::int FROM ${ANSWER}
              WHERE ${ANSWER.triageCallId} = ${CALL.id} AND ${ANSWER.redFlagHit} = true
            )`,
          })
          .from(CALL)
          .leftJoin(PROTOCOL, eq(PROTOCOL.id, CALL.selectedProtocolId))
          .where(
            and(
              eq(CALL.organizationId, actor.organizationId),
              ...callScopeConditions(scope),
              ...(filters.state ? [eq(CALL.state, filters.state)] : []),
              ...(filters.openOnly ? [inArray(CALL.state, [...OPEN_STATES])] : []),
              ...(filters.providerEntityId
                ? [eq(CALL.providerEntityId, filters.providerEntityId)]
                : []),
              ...(filters.patientId ? [eq(CALL.patientId, filters.patientId)] : []),
              ...(filters.openedFrom ? [gte(CALL.openedAt, new Date(filters.openedFrom))] : []),
              ...(filters.openedTo ? [lte(CALL.openedAt, new Date(filters.openedTo))] : []),
              // §4.1.1 keyset: `(opened_at DESC, id)`.
              ...(cursor
                ? [
                    or(
                      lt(CALL.openedAt, new Date(cursor.a)),
                      and(eq(CALL.openedAt, new Date(cursor.a)), lt(CALL.id, cursor.id)),
                    ),
                  ]
                : []),
            ),
          )
          .orderBy(desc(CALL.openedAt), desc(CALL.id))
          .limit(limit + 1);

        return toCursorPage(
          actor.organizationId,
          rows,
          limit,
          (r) => ({ a: isoReq(r.openedAt), id: r.id }),
          (r): TriageCallListItem => ({
            id: r.id,
            providerEntityId: r.providerEntityId,
            patientId: r.patientId,
            state: r.state,
            disposition: r.disposition,
            callerKind: r.callerKind,
            inboundChannel: r.inboundChannel,
            source: r.source,
            chiefComplaintSnomed: r.chiefComplaintSnomed,
            openedAt: isoReq(r.openedAt),
            firstResponseAt: iso(r.firstResponseAt),
            closedAt: iso(r.closedAt),
            protocolLabel: r.protocolLabel,
            openEscalationCount: Number(r.openEscalationCount ?? 0),
            redFlagAnswerCount: Number(r.redFlagAnswerCount ?? 0),
            version: r.version,
          }),
        );
      });
    },

    async getTriageCall(actor, triageCallId) {
      const { call, answers, escalations, history, questions } = await withOrgContext(
        db,
        ctx(actor),
        async (tx) => {
          const [row] = await tx
            .select()
            .from(CALL)
            .where(and(eq(CALL.id, triageCallId), eq(CALL.organizationId, actor.organizationId)))
            .limit(1);
          require_(
            row !== undefined,
            "TRIAGE_CALL_NOT_FOUND",
            `no triage call ${triageCallId} is readable in this organization`,
          );

          const answerRows = await tx
            .select({
              id: ANSWER.id,
              triageProtocolQuestionId: ANSWER.triageProtocolQuestionId,
              questionOrder: QUESTION.questionOrder,
              prompt: QUESTION.prompt,
              answerType: QUESTION.answerType,
              answerValueText: ANSWER.answerValueText,
              answerValueInt: ANSWER.answerValueInt,
              answerValueBool: ANSWER.answerValueBool,
              redFlagHit: ANSWER.redFlagHit,
              correctionOfAnswerId: ANSWER.correctionOfAnswerId,
              answeredAt: ANSWER.answeredAt,
              answeredByMembershipId: ANSWER.answeredByMembershipId,
            })
            .from(ANSWER)
            .leftJoin(QUESTION, eq(QUESTION.id, ANSWER.triageProtocolQuestionId))
            .where(eq(ANSWER.triageCallId, triageCallId))
            .orderBy(asc(ANSWER.answeredAt));

          const escalationRows = await tx
            .select({
              id: ESCALATION.id,
              tier: ESCALATION.tier,
              triggerKind: ESCALATION.triggerKind,
              escalatedToMembershipId: ESCALATION.escalatedToMembershipId,
              escalatedToExternalActorId: ESCALATION.escalatedToExternalActorId,
              escalatedAt: ESCALATION.escalatedAt,
              acknowledgedAt: ESCALATION.acknowledgedAt,
              resolvedAt: ESCALATION.resolvedAt,
              resolvedByMembershipId: ESCALATION.resolvedByMembershipId,
            })
            .from(ESCALATION)
            .where(eq(ESCALATION.triageCallId, triageCallId))
            .orderBy(asc(ESCALATION.escalatedAt));

          const historyRows = await tx
            .select({
              id: HISTORY.id,
              fromState: HISTORY.fromState,
              toState: HISTORY.toState,
              transitionedAt: HISTORY.transitionedAt,
              actorMembershipId: HISTORY.actorMembershipId,
              systemActor: HISTORY.systemActor,
            })
            .from(HISTORY)
            .where(eq(HISTORY.triageCallId, triageCallId))
            .orderBy(asc(HISTORY.transitionedAt));

          const questionRows = row.selectedProtocolId
            ? await tx
                .select({
                  questionId: QUESTION.id,
                  protocolId: QUESTION.triageProtocolId,
                  questionOrder: QUESTION.questionOrder,
                  prompt: QUESTION.prompt,
                  answerType: QUESTION.answerType,
                  answerEnumValues: QUESTION.answerEnumValues,
                  required: QUESTION.required,
                  isRedFlagQuestion: QUESTION.isRedFlagQuestion,
                  redFlagMatch: QUESTION.redFlagMatch,
                })
                .from(QUESTION)
                .where(eq(QUESTION.triageProtocolId, row.selectedProtocolId))
                .orderBy(asc(QUESTION.questionOrder))
            : [];

          const [protocolRow] = row.selectedProtocolId
            ? await tx
                .select({ label: PROTOCOL.chiefComplaintLabel })
                .from(PROTOCOL)
                .where(eq(PROTOCOL.id, row.selectedProtocolId))
                .limit(1)
            : [];

          return {
            call: { ...row, protocolLabel: protocolRow?.label ?? null },
            answers: answerRows,
            escalations: escalationRows,
            history: historyRows,
            questions: questionRows,
          };
        },
      );

      const answerViews = answers.map(mapAnswer);
      const escalationViews = escalations.map(mapEscalation);
      const discipline = disciplineOf(actor);
      // §7.1 / D5 — the server's own cursor, recomputed from the ledger (decision 3).
      const nextQuestion = nextUnansweredQuestion(
        questions.map((q) => ({
          questionId: q.questionId,
          protocolId: q.protocolId,
          questionOrder: q.questionOrder,
          prompt: q.prompt,
          answerType: q.answerType,
          answerEnumValues: (q.answerEnumValues as string[] | null) ?? null,
          required: q.required,
          isRedFlagQuestion: q.isRedFlagQuestion,
          redFlagMatch: q.redFlagMatch as never,
        })),
        answerViews.map((a) => ({
          answerId: a.id,
          questionId: a.questionId,
          correctionOfAnswerId: a.correctionOfAnswerId,
          redFlagHit: a.redFlagHit,
        })),
      );

      const common = {
        id: call.id,
        providerEntityId: call.providerEntityId,
        state: call.state,
        callerKind: call.callerKind,
        inboundChannel: call.inboundChannel,
        chiefComplaintSnomed: call.chiefComplaintSnomed,
        openedAt: isoReq(call.openedAt),
        onCallShiftId: call.onCallShiftId,
        selectedProtocolId: call.selectedProtocolId,
        selectedProtocolVersion: call.selectedProtocolVersion,
        answers: answerViews,
        escalations: escalationViews,
        nextQuestionId: nextQuestion?.questionId ?? null,
        permittedDispositions: permittedDispositions(discipline),
        version: call.version,
      } as const;

      // Decision 1 — a vendor session gets a DIFFERENT TYPE, not a filtered one.
      if (isVendorActor(actor)) return common satisfies VendorTriageCallView;

      // Decision 2 — the Part 2 verdict is resolved BEFORE the medication read.
      const partTwoAllowed = await sudAllowed(actor, call.patientId);
      const medicationContext =
        call.patientId === null
          ? null
          : await readTriageMedicationContext({
              organizationId: actor.organizationId,
              patientId: call.patientId,
              sudDisclosurePermitted: partTwoAllowed,
            });

      const redactedCategories: TriageRedactedCategory[] = [];
      if (!partTwoAllowed && (medicationContext?.sudRedactedCount ?? 0) > 0) {
        redactedCategories.push("sud");
      }

      const detail: TriageCallDetail = {
        ...common,
        patientId: call.patientId,
        disposition: call.disposition,
        source: call.source,
        firstResponseAt: iso(call.firstResponseAt),
        closedAt: iso(call.closedAt),
        protocolLabel: call.protocolLabel,
        openEscalationCount: escalationViews.filter((e) => e.state !== "resolved").length,
        redFlagAnswerCount: answerViews.filter((a) => a.redFlagHit).length,
        locationId: call.locationId,
        admissionId: call.admissionId,
        callerDisplayName: call.callerDisplayName,
        callerPhoneE164: call.callerPhoneE164,
        callerRelationshipLabel: call.callerRelationshipLabel,
        callerCaregiverId: call.callerCaregiverId,
        chiefComplaintText: call.chiefComplaintText,
        suggestedProtocolId: call.suggestedProtocolId,
        suggestedProtocolConfidence: call.suggestedProtocolConfidence,
        hospitalizationRiskBand: call.hospitalizationRiskBand,
        dispositionData: call.dispositionData as TriageCallDetail["dispositionData"],
        linkedEncounterId: call.linkedEncounterId,
        linkedVerbalOrderIds: (call.linkedVerbalOrderIds as string[] | null) ?? [],
        linkedVisitProposalId: call.linkedVisitProposalId,
        paperOriginFlag: call.paperOriginFlag,
        paperOriginalOpenedAt: iso(call.paperOriginalOpenedAt),
        documentedAt: iso(call.documentedAt),
        stateHistory: history.map(
          (h): TriageStateHistoryView => ({
            id: h.id,
            fromState: h.fromState,
            toState: h.toState,
            transitionedAt: isoReq(h.transitionedAt),
            actorMembershipId: h.actorMembershipId,
            systemActor: h.systemActor,
          }),
        ),
        medicationContext,
        redactedCategories,
        dispositionBlockedByMandatoryEscalation: hasUnacknowledgedMandatoryEscalation(
          escalationViews.map((e) => ({
            escalationId: e.id,
            tier: e.tier,
            triggerKind: e.triggerKind,
            escalatedAt: e.escalatedAt,
            acknowledgedAt: e.acknowledgedAt,
            resolvedAt: e.resolvedAt,
            escalatedToMembershipId: e.escalatedToMembershipId,
            escalatedToExternalActorId: e.escalatedToExternalActorId,
          })),
        ),
      };
      return detail;
    },

    /**
     * §4.1 row 14 — the step-up, per-access-audited transcript read.
     *
     * A VENDOR session is refused outright, before the cipher is touched: §6 grants Ext Triage Op no
     * transcript key, and D13's minimization profile has no arm that could carry one. The guard is here as
     * well as at the route because this method decrypts, and a decrypt with no in-agency actor behind it is
     * the one read §8.3.4 lists under "vendor receives full PHI".
     */
    async getTranscript(actor, triageCallId): Promise<TriageTranscriptView> {
      require_(
        !isVendorActor(actor),
        "ENCOUNTER_ACTOR_CANNOT_AUTHOR",
        "an external triage vendor session may not decrypt a call transcript (§6 / D13)",
      );
      const row = await withOrgContext(db, ctx(actor), async (tx) => {
        const [found] = await tx
          .select({
            id: CALL.id,
            transcriptCipher: CALL.transcriptCipher,
            callerQuoteCipher: CALL.callerQuoteCipher,
          })
          .from(CALL)
          .where(and(eq(CALL.id, triageCallId), eq(CALL.organizationId, actor.organizationId)))
          .limit(1);
        return found;
      });
      require_(
        row !== undefined,
        "TRIAGE_CALL_NOT_FOUND",
        `no triage call ${triageCallId} is readable in this organization`,
      );

      const open = async (value: string | null): Promise<string | null> =>
        value === null
          ? null
          : cipher.decrypt({ organizationId: actor.organizationId, cipher: value });

      return {
        triageCallId,
        transcript: await open(row.transcriptCipher),
        callerQuote: await open(row.callerQuoteCipher),
        decryptedAt: isoReq(now()),
      };
    },

    async listEscalations(actor, filters): Promise<CursorPage<EscalationInboxItem>> {
      const limit = clampLimit(filters.limit, M19_PAGE_SIZES.escalations);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      const openOnly = filters.openOnly ?? true; // an inbox shows what is outstanding
      const nowMs = now().getTime();
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await tx
          .select({
            id: ESCALATION.id,
            tier: ESCALATION.tier,
            triggerKind: ESCALATION.triggerKind,
            escalatedToMembershipId: ESCALATION.escalatedToMembershipId,
            escalatedToExternalActorId: ESCALATION.escalatedToExternalActorId,
            escalatedAt: ESCALATION.escalatedAt,
            acknowledgedAt: ESCALATION.acknowledgedAt,
            resolvedAt: ESCALATION.resolvedAt,
            resolvedByMembershipId: ESCALATION.resolvedByMembershipId,
            version: ESCALATION.version,
            triageCallId: ESCALATION.triageCallId,
            providerEntityId: ESCALATION.providerEntityId,
            patientId: CALL.patientId,
            callState: CALL.state,
          })
          .from(ESCALATION)
          .innerJoin(CALL, eq(CALL.id, ESCALATION.triageCallId))
          .where(
            and(
              eq(ESCALATION.organizationId, actor.organizationId),
              ...(filters.tier ? [eq(ESCALATION.tier, filters.tier)] : []),
              ...(openOnly ? [isNull(ESCALATION.resolvedAt)] : []),
              ...(filters.triageCallId ? [eq(ESCALATION.triageCallId, filters.triageCallId)] : []),
              // §4.1.1 keyset: `(escalated_at DESC, id)`.
              ...(cursor
                ? [
                    or(
                      lt(ESCALATION.escalatedAt, new Date(cursor.a)),
                      and(
                        eq(ESCALATION.escalatedAt, new Date(cursor.a)),
                        lt(ESCALATION.id, cursor.id),
                      ),
                    ),
                  ]
                : []),
            ),
          )
          .orderBy(desc(ESCALATION.escalatedAt), desc(ESCALATION.id))
          .limit(limit + 1);

        return toCursorPage(
          actor.organizationId,
          rows,
          limit,
          (r) => ({ a: isoReq(r.escalatedAt), id: r.id }),
          (r): EscalationInboxItem => ({
            ...mapEscalation(r),
            triageCallId: r.triageCallId,
            providerEntityId: r.providerEntityId,
            patientId: r.patientId,
            callState: r.callState,
            minutesOpen: Math.max(
              0,
              Math.floor((nowMs - new Date(r.escalatedAt).getTime()) / 60_000),
            ),
            version: r.version,
          }),
        );
      });
    },

    async listShifts(actor, filters): Promise<CursorPage<OnCallShiftView>> {
      const limit = clampLimit(filters.limit, M19_PAGE_SIZES.shifts);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await tx
          .select()
          .from(SHIFT)
          .where(
            and(
              eq(SHIFT.organizationId, actor.organizationId),
              ...(filters.providerEntityId
                ? [eq(SHIFT.providerEntityId, filters.providerEntityId)]
                : []),
              ...(filters.discipline ? [eq(SHIFT.discipline, filters.discipline)] : []),
              ...(filters.from ? [gte(SHIFT.shiftEndsAt, new Date(filters.from))] : []),
              ...(filters.to ? [lte(SHIFT.shiftStartsAt, new Date(filters.to))] : []),
              // §4.1.1 keyset: `(shift_starts_at DESC, id)`.
              ...(cursor
                ? [
                    or(
                      lt(SHIFT.shiftStartsAt, new Date(cursor.a)),
                      and(eq(SHIFT.shiftStartsAt, new Date(cursor.a)), lt(SHIFT.id, cursor.id)),
                    ),
                  ]
                : []),
            ),
          )
          .orderBy(desc(SHIFT.shiftStartsAt), desc(SHIFT.id))
          .limit(limit + 1);

        return toCursorPage(
          actor.organizationId,
          rows,
          limit,
          (r) => ({ a: isoReq(r.shiftStartsAt), id: r.id }),
          (r): OnCallShiftView => ({
            id: r.id,
            providerEntityId: r.providerEntityId,
            shiftStartsAt: isoReq(r.shiftStartsAt),
            shiftEndsAt: isoReq(r.shiftEndsAt),
            discipline: r.discipline,
            status: r.status,
            primaryOnCallMembershipId: r.primaryOnCallMembershipId,
            backupMembershipId: r.backupMembershipId,
            externalActorId: r.externalActorId,
            externalActorLabel: r.externalActorLabel,
            openedAt: iso(r.openedAt),
            closedAt: iso(r.closedAt),
            m17VisitAssignmentRef: r.m17VisitAssignmentRef,
            cancellationReason: r.cancellationReason,
            version: r.version,
          }),
        );
      });
    },

    /**
     * §4.1 row 24 / §7.4 — who is on call NOW, PER ProviderEntity.
     *
     * The answer is keyed per PE and never unioned: CoP 418.100(c)(2) is per-CCN, so a union lets one
     * covered entity mask another's dark night (the M19-T06 finding). `actors: []` is a REAL answer.
     */
    async getCurrentOnCall(actor, input): Promise<CurrentOnCallView> {
      const asOf = (input.asOf ?? now().toISOString()) as IsoInstant;
      const providerEntityIds = input.providerEntityId
        ? [input.providerEntityId]
        : await withOrgContext(db, ctx(actor), async (tx) => {
            const rows = await tx
              .selectDistinct({ id: SHIFT.providerEntityId })
              .from(SHIFT)
              .where(eq(SHIFT.organizationId, actor.organizationId));
            // A PE with NO shift row at all never appears here. That is the read's honest limit and it is
            // why the §4.8 watchdog enumerates the org's ACTIVE provider entities instead: this route
            // answers "who is on call", the watchdog answers "who should be and is not".
            return rows.map((r) => r.id);
          });

      const perProviderEntity = await Promise.all(
        providerEntityIds.map(async (providerEntityId) => {
          const actors: readonly OnCallActor[] = await onCallProvider.currentOnCallActors(
            actor.organizationId,
            providerEntityId,
            asOf,
          );
          return {
            providerEntityId,
            actors,
            rnCoverageGap: !actors.some((a) => a.discipline === "clinical_rn"),
          };
        }),
      );
      return { asOf, perProviderEntity };
    },

    async getPolicy(actor, providerEntityId): Promise<OncallPolicyView> {
      const row = await withOrgContext(db, ctx(actor), async (tx) => {
        const [found] = await tx
          .select()
          .from(POLICY)
          .where(
            and(
              eq(POLICY.organizationId, actor.organizationId),
              eq(POLICY.providerEntityId, providerEntityId),
            ),
          )
          .limit(1);
        return found;
      });
      require_(
        row !== undefined,
        "ONCALL_POLICY_NOT_FOUND",
        `this organization has no on-call policy for provider entity ${providerEntityId}`,
      );
      return {
        id: row.id,
        providerEntityId: row.providerEntityId,
        model: row.model,
        escalationTiers: row.escalationTiers,
        callbackSlaPerSeverity: row.callbackSlaPerSeverity,
        stateOverrides: row.stateOverrides,
        externalTriageVendorId: row.externalTriageVendorId,
        emergencyContactE164: row.emergencyContactE164,
        aiProtocolSuggestionEnabled: row.aiProtocolSuggestionEnabled,
        aiHospitalizationRiskEnabled: row.aiHospitalizationRiskEnabled,
        version: row.version,
      };
    },

    async listProtocols(actor, filters): Promise<CursorPage<TriageProtocolView>> {
      const limit = clampLimit(filters.limit, M19_PAGE_SIZES.protocols);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      const at = now();
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await tx
          .select()
          .from(PROTOCOL)
          .where(
            and(
              // D4 — the platform floor plus this tenant's own rows, mirroring migration 0108's SELECT
              // policy at the layer that can say WHY a mis-scoped id is a 404 rather than an empty set.
              or(
                isNull(PROTOCOL.organizationId),
                eq(PROTOCOL.organizationId, actor.organizationId),
              ),
              ...((filters.effectiveOnly ?? true)
                ? [
                    lte(PROTOCOL.effectiveFrom, at),
                    or(isNull(PROTOCOL.effectiveTo), sql`${PROTOCOL.effectiveTo} > ${at}`),
                  ]
                : []),
              ...(filters.disciplineRequired
                ? [eq(PROTOCOL.disciplineRequired, filters.disciplineRequired)]
                : []),
              ...(filters.search
                ? [sql`${PROTOCOL.chiefComplaintLabel} ILIKE ${`%${filters.search}%`}`]
                : []),
              // §4.1.1 keyset: `(effective_from DESC, id)`.
              ...(cursor
                ? [
                    or(
                      lt(PROTOCOL.effectiveFrom, new Date(cursor.a)),
                      and(
                        eq(PROTOCOL.effectiveFrom, new Date(cursor.a)),
                        lt(PROTOCOL.id, cursor.id),
                      ),
                    ),
                  ]
                : []),
            ),
          )
          .orderBy(desc(PROTOCOL.effectiveFrom), desc(PROTOCOL.id))
          .limit(limit + 1);

        const questionRows =
          rows.length === 0
            ? []
            : await tx
                .select()
                .from(QUESTION)
                .where(
                  inArray(
                    QUESTION.triageProtocolId,
                    rows.map((r) => r.id),
                  ),
                )
                .orderBy(asc(QUESTION.questionOrder));

        const byProtocol = new Map<string, typeof questionRows>();
        for (const q of questionRows) {
          const list = byProtocol.get(q.triageProtocolId) ?? [];
          list.push(q);
          byProtocol.set(q.triageProtocolId, list);
        }

        return toCursorPage(
          actor.organizationId,
          rows,
          limit,
          (r) => ({ a: isoReq(r.effectiveFrom), id: r.id }),
          (r) => toProtocolView(r, byProtocol.get(r.id) ?? []),
        );
      });
    },

    async getProtocol(actor, protocolId): Promise<TriageProtocolView> {
      const found = await withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await tx
          .select()
          .from(PROTOCOL)
          .where(
            and(
              eq(PROTOCOL.id, protocolId),
              or(
                isNull(PROTOCOL.organizationId),
                eq(PROTOCOL.organizationId, actor.organizationId),
              ),
            ),
          )
          .limit(1);
        if (!row) return null;
        const questions = await tx
          .select()
          .from(QUESTION)
          .where(eq(QUESTION.triageProtocolId, protocolId))
          .orderBy(asc(QUESTION.questionOrder));
        return { row, questions };
      });
      require_(
        found !== null,
        "PROTOCOL_NOT_FOUND",
        `no triage protocol ${protocolId} is in this organization's catalog`,
      );
      return toProtocolView(found.row, found.questions);
    },

    async listVendorBindings(actor): Promise<readonly VendorBindingView[]> {
      const rows = await withOrgContext(db, ctx(actor), async (tx) =>
        tx
          .select()
          .from(VENDOR)
          .where(eq(VENDOR.organizationId, actor.organizationId))
          .orderBy(asc(VENDOR.name)),
      );
      return rows.map((r) => ({
        id: r.id,
        mdmVendorId: r.mdmVendorId,
        name: r.name,
        adapterKey: r.adapterKey,
        rnCoverageAttested: r.rnCoverageAttested,
        baaInEffect: r.baaInEffect,
        baaExpiresOn: r.baaExpiresOn === null ? null : r.baaExpiresOn.toISOString().slice(0, 10),
        minimizationProfile: profileLabelOf(r.defaultMinimizationPolicy),
        // §8.5 — the admin screen must be able to see that a configured binding has no loaded adapter
        // BEFORE 2 a.m., not discover it when a call needs handing off.
        adapterRegistered: triageVendorAdapters.find(r.adapterKey) !== null,
      }));
    },

    /**
     * §4.1 row 36 / §5.3 — the M31 portal's lay-language care log (decision 4).
     *
     * The SELECT names six columns and no more. There is no AI advisory, no vendor attribution, no
     * protocol answer and no clinician free text in the query, so `PortalTriageSummary` cannot start
     * carrying them by a later edit to the mapper alone.
     */
    async listPortalRecent(actor, patientId, filters): Promise<CursorPage<PortalTriageSummary>> {
      const limit = clampLimit(filters.limit, M19_PAGE_SIZES.portalRecent);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      const since = new Date(now().getTime() - (filters.sinceDays ?? 30) * 86_400_000);
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await tx
          .select({
            id: CALL.id,
            openedAt: CALL.openedAt,
            callerRelationshipLabel: CALL.callerRelationshipLabel,
            callerKind: CALL.callerKind,
            disposition: CALL.disposition,
          })
          .from(CALL)
          .where(
            and(
              eq(CALL.organizationId, actor.organizationId),
              eq(CALL.patientId, patientId),
              gte(CALL.openedAt, since),
              // A call the family can see is one that reached a documented outcome. An OPEN call is a
              // conversation in progress, and surfacing it would show a caregiver a half-finished
              // clinical judgement — §5.3's projection is a care LOG, not a live board.
              inArray(CALL.state, ["documented", "closed"]),
              ...(cursor
                ? [
                    or(
                      lt(CALL.openedAt, new Date(cursor.a)),
                      and(eq(CALL.openedAt, new Date(cursor.a)), lt(CALL.id, cursor.id)),
                    ),
                  ]
                : []),
            ),
          )
          .orderBy(desc(CALL.openedAt), desc(CALL.id))
          .limit(limit + 1);

        return toCursorPage(
          actor.organizationId,
          rows,
          limit,
          (r) => ({ a: isoReq(r.openedAt), id: r.id }),
          (r): PortalTriageSummary => ({
            triageCallId: r.id,
            occurredAt: isoReq(r.openedAt),
            callerRelationshipLabel: r.callerRelationshipLabel,
            callerKind: r.callerKind,
            dispositionSummaryLay: layDispositionSummary(r.disposition),
            visitDispatched: r.disposition === "visit_dispatched_now",
            visitScheduledFirstLight: r.disposition === "visit_scheduled_first_light",
          }),
        );
      });
    },

    async listPaperReentryWorklist(actor): Promise<readonly PaperReentryWorklistView[]> {
      const rows = await withOrgContext(db, ctx(actor), async (tx) =>
        tx
          .select()
          .from(WORKLIST)
          .where(
            and(eq(WORKLIST.organizationId, actor.organizationId), isNull(WORKLIST.reenteredAt)),
          )
          .orderBy(asc(WORKLIST.expiresAt)),
      );
      return rows.map((r) => ({
        id: r.id,
        providerEntityId: r.providerEntityId,
        outageWindowId: r.outageWindowId,
        shiftId: r.shiftId,
        shiftStartsAt: isoReq(r.shiftStartsAt),
        shiftEndsAt: isoReq(r.shiftEndsAt),
        assignedToMembershipId: r.assignedToMembershipId,
        reenteredAt: iso(r.reenteredAt),
        linkedTriageCallId: r.linkedTriageCallId,
        expiresAt: isoReq(r.expiresAt),
      }));
    },
  };
}

/** Project a protocol row + its questions onto the §4.1 catalog DTO. */
function toProtocolView(
  row: {
    id: string;
    organizationId: string | null;
    key: string;
    chiefComplaintLabel: string;
    snomedCode: string;
    disciplineRequired: string;
    isSystemLocked: boolean;
    requiresMandatoryEscalation: boolean;
    mandatoryEscalationTier: string | null;
    version: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    sortOrder: number;
  },
  questions: readonly {
    id: string;
    questionOrder: number;
    prompt: string;
    answerType: string;
    answerEnumValues: unknown;
    required: boolean;
    isRedFlagQuestion: boolean;
    redFlagMatch: unknown;
    isSystemLocked: boolean;
  }[],
): TriageProtocolView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    key: row.key,
    chiefComplaintLabel: row.chiefComplaintLabel,
    snomedCode: row.snomedCode,
    disciplineRequired: row.disciplineRequired,
    isSystemLocked: row.isSystemLocked,
    requiresMandatoryEscalation: row.requiresMandatoryEscalation,
    mandatoryEscalationTier:
      row.mandatoryEscalationTier as TriageProtocolView["mandatoryEscalationTier"],
    version: row.version,
    effectiveFrom: row.effectiveFrom.toISOString() as IsoInstant,
    effectiveTo: row.effectiveTo === null ? null : (row.effectiveTo.toISOString() as IsoInstant),
    sortOrder: row.sortOrder,
    questions: questions.map((q) => ({
      id: q.id,
      questionOrder: q.questionOrder,
      prompt: q.prompt,
      answerType: q.answerType as TriageProtocolView["questions"][number]["answerType"],
      answerEnumValues: (q.answerEnumValues as string[] | null) ?? null,
      required: q.required,
      isRedFlagQuestion: q.isRedFlagQuestion,
      redFlagMatch: q.redFlagMatch as TriageProtocolView["questions"][number]["redFlagMatch"],
      isSystemLocked: q.isSystemLocked,
    })),
  };
}

/** The D13 profile a vendor row's `jsonb` policy names, or the literal it holds. */
function profileLabelOf(policy: unknown): string {
  if (typeof policy === "string") return policy;
  if (policy !== null && typeof policy === "object" && "profile" in policy) {
    const named = (policy as { profile?: unknown }).profile;
    if (typeof named === "string") return named;
  }
  return "unknown";
}

/**
 * §5.3 / D13 — the lay-language sentence a family reads, keyed off the DISPOSITION ENUM.
 *
 * Never the enum value itself, and never the clinician's own words: "ed_transfer_acknowledged" means
 * nothing to a caregiver, and the free-text `disposition_data` fields are clinical prose written for a
 * chart. A disposition with no mapping falls back to the most general true statement rather than to the
 * raw value — an unmapped enum member must not leak an internal code into a portal (§5.1's "redacts
 * internal codes").
 */
export function layDispositionSummary(disposition: string | null): string {
  switch (disposition) {
    case "caregiver_education_only":
      return "A nurse gave advice by phone.";
    case "prn_intervention_authorized":
      return "A nurse authorized an as-needed medication already on the care plan.";
    case "verbal_order_recorded":
      return "A nurse took an order from the doctor by phone.";
    case "visit_dispatched_now":
      return "A nurse was sent to visit.";
    case "visit_scheduled_first_light":
      return "A visit was scheduled for the next morning.";
    case "gip_admission_proposed":
      return "The care team discussed a higher level of care.";
    case "ed_transfer_acknowledged":
      return "The care team was told about an emergency department visit.";
    case "pronouncement_scheduled":
      return "A nurse was sent to the home.";
    case "escalated_unresolved":
      return "The call was passed to a supervisor.";
    case "abandoned":
      return "The call ended before it could be completed.";
    default:
      return "Your call was received by the on-call team.";
  }
}
