// apps/backend/__tests__/oncall-inject.test.ts — M19-T07 (§4.1) HTTP-layer smoke suite (TASK-050A /
// TEST-001).
//
// `oncall-routes.test.ts` already covers M19's §4.6/§4.7 DECISIONS as pure functions, and its own header
// says so explicitly: those tests are about the decisions, never about the SQL, and none of them calls
// Fastify `.inject()`. That leaves the module's ~38 route defs with ZERO coverage of the thing a pure
// function cannot see — a mis-wired guard, a permission key that does not match the catalog, an ABAC
// predicate name that does not resolve, or a TypeBox schema that silently drifted from the route body it
// guards. This file closes that gap by driving every route through the FULL Fastify middleware chain:
// `buildServer()` mounts the host, `mountM19Routes()` mounts the five §4.1 plugins, the REAL Authorization
// Contract gates every route on the real §4.6 permission keys, and the REAL `buildOncallAbacPredicates`
// resolves the six §4.7 predicates M19 owns.
//
// M19 ships no `createInMemory*Backend` the way M11's orders module does (grepped
// `apps/backend/src/modules/19-oncall/index.ts` — only `mountM19Routes` and the §3.7 eraser backend are
// exported; there is no in-memory `M19ReadService`/`M19WriteService` pair anywhere in the module). The
// harness half of this file (the header-auth shim, the permission/ABAC registry wiring, the
// beforeEach/afterEach reset) clones `orders-routes.test.ts` exactly; the SERVICE half is a small
// hand-rolled backend built directly against the real, exported `M19ReadService`/`M19WriteService`
// contracts (`../src/modules/19-oncall/routes/index`) so the compiler still catches an interface drift.
// It does not reimplement the §2.2-§2.7 lifecycle machine or the §2.5 optimistic-concurrency check — those
// are `oncall-lifecycle.test.ts`'s and the (still-partial) live-RLS suite's job — it only has to prove the
// HTTP boundary (guard → ABAC → schema → service → response) is wired correctly end to end.
//
// Two predicates the per-call/list routes compose on are NOT M19's own: `caseload_or_scope` (M7) and
// `step_up_recent` (M3, boot-registered from a real M2 session-context store in production). Registering
// the full M7/M3 machinery here would pull in seams this module does not depend on for a smoke test whose
// job is M19's own wiring, so both get a small test-local stand-in registered into the SAME fresh
// `createPredicateRegistry()` this file builds — `caseload_or_scope` answers true whenever an org resolved
// (mirroring routes/guards.ts's own comment: "the predicate is the precondition, RLS plus the read
// service's own caseload narrowing is the control"), and `step_up_recent` answers
// `context.attributes.stepUpRecent === true`, exactly the M2 session fact `requireStepUp` composes on.
// Neither predicate is M19's to test; both are real enough that a genuinely wrong `requirePermission` key
// or a genuinely wrong `requireAbac` predicate NAME (the bug class this file exists to catch) still fails
// loudly.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError, type PortalTriageSummary } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildOncallAbacPredicates,
  type OncallAbacPorts,
  type OncallAbacResolver,
} from "../src/modules/19-oncall/abac-predicates";
import { M19_PERMISSION_KEY_LIST } from "../src/modules/19-oncall/permission-keys";
import { mountM19Routes } from "../src/modules/19-oncall/routes/mount";
import type {
  CurrentOnCallView,
  EscalationInboxItem,
  M19ReadService,
  M19WriteService,
  OnCallShiftView,
  OncallPolicyView,
  PaperReentryWorklistView,
  TriageAnswerView,
  TriageCallDetail,
  TriageProtocolQuestionView,
  TriageProtocolView,
  VendorBindingView,
} from "../src/modules/19-oncall/routes/index";

// ── fixed test ids ───────────────────────────────────────────────────────────────────────────────────
const ORG = "org_a";
const PE = "44444444-4444-4444-8444-444444444444";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const VENDOR_MDM = "55555555-5555-4555-8555-555555555555";
const QUESTION_REF = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-08-01T12:00:00.000Z";
const FUTURE = "2026-12-31T00:00:00.000Z";

// ── in-memory row shapes (supersets of the published view types; extra bookkeeping fields like
//    `organizationId` are fine — the routes never declare a Fastify response schema, so nothing strips
//    them, and TypeScript's excess-property check does not apply to a variable already typed as a Row) ──
interface CallRow extends TriageCallDetail {
  readonly organizationId: string;
}
interface ShiftRow extends OnCallShiftView {
  readonly organizationId: string;
}
interface EscalationRow extends EscalationInboxItem {
  readonly organizationId: string;
}
interface PolicyRow extends OncallPolicyView {
  readonly organizationId: string;
}
interface VendorBindingRow extends VendorBindingView {
  readonly organizationId: string;
}
interface WorklistRow extends PaperReentryWorklistView {
  readonly organizationId: string;
}

const SELECTABLE_DISPOSITIONS = [
  "caregiver_education_only",
  "prn_intervention_authorized",
  "verbal_order_recorded",
  "visit_dispatched_now",
  "visit_scheduled_first_light",
  "gip_admission_proposed",
  "ed_transfer_acknowledged",
  "pronouncement_scheduled",
] as const;

function page<T>(data: readonly T[]): { data: T[]; next_cursor: string | null; has_more: boolean } {
  return { data: [...data], next_cursor: null, has_more: false };
}

function answerTypeOf(kind: "text" | "int" | "bool"): TriageAnswerView["answerType"] {
  if (kind === "bool") return "boolean";
  if (kind === "int") return "integer";
  return "free_text";
}

/** Build the in-memory `M19ReadService`/`M19WriteService` pair this file exercises over HTTP. */
function createOncallTestBackend() {
  const calls = new Map<string, CallRow>();
  const shifts = new Map<string, ShiftRow>();
  const escalations = new Map<string, EscalationRow>();
  const protocols = new Map<string, TriageProtocolView>();
  const vendorBindings = new Map<string, VendorBindingRow>();
  const worklist = new Map<string, WorklistRow>();
  const policies = new Map<string, PolicyRow>();

  const seedProtocolId = randomUUID();
  protocols.set(seedProtocolId, {
    id: seedProtocolId,
    organizationId: null,
    key: "shortness_of_breath",
    chiefComplaintLabel: "Shortness of breath",
    snomedCode: "267036007",
    disciplineRequired: "clinical_rn",
    isSystemLocked: true,
    requiresMandatoryEscalation: false,
    mandatoryEscalationTier: null,
    version: "1.0",
    effectiveFrom: NOW,
    effectiveTo: null,
    sortOrder: 1,
    questions: [],
  });

  const seedWorklistId = randomUUID();
  worklist.set(seedWorklistId, {
    organizationId: ORG,
    id: seedWorklistId,
    providerEntityId: PE,
    outageWindowId: randomUUID(),
    shiftId: null,
    shiftStartsAt: NOW,
    shiftEndsAt: NOW,
    assignedToMembershipId: null,
    reenteredAt: null,
    linkedTriageCallId: null,
    expiresAt: FUTURE,
  });

  function requireCall(id: string): CallRow {
    const row = calls.get(id);
    if (!row) throw new NotFoundError("triage_call", id);
    return row;
  }
  function requireShift(id: string): ShiftRow {
    const row = shifts.get(id);
    if (!row) throw new NotFoundError("on_call_shift", id);
    return row;
  }
  function requireEscalation(id: string): EscalationRow {
    const row = escalations.get(id);
    if (!row) throw new NotFoundError("triage_escalation", id);
    return row;
  }
  function requireProtocol(id: string): TriageProtocolView {
    const row = protocols.get(id);
    if (!row) throw new NotFoundError("triage_protocol", id);
    return row;
  }
  function requireVendorBinding(id: string): VendorBindingRow {
    const row = vendorBindings.get(id);
    if (!row) throw new NotFoundError("external_triage_vendor", id);
    return row;
  }
  function requireWorklist(id: string): WorklistRow {
    const row = worklist.get(id);
    if (!row) throw new NotFoundError("paper_reentry_worklist", id);
    return row;
  }

  function ensureShift(providerEntityId: string): ShiftRow {
    for (const row of shifts.values()) {
      if (row.providerEntityId === providerEntityId && row.status === "active") return row;
    }
    const row: ShiftRow = {
      organizationId: ORG,
      id: randomUUID(),
      providerEntityId,
      shiftStartsAt: NOW,
      shiftEndsAt: NOW,
      discipline: "clinical_rn",
      status: "active",
      primaryOnCallMembershipId: MEMBERSHIP,
      backupMembershipId: null,
      externalActorId: null,
      externalActorLabel: null,
      openedAt: NOW,
      closedAt: null,
      m17VisitAssignmentRef: null,
      cancellationReason: null,
      version: 1,
    };
    shifts.set(row.id, row);
    return row;
  }

  function getOrCreatePolicy(providerEntityId: string): PolicyRow {
    const existing = policies.get(providerEntityId);
    if (existing) return existing;
    const row: PolicyRow = {
      organizationId: ORG,
      id: randomUUID(),
      providerEntityId,
      model: "direct",
      escalationTiers: {},
      callbackSlaPerSeverity: {},
      stateOverrides: {},
      externalTriageVendorId: null,
      emergencyContactE164: null,
      aiProtocolSuggestionEnabled: false,
      aiHospitalizationRiskEnabled: false,
      version: 1,
    };
    policies.set(providerEntityId, row);
    return row;
  }

  function newCallRow(input: {
    providerEntityId: string;
    onCallShiftId: string;
    callerKind: CallRow["callerKind"];
    inboundChannel: CallRow["inboundChannel"];
    patientId?: string | null;
    admissionId?: string | null;
    callerDisplayName?: string | null;
    callerPhoneE164?: string | null;
    callerRelationshipLabel?: string | null;
    callerCaregiverId?: string | null;
    chiefComplaintText?: string | null;
    chiefComplaintSnomed?: string | null;
    source?: CallRow["source"];
    paperOriginFlag?: boolean;
    paperOriginalOpenedAt?: string | null;
  }): CallRow {
    return {
      organizationId: ORG,
      id: randomUUID(),
      providerEntityId: input.providerEntityId,
      patientId: input.patientId ?? null,
      state: "open",
      disposition: null,
      callerKind: input.callerKind,
      inboundChannel: input.inboundChannel,
      source: input.source ?? "manual",
      chiefComplaintSnomed: input.chiefComplaintSnomed ?? null,
      openedAt: NOW,
      firstResponseAt: null,
      closedAt: null,
      protocolLabel: null,
      openEscalationCount: 0,
      redFlagAnswerCount: 0,
      version: 1,
      locationId: null,
      admissionId: input.admissionId ?? null,
      callerDisplayName: input.callerDisplayName ?? null,
      callerPhoneE164: input.callerPhoneE164 ?? null,
      callerRelationshipLabel: input.callerRelationshipLabel ?? null,
      callerCaregiverId: input.callerCaregiverId ?? null,
      chiefComplaintText: input.chiefComplaintText ?? null,
      onCallShiftId: input.onCallShiftId,
      selectedProtocolId: null,
      selectedProtocolVersion: null,
      suggestedProtocolId: null,
      suggestedProtocolConfidence: null,
      hospitalizationRiskBand: null,
      dispositionData: null,
      linkedEncounterId: null,
      linkedVerbalOrderIds: [],
      linkedVisitProposalId: null,
      paperOriginFlag: input.paperOriginFlag ?? false,
      paperOriginalOpenedAt: input.paperOriginalOpenedAt ?? null,
      documentedAt: null,
      answers: [],
      escalations: [],
      stateHistory: [],
      nextQuestionId: null,
      permittedDispositions: SELECTABLE_DISPOSITIONS,
      medicationContext: null,
      redactedCategories: [],
      dispositionBlockedByMandatoryEscalation: false,
    };
  }

  const PORTAL_SUMMARY: PortalTriageSummary = {
    triageCallId: "portal-call-1",
    occurredAt: NOW,
    callerRelationshipLabel: "daughter",
    callerKind: "caregiver",
    dispositionSummaryLay: "Your call was received by the on-call team.",
    visitDispatched: false,
    visitScheduledFirstLight: false,
  };

  const readService: M19ReadService = {
    async listTriageCalls() {
      return page([...calls.values()]);
    },
    async getTriageCall(_actor, triageCallId) {
      return requireCall(triageCallId);
    },
    async getTranscript(_actor, triageCallId) {
      requireCall(triageCallId);
      return {
        triageCallId,
        transcript: "stub-decrypted-transcript",
        callerQuote: null,
        decryptedAt: NOW,
      };
    },
    async listEscalations() {
      return page([...escalations.values()]);
    },
    async listShifts() {
      return page([...shifts.values()]);
    },
    async getCurrentOnCall(_actor, input) {
      const providerEntityId = input.providerEntityId ?? PE;
      const view: CurrentOnCallView = {
        asOf: NOW,
        perProviderEntity: [{ providerEntityId, actors: [], rnCoverageGap: false }],
      };
      return view;
    },
    async getPolicy(_actor, providerEntityId) {
      return getOrCreatePolicy(providerEntityId);
    },
    async listProtocols() {
      return page([...protocols.values()]);
    },
    async getProtocol(_actor, protocolId) {
      return requireProtocol(protocolId);
    },
    async listVendorBindings() {
      return [...vendorBindings.values()];
    },
    async listPortalRecent(_actor, patientId) {
      return page(patientId === PATIENT ? [PORTAL_SUMMARY] : []);
    },
    async listPaperReentryWorklist() {
      return [...worklist.values()];
    },
  };

  const writeService: M19WriteService = {
    async openTriageCall(_actor, input) {
      const shift = ensureShift(input.providerEntityId);
      const row = newCallRow({
        providerEntityId: input.providerEntityId,
        onCallShiftId: shift.id,
        callerKind: input.callerKind,
        inboundChannel: input.inboundChannel,
        patientId: input.patientId ?? null,
        admissionId: input.admissionId ?? null,
        callerDisplayName: input.callerDisplayName ?? null,
        callerPhoneE164: input.callerPhoneE164 ?? null,
        callerRelationshipLabel: input.callerRelationshipLabel ?? null,
        callerCaregiverId: input.callerCaregiverId ?? null,
        chiefComplaintText: input.chiefComplaintText ?? null,
        chiefComplaintSnomed: input.chiefComplaintSnomed ?? null,
      });
      calls.set(row.id, row);
      return {
        triageCallId: row.id,
        state: "open",
        onCallShiftId: shift.id,
        version: 1,
        suggestedProtocolId: null,
        suggestedProtocolConfidence: null,
        hospitalizationRiskBand: null,
        aiBlockDisabled: true,
      };
    },
    async identifyPatient(_actor, triageCallId, input) {
      const row = requireCall(triageCallId);
      const updated: CallRow = {
        ...row,
        patientId: input.patientId,
        admissionId: input.admissionId,
        locationId: input.locationId ?? row.locationId,
        callerCaregiverId: input.callerCaregiverId ?? row.callerCaregiverId,
      };
      calls.set(triageCallId, updated);
      return updated;
    },
    async applyProtocol(_actor, triageCallId, input) {
      const row = requireCall(triageCallId);
      const protocol = protocols.get(input.triageProtocolId);
      const updated: CallRow = {
        ...row,
        state: "protocol_in_progress",
        selectedProtocolId: input.triageProtocolId,
        selectedProtocolVersion: protocol?.version ?? "1.0",
      };
      calls.set(triageCallId, updated);
      return updated;
    },
    async recordAnswer(_actor, triageCallId, input) {
      const row = requireCall(triageCallId);
      const answer: TriageAnswerView = {
        id: randomUUID(),
        questionId: input.triageProtocolQuestionId,
        questionOrder: 1,
        prompt: "stub question",
        answerType: answerTypeOf(input.value.kind),
        valueText: input.value.kind === "text" ? input.value.value : null,
        valueInt: input.value.kind === "int" ? input.value.value : null,
        valueBool: input.value.kind === "bool" ? input.value.value : null,
        redFlagHit: false,
        correctionOfAnswerId: null,
        answeredAt: NOW,
        answeredByMembershipId: MEMBERSHIP,
      };
      calls.set(triageCallId, { ...row, answers: [...row.answers, answer] });
      return {
        answerId: answer.id,
        redFlagHit: false,
        mandatoryEscalationTriggered: false,
        escalationId: null,
        tier: null,
        nextQuestionId: null,
        version: row.version,
      };
    },
    async correctAnswer(_actor, triageCallId, answerId, input) {
      const row = requireCall(triageCallId);
      const answer: TriageAnswerView = {
        id: randomUUID(),
        questionId: input.triageProtocolQuestionId,
        questionOrder: 1,
        prompt: "stub question",
        answerType: answerTypeOf(input.value.kind),
        valueText: input.value.kind === "text" ? input.value.value : null,
        valueInt: input.value.kind === "int" ? input.value.value : null,
        valueBool: input.value.kind === "bool" ? input.value.value : null,
        redFlagHit: false,
        correctionOfAnswerId: answerId,
        answeredAt: NOW,
        answeredByMembershipId: MEMBERSHIP,
      };
      calls.set(triageCallId, { ...row, answers: [...row.answers, answer] });
      return {
        answerId: answer.id,
        redFlagHit: false,
        mandatoryEscalationTriggered: false,
        escalationId: null,
        tier: null,
        nextQuestionId: null,
        version: row.version,
      };
    },
    async completeProtocol(_actor, triageCallId) {
      const row = requireCall(triageCallId);
      const updated: CallRow = { ...row, state: "disposition_pending" };
      calls.set(triageCallId, updated);
      return updated;
    },
    async markAwaitingCallback(_actor, triageCallId, _input) {
      const row = requireCall(triageCallId);
      const updated: CallRow = { ...row, state: "awaiting_callback" };
      calls.set(triageCallId, updated);
      return updated;
    },
    async resumeAfterCallback(_actor, triageCallId) {
      const row = requireCall(triageCallId);
      const updated: CallRow = { ...row, state: "protocol_in_progress" };
      calls.set(triageCallId, updated);
      return updated;
    },
    async selectDisposition(_actor, triageCallId, input) {
      const row = requireCall(triageCallId);
      const updated: CallRow = {
        ...row,
        state: "documented_pending_encounter",
        disposition: input.dispositionData.disposition,
        dispositionData: input.dispositionData,
      };
      calls.set(triageCallId, updated);
      return updated;
    },
    async documentCall(_actor, triageCallId, _input) {
      const row = requireCall(triageCallId);
      const updated: CallRow = { ...row, linkedEncounterId: randomUUID() };
      calls.set(triageCallId, updated);
      return updated;
    },
    async abandonCall(_actor, triageCallId, _input) {
      const row = requireCall(triageCallId);
      const updated: CallRow = { ...row, state: "abandoned" };
      calls.set(triageCallId, updated);
      return updated;
    },
    async escalate(_actor, triageCallId, input) {
      const row = requireCall(triageCallId);
      const esc: EscalationRow = {
        organizationId: ORG,
        id: randomUUID(),
        tier: input.tier,
        triggerKind: "manual",
        state: "open",
        mandatory: false,
        escalatedToMembershipId: input.escalatedToMembershipId ?? null,
        escalatedToExternalActorId: input.escalatedToExternalActorId ?? null,
        escalatedAt: NOW,
        acknowledgedAt: null,
        resolvedAt: null,
        resolvedByMembershipId: null,
        triageCallId,
        providerEntityId: row.providerEntityId,
        patientId: row.patientId,
        callState: row.state,
        minutesOpen: 0,
        version: 1,
      };
      escalations.set(esc.id, esc);
      if (input.handOffCall) calls.set(triageCallId, { ...row, state: "escalated_unresolved" });
      return esc;
    },
    async acknowledgeEscalation(_actor, escalationId, _input) {
      const row = requireEscalation(escalationId);
      const updated: EscalationRow = { ...row, state: "acknowledged", acknowledgedAt: NOW };
      escalations.set(escalationId, updated);
      return updated;
    },
    async resolveEscalation(_actor, escalationId, _input) {
      const row = requireEscalation(escalationId);
      const updated: EscalationRow = {
        ...row,
        state: "resolved",
        resolvedAt: NOW,
        resolvedByMembershipId: MEMBERSHIP,
      };
      escalations.set(escalationId, updated);
      return updated;
    },
    async createShift(_actor, input) {
      const row: ShiftRow = {
        organizationId: ORG,
        id: randomUUID(),
        providerEntityId: input.providerEntityId,
        shiftStartsAt: input.shiftStartsAt,
        shiftEndsAt: input.shiftEndsAt,
        discipline: input.discipline,
        status: "scheduled",
        primaryOnCallMembershipId: input.primaryOnCallMembershipId ?? null,
        backupMembershipId: input.backupMembershipId ?? null,
        externalActorId: input.externalActorId ?? null,
        externalActorLabel: input.externalActorLabel ?? null,
        openedAt: null,
        closedAt: null,
        m17VisitAssignmentRef: null,
        cancellationReason: null,
        version: 1,
      };
      shifts.set(row.id, row);
      return row;
    },
    async cancelShift(_actor, shiftId, input) {
      const row = requireShift(shiftId);
      const updated: ShiftRow = { ...row, status: "cancelled", cancellationReason: input.reason };
      shifts.set(shiftId, updated);
      return updated;
    },
    async openShift(_actor, shiftId, _input) {
      const row = requireShift(shiftId);
      const updated: ShiftRow = { ...row, status: "active", openedAt: NOW };
      shifts.set(shiftId, updated);
      return updated;
    },
    async closeShift(_actor, shiftId, _input) {
      const row = requireShift(shiftId);
      const updated: ShiftRow = { ...row, status: "completed", closedAt: NOW };
      shifts.set(shiftId, updated);
      return updated;
    },
    async patchPolicy(_actor, input) {
      const existing = getOrCreatePolicy(input.providerEntityId);
      const updated: PolicyRow = {
        ...existing,
        model: input.model ?? existing.model,
        escalationTiers: input.escalationTiers ?? existing.escalationTiers,
        callbackSlaPerSeverity: input.callbackSlaPerSeverity ?? existing.callbackSlaPerSeverity,
        stateOverrides: input.stateOverrides ?? existing.stateOverrides,
        externalTriageVendorId:
          input.externalTriageVendorId !== undefined
            ? input.externalTriageVendorId
            : existing.externalTriageVendorId,
        emergencyContactE164:
          input.emergencyContactE164 !== undefined
            ? input.emergencyContactE164
            : existing.emergencyContactE164,
        aiProtocolSuggestionEnabled:
          input.aiProtocolSuggestionEnabled ?? existing.aiProtocolSuggestionEnabled,
        aiHospitalizationRiskEnabled:
          input.aiHospitalizationRiskEnabled ?? existing.aiHospitalizationRiskEnabled,
      };
      policies.set(input.providerEntityId, updated);
      return updated;
    },
    async createProtocol(_actor, input) {
      const row: TriageProtocolView = {
        id: randomUUID(),
        organizationId: ORG,
        key: input.key,
        chiefComplaintLabel: input.chiefComplaintLabel,
        snomedCode: input.snomedCode,
        disciplineRequired: input.disciplineRequired,
        isSystemLocked: false,
        requiresMandatoryEscalation: input.requiresMandatoryEscalation ?? false,
        mandatoryEscalationTier: input.mandatoryEscalationTier ?? null,
        version: input.version ?? "1.0",
        effectiveFrom: input.effectiveFrom ?? NOW,
        effectiveTo: input.effectiveTo ?? null,
        sortOrder: input.sortOrder ?? 0,
        questions: (input.questions ?? []).map((q) => ({
          id: randomUUID(),
          questionOrder: q.questionOrder,
          prompt: q.prompt,
          answerType: q.answerType,
          answerEnumValues: q.answerEnumValues ?? null,
          required: q.required ?? true,
          isRedFlagQuestion: q.isRedFlagQuestion ?? false,
          redFlagMatch: q.redFlagMatch ?? null,
          isSystemLocked: false,
        })),
      };
      protocols.set(row.id, row);
      return row;
    },
    async patchProtocol(_actor, protocolId, input) {
      const row = requireProtocol(protocolId);
      const updated: TriageProtocolView = {
        ...row,
        chiefComplaintLabel: input.chiefComplaintLabel ?? row.chiefComplaintLabel,
        snomedCode: input.snomedCode ?? row.snomedCode,
        disciplineRequired: input.disciplineRequired ?? row.disciplineRequired,
        requiresMandatoryEscalation:
          input.requiresMandatoryEscalation ?? row.requiresMandatoryEscalation,
        mandatoryEscalationTier: input.mandatoryEscalationTier ?? row.mandatoryEscalationTier,
        version: input.version ?? row.version,
        effectiveTo: input.effectiveTo !== undefined ? input.effectiveTo : row.effectiveTo,
        sortOrder: input.sortOrder ?? row.sortOrder,
      };
      protocols.set(protocolId, updated);
      return updated;
    },
    async addProtocolQuestion(_actor, protocolId, input) {
      const row = requireProtocol(protocolId);
      const question: TriageProtocolQuestionView = {
        id: randomUUID(),
        questionOrder: input.questionOrder,
        prompt: input.prompt,
        answerType: input.answerType,
        answerEnumValues: input.answerEnumValues ?? null,
        required: input.required ?? true,
        isRedFlagQuestion: input.isRedFlagQuestion ?? false,
        redFlagMatch: input.redFlagMatch ?? null,
        isSystemLocked: false,
      };
      const updated: TriageProtocolView = { ...row, questions: [...row.questions, question] };
      protocols.set(protocolId, updated);
      return updated;
    },
    async patchProtocolQuestion(_actor, questionId, input) {
      for (const [protocolId, row] of protocols) {
        const idx = row.questions.findIndex((q) => q.id === questionId);
        if (idx === -1) continue;
        const question = row.questions[idx];
        if (!question) continue;
        const updatedQuestion: TriageProtocolQuestionView = { ...question, ...input };
        const questions = [...row.questions];
        questions[idx] = updatedQuestion;
        const updatedRow: TriageProtocolView = { ...row, questions };
        protocols.set(protocolId, updatedRow);
        return updatedRow;
      }
      throw new NotFoundError("triage_protocol_question", questionId);
    },
    async createVendorBinding(_actor, input) {
      const row: VendorBindingRow = {
        organizationId: ORG,
        id: randomUUID(),
        mdmVendorId: input.mdmVendorId,
        name: input.name,
        adapterKey: input.adapterKey,
        rnCoverageAttested: input.rnCoverageAttested,
        baaInEffect: input.baaInEffect,
        baaExpiresOn: input.baaExpiresOn ?? null,
        minimizationProfile: input.defaultMinimizationPolicy.profile,
        adapterRegistered: false,
      };
      vendorBindings.set(row.id, row);
      return row;
    },
    async patchVendorBinding(_actor, vendorId, input) {
      const row = requireVendorBinding(vendorId);
      const updated: VendorBindingRow = {
        ...row,
        rnCoverageAttested: input.rnCoverageAttested ?? row.rnCoverageAttested,
        baaInEffect: input.baaInEffect ?? row.baaInEffect,
        baaExpiresOn: input.baaExpiresOn !== undefined ? input.baaExpiresOn : row.baaExpiresOn,
      };
      vendorBindings.set(vendorId, updated);
      return updated;
    },
    async reenterPaperCall(_actor, input) {
      const wl = requireWorklist(input.worklistId);
      const shift = ensureShift(input.providerEntityId);
      const row = newCallRow({
        providerEntityId: input.providerEntityId,
        onCallShiftId: shift.id,
        callerKind: input.callerKind,
        inboundChannel: input.inboundChannel,
        patientId: input.patientId ?? null,
        admissionId: input.admissionId ?? null,
        callerDisplayName: input.callerDisplayName ?? null,
        chiefComplaintText: input.chiefComplaintText ?? null,
        source: "paper_origin",
        paperOriginFlag: true,
        paperOriginalOpenedAt: input.paperOriginalOpenedAt,
      });
      calls.set(row.id, row);
      worklist.set(wl.id, { ...wl, reenteredAt: NOW, linkedTriageCallId: row.id });
      return {
        triageCallId: row.id,
        state: "open",
        onCallShiftId: shift.id,
        version: 1,
        suggestedProtocolId: null,
        suggestedProtocolConfidence: null,
        hospitalizationRiskBand: null,
        aiBlockDisabled: true,
      };
    },
  };

  const resolver: OncallAbacResolver = {
    async loadCall(orgId, id) {
      const row = calls.get(id);
      if (!row || row.organizationId !== orgId) return null;
      return {
        organizationId: row.organizationId,
        triageCallId: row.id,
        providerEntityId: row.providerEntityId,
        patientId: row.patientId,
        onCallShiftId: row.onCallShiftId,
      };
    },
    async loadShift(orgId, id) {
      const row = shifts.get(id);
      if (!row || row.organizationId !== orgId) return null;
      return {
        organizationId: row.organizationId,
        shiftId: row.id,
        providerEntityId: row.providerEntityId,
        discipline: row.discipline,
        primaryOnCallMembershipId: row.primaryOnCallMembershipId,
        backupMembershipId: row.backupMembershipId,
        externalActorId: row.externalActorId,
      };
    },
    async loadEscalation(orgId, id) {
      const row = escalations.get(id);
      if (!row || row.organizationId !== orgId) return null;
      return {
        organizationId: row.organizationId,
        escalationId: row.id,
        tier: row.tier,
        escalatedToMembershipId: row.escalatedToMembershipId,
        escalatedToExternalActorId: row.escalatedToExternalActorId,
      };
    },
    async activeShiftForMembership() {
      return null;
    },
    async roleKeysOf() {
      return null;
    },
  };

  const ports: OncallAbacPorts = {
    async isInCaseload() {
      return false;
    },
    async tonightsOnCallRoster() {
      return null;
    },
    async familyCaregiverAccessActive({ patientId }) {
      return patientId === PATIENT;
    },
  };

  return { readService, writeService, resolver, ports, seedProtocolId, seedWorklistId };
}

// ── the M15/M16/M21/M24/M26 header-auth shim, extended with the test-only attribute headers M19's
//    session-class / step-up / portal-anchor facts need (the identity-routes.test.ts / consent-surface.test.ts
//    `context.attributes.<field> = <header>` precedent) ──────────────────────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  const sessionClass = request.headers["x-test-session-class"];
  if (typeof sessionClass === "string" && sessionClass.length > 0) {
    request.context.attributes.sessionClass = sessionClass;
  }
  if (request.headers["x-test-step-up"] === "1") {
    request.context.attributes.stepUpRecent = true;
  }
  const portalPatient = request.headers["x-test-portal-patient"];
  if (typeof portalPatient === "string" && portalPatient.length > 0) {
    request.context.attributes.portalPatientId = portalPatient;
  }
}

const PERMISSION_SEED = [
  { userId: "super_1", permissions: [...M19_PERMISSION_KEY_LIST] as string[] },
  { userId: "nobody_1", permissions: [] as string[] },
  { userId: "portal_1", permissions: ["portal.triage.read_recent"] },
];

function makeServer() {
  const backend = createOncallTestBackend();

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server, seeded with M3's intrinsics (`inOrg` among them) plus M19's
  // real six §4.7 predicates, plus the two test-local stand-ins for the M7/M3 predicates M19 composes on
  // but does not own (see the file header).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildOncallAbacPredicates({ resolver: backend.resolver, ports: backend.ports }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("caseload_or_scope", async (context) => Boolean(context.organizationId));
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM19Routes(app, { readService: backend.readService, writeService: backend.writeService });
  return { app, backend };
}

const SUPER = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "administrator",
  "x-test-membership": MEMBERSHIP,
  "x-test-step-up": "1",
};
const NOBODY = { "x-test-user": "nobody_1", "x-test-org": ORG };
const PORTAL = {
  "x-test-user": "portal_1",
  "x-test-org": ORG,
  "x-test-session-class": "caregiver_portal",
  "x-test-portal-patient": PATIENT,
};
/** A FRESH Idempotency-Key per mutating call — the M1 idempotency store (`applyIdempotency`) keys
 *  on `(orgId, key)` and 409s a REPLAY of the same key against a different body, so reusing one
 *  literal key across this file's many distinct requests would collide with itself, not the route. */
const idemp = () => ({ "idempotency-key": randomUUID() });
const IFM = { "if-match": "1" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

// ── auth/shape smoke: 401 / 403 / 422 ────────────────────────────────────────────────────────────────

describe("M19-T07 auth + schema boundary", () => {
  it("no auth headers at all → 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/triage-calls" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an authenticated actor holding NO permissions → 403", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/triage-calls", headers: NOBODY });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned actor posting an empty body → 422 (TypeBox VALIDATION_FAILED)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/triage-calls",
      headers: { ...SUPER, ...idemp() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── routes 1, 3-14 — the triage-call lifecycle over one call ────────────────────────────────────────

describe("M19-T07 §4.1 triage-call lifecycle (routes 1, 3-14)", () => {
  it("drives one call from open through abandon, hitting every per-call route", async () => {
    const { app } = makeServer();

    // 1 — open
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/triage-calls",
      headers: { ...SUPER, ...idemp() },
      payload: { providerEntityId: PE, inboundChannel: "phone", callerKind: "caregiver", source: "manual" },
    });
    expect(opened.statusCode).toBe(201);
    const callId = opened.json().triageCallId as string;

    // 3 — get detail
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/triage-calls/${callId}`,
      headers: SUPER,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(callId);

    // 4 — identify patient
    const identified = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/identify-patient`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { patientId: PATIENT, admissionId: ADMISSION },
    });
    expect(identified.statusCode).toBe(200);

    // 5 — apply protocol (against the seeded platform-floor protocol)
    const seed = await app.inject({ method: "GET", url: "/api/v1/triage-protocols", headers: SUPER });
    const seedProtocolId = seed.json().data[0].id as string;
    const applyReal = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/apply-protocol`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { triageProtocolId: seedProtocolId },
    });
    expect(applyReal.statusCode).toBe(200);
    expect(applyReal.json().selectedProtocolId).toBe(seedProtocolId);

    // 6 — record an answer
    const answered = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/answers`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { triageProtocolQuestionId: QUESTION_REF, value: { kind: "bool", value: true } },
    });
    expect(answered.statusCode).toBe(201);
    const answerId = answered.json().answerId as string;

    // 7 — correct that answer
    const corrected = await app.inject({
      method: "PATCH",
      url: `/api/v1/triage-calls/${callId}/answers/${answerId}/correct`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {
        triageProtocolQuestionId: QUESTION_REF,
        value: { kind: "bool", value: false },
        correctionReason: "Mis-heard the caller's first answer.",
      },
    });
    expect(corrected.statusCode).toBe(200);

    // 8 — complete the protocol walk
    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/complete-protocol`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {},
    });
    expect(completed.statusCode).toBe(200);

    // 9 — park on a callback
    const parked = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/awaiting-callback`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { reason: "Waiting for the caregiver to reach the bedside phone." },
    });
    expect(parked.statusCode).toBe(200);

    // 10 — resume
    const resumed = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/resume`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);

    // 14 — transcript decrypt (step-up + distinct permission)
    const transcript = await app.inject({
      method: "GET",
      url: `/api/v1/triage-calls/${callId}/transcript-decrypt`,
      headers: SUPER,
    });
    expect(transcript.statusCode).toBe(200);

    // 11 — select disposition
    const disposed = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/disposition`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {
        dispositionData: {
          disposition: "caregiver_education_only",
          educationSummary: "Reviewed comfort-care escalation steps with the caregiver at length.",
          followUpCallAt: null,
        },
      },
    });
    expect(disposed.statusCode).toBe(200);

    // 12 — document (invokes the M8 seam in production; If-Match not required here)
    const documented = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/document`,
      headers: { ...SUPER, ...idemp() },
      payload: { narrativeSummary: "Call documented via the stub M8 EncounterCreator seam." },
    });
    expect(documented.statusCode).toBe(200);

    // 13 — abandon (on the same call — the stub enforces no terminal-state guard)
    const abandoned = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/abandon`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { reason: "Caller disconnected before disposition could be confirmed.", callbackAttempts: 1 },
    });
    expect(abandoned.statusCode).toBe(200);

    await app.close();
  });
});

// ── route 2 — the supervisor board / caseload list ───────────────────────────────────────────────────

describe("M19-T07 §4.1 route 2 — list triage calls", () => {
  it("lists calls for a caseload_or_scope-eligible actor", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "POST",
      url: "/api/v1/triage-calls",
      headers: { ...SUPER, ...idemp() },
      payload: { providerEntityId: PE, inboundChannel: "phone", callerKind: "caregiver" },
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/triage-calls", headers: SUPER });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);
    await app.close();
  });
});

// ── §2.7 BCP paper re-entry — routes 15-16 ───────────────────────────────────────────────────────────

describe("M19-T07 §2.7 paper re-entry (routes 15-16)", () => {
  it("re-enters a paper-origin call (step-up) and lists the worklist", async () => {
    const { app, backend } = makeServer();
    const reentered = await app.inject({
      method: "POST",
      url: "/api/v1/triage-calls/paper-reentry",
      headers: { ...SUPER, ...idemp() },
      payload: {
        worklistId: backend.seedWorklistId,
        providerEntityId: PE,
        paperOriginalOpenedAt: NOW,
        inboundChannel: "phone",
        callerKind: "caregiver",
      },
    });
    expect(reentered.statusCode).toBe(201);
    expect(reentered.json().state).toBe("open");

    const worklist = await app.inject({
      method: "GET",
      url: "/api/v1/triage-calls/paper-reentry/worklist",
      headers: SUPER,
    });
    expect(worklist.statusCode).toBe(200);
    expect(Array.isArray(worklist.json())).toBe(true);
    await app.close();
  });
});

// ── escalations — routes 17-20 ───────────────────────────────────────────────────────────────────────

describe("M19-T07 §4.1 escalations (routes 17-20)", () => {
  it("escalates a call, lists the inbox, acknowledges and resolves the row", async () => {
    const { app } = makeServer();
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/triage-calls",
      headers: { ...SUPER, ...idemp() },
      payload: { providerEntityId: PE, inboundChannel: "phone", callerKind: "caregiver" },
    });
    const callId = opened.json().triageCallId as string;

    // 17 — escalate
    const escalated = await app.inject({
      method: "POST",
      url: `/api/v1/triage-calls/${callId}/escalations`,
      headers: { ...SUPER, ...idemp() },
      payload: {
        tier: "tier_1_rn_supervisor",
        reason: "Caller reports acute unrelieved pain requiring an urgent clinical response.",
      },
    });
    expect(escalated.statusCode).toBe(201);
    const escalationId = escalated.json().id as string;

    // 18 — the inbox
    const inbox = await app.inject({ method: "GET", url: "/api/v1/escalations", headers: SUPER });
    expect(inbox.statusCode).toBe(200);

    // 19 — acknowledge
    const ack = await app.inject({
      method: "POST",
      url: `/api/v1/escalations/${escalationId}/acknowledge`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {},
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().state).toBe("acknowledged");

    // 20 — resolve
    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/escalations/${escalationId}/resolve`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { resolution: "Reviewed with the on-call RN; medication guidance given and callback closed." },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().state).toBe("resolved");

    await app.close();
  });
});

// ── shifts + tenant policy — routes 21-28 ────────────────────────────────────────────────────────────

describe("M19-T07 §4.1 shifts + policy (routes 21-28)", () => {
  it("lists, creates, cancels, opens and closes shifts, then reads/patches the policy", async () => {
    const { app } = makeServer();

    // 22 — create three shifts (one each for cancel / open / close)
    const createShift = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/oncall/shifts",
        headers: { ...SUPER, ...idemp() },
        payload: {
          providerEntityId: PE,
          shiftStartsAt: "2026-08-01T20:00:00.000Z",
          shiftEndsAt: "2026-08-02T06:00:00.000Z",
          discipline: "clinical_rn",
        },
      });
    const forCancel = await createShift();
    const forOpen = await createShift();
    const forClose = await createShift();
    expect(forCancel.statusCode).toBe(201);
    expect(forOpen.statusCode).toBe(201);
    expect(forClose.statusCode).toBe(201);

    // 21 — list
    const list = await app.inject({ method: "GET", url: "/api/v1/oncall/shifts", headers: SUPER });
    expect(list.statusCode).toBe(200);

    // 23 — cancel
    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/v1/oncall/shifts/${forCancel.json().id}/cancel`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { reason: "Coverage swap arranged before the shift began." },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");

    // 24 — open
    const opened = await app.inject({
      method: "POST",
      url: `/api/v1/oncall/shifts/${forOpen.json().id}/open`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {},
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().status).toBe("active");

    // 25 — close
    const closed = await app.inject({
      method: "POST",
      url: `/api/v1/oncall/shifts/${forClose.json().id}/close`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("completed");

    // 26 — who is on call now
    const current = await app.inject({
      method: "GET",
      url: `/api/v1/oncall/current?providerEntityId=${PE}`,
      headers: SUPER,
    });
    expect(current.statusCode).toBe(200);

    // 27 — read policy
    const policy = await app.inject({
      method: "GET",
      url: `/api/v1/oncall/policy?providerEntityId=${PE}`,
      headers: SUPER,
    });
    expect(policy.statusCode).toBe(200);

    // 28 — patch policy (step-up)
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/oncall/policy?providerEntityId=${PE}`,
      headers: { ...SUPER, ...idemp(), ...IFM },
      payload: { aiProtocolSuggestionEnabled: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().aiProtocolSuggestionEnabled).toBe(true);

    await app.close();
  });
});

// ── protocol catalog + external vendor bindings — routes 29-37 ──────────────────────────────────────

describe("M19-T07 §4.1 protocol catalog + vendor bindings (routes 29-37)", () => {
  it("reads the catalog, authors a tenant protocol + question, then binds a vendor", async () => {
    const { app, backend } = makeServer();

    // 29 — list catalog
    const list = await app.inject({ method: "GET", url: "/api/v1/triage-protocols", headers: SUPER });
    expect(list.statusCode).toBe(200);

    // 30 — get one (the seeded platform-floor protocol)
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/triage-protocols/${backend.seedProtocolId}`,
      headers: SUPER,
    });
    expect(got.statusCode).toBe(200);

    // 31 — author a tenant protocol (step-up)
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/triage-protocols",
      headers: { ...SUPER, ...idemp() },
      payload: {
        key: "acute_dyspnea_test",
        chiefComplaintLabel: "Acute dyspnea",
        snomedCode: "267036007",
        disciplineRequired: "clinical_rn",
      },
    });
    expect(created.statusCode).toBe(201);
    const protocolId = created.json().id as string;

    // 32 — patch it (step-up)
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/triage-protocols/${protocolId}`,
      headers: { ...SUPER, ...idemp() },
      payload: { chiefComplaintLabel: "Acute dyspnea (updated)" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().chiefComplaintLabel).toBe("Acute dyspnea (updated)");

    // 33 — add a question (step-up)
    const withQuestion = await app.inject({
      method: "POST",
      url: `/api/v1/triage-protocols/${protocolId}/questions`,
      headers: { ...SUPER, ...idemp() },
      payload: { questionOrder: 1, prompt: "Is the patient in acute distress right now?", answerType: "boolean" },
    });
    expect(withQuestion.statusCode).toBe(201);
    const questions = withQuestion.json().questions as ReadonlyArray<{ id: string }>;
    const questionId = questions[questions.length - 1]?.id as string;

    // 34 — patch that question (step-up)
    const patchedQuestion = await app.inject({
      method: "PATCH",
      url: `/api/v1/triage-protocol-questions/${questionId}`,
      headers: { ...SUPER, ...idemp() },
      payload: { prompt: "Is the patient in acute respiratory distress right now?" },
    });
    expect(patchedQuestion.statusCode).toBe(200);

    // 35 — list vendor bindings (empty is fine — still a 200)
    const bindings = await app.inject({
      method: "GET",
      url: "/api/v1/oncall/external-vendors",
      headers: SUPER,
    });
    expect(bindings.statusCode).toBe(200);

    // 36 — create a vendor binding (step-up)
    const bound = await app.inject({
      method: "POST",
      url: "/api/v1/oncall/external-vendors",
      headers: { ...SUPER, ...idemp() },
      payload: {
        mdmVendorId: VENDOR_MDM,
        name: "Acme Triage Partners",
        adapterKey: "tenants/acme-triage",
        rnCoverageAttested: true,
        baaInEffect: true,
        defaultMinimizationPolicy: { profile: "hybrid_phi_min" },
      },
    });
    expect(bound.statusCode).toBe(201);
    const vendorId = bound.json().id as string;

    // 37 — patch the binding (BAA renewal; step-up)
    const rebound = await app.inject({
      method: "PATCH",
      url: `/api/v1/oncall/external-vendors/${vendorId}`,
      headers: { ...SUPER, ...idemp() },
      payload: { baaExpiresOn: "2027-01-01" },
    });
    expect(rebound.statusCode).toBe(200);
    expect(rebound.json().baaExpiresOn).toBe("2027-01-01");

    await app.close();
  });
});

// ── the M31 portal projection — route 38 ─────────────────────────────────────────────────────────────

describe("M19-T07 §4.1 route 38 — portal recent activity", () => {
  it("a consented caregiver-portal session reads the lay-language care log", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/triage/recent",
      headers: PORTAL,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);
    await app.close();
  });
});
