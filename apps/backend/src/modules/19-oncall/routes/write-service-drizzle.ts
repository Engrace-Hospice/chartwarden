// apps/backend/src/modules/19-oncall/routes/write-service-drizzle.ts — the Drizzle-backed M19 WRITE service
// (§4.1's POST/PATCH rows).
//
// Shape of EVERY command: open `withOrgContext` (RLS pins app.org_id) → load the aggregate row → run the
// PURE §2.2-§2.7 decision (`../lifecycle`, `../roster`) over already-resolved facts → execute the
// transition's DECLARED side effects (`./effects-runner`) and apply the row change under the §2.5
// optimistic-concurrency guard → emit the §4.10 outbox event on the SAME tx. No business rule lives in
// SQL, and no event can outlive a rolled-back write (§2.4).
//
// SIX DECISIONS THAT ARE LOAD-BEARING AND EASY TO GET BACKWARDS:
//
//   1. THE M8 SEAM CALL RUNS AFTER THE TRANSACTION COMMITS, NEVER INSIDE IT. `selectDisposition` declares
//      `create_encounter` and the effect is resolved by `linkTriageEncounter` once the disposition has
//      committed. Two reasons, both hard: a cross-module seam probe inside your own transaction
//      self-deadlocks the pool (M21-T05's finding), and §2.7's degraded class D-B REQUIRES the transition
//      to survive an M8 outage — the call parks in `documented_pending_encounter` and the §4.8 worker
//      retries. A seam call inside the tx would roll the clinician's disposition back because a different
//      module was down.
//   2. THE D11/D12 ADVISORIES ARE READ AFTER THE CALL ROW EXISTS, AND NEITHER CAN FAIL THE OPEN. §8.6 is
//      explicit that the AI block degrades to "visibly disabled — no silent fallback or guess"; the two
//      M32 seams are the platform's only NON-throwing deny-stubs for exactly this reason (M19-T06). A
//      suggestion that cannot be fetched leaves `suggested_protocol_id` null and sets `aiBlockDisabled`.
//   3. THE TENANT AI GATES ARE CHECKED BEFORE THE SEAM IS CALLED, NOT AFTER. `tenant_oncall_policy
//      .ai_*_enabled` default to FALSE, and an M32 call made for a tenant that opted out would send
//      chief-complaint text across the AI boundary that the tenant refused — the disclosure is the call,
//      not the answer.
//   4. `openTriageCall` RESOLVES THE COVERING SHIFT SERVER-SIDE. `on_call_shift_id` is NOT NULL and it is
//      the CoP 418.100(c)(2) attribution: letting a caller name the shift lets them attribute their call
//      to someone else's coverage window. No covering shift is a 409 that names the gap.
//   5. THE PROTOCOL-CATALOG WRITES REFUSE PLATFORM-FLOOR ROWS AT THIS LAYER TOO. Migration 0108's RLS
//      policies already make the UPDATE impossible, but "0 rows updated" is not an answer a DON can act
//      on; §8.3.2 lists lowering a mandatory-escalation floor as the tampering threat, so the refusal says
//      which row and why.
//   6. EVERY MUTATION RE-DERIVES THE ACTOR'S DISCIPLINE FROM THE REQUEST CONTEXT. §7.3's matrix is
//      evaluated against `disciplineOf(actor)` INSIDE the transaction, so a grant revoked between the
//      preHandler and the commit still cannot select a clinician-judgment disposition.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type IsoInstant,
  type M19EventName,
  M19_AI_CONFIDENCE_FLOOR,
  M19_AI_OVERRIDE_REASON_MIN_CHARS,
  type TriageDispositionData,
  type TriageEscalationTier,
} from "@wardenx/types";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  buildCaseOpenedAlert,
  buildDocumentedAlert,
  buildMandatoryEscalationAlert,
  buildRedFlagHitAlert,
} from "../alerts";
import { linkTriageEncounter } from "../clinical/encounter-link";
import {
  type SelectableDisposition,
  DEFAULT_UNRESOLVED_ESCALATION_TIER,
} from "../lifecycle/disposition";
import type { TriageSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";
import {
  type TriageEscalationFacts,
  acknowledgeEscalation,
  assertRecipientCoherent,
  resolveEscalation as resolveEscalationDecision,
} from "../lifecycle/escalation";
import { assertPaperOriginCoherent, linkPaperReentry } from "../lifecycle/paper-reentry";
import {
  type TriageAnswerFacts,
  type TriageProtocolFacts,
  type TriageProtocolQuestionFacts,
  applyProtocol as applyProtocolDecision,
  mandatoryEscalationNotifyTiers,
  nextUnansweredQuestion,
  recordAnswer as recordAnswerDecision,
} from "../lifecycle/protocol";
import {
  type TriageCallFacts,
  assertVersion,
  completeProtocol as completeProtocolDecision,
  markAbandoned,
  markAwaitingCallback,
  openCallEffects,
  resolveEscalationAndDisposition,
  resumeAfterCallback,
  selectDisposition as selectDispositionDecision,
} from "../lifecycle/triage-call";
import {
  type OnCallShiftFacts,
  activateShift,
  cancelShift as cancelShiftDecision,
  completeShift,
  shiftCoversInstant,
} from "../roster/shift-machine";
import { getHospitalizationRiskProvider, getProtocolSuggestionProvider } from "../seams/consumed";
import { type M19WriteActor, disciplineOf, isVendorActor } from "./actor";
import { type EffectPatch, type StateHistoryPort, runEffects } from "./effects-runner";
import type {
  M19ReadService,
  OnCallShiftView,
  OncallPolicyView,
  TriageProtocolView,
  VendorBindingView,
} from "./read-service";
import type {
  AbandonCallInput,
  AlertPort,
  ApplyProtocolInput,
  AwaitingCallbackInput,
  CancelShiftInput,
  CorrectAnswerInput,
  CreateProtocolInput,
  CreateShiftInput,
  CreateVendorBindingInput,
  DocumentCallInput,
  EscalateInput,
  IdentifyPatientInput,
  M19WriteService,
  OpenTriageCallInput,
  OpenTriageCallResult,
  PaperReentryInput,
  PatchPolicyInput,
  PatchProtocolInput,
  PatchVendorBindingInput,
  ProtocolQuestionInput,
  RecordAnswerInput,
  AnswerWriteResult,
  ResolveEscalationInput,
  SelectDispositionInput,
  WriteOutboxPort,
} from "./write-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };

const iso = (d: Date | string): IsoInstant =>
  (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) as IsoInstant;

/** §8.3.3 — the command-payload digest the state-history row carries. The cleartext is never stored. */
const digestOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");

/**
 * The per-tenant DEK envelope (D14) the `caller_quote_cipher` / `transcript_cipher` columns ride.
 *
 * The default REFUSES to encrypt rather than storing plaintext in a column named `_cipher`. A column that
 * says "cipher" and holds cleartext is worse than an absent value: the §3.7 eraser's crypto-shred would
 * report the quote destroyed while the plaintext sat in a backup. `openTriageCall` therefore DROPS the
 * caller quote when no port is bound, and says so in the result rather than silently persisting it.
 */
export interface TriageCipherPort {
  encrypt(input: { readonly organizationId: string; readonly plaintext: string }): Promise<string>;
}

/** Deps the composition root binds. */
export interface M19WriteDeps {
  readonly outbox?: WriteOutboxPort;
  readonly alerts?: AlertPort;
  readonly now?: () => Date;
  readonly cipher?: TriageCipherPort;
  /**
   * D3 — are the `hybrid` / `centralized` deployment models enabled on this deployment? Defaults to
   * FALSE: Phase 1 ships them structurally complete and feature-flagged off, and a policy PATCH that
   * selects one is refused rather than accepted-and-ignored (decision: a tenant must never believe a
   * vendor is answering their nights when none is).
   */
  readonly vendorModelsEnabled?: boolean;
}

export function buildDrizzleM19WriteService(
  db: DbClient,
  readService: M19ReadService,
  deps: M19WriteDeps = {},
): M19WriteService {
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

  const outbox = deps.outbox ?? NOOP_OUTBOX;
  const alerts = deps.alerts;
  const now = deps.now ?? (() => new Date());
  const vendorModelsEnabled = deps.vendorModelsEnabled ?? false;

  const ctx = (actor: M19WriteActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  /** The runner's ONE child-row write (see effects-runner's header on why the runner owns it). */
  const stateHistory: StateHistoryPort = {
    async insert(tx, row) {
      await (tx as Tx).insert(HISTORY).values({
        organizationId: row.organizationId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        triageCallId: row.triageCallId,
        fromState: row.fromState as never,
        toState: row.toState as never,
        transitionedAt: row.transitionedAt,
        actorMembershipId: row.actorMembershipId,
        systemActor: row.systemActor,
        commandPayloadDigest: row.commandPayloadDigest,
      });
    },
  };

  /** Load a call row for a transition, or 404. */
  async function loadCall(tx: Tx, actor: M19WriteActor, triageCallId: string) {
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
    return row;
  }

  const callFactsOf = (row: {
    state: string;
    version: number;
    selectedProtocolId: string | null;
    linkedEncounterId: string | null;
    firstResponseAt: Date | null;
    documentedAt: Date | null;
    paperOriginFlag: boolean;
  }): TriageCallFacts => ({
    state: row.state as TriageCallFacts["state"],
    version: row.version,
    selectedProtocolId: row.selectedProtocolId,
    linkedEncounterId: row.linkedEncounterId,
    firstResponseAt: row.firstResponseAt === null ? null : iso(row.firstResponseAt),
    documentedAt: row.documentedAt === null ? null : iso(row.documentedAt),
    paperOriginFlag: row.paperOriginFlag,
  });

  /** The call's escalation rows as the §2.2.4 machine sees them. */
  async function loadEscalationFacts(
    tx: Tx,
    triageCallId: string,
  ): Promise<readonly TriageEscalationFacts[]> {
    const rows = await tx
      .select()
      .from(ESCALATION)
      .where(eq(ESCALATION.triageCallId, triageCallId))
      .orderBy(asc(ESCALATION.escalatedAt));
    return rows.map((r) => ({
      escalationId: r.id,
      tier: r.tier,
      triggerKind: r.triggerKind,
      escalatedAt: iso(r.escalatedAt),
      acknowledgedAt: r.acknowledgedAt === null ? null : iso(r.acknowledgedAt),
      resolvedAt: r.resolvedAt === null ? null : iso(r.resolvedAt),
      escalatedToMembershipId: r.escalatedToMembershipId,
      escalatedToExternalActorId: r.escalatedToExternalActorId,
    }));
  }

  /** The pinned protocol's questions + the call's answers, as the D5 engine sees them. */
  async function loadWalk(
    tx: Tx,
    triageCallId: string,
    protocolId: string,
  ): Promise<{
    questions: readonly TriageProtocolQuestionFacts[];
    answers: readonly TriageAnswerFacts[];
  }> {
    const questionRows = await tx
      .select()
      .from(QUESTION)
      .where(eq(QUESTION.triageProtocolId, protocolId))
      .orderBy(asc(QUESTION.questionOrder));
    const answerRows = await tx
      .select()
      .from(ANSWER)
      .where(eq(ANSWER.triageCallId, triageCallId))
      .orderBy(asc(ANSWER.answeredAt));
    return {
      questions: questionRows.map((q) => ({
        questionId: q.id,
        protocolId: q.triageProtocolId,
        questionOrder: q.questionOrder,
        prompt: q.prompt,
        answerType: q.answerType,
        answerEnumValues: (q.answerEnumValues as string[] | null) ?? null,
        required: q.required,
        isRedFlagQuestion: q.isRedFlagQuestion,
        redFlagMatch: q.redFlagMatch as TriageProtocolQuestionFacts["redFlagMatch"],
      })),
      answers: answerRows.map((a) => ({
        answerId: a.id,
        questionId: a.triageProtocolQuestionId,
        correctionOfAnswerId: a.correctionOfAnswerId,
        redFlagHit: a.redFlagHit,
      })),
    };
  }

  /**
   * §2.4 — write one `triage_escalation` row for a `create_escalation` effect.
   *
   * The recipient is resolved from the effect's tier through `tenant_oncall_policy.escalation_tiers`; when
   * the ladder names nobody for the tier the row is still written, to the CALLER'S OWN membership as the
   * tier-1 fallback. That is deliberate and it is the lesser evil: §3.3's recipient CHECK forbids a
   * recipient-less row, so the alternative to a fallback is refusing to record the escalation at all —
   * which on a red-flag answer would mean losing the answer AND the flag (D5's own fail direction).
   */
  async function insertEscalation(
    tx: Tx,
    actor: M19WriteActor,
    call: { id: string; organizationId: string; providerEntityId: string; locationId: string | null },
    effect: Extract<TriageSideEffect, { kind: "create_escalation" }>,
    recipient: { membershipId: string | null; externalActorId: string | null },
    triggerDetail: string | null,
  ): Promise<string> {
    const isExternal = effect.tier === "tier_5_external";
    const resolved = isExternal
      ? { membershipId: null, externalActorId: recipient.externalActorId }
      : {
          membershipId: recipient.membershipId ?? actor.membershipId,
          externalActorId: null,
        };
    assertRecipientCoherent({
      tier: effect.tier,
      escalatedToMembershipId: resolved.membershipId,
      escalatedToExternalActorId: resolved.externalActorId,
    });
    const [row] = await tx
      .insert(ESCALATION)
      .values({
        organizationId: call.organizationId,
        providerEntityId: call.providerEntityId,
        locationId: call.locationId,
        triageCallId: call.id,
        tier: effect.tier,
        triggerKind: effect.triggerKind,
        triggerDetail,
        escalatedToMembershipId: resolved.membershipId,
        escalatedToExternalActorId: resolved.externalActorId,
        escalatedAt: now(),
      })
      .returning({ id: ESCALATION.id });
    return (row as { id: string }).id;
  }

  /** Apply the accumulated patch + bump `version` under the §2.5 guard. */
  async function applyCallPatch(
    tx: Tx,
    callId: string,
    currentVersion: number,
    patch: EffectPatch,
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const nextVersion = currentVersion + 1;
    const updated = await tx
      .update(CALL)
      .set({
        ...(patch.firstResponseAt ? { firstResponseAt: patch.firstResponseAt } : {}),
        ...(patch.documentedAt ? { documentedAt: patch.documentedAt } : {}),
        ...(patch.closedAt ? { closedAt: patch.closedAt } : {}),
        ...(patch.selectedProtocolId ? { selectedProtocolId: patch.selectedProtocolId } : {}),
        ...(patch.selectedProtocolVersion
          ? { selectedProtocolVersion: patch.selectedProtocolVersion }
          : {}),
        ...(patch.disposition ? { disposition: patch.disposition as never } : {}),
        ...(patch.dispositionData !== undefined ? { dispositionData: patch.dispositionData } : {}),
        ...extra,
        version: nextVersion,
        updatedAt: now(),
      })
      .where(and(eq(CALL.id, callId), eq(CALL.version, currentVersion)))
      .returning({ version: CALL.version });
    require_(
      updated.length === 1,
      "STALE_VERSION",
      "the call has moved on since you read it; re-read and retry (§2.5)",
    );
    return nextVersion;
  }

  /** The §4.10 payload base every call-scoped event carries. */
  const callEventBase = (call: {
    organizationId: string;
    providerEntityId: string;
    id: string;
  }) => ({
    orgId: call.organizationId,
    providerEntityId: call.providerEntityId,
    triageCallId: call.id,
    occurredAt: iso(now()),
  });

  /** Re-read the aggregate through the READ service so every mutation answers the SAME projection the
   *  detail route serves — one DTO, one disclosure gate, no drift (the M16-T06 posture). */
  const reread = (actor: M19WriteActor, triageCallId: string) =>
    readService.getTriageCall(actor, triageCallId);

  return {
    // ── §4.1 row 1 — open a call ──────────────────────────────────────────────────────────────────────
    async openTriageCall(actor, input): Promise<OpenTriageCallResult> {
      const at = now();
      const cipherPort = deps.cipher;
      // Encrypt BEFORE the transaction: an external KMS round-trip inside our own tx holds a pooled
      // connection open for the latency of a network call (the M21-T05 finding, same shape).
      const callerQuoteCipher =
        input.callerQuote !== undefined && cipherPort !== undefined
          ? await cipherPort.encrypt({
              organizationId: actor.organizationId,
              plaintext: input.callerQuote,
            })
          : null;

      const created = await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          // Decision 4 — the server resolves the covering shift.
          const shifts = await inner
            .select()
            .from(SHIFT)
            .where(
              and(
                eq(SHIFT.organizationId, actor.organizationId),
                eq(SHIFT.providerEntityId, input.providerEntityId),
                or(eq(SHIFT.status, "active"), eq(SHIFT.status, "scheduled")),
              ),
            )
            .orderBy(asc(SHIFT.shiftStartsAt));
          const covering = shifts
            .filter((s) =>
              shiftCoversInstant(
                {
                  status: s.status,
                  shiftStartsAt: iso(s.shiftStartsAt),
                  shiftEndsAt: iso(s.shiftEndsAt),
                  discipline: s.discipline,
                  version: s.version,
                  primaryOnCallMembershipId: s.primaryOnCallMembershipId,
                  externalActorId: s.externalActorId,
                  openedAt: s.openedAt === null ? null : iso(s.openedAt),
                  closedAt: s.closedAt === null ? null : iso(s.closedAt),
                },
                iso(at),
              ),
            )
            .sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));
          const shift = covering[0];
          require_(
            shift !== undefined,
            "TRIGGER_NO_COVERING_SHIFT",
            `no on-call shift covers ${iso(at)} for provider entity ${input.providerEntityId}; the §4.8 watchdog reports this as a coverage gap`,
          );

          const [row] = await inner
            .insert(CALL)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: input.providerEntityId,
              onCallShiftId: shift.id,
              patientId: input.patientId ?? null,
              admissionId: input.admissionId ?? null,
              callerCaregiverId: input.callerCaregiverId ?? null,
              callerKind: input.callerKind,
              callerDisplayName: input.callerDisplayName ?? null,
              callerPhoneE164: input.callerPhoneE164 ?? null,
              callerRelationshipLabel: input.callerRelationshipLabel ?? null,
              inboundChannel: input.inboundChannel,
              source: "manual",
              chiefComplaintText: input.chiefComplaintText ?? null,
              chiefComplaintSnomed: input.chiefComplaintSnomed ?? null,
              callerQuoteCipher,
              openedAt: at,
            })
            .returning();
          const call = row as typeof CALL.$inferSelect;

          const effects = openCallEffects({ machineOpened: false, at: iso(at) });
          const patch = await runEffects(inner, effects, {
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            at,
            actorMembershipId: actor.membershipId,
            commandPayloadDigest: digestOf({ ...input, callerQuote: undefined }),
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "triage_call",
            aggregateId: call.id,
            payloads: {
              "m19.triage_call.opened": {
                ...callEventBase(call),
                onCallShiftId: call.onCallShiftId,
                source: call.source,
                patientId: call.patientId,
                paperOrigin: false,
                originalOpenedAt: null,
              },
            },
            alertPayloads: {
              "m19.triage.case_opened": buildCaseOpenedAlert({
                orgId: actor.organizationId,
                providerEntityId: call.providerEntityId,
                triageCallId: call.id,
                source: call.source,
                openedAt: iso(at),
              }) as unknown as Record<string, unknown>,
            },
          });
          const version = await applyCallPatch(inner, call.id, call.version, patch);
          return { call, version };
        }),
      );

      // Decisions 2 + 3 — the ADVISORIES, read after the row exists and gated by the tenant's own flags.
      const advisories = await readAdvisories(actor, created.call, input.chiefComplaintText ?? null);
      if (advisories.suggestedProtocolId !== null || advisories.hospitalizationRiskBand !== null) {
        await withOrgContext(db, ctx(actor), async (tx) => {
          await tx
            .update(CALL)
            .set({
              ...(advisories.suggestedProtocolId
                ? {
                    suggestedProtocolId: advisories.suggestedProtocolId,
                    suggestedProtocolConfidence: advisories.confidence as never,
                  }
                : {}),
              ...(advisories.hospitalizationRiskBand
                ? { hospitalizationRiskBand: advisories.hospitalizationRiskBand as never }
                : {}),
            })
            .where(eq(CALL.id, created.call.id));
        });
      }

      return {
        triageCallId: created.call.id,
        state: "open",
        onCallShiftId: created.call.onCallShiftId,
        version: created.version,
        suggestedProtocolId: advisories.suggestedProtocolId,
        suggestedProtocolConfidence: advisories.confidence,
        hospitalizationRiskBand: advisories.hospitalizationRiskBand,
        aiBlockDisabled: advisories.aiBlockDisabled,
      };
    },

    // ── §4.1 row 4 — identify the caller's patient ────────────────────────────────────────────────────
    async identifyPatient(actor, triageCallId, input: IdentifyPatientInput) {
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const call = await loadCall(inner, actor, triageCallId);
          if (input.expectedVersion !== undefined) {
            assertVersion(call.version, input.expectedVersion);
          }
          await applyCallPatch(
            inner,
            call.id,
            call.version,
            {},
            {
              patientId: input.patientId,
              admissionId: input.admissionId,
              locationId: input.locationId ?? call.locationId,
              callerCaregiverId: input.callerCaregiverId ?? call.callerCaregiverId,
            },
          );
        }),
      );
      return reread(actor, triageCallId);
    },

    // ── §4.1 row 5 — apply a protocol (D4 + D12) ──────────────────────────────────────────────────────
    async applyProtocol(actor, triageCallId, input: ApplyProtocolInput) {
      const discipline = disciplineOf(actor); // decision 6
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const call = await loadCall(inner, actor, triageCallId);
          if (input.expectedVersion !== undefined) {
            assertVersion(call.version, input.expectedVersion);
          }
          require_(
            call.selectedProtocolId === null,
            "PROTOCOL_ALREADY_APPLIED",
            "this call already has a pinned protocol; a change would re-key the answers already recorded (D4)",
          );

          const [protocolRow] = await inner
            .select()
            .from(PROTOCOL)
            .where(eq(PROTOCOL.id, input.triageProtocolId))
            .limit(1);
          require_(
            protocolRow !== undefined,
            "PROTOCOL_NOT_AVAILABLE",
            `protocol ${input.triageProtocolId} is not in this organization's catalog`,
          );
          const protocol: TriageProtocolFacts = {
            protocolId: protocolRow.id,
            key: protocolRow.key,
            chiefComplaintLabel: protocolRow.chiefComplaintLabel,
            organizationId: protocolRow.organizationId,
            isSystemLocked: protocolRow.isSystemLocked,
            disciplineRequired: protocolRow.disciplineRequired as TriageProtocolFacts["disciplineRequired"],
            requiresMandatoryEscalation: protocolRow.requiresMandatoryEscalation,
            mandatoryEscalationTier: protocolRow.mandatoryEscalationTier,
            version: protocolRow.version,
            effectiveFrom: iso(protocolRow.effectiveFrom),
            effectiveTo: protocolRow.effectiveTo === null ? null : iso(protocolRow.effectiveTo),
          };

          const { decision, effects } = applyProtocolDecision({
            orgId: actor.organizationId,
            protocol,
            actorDiscipline: discipline,
            at,
            suggestedProtocolId: call.suggestedProtocolId,
          });

          // D12 / §8.6 — an override of an AT-OR-ABOVE-floor suggestion needs a reason. The confidence
          // BAND is what the column holds; `high` is the band the 0.75 floor lands in, so the comparison
          // is made against the band rather than the score M32 sent (which §3.3 has no column for).
          if (decision.aiAccepted === false && call.suggestedProtocolConfidence === "high") {
            require_(
              (input.aiOverrideReason ?? "").trim().length >= M19_AI_OVERRIDE_REASON_MIN_CHARS,
              "AI_OVERRIDE_REASON_REQUIRED",
              `overriding a suggestion at or above the ${M19_AI_CONFIDENCE_FLOOR} governance floor requires a reason of at least ${M19_AI_OVERRIDE_REASON_MIN_CHARS} characters (D12)`,
            );
          }

          const mandatoryEffect = effects.find(
            (e): e is Extract<TriageSideEffect, { kind: "create_escalation" }> =>
              e.kind === "create_escalation",
          );
          let escalationId: string | null = null;
          if (mandatoryEffect) {
            escalationId = await insertEscalation(
              inner,
              actor,
              call,
              mandatoryEffect,
              { membershipId: null, externalActorId: null },
              `mandatory escalation for protocol '${protocol.key}'`,
            );
          }

          const patch = await runEffects(inner, effects, {
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            at,
            actorMembershipId: actor.membershipId,
            commandPayloadDigest: digestOf(input),
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "triage_call",
            aggregateId: call.id,
            payloads: {
              "m19.triage_call.protocol_applied": {
                ...callEventBase(call),
                triageProtocolId: protocol.protocolId,
                protocolVersion: decision.pinnedVersion,
                mandatoryEscalation: decision.mandatoryTier,
              },
              ...(escalationId !== null && mandatoryEffect
                ? {
                    "m19.triage_call.escalation_recorded": {
                      ...callEventBase(call),
                      escalationId,
                      tier: mandatoryEffect.tier,
                      triggerKind: mandatoryEffect.triggerKind,
                    },
                  }
                : {}),
            },
            alertPayloads:
              escalationId !== null && decision.mandatoryTier !== null
                ? {
                    "m19.triage.mandatory_escalation_triggered": buildMandatoryEscalationAlert({
                      orgId: actor.organizationId,
                      providerEntityId: call.providerEntityId,
                      triageCallId: call.id,
                      escalationId,
                      tier: decision.mandatoryTier,
                      protocolLabel: protocol.chiefComplaintLabel,
                    }) as unknown as Record<string, unknown>,
                  }
                : {},
          });

          await applyCallPatch(inner, call.id, call.version, patch, {
            state: "protocol_in_progress",
            // D12's governance record. `ai_accepted` has no column of its own (§3.3); the fact rides the
            // state-history digest and the M4 audit row, which is where §8.7.2 puts the AI-governance
            // entry. The SUGGESTION itself is already on the row.
          });
        }),
      );
      return reread(actor, triageCallId);
    },

    // ── §4.1 rows 6-7 — the answer ledger (D5 / §2.2.3) ───────────────────────────────────────────────
    async recordAnswer(actor, triageCallId, input) {
      return writeAnswer(actor, triageCallId, input, null);
    },

    async correctAnswer(actor, triageCallId, answerId, input: CorrectAnswerInput) {
      return writeAnswer(actor, triageCallId, input, answerId);
    },

    // ── §4.1 row 8 — complete the protocol ────────────────────────────────────────────────────────────
    async completeProtocol(actor, triageCallId, input) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const call = await loadCall(inner, actor, triageCallId);
          if (input.expectedVersion !== undefined) {
            assertVersion(call.version, input.expectedVersion);
          }
          require_(
            call.selectedProtocolId !== null,
            "PROTOCOL_NOT_AVAILABLE",
            "no protocol is pinned on this call yet",
          );
          const walk = await loadWalk(inner, call.id, call.selectedProtocolId);
          const escalations = await loadEscalationFacts(inner, call.id);
          const transition = completeProtocolDecision({
            call: callFactsOf(call),
            questions: walk.questions,
            answers: walk.answers,
            escalations,
          });
          const patch = await runEffects(inner, transition.effects, {
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            at,
            actorMembershipId: actor.membershipId,
            commandPayloadDigest: digestOf(input),
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "triage_call",
            aggregateId: call.id,
            payloads: {},
          });
          await applyCallPatch(inner, call.id, call.version, patch, { state: transition.to });
        }),
      );
      return reread(actor, triageCallId);
    },

    // ── §4.1 rows 9-10 — the callback park + resume ───────────────────────────────────────────────────
    async markAwaitingCallback(actor, triageCallId, input: AwaitingCallbackInput) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const call = await loadCall(inner, actor, triageCallId);
          if (input.expectedVersion !== undefined) {
            assertVersion(call.version, input.expectedVersion);
          }
          const transition = markAwaitingCallback({
            call: callFactsOf(call),
            reason: input.reason,
          });
          const patch = await runEffects(inner, transition.effects, {
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            at,
            actorMembershipId: actor.membershipId,
            commandPayloadDigest: digestOf(input),
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "triage_call",
            aggregateId: call.id,
            payloads: {},
            // The `callback_sla_breached` alert is DECLARED by the transition but is the §4.8 detector's
            // to SEND: the timer starts here and the breach happens later. No payload ⇒ the runner skips
            // it, which is exactly the "an alert is advisory, an event is a contract" rule.
            alertPayloads: {},
          });
          await applyCallPatch(inner, call.id, call.version, patch, { state: transition.to });
        }),
      );
      return reread(actor, triageCallId);
    },

    async resumeAfterCallback(actor, triageCallId, input) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const call = await loadCall(inner, actor, triageCallId);
          if (input.expectedVersion !== undefined) {
            assertVersion(call.version, input.expectedVersion);
          }
          const transition = resumeAfterCallback(callFactsOf(call));
          const patch = await runEffects(inner, transition.effects, {
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            at,
            actorMembershipId: actor.membershipId,
            commandPayloadDigest: digestOf(input),
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "triage_call",
            aggregateId: call.id,
            payloads: {},
          });
          await applyCallPatch(inner, call.id, call.version, patch, { state: transition.to });
        }),
      );
      return reread(actor, triageCallId);
    },

    // ── §4.1 row 11 — the disposition (D6 / D8) ───────────────────────────────────────────────────────
    async selectDisposition(actor, triageCallId, input: SelectDispositionInput) {
      const discipline = disciplineOf(actor); // decision 6
      const at = now();
      const data = input.dispositionData as TriageDispositionData;

      const committed = await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const call = await loadCall(inner, actor, triageCallId);
          if (input.expectedVersion !== undefined) {
            assertVersion(call.version, input.expectedVersion);
          }
          const escalations = await loadEscalationFacts(inner, call.id);

          // §2.2.1 — the SAME payload reaches `documented_pending_encounter` from two states, by two
          // commands. Picking by the call's current state (rather than exposing two routes) is what makes
          // §7.2's worked sequence — MD acknowledges, THEN the RN dispositions with their guidance — one
          // action for the clinician instead of two they must choose between at 2 a.m.
          const transition =
            call.state === "escalated_unresolved"
              ? resolveEscalationAndDisposition({
                  call: callFactsOf(call),
                  escalations,
                  actorDiscipline: discipline,
                  disposition: data.disposition,
                  data,
                })
              : selectDispositionDecision({
                  call: callFactsOf(call),
                  escalations,
                  actorDiscipline: discipline,
                  disposition: data.disposition,
                  data,
                  at: iso(at),
                });

          const patch = await runEffects(inner, transition.effects, {
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            at,
            actorMembershipId: actor.membershipId,
            commandPayloadDigest: digestOf(input),
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "triage_call",
            aggregateId: call.id,
            payloads: dispositionPayloads(call, data, iso(at)),
          });
          await applyCallPatch(inner, call.id, call.version, patch, { state: transition.to });
          return call;
        }),
      );

      // Decision 1 — the M8 seam call runs AFTER the commit. A deferral is §2.7 class D-B, not an error.
      await linkTriageEncounter({
        call: {
          triageCallId: committed.id,
          organizationId: committed.organizationId,
          patientId: committed.patientId,
          admissionId: committed.admissionId,
          linkedEncounterId: committed.linkedEncounterId,
          openedAt: iso(committed.openedAt),
        },
        actorDiscipline: discipline,
        authorMembershipId: actor.membershipId,
        port: encounterLinkPort(db, actor),
      }).catch(() => undefined);

      return reread(actor, triageCallId);
    },

    // ── §4.1 row 12 — document (the explicit M8 invocation) ───────────────────────────────────────────
    async documentCall(actor, triageCallId, _input: DocumentCallInput) {
      const discipline = disciplineOf(actor);
      const call = await withOrgContext(db, ctx(actor), async (tx) =>
        loadCall(tx as Tx, actor, triageCallId),
      );
      const outcome = await linkTriageEncounter({
        call: {
          triageCallId: call.id,
          organizationId: call.organizationId,
          patientId: call.patientId,
          admissionId: call.admissionId,
          linkedEncounterId: call.linkedEncounterId,
          openedAt: iso(call.openedAt),
        },
        actorDiscipline: discipline,
        authorMembershipId: actor.membershipId,
        port: encounterLinkPort(db, actor),
      });
      // §2.7 class D-B — a deferral is REPORTED through the re-read (the call stays in
      // `documented_pending_encounter` with no link) rather than thrown: the clinician is not blocked and
      // the §4.8 `encounter-creator.consumer` retries. `markDocumented` is the M8 consumer's transition,
      // never this route's — the call reaches `documented` when the encounter is SIGNED (D8).
      void outcome;
      return reread(actor, triageCallId);
    },

    // ── §4.1 row 13 — abandon ─────────────────────────────────────────────────────────────────────────
    async abandonCall(actor, triageCallId, input: AbandonCallInput) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const call = await loadCall(inner, actor, triageCallId);
          if (input.expectedVersion !== undefined) {
            assertVersion(call.version, input.expectedVersion);
          }
          const escalations = await loadEscalationFacts(inner, call.id);
          const transition = markAbandoned({
            call: callFactsOf(call),
            escalations,
            reason: input.reason,
            callbackAttempts: input.callbackAttempts,
            at: iso(at),
          });
          const patch = await runEffects(inner, transition.effects, {
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            at,
            actorMembershipId: actor.membershipId,
            commandPayloadDigest: digestOf(input),
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "triage_call",
            aggregateId: call.id,
            payloads: {
              "m19.triage_call.closed": { ...callEventBase(call), finalDisposition: "abandoned" },
            },
          });
          await applyCallPatch(inner, call.id, call.version, patch, { state: transition.to });
        }),
      );
      return reread(actor, triageCallId);
    },

    // ── §4.1 rows 15, 17-18 — escalations ─────────────────────────────────────────────────────────────
    async escalate(actor, triageCallId, input: EscalateInput) {
      const at = now();
      const escalationId = await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const call = await loadCall(inner, actor, triageCallId);
          if (input.expectedVersion !== undefined) {
            assertVersion(call.version, input.expectedVersion);
          }
          const id = await insertEscalation(
            inner,
            actor,
            call,
            {
              kind: "create_escalation",
              tier: input.tier,
              triggerKind: "manual",
              mandatory: false,
              notifyTiers: mandatoryEscalationNotifyTiers(input.tier),
            },
            {
              membershipId: input.escalatedToMembershipId ?? null,
              externalActorId: input.escalatedToExternalActorId ?? null,
            },
            input.reason,
          );

          const effects: TriageSideEffect[] = [
            { kind: "audit" },
            { kind: "outbox", event: "m19.triage_call.escalation_recorded" },
          ];
          // §2.2.1 — the HAND-OFF form also moves the call. Without it the escalation is a rung recorded
          // on a call that keeps running, which is §7.5's vendor-escalates-to-agency shape.
          const handOff = input.handOffCall === true;
          if (handOff) {
            effects.push(
              { kind: "state_history", from: call.state as never, to: "escalated_unresolved", systemActor: false },
              {
                kind: "set_disposition",
                disposition: "escalated_unresolved",
                data: { disposition: "escalated_unresolved", escalationId: id, tier: input.tier },
              },
              { kind: "outbox", event: "m19.triage_call.disposition_selected" },
            );
          }

          const patch = await runEffects(inner, effects, {
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            at,
            actorMembershipId: actor.membershipId,
            commandPayloadDigest: digestOf(input),
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "triage_call",
            aggregateId: call.id,
            payloads: {
              "m19.triage_call.escalation_recorded": {
                ...callEventBase(call),
                escalationId: id,
                tier: input.tier,
                triggerKind: "manual",
              },
              ...(handOff
                ? {
                    "m19.triage_call.disposition_selected": {
                      ...callEventBase(call),
                      disposition: "escalated_unresolved",
                      dispositionData: {
                        disposition: "escalated_unresolved",
                        escalationId: id,
                        tier: input.tier,
                      },
                    },
                  }
                : {}),
            },
          });
          await applyCallPatch(
            inner,
            call.id,
            call.version,
            patch,
            handOff ? { state: "escalated_unresolved" } : {},
          );
          return id;
        }),
      );
      return findEscalation(actor, escalationId);
    },

    async acknowledgeEscalation(actor, escalationId, input) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const { row, facts } = await loadEscalation(inner, actor, escalationId);
          if (input.expectedVersion !== undefined) {
            assertVersion(row.version, input.expectedVersion);
          }
          const transition = acknowledgeEscalation({
            escalation: facts,
            by: actor.membershipId,
            at: iso(at),
          });
          void transition;
          const updated = await inner
            .update(ESCALATION)
            .set({ acknowledgedAt: at, version: row.version + 1, updatedAt: at })
            .where(and(eq(ESCALATION.id, escalationId), eq(ESCALATION.version, row.version)))
            .returning({ id: ESCALATION.id });
          require_(
            updated.length === 1,
            "STALE_VERSION",
            "the escalation has moved on since you read it (§2.5)",
          );
        }),
      );
      return findEscalation(actor, escalationId);
    },

    async resolveEscalation(actor, escalationId, input: ResolveEscalationInput) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const { row, facts } = await loadEscalation(inner, actor, escalationId);
          if (input.expectedVersion !== undefined) {
            assertVersion(row.version, input.expectedVersion);
          }
          resolveEscalationDecision({
            escalation: facts,
            resolution: input.resolution,
            by: actor.membershipId,
            at: iso(at),
          });
          const updated = await inner
            .update(ESCALATION)
            .set({
              resolvedAt: at,
              resolution: input.resolution,
              resolvedByMembershipId: actor.membershipId,
              version: row.version + 1,
              updatedAt: at,
            })
            .where(and(eq(ESCALATION.id, escalationId), eq(ESCALATION.version, row.version)))
            .returning({ id: ESCALATION.id });
          require_(
            updated.length === 1,
            "STALE_VERSION",
            "the escalation has moved on since you read it (§2.5)",
          );
        }),
      );
      return findEscalation(actor, escalationId);
    },

    // ── §4.1 rows 20-23 — shifts ──────────────────────────────────────────────────────────────────────
    async createShift(actor, input: CreateShiftInput): Promise<OnCallShiftView> {
      const at = now();
      const shiftId = await withOrgContext(db, ctx(actor), async (tx) => {
        // D7 — the policy row must EXIST before a shift can be created for the PE, because
        // `policy_snapshot` is NOT NULL and the snapshot is pinned at activation. A shift created against
        // no policy could never open.
        const [policy] = await tx
          .select()
          .from(POLICY)
          .where(
            and(
              eq(POLICY.organizationId, actor.organizationId),
              eq(POLICY.providerEntityId, input.providerEntityId),
            ),
          )
          .limit(1);
        require_(
          policy !== undefined,
          "SHIFT_POLICY_SNAPSHOT_REQUIRED",
          `provider entity ${input.providerEntityId} has no on-call policy; a shift created against none could never open (D7)`,
        );
        const [row] = await tx
          .insert(SHIFT)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            shiftStartsAt: new Date(input.shiftStartsAt),
            shiftEndsAt: new Date(input.shiftEndsAt),
            discipline: input.discipline,
            primaryOnCallMembershipId: input.primaryOnCallMembershipId ?? null,
            backupMembershipId: input.backupMembershipId ?? null,
            externalActorId: input.externalActorId ?? null,
            externalActorLabel: input.externalActorLabel ?? null,
            // Pinned again at activation (D7); seeded here so the NOT NULL holds for a `scheduled` row.
            policySnapshot: policy,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: SHIFT.id });
        return (row as { id: string }).id;
      });
      return findShift(actor, shiftId);
    },

    async cancelShift(actor, shiftId, input: CancelShiftInput): Promise<OnCallShiftView> {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const { row, facts } = await loadShift(inner, actor, shiftId);
          if (input.expectedVersion !== undefined) {
            assertVersion(row.version, input.expectedVersion);
          }
          const transition = cancelShiftDecision({ shift: facts, reason: input.reason });
          const updated = await inner
            .update(SHIFT)
            .set({
              status: transition.to,
              cancellationReason: input.reason,
              version: row.version + 1,
              updatedAt: at,
            })
            .where(and(eq(SHIFT.id, shiftId), eq(SHIFT.version, row.version)))
            .returning({ id: SHIFT.id });
          require_(updated.length === 1, "SHIFT_STALE_VERSION", "the shift has moved on (§2.5)");
        }),
      );
      return findShift(actor, shiftId);
    },

    async openShift(actor, shiftId, input): Promise<OnCallShiftView> {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const { row, facts } = await loadShift(inner, actor, shiftId);
          if (input.expectedVersion !== undefined) {
            assertVersion(row.version, input.expectedVersion);
          }
          const [policy] = await inner
            .select()
            .from(POLICY)
            .where(
              and(
                eq(POLICY.organizationId, actor.organizationId),
                eq(POLICY.providerEntityId, row.providerEntityId),
              ),
            )
            .limit(1);
          require_(
            policy !== undefined,
            "SHIFT_POLICY_SNAPSHOT_REQUIRED",
            "no tenant on-call policy to pin; a shift that opens without one can never prove which ladder was live (D7)",
          );
          const transition = activateShift({ shift: facts, policySnapshot: policy, at: iso(at) });
          const updated = await inner
            .update(SHIFT)
            .set({
              status: transition.to,
              openedAt: at,
              policySnapshot: policy,
              version: row.version + 1,
              updatedAt: at,
            })
            .where(and(eq(SHIFT.id, shiftId), eq(SHIFT.version, row.version)))
            .returning({ id: SHIFT.id });
          require_(updated.length === 1, "SHIFT_STALE_VERSION", "the shift has moved on (§2.5)");
          await outbox.publish(inner, {
            eventName: "m19.oncall_shift.activated",
            payload: {
              orgId: actor.organizationId,
              providerEntityId: row.providerEntityId,
              occurredAt: iso(at),
              shiftId: row.id,
              discipline: row.discipline,
              membershipId: row.primaryOnCallMembershipId,
              externalActorId: row.externalActorId,
              openedAt: iso(at),
            },
            organizationId: actor.organizationId,
            aggregateKind: "on_call_shift",
            aggregateId: row.id,
          });
        }),
      );
      return findShift(actor, shiftId);
    },

    async closeShift(actor, shiftId, input): Promise<OnCallShiftView> {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const { row, facts } = await loadShift(inner, actor, shiftId);
          if (input.expectedVersion !== undefined) {
            assertVersion(row.version, input.expectedVersion);
          }
          const transition = completeShift({ shift: facts, at: iso(at) });
          const updated = await inner
            .update(SHIFT)
            .set({
              status: transition.to,
              closedAt: at,
              version: row.version + 1,
              updatedAt: at,
            })
            .where(and(eq(SHIFT.id, shiftId), eq(SHIFT.version, row.version)))
            .returning({ id: SHIFT.id });
          require_(updated.length === 1, "SHIFT_STALE_VERSION", "the shift has moved on (§2.5)");
          await outbox.publish(inner, {
            eventName: "m19.oncall_shift.completed",
            payload: {
              orgId: actor.organizationId,
              providerEntityId: row.providerEntityId,
              occurredAt: iso(at),
              shiftId: row.id,
            },
            organizationId: actor.organizationId,
            aggregateKind: "on_call_shift",
            aggregateId: row.id,
          });
        }),
      );
      return findShift(actor, shiftId);
    },

    // ── §4.1 row 26 — the tenant policy PATCH ─────────────────────────────────────────────────────────
    async patchPolicy(actor, input: PatchPolicyInput): Promise<OncallPolicyView> {
      const at = now();
      // D3 — refuse rather than accept-and-ignore (see `M19WriteDeps.vendorModelsEnabled`).
      if (input.model !== undefined && input.model !== "direct") {
        require_(
          vendorModelsEnabled,
          "ONCALL_MODEL_NOT_ENABLED",
          `the '${input.model}' deployment model is not enabled on this deployment (D3: Phase 1 ships direct only)`,
        );
      }
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const [row] = await inner
            .select()
            .from(POLICY)
            .where(
              and(
                eq(POLICY.organizationId, actor.organizationId),
                eq(POLICY.providerEntityId, input.providerEntityId),
              ),
            )
            .limit(1);
          require_(
            row !== undefined,
            "ONCALL_POLICY_NOT_FOUND",
            `this organization has no on-call policy for provider entity ${input.providerEntityId}`,
          );
          if (input.expectedVersion !== undefined) {
            assertVersion(row.version, input.expectedVersion);
          }
          const updated = await inner
            .update(POLICY)
            .set({
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.escalationTiers !== undefined
                ? { escalationTiers: input.escalationTiers }
                : {}),
              ...(input.callbackSlaPerSeverity !== undefined
                ? { callbackSlaPerSeverity: input.callbackSlaPerSeverity }
                : {}),
              ...(input.stateOverrides !== undefined
                ? { stateOverrides: input.stateOverrides }
                : {}),
              ...(input.externalTriageVendorId !== undefined
                ? { externalTriageVendorId: input.externalTriageVendorId }
                : {}),
              ...(input.emergencyContactE164 !== undefined
                ? { emergencyContactE164: input.emergencyContactE164 }
                : {}),
              ...(input.aiProtocolSuggestionEnabled !== undefined
                ? { aiProtocolSuggestionEnabled: input.aiProtocolSuggestionEnabled }
                : {}),
              ...(input.aiHospitalizationRiskEnabled !== undefined
                ? { aiHospitalizationRiskEnabled: input.aiHospitalizationRiskEnabled }
                : {}),
              version: row.version + 1,
              updatedAt: at,
            })
            .where(and(eq(POLICY.id, row.id), eq(POLICY.version, row.version)))
            .returning({ id: POLICY.id });
          require_(
            updated.length === 1,
            "STALE_VERSION",
            "the policy has moved on since you read it (§2.5)",
          );
        }),
      );
      return readService.getPolicy(actor, input.providerEntityId);
    },

    // ── §4.1 rows 29-32 — the protocol catalog (tenant rows only; decision 5) ─────────────────────────
    async createProtocol(actor, input: CreateProtocolInput): Promise<TriageProtocolView> {
      const at = now();
      const protocolId = await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const [row] = await inner
            .insert(PROTOCOL)
            .values({
              // Decision 5's other half — a tenant row ALWAYS carries the org and NEVER the lock flag.
              // §3.3's CHECK pair makes a locked row org-less, so writing `is_system_locked: true` here
              // would fail the constraint; writing the org explicitly is what makes the refusal
              // structural rather than reliant on a default.
              organizationId: actor.organizationId,
              isSystemLocked: false,
              key: input.key,
              chiefComplaintLabel: input.chiefComplaintLabel,
              snomedCode: input.snomedCode,
              disciplineRequired: input.disciplineRequired,
              requiresMandatoryEscalation: input.requiresMandatoryEscalation ?? false,
              mandatoryEscalationTier: (input.mandatoryEscalationTier ??
                null) as TriageEscalationTier | null,
              version: input.version ?? "1.0",
              effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : at,
              effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
              sortOrder: input.sortOrder ?? 100,
              createdAt: at,
              updatedAt: at,
            })
            .returning({ id: PROTOCOL.id });
          const id = (row as { id: string }).id;
          for (const q of input.questions ?? []) {
            await insertQuestion(inner, actor, id, q, at);
          }
          return id;
        }),
      );
      return readService.getProtocol(actor, protocolId);
    },

    async patchProtocol(actor, protocolId, input: PatchProtocolInput): Promise<TriageProtocolView> {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const row = await loadTenantProtocol(inner, actor, protocolId);
          await inner
            .update(PROTOCOL)
            .set({
              ...(input.chiefComplaintLabel !== undefined
                ? { chiefComplaintLabel: input.chiefComplaintLabel }
                : {}),
              ...(input.snomedCode !== undefined ? { snomedCode: input.snomedCode } : {}),
              ...(input.disciplineRequired !== undefined
                ? { disciplineRequired: input.disciplineRequired }
                : {}),
              ...(input.requiresMandatoryEscalation !== undefined
                ? { requiresMandatoryEscalation: input.requiresMandatoryEscalation }
                : {}),
              ...(input.mandatoryEscalationTier !== undefined
                ? { mandatoryEscalationTier: input.mandatoryEscalationTier }
                : {}),
              ...(input.version !== undefined ? { version: input.version } : {}),
              ...(input.effectiveTo !== undefined
                ? { effectiveTo: input.effectiveTo === null ? null : new Date(input.effectiveTo) }
                : {}),
              ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
              updatedAt: at,
            })
            .where(eq(PROTOCOL.id, row.id));
        }),
      );
      return readService.getProtocol(actor, protocolId);
    },

    /**
     * §4.1 row 31 — add a question. §4.1's Notes say "additive only on platform protocols", and that is
     * NOT implemented as an exception: the platform-floor rows are org-less and migration 0108's INSERT
     * policy makes a tenant physically unable to write a child row against them. Attempting it here would
     * therefore fail at the database with a policy violation rather than a message the DON can act on, so
     * the refusal is raised at this layer with the protocol named.
     */
    async addProtocolQuestion(
      actor,
      protocolId,
      input: ProtocolQuestionInput,
    ): Promise<TriageProtocolView> {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const row = await loadTenantProtocol(inner, actor, protocolId);
          await insertQuestion(inner, actor, row.id, input, at);
        }),
      );
      return readService.getProtocol(actor, protocolId);
    },

    async patchProtocolQuestion(
      actor,
      questionId,
      input: Partial<ProtocolQuestionInput>,
    ): Promise<TriageProtocolView> {
      const at = now();
      const protocolId = await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const [row] = await inner
            .select()
            .from(QUESTION)
            .where(eq(QUESTION.id, questionId))
            .limit(1);
          require_(
            row !== undefined,
            "PROTOCOL_NOT_FOUND",
            `no triage protocol question ${questionId} is in this organization's catalog`,
          );
          require_(
            !row.isSystemLocked && row.organizationId === actor.organizationId,
            "PROTOCOL_SYSTEM_LOCKED",
            `question ${questionId} belongs to a platform-floor protocol; a tenant may raise the escalation floor with its own protocol but may not edit the floor (§8.3.2)`,
          );
          await inner
            .update(QUESTION)
            .set({
              ...(input.questionOrder !== undefined ? { questionOrder: input.questionOrder } : {}),
              ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
              ...(input.answerType !== undefined ? { answerType: input.answerType } : {}),
              ...(input.answerEnumValues !== undefined
                ? { answerEnumValues: input.answerEnumValues }
                : {}),
              ...(input.required !== undefined ? { required: input.required } : {}),
              ...(input.isRedFlagQuestion !== undefined
                ? { isRedFlagQuestion: input.isRedFlagQuestion }
                : {}),
              ...(input.redFlagMatch !== undefined ? { redFlagMatch: input.redFlagMatch } : {}),
              updatedAt: at,
            })
            .where(eq(QUESTION.id, questionId));
          return row.triageProtocolId;
        }),
      );
      return readService.getProtocol(actor, protocolId);
    },

    // ── §4.1 rows 34-35 — vendor bindings (§8.5) ──────────────────────────────────────────────────────
    async createVendorBinding(
      actor,
      input: CreateVendorBindingInput,
    ): Promise<VendorBindingView> {
      const at = now();
      // §8.5 — the BAA is a PRECONDITION for enabling an adapter at runtime, so a binding created without
      // the attestation is refused rather than created-and-inert. An inert binding is the worse outcome:
      // the tenant's policy would name a vendor that silently cannot carry a call.
      require_(
        input.baaInEffect,
        "VENDOR_BAA_ATTESTATION_REQUIRED",
        "a vendor binding requires the BAA attestation on file before its adapter may be enabled (§8.5)",
      );
      const vendorId = await withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await tx
          .insert(VENDOR)
          .values({
            organizationId: actor.organizationId,
            mdmVendorId: input.mdmVendorId,
            name: input.name,
            adapterKey: input.adapterKey,
            rnCoverageAttested: input.rnCoverageAttested,
            baaInEffect: input.baaInEffect,
            baaExpiresOn: input.baaExpiresOn ? new Date(input.baaExpiresOn) : null,
            defaultMinimizationPolicy: input.defaultMinimizationPolicy,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: VENDOR.id });
        return (row as { id: string }).id;
      });
      const bindings = await readService.listVendorBindings(actor);
      const found = bindings.find((b) => b.id === vendorId);
      require_(found !== undefined, "VENDOR_BINDING_NOT_FOUND", "the vendor binding did not persist");
      return found;
    },

    async patchVendorBinding(
      actor,
      vendorId,
      input: PatchVendorBindingInput,
    ): Promise<VendorBindingView> {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) => {
        const updated = await tx
          .update(VENDOR)
          .set({
            ...(input.rnCoverageAttested !== undefined
              ? { rnCoverageAttested: input.rnCoverageAttested }
              : {}),
            ...(input.baaInEffect !== undefined ? { baaInEffect: input.baaInEffect } : {}),
            ...(input.baaExpiresOn !== undefined
              ? { baaExpiresOn: input.baaExpiresOn === null ? null : new Date(input.baaExpiresOn) }
              : {}),
            updatedAt: at,
          })
          .where(and(eq(VENDOR.id, vendorId), eq(VENDOR.organizationId, actor.organizationId)))
          .returning({ id: VENDOR.id });
        require_(
          updated.length === 1,
          "VENDOR_BINDING_NOT_FOUND",
          `no external triage vendor binding ${vendorId} in this organization`,
        );
      });
      const bindings = await readService.listVendorBindings(actor);
      const found = bindings.find((b) => b.id === vendorId);
      require_(found !== undefined, "VENDOR_BINDING_NOT_FOUND", "the vendor binding disappeared");
      return found;
    },

    // ── §2.7 — the BCP paper-origin re-entry ──────────────────────────────────────────────────────────
    async reenterPaperCall(actor, input: PaperReentryInput): Promise<OpenTriageCallResult> {
      const at = now();
      const originalAt = input.paperOriginalOpenedAt;
      // §2.7 steps 1-2 — the three columns are ONE fact; refuse here so the message names the field the
      // re-entering clinician got wrong rather than surfacing a constraint name from the driver.
      assertPaperOriginCoherent(
        {
          source: "paper_origin",
          paperOriginFlag: true,
          paperOriginalOpenedAt: originalAt,
          openedAt: originalAt,
        },
        at,
      );

      const created = await withOrgContext(db, ctx(actor), async (tx) =>
        tx.transaction(async (inner) => {
          const [worklist] = await inner
            .select()
            .from(WORKLIST)
            .where(
              and(
                eq(WORKLIST.id, input.worklistId),
                eq(WORKLIST.organizationId, actor.organizationId),
              ),
            )
            .limit(1);
          require_(
            worklist !== undefined,
            "PAPER_REENTRY_WORKLIST_EXPIRED",
            `no open paper-re-entry worklist row ${input.worklistId} in this organization`,
          );
          // §2.7 step 3 — the claimed original time must fall inside the outage the row records. Outside
          // it the platform was UP and this is an ordinary late entry, which M8's late-entry tier records
          // honestly instead of attributing the delay to an outage.
          require_(
            new Date(originalAt).getTime() >= worklist.shiftStartsAt.getTime() &&
              new Date(originalAt).getTime() <= worklist.shiftEndsAt.getTime(),
            "PAPER_REENTRY_OUTSIDE_OUTAGE_WINDOW",
            `${originalAt} is outside the outage window ${iso(worklist.shiftStartsAt)} → ${iso(worklist.shiftEndsAt)}`,
          );

          const [row] = await inner
            .insert(CALL)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: input.providerEntityId,
              onCallShiftId: worklist.shiftId ?? "",
              patientId: input.patientId ?? null,
              admissionId: input.admissionId ?? null,
              callerKind: input.callerKind,
              callerDisplayName: input.callerDisplayName ?? null,
              inboundChannel: input.inboundChannel,
              source: "paper_origin",
              chiefComplaintText: input.chiefComplaintText ?? null,
              paperOriginFlag: true,
              paperOriginalOpenedAt: new Date(originalAt),
              // §2.7 step 2 — `opened_at` IS the original call time, so downstream consumers order the
              // call by the night it happened rather than by the morning it was typed up.
              openedAt: new Date(originalAt),
            })
            .returning();
          const call = row as typeof CALL.$inferSelect;

          const linkEffects = linkPaperReentry({
            worklist: {
              worklistId: worklist.id,
              expiresAt: iso(worklist.expiresAt),
              reenteredAt: worklist.reenteredAt === null ? null : iso(worklist.reenteredAt),
              linkedTriageCallId: worklist.linkedTriageCallId,
            },
            triageCallId: call.id,
            at: iso(at),
          });
          void linkEffects;
          await inner
            .update(WORKLIST)
            .set({ reenteredAt: at, linkedTriageCallId: call.id })
            .where(eq(WORKLIST.id, worklist.id));

          const patch = await runEffects(
            inner,
            openCallEffects({ machineOpened: false, at: iso(originalAt) }),
            {
              organizationId: actor.organizationId,
              providerEntityId: call.providerEntityId,
              locationId: call.locationId,
              triageCallId: call.id,
              at,
              actorMembershipId: actor.membershipId,
              commandPayloadDigest: digestOf(input),
              outbox,
              alerts,
              stateHistory,
              aggregateKind: "triage_call",
              aggregateId: call.id,
              payloads: {
                "m19.triage_call.opened": {
                  ...callEventBase(call),
                  onCallShiftId: call.onCallShiftId,
                  source: "paper_origin",
                  patientId: call.patientId,
                  paperOrigin: true,
                  originalOpenedAt: originalAt,
                },
              },
              // §2.7 — a re-entry is a human typing up a night that already happened; paging the on-call
              // nurse about it now would be an alert about the past (see `caseOpenedSeverity`).
              alertPayloads: {},
            },
          );
          const version = await applyCallPatch(inner, call.id, call.version, patch);
          return { call, version };
        }),
      );

      return {
        triageCallId: created.call.id,
        state: "open",
        onCallShiftId: created.call.onCallShiftId,
        version: created.version,
        suggestedProtocolId: null,
        suggestedProtocolConfidence: null,
        hospitalizationRiskBand: null,
        // §8.6 — a re-entry never calls M32: the AI block is disabled on this path by construction, not
        // by an outage.
        aiBlockDisabled: true,
      };
    },
  };

  // ── helpers that need the closure ────────────────────────────────────────────────────────────────

  /** D5 / §2.2.3 — the shared body of `recordAnswer` and `correctAnswer`. */
  async function writeAnswer(
    actor: M19WriteActor,
    triageCallId: string,
    input: RecordAnswerInput | CorrectAnswerInput,
    correctionOfAnswerId: string | null,
  ): Promise<AnswerWriteResult> {
    const at = now();
    return withOrgContext(db, ctx(actor), async (tx) =>
      tx.transaction(async (inner) => {
        const call = await loadCall(inner, actor, triageCallId);
        if (input.expectedVersion !== undefined) {
          assertVersion(call.version, input.expectedVersion);
        }
        require_(
          call.selectedProtocolId !== null,
          "PROTOCOL_NOT_AVAILABLE",
          "no protocol is pinned on this call yet; apply one before recording answers",
        );
        const walk = await loadWalk(inner, call.id, call.selectedProtocolId);
        const question = walk.questions.find(
          (q) => q.questionId === input.triageProtocolQuestionId,
        );
        require_(
          question !== undefined,
          "PROTOCOL_QUESTION_NOT_IN_PROTOCOL",
          `question ${input.triageProtocolQuestionId} is not part of the pinned protocol`,
        );

        const decision = recordAnswerDecision({
          question,
          questions: walk.questions,
          answers: walk.answers,
          protocolId: call.selectedProtocolId,
          value: input.value,
          correctionOfAnswerId,
          answeredByMembershipId: actor.membershipId,
        });

        const [answerRow] = await inner
          .insert(ANSWER)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: call.providerEntityId,
            locationId: call.locationId,
            triageCallId: call.id,
            triageProtocolQuestionId: question.questionId,
            correctionOfAnswerId,
            answerValueText: input.value.kind === "text" ? input.value.value : null,
            answerValueInt: input.value.kind === "int" ? input.value.value : null,
            answerValueBool: input.value.kind === "bool" ? input.value.value : null,
            // D5 — the SERVER's evaluation, never a client assertion.
            redFlagHit: decision.redFlagHit,
            answeredAt: at,
            answeredByMembershipId: actor.membershipId,
          })
          .returning({ id: ANSWER.id });
        const answerId = (answerRow as { id: string }).id;

        const escalationEffect = decision.effects.find(
          (e): e is Extract<TriageSideEffect, { kind: "create_escalation" }> =>
            e.kind === "create_escalation",
        );
        let escalationId: string | null = null;
        if (escalationEffect) {
          escalationId = await insertEscalation(
            inner,
            actor,
            call,
            escalationEffect,
            { membershipId: null, externalActorId: null },
            `red flag on question ${question.questionOrder}`,
          );
        }

        await runEffects(inner, decision.effects, {
          organizationId: actor.organizationId,
          providerEntityId: call.providerEntityId,
          locationId: call.locationId,
          triageCallId: call.id,
          at,
          actorMembershipId: actor.membershipId,
          // The DIGEST, not the answer: `answer_value_text` is §3.6-denylisted and the state-history row
          // is not where a caller's words belong.
          commandPayloadDigest: digestOf({ questionId: question.questionId }),
          outbox,
          alerts,
          stateHistory,
          aggregateKind: "triage_call",
          aggregateId: call.id,
          payloads:
            escalationId !== null
              ? {
                  "m19.triage_call.red_flag_hit": {
                    ...callEventBase(call),
                    questionId: question.questionId,
                    escalationId,
                  },
                }
              : {},
          alertPayloads:
            escalationId !== null
              ? {
                  "m19.triage.protocol_red_flag_hit": buildRedFlagHitAlert({
                    orgId: actor.organizationId,
                    providerEntityId: call.providerEntityId,
                    triageCallId: call.id,
                    escalationId,
                    questionPrompt: question.prompt,
                  }) as unknown as Record<string, unknown>,
                }
              : {},
        });

        const nextVersion = await applyCallPatch(inner, call.id, call.version, {});
        const nextQuestion = nextUnansweredQuestion(walk.questions, [
          ...walk.answers,
          { answerId, questionId: question.questionId, correctionOfAnswerId, redFlagHit: decision.redFlagHit },
        ]);

        return {
          answerId,
          redFlagHit: decision.redFlagHit,
          // §7.2's response field. A MANDATORY escalation comes from the protocol row (D7) and is written
          // at `applyProtocol`, so an answer-driven escalation is never mandatory — reporting it as one
          // would put the §5 panel's sticky red banner on an ordinary clinical concern and teach
          // clinicians to ignore the banner that matters.
          mandatoryEscalationTriggered: false,
          escalationId,
          tier: escalationEffect?.tier ?? null,
          nextQuestionId: nextQuestion?.questionId ?? null,
          version: nextVersion,
        };
      }),
    );
  }

  /** Decision 5 — resolve a TENANT protocol row, refusing a platform-floor one with a reason. */
  async function loadTenantProtocol(tx: Tx, actor: M19WriteActor, protocolId: string) {
    const [row] = await tx.select().from(PROTOCOL).where(eq(PROTOCOL.id, protocolId)).limit(1);
    require_(
      row !== undefined,
      "PROTOCOL_NOT_FOUND",
      `no triage protocol ${protocolId} is in this organization's catalog`,
    );
    require_(
      !row.isSystemLocked,
      "PROTOCOL_SYSTEM_LOCKED",
      `protocol '${row.key}' is a platform-floor row; a tenant may author its own protocol but may not edit the floor (§8.3.2)`,
    );
    require_(
      row.organizationId === actor.organizationId,
      "PROTOCOL_NOT_FOUND",
      `no triage protocol ${protocolId} is in this organization's catalog`,
    );
    return row;
  }

  async function insertQuestion(
    tx: Tx,
    actor: M19WriteActor,
    protocolId: string,
    input: ProtocolQuestionInput,
    at: Date,
  ): Promise<void> {
    await tx.insert(QUESTION).values({
      triageProtocolId: protocolId,
      organizationId: actor.organizationId,
      isSystemLocked: false,
      questionOrder: input.questionOrder,
      prompt: input.prompt,
      answerType: input.answerType,
      answerEnumValues: input.answerEnumValues ?? null,
      required: input.required ?? false,
      isRedFlagQuestion: input.isRedFlagQuestion ?? false,
      redFlagMatch: input.redFlagMatch ?? null,
      createdAt: at,
      updatedAt: at,
    });
  }

  async function loadEscalation(tx: Tx, actor: M19WriteActor, escalationId: string) {
    const [row] = await tx
      .select()
      .from(ESCALATION)
      .where(
        and(eq(ESCALATION.id, escalationId), eq(ESCALATION.organizationId, actor.organizationId)),
      )
      .limit(1);
    require_(
      row !== undefined,
      "ESCALATION_NOT_FOUND",
      `no triage escalation ${escalationId} is readable in this organization`,
    );
    const facts: TriageEscalationFacts = {
      escalationId: row.id,
      tier: row.tier,
      triggerKind: row.triggerKind,
      escalatedAt: iso(row.escalatedAt),
      acknowledgedAt: row.acknowledgedAt === null ? null : iso(row.acknowledgedAt),
      resolvedAt: row.resolvedAt === null ? null : iso(row.resolvedAt),
      escalatedToMembershipId: row.escalatedToMembershipId,
      escalatedToExternalActorId: row.escalatedToExternalActorId,
    };
    return { row, facts };
  }

  async function loadShift(tx: Tx, actor: M19WriteActor, shiftId: string) {
    const [row] = await tx
      .select()
      .from(SHIFT)
      .where(and(eq(SHIFT.id, shiftId), eq(SHIFT.organizationId, actor.organizationId)))
      .limit(1);
    require_(
      row !== undefined,
      "SHIFT_NOT_FOUND",
      `no on-call shift ${shiftId} is readable in this organization`,
    );
    const facts: OnCallShiftFacts = {
      status: row.status,
      version: row.version,
      shiftStartsAt: iso(row.shiftStartsAt),
      shiftEndsAt: iso(row.shiftEndsAt),
      discipline: row.discipline,
      primaryOnCallMembershipId: row.primaryOnCallMembershipId,
      externalActorId: row.externalActorId,
      openedAt: row.openedAt === null ? null : iso(row.openedAt),
      closedAt: row.closedAt === null ? null : iso(row.closedAt),
    };
    return { row, facts };
  }

  /** Re-read one escalation through the READ service so a mutation answers the inbox DTO. */
  async function findEscalation(actor: M19WriteActor, escalationId: string) {
    const page = await readService.listEscalations(actor, { openOnly: false, limit: 200 });
    const found = page.data.find((e) => e.id === escalationId);
    require_(
      found !== undefined,
      "ESCALATION_NOT_FOUND",
      `escalation ${escalationId} is not readable after the write`,
    );
    return found;
  }

  /** Re-read one shift through the READ service so a mutation answers the schedule DTO. */
  async function findShift(actor: M19WriteActor, shiftId: string): Promise<OnCallShiftView> {
    const page = await readService.listShifts(actor, { limit: 200 });
    const found = page.data.find((s) => s.id === shiftId);
    require_(found !== undefined, "SHIFT_NOT_FOUND", `shift ${shiftId} is not readable after the write`);
    return found;
  }

  /**
   * Decisions 2 + 3 — the two ADVISORY M32 reads.
   *
   * Both are gated by the tenant's own flag BEFORE the seam is touched (decision 3: the disclosure is the
   * CALL, not the answer), and neither can fail the open (decision 2). `aiBlockDisabled` is true whenever
   * the panel must render the AI block visibly disabled — because the tenant opted out, because M32 is
   * deny-stubbed, or because the provider errored. §8.6 forbids a silent fallback or a guess, and those
   * three cases are indistinguishable to the clinician for a reason: in all three, there is no advisory.
   */
  async function readAdvisories(
    actor: M19WriteActor,
    call: { id: string; providerEntityId: string; patientId: string | null },
    chiefComplaintText: string | null,
  ): Promise<{
    suggestedProtocolId: string | null;
    confidence: string | null;
    hospitalizationRiskBand: string | null;
    aiBlockDisabled: boolean;
  }> {
    const policy = await withOrgContext(db, ctx(actor), async (tx) => {
      const [row] = await tx
        .select({
          suggestion: POLICY.aiProtocolSuggestionEnabled,
          risk: POLICY.aiHospitalizationRiskEnabled,
        })
        .from(POLICY)
        .where(
          and(
            eq(POLICY.organizationId, actor.organizationId),
            eq(POLICY.providerEntityId, call.providerEntityId),
          ),
        )
        .limit(1);
      return row ?? { suggestion: false, risk: false };
    });

    let suggestedProtocolId: string | null = null;
    let confidence: string | null = null;
    let suggestionUnavailable = !policy.suggestion;
    if (policy.suggestion && chiefComplaintText !== null) {
      try {
        const candidateKeys = await withOrgContext(db, ctx(actor), async (tx) => {
          const rows = await tx
            .select({ key: PROTOCOL.key })
            .from(PROTOCOL)
            .where(
              or(
                isNull(PROTOCOL.organizationId),
                eq(PROTOCOL.organizationId, actor.organizationId),
              ),
            );
          return rows.map((r) => r.key);
        });
        const result = await getProtocolSuggestionProvider().suggestProtocol(
          actor.organizationId,
          {
            triageCallId: call.id,
            patientId: call.patientId,
            chiefComplaintText,
            candidateProtocolKeys: candidateKeys,
          },
        );
        if (result.kind === "suggestion") {
          suggestedProtocolId = result.suggestion.suggestedProtocolId;
          confidence = result.suggestion.confidence;
        } else if (result.kind === "unavailable") {
          suggestionUnavailable = true;
        }
      } catch {
        suggestionUnavailable = true;
      }
    }

    let hospitalizationRiskBand: string | null = null;
    let riskUnavailable = !policy.risk;
    if (policy.risk && call.patientId !== null) {
      try {
        const result = await getHospitalizationRiskProvider().hospitalizationRiskForPatient(
          actor.organizationId,
          call.patientId,
          iso(now()),
        );
        if (result.kind === "advisory") hospitalizationRiskBand = result.advisory.riskBand;
        else riskUnavailable = true;
      } catch {
        riskUnavailable = true;
      }
    }

    return {
      suggestedProtocolId,
      confidence,
      hospitalizationRiskBand,
      aiBlockDisabled: suggestionUnavailable && riskUnavailable,
    };
  }
}

/** The §4.10 payloads a disposition emits, keyed by the effects `dispositionEffects` declared. */
function dispositionPayloads(
  call: { organizationId: string; providerEntityId: string; id: string; patientId: string | null },
  data: TriageDispositionData,
  occurredAt: IsoInstant,
): Partial<Record<M19EventName, Record<string, unknown>>> {
  const base = {
    orgId: call.organizationId,
    providerEntityId: call.providerEntityId,
    triageCallId: call.id,
    occurredAt,
  };
  const payloads: Partial<Record<M19EventName, Record<string, unknown>>> = {
    "m19.triage_call.disposition_selected": {
      ...base,
      disposition: data.disposition,
      dispositionData: data,
    },
  };

  if (data.disposition === "visit_dispatched_now") {
    payloads["m19.triage_call.visit_needed"] = {
      ...base,
      patientId: call.patientId,
      requestedDiscipline: data.requestedDiscipline,
      requestedArrivalBy: data.requestedArrivalBy,
      proposedForDate: null,
      reason: data.reason,
    };
  }
  if (data.disposition === "visit_scheduled_first_light") {
    payloads["m19.triage_call.visit_needed"] = {
      ...base,
      patientId: call.patientId,
      requestedDiscipline: data.requestedDiscipline,
      requestedArrivalBy: null,
      proposedForDate: data.proposedForDate,
      reason: data.reason,
    };
  }
  if (data.disposition === "pronouncement_scheduled") {
    // §7.9 — the pronouncement DISPATCHES an RN; M17 creates the visit from this event. Reading the
    // disposition as merely "scheduled" and emitting nothing would leave the family waiting for a nurse
    // M17 was never asked for.
    payloads["m19.triage_call.visit_needed"] = {
      ...base,
      patientId: call.patientId,
      requestedDiscipline: data.pronouncingDiscipline,
      requestedArrivalBy: data.expectedArrivalBy,
      proposedForDate: null,
      reason: "death pronouncement requested during after-hours triage call",
    };
  }
  if (data.disposition === "gip_admission_proposed") {
    payloads["m19.triage_call.gip_admission_proposed"] = {
      ...base,
      patientId: call.patientId,
      gipCriteriaSummary: data.gipCriteriaSummary,
      preferredFacility: data.preferredFacility,
    };
    payloads["m19.triage_call.care_plan_change_indicated"] = {
      ...base,
      patientId: call.patientId,
      changeKind: "level_of_care_gip_proposed",
    };
  }
  return payloads;
}

/**
 * D8 — the conditional back-reference write (`SET linked_encounter_id = $3 WHERE id = $2 AND
 * linked_encounter_id IS NULL`). That conditional IS the idempotency guarantee §2.6 wrongly attributes to
 * M8's creator (M19-T05's finding): the seam has no dedupe key, so the retry path's double-create is the
 * LIKELY failure, and this is what stops the second draft from replacing the first link.
 */
function encounterLinkPort(db: DbClient, actor: M19WriteActor) {
  const CALL = schema.triageCall;
  return {
    async linkEncounter(
      organizationId: string,
      triageCallId: string,
      encounterId: string,
    ): Promise<"linked" | "already_linked"> {
      return withOrgContext(
        db,
        { organizationId, userId: actor.userId },
        async (tx): Promise<"linked" | "already_linked"> => {
          const updated = await tx
            .update(CALL)
            .set({ linkedEncounterId: encounterId })
            .where(and(eq(CALL.id, triageCallId), isNull(CALL.linkedEncounterId)))
            .returning({ id: CALL.id });
          return updated.length === 1 ? "linked" : "already_linked";
        },
      );
    },
  };
}
