// apps/backend/src/modules/27-cost-report/consumers — the §4.10 UPSTREAM-event handlers (PURE, port-
// injected). Mirrors the M30 `@chartwarden/quality` consumers/handlers.ts precedent: one pure handler per
// subscribed topic (`./subscription-map.ts`), each projecting the structurally-minimal upstream event into
// its M27 effect and fanning it out through the injected {@link M27ConsumerPorts}.
//
// PURITY / BOUNDARIES (RULE 1 & 2): NO DB, NO BullMQ, NO Fastify, NO direct M22/M25/M40 import, NO
// `getSeam` at import — the upstream event STRING + its payload SHAPE is the entire contract. The effect
// ports are INJECTED; at the composition root the integrator binds them to the real Drizzle repositories
// (ecr_submission back-ref writer, the validation-rule library reader + draft-suggestion writer, the
// cost-report repo + transactional outbox), and any unlanded port stays a LAZY fail-closed thunk so a throw
// happens only when a JOB RUNS, never at port-bundle construction (RULE 2 / the M34 eager-bind gotcha).
// These handlers are NOT boot-wired to a running subscriber (RULE 3(d)) — they ship pure + the subscription
// map; the live inbound dispatcher is a later platform phase.
//
// M27 carries NO PHI (D18) — every payload is IDs + aggregate financial facts only. Money is integer cents.
import {
  type CostReportState,
  type CostReportTransitionEvent,
  type RuleDef,
  applyTransition,
  canTransition,
  suggestRuleFromRejection,
} from "@chartwarden/cost-report";
import {
  type M27ArtifactKind,
  type M27SubscriptionEffect,
  effectsForTopic,
} from "./subscription-map";

// ── effect request shapes (what a handler hands its port) ───────────────────────────────────────────────

/** The `ecr_submission` column an artifact back-reference lands on, resolved purely from the artifact kind. */
export type EcrSubmissionBackRefColumn =
  | "ecr_file_document_id"
  | "pi_file_document_id"
  | "supporting_documents_document_ids";

/**
 * The structurally-resolved target for an M22-returned document id: the `ecr_submission` column and, for
 * the supporting-docs bundle, whether the write APPENDS to the jsonb array (vs. setting a scalar column).
 */
export interface ArtifactBackRefTarget {
  readonly artifactKind: M27ArtifactKind;
  readonly column: EcrSubmissionBackRefColumn;
  /** True only for `supporting_doc`: append the id to `supporting_documents_document_ids[]` (idempotently). */
  readonly append: boolean;
}

/** The back-reference write the {@link M27ConsumerPorts.recordArtifactBackReference} port applies. */
export interface ArtifactBackReferenceWrite {
  readonly submissionId: string;
  readonly documentId: string;
  readonly target: ArtifactBackRefTarget;
  /** The originating `m22.document.rendered` outbox-event id (→ §2.6 idempotency on the back-ref write). */
  readonly triggeringEventId: string;
}

/** The draft-suggestion rule write the {@link M27ConsumerPorts.createDraftSuggestionRule} port persists. */
export interface DraftSuggestionWrite {
  /** The `draft_suggestion` `RuleDef` derived purely from the rejection code (anonymized; platform-owned). */
  readonly rule: RuleDef;
  readonly sourceRejectionCode: string;
  /** The cost report the denial is attributed to (resolved by the binding); platform suggestion provenance. */
  readonly suggestedFromCostReportId: string;
  readonly triggeringEventId: string;
}

/** One still-open cost report the offboard handler may close (resolved by the repo port). */
export interface OpenCostReportRef {
  readonly costReportId: string;
  readonly state: CostReportState;
}

// ── the injected effect ports (bound to Drizzle repositories + the outbox at the composition root) ───────

/**
 * The effect ports the handlers fan out through (INJECTED at boot, RULE 2). Each is `async` so the binding
 * can wrap the write in `withOrgContext` + the transactional outbox; the pure handlers never touch the DB.
 * An unlanded port binds to a LAZY fail-closed thunk (throws only when the handler runs), never a no-op.
 */
export interface M27ConsumerPorts {
  /** Record an M22-returned `document_id` as the ECR / PI / supporting-doc back-ref on `ecr_submission`. */
  readonly recordArtifactBackReference: (write: ArtifactBackReferenceWrite) => Promise<void>;
  /**
   * True iff the rule library already COVERS this MAC rejection code (an active rule whose predicate, or a
   * prior draft suggestion of the same identity, addresses it). When true the denial handler does NOT
   * create a duplicate suggestion. Fail-closed: the binding returns `true` on its own ambiguity is wrong —
   * it must return a definite coverage answer; an unbound port throws (RULE 2).
   */
  readonly isRejectionCodeCovered: (input: {
    readonly rejectionCode: string;
    readonly suggestedRuleCode: string;
  }) => Promise<boolean>;
  /** Persist the anonymized `draft_suggestion` rule for platform-team review; returns its new id. */
  readonly createDraftSuggestionRule: (
    write: DraftSuggestionWrite,
  ) => Promise<{ readonly draftRuleId: string }>;
  /** Every still-open cost report for the offboarded ProviderEntity (the repo applies RLS + state filter). */
  readonly listOpenCostReportsForProvider: (input: {
    readonly organizationId: string;
    readonly providerEntityId: string;
  }) => Promise<readonly OpenCostReportRef[]>;
  /** Persist the lifecycle transition of one cost report to its new state (here always terminal `closed`). */
  readonly closeCostReport: (input: {
    readonly costReportId: string;
    readonly fromState: CostReportState;
    readonly toState: CostReportState;
  }) => Promise<void>;
  /** The transactional-outbox emit ports (one typed method per `m27.*` event the handlers raise). */
  readonly outbox: M27ConsumerOutbox;
}

/** The typed transactional-outbox emit surface the handlers raise their `m27.*` events through. */
export interface M27ConsumerOutbox {
  /** `m27.artifact.stored_back_reference` — M22 stored an artifact; M27 recorded its document id (internal). */
  readonly emitArtifactStoredBackReference: (payload: {
    readonly submissionId: string;
    readonly artifactKind: M27ArtifactKind;
    readonly documentId: string;
  }) => Promise<void>;
  /** `m27.validation.rule_suggestion_created` — an uncovered MAC rejection produced a draft suggestion. */
  readonly emitRuleSuggestionCreated: (payload: {
    readonly draftRuleId: string;
    readonly sourceRejectionCode: string;
    readonly suggestedFromCostReportId: string;
    readonly anonymized: boolean;
  }) => Promise<void>;
  /** `m27.cost_report.closed` — a cost report was closed on ProviderEntity offboarding. */
  readonly emitCostReportClosed: (payload: {
    readonly costReportId: string;
    readonly providerEntityId: string;
  }) => Promise<void>;
}

// ── pure projection helpers ──────────────────────────────────────────────────────────────────────────────

/**
 * Resolve, PURELY, which `ecr_submission` column an artifact kind back-references — the structural spine of
 * the handshake (§4.4): `ecr` → the scalar ECR file column, `pi` → the scalar Print-Image column,
 * `supporting_doc` → an APPEND onto the `supporting_documents_document_ids` jsonb array. Total over the
 * three M27 artifact kinds.
 */
export function resolveArtifactBackRefTarget(artifactKind: M27ArtifactKind): ArtifactBackRefTarget {
  switch (artifactKind) {
    case "ecr":
      return { artifactKind, column: "ecr_file_document_id", append: false };
    case "pi":
      return { artifactKind, column: "pi_file_document_id", append: false };
    case "supporting_doc":
      return { artifactKind, column: "supporting_documents_document_ids", append: true };
  }
}

/** The §4.10 effect kinds present in the subscription map for a topic (the dispatcher's routing hint). */
export function effectKindsForTopic(topic: string): readonly M27SubscriptionEffect["kind"][] {
  return effectsForTopic(topic).map((effect) => effect.kind);
}

// ── per-topic event payload shapes (the structurally-minimal slice M27 reads) ────────────────────────────

/**
 * The minimal `m22.document.rendered` payload M27 reads (§4.4). M22 fans this event out to every requesting
 * module; M27 acts ONLY when the rendered document back-references an M27 artifact render-request — keyed by
 * `sourceModule === 'm27'` AND an aggregate type that is one of M27's three. Everything else is a deliberate no-op
 * (fail-closed: M27 never writes a back-ref for a document it did not request).
 */
export interface DocumentRenderedEvent {
  readonly eventId: string;
  /** The requesting module the M22 render handshake echoes back (`'m27'` for an M27 artifact). */
  readonly sourceModule: string;
  /**
   * M22's `document.aggregate_type` — the WIRE-VISIBLE artifact discriminator. The published
   * `m22.document.rendered` payload carries no `artifactKind`: M27 fans three artifacts out under ONE
   * request event name, and M22 routes each to its own template + aggregate type, so the aggregate type
   * is what comes back. It is also the shared vocabulary rather than M22's private routing map — the
   * three values are `DocumentAggregateType` members in the leaf `packages/types`, which is why
   * {@link artifactKindForAggregateType} is a read of a published contract and not a copy of a list.
   */
  readonly aggregateType: string;
  /** The `ecr_submission` this artifact belongs to — M22 echoes back the aggregate id M27's request set. */
  readonly aggregateId: string;
  /** The MinIO-stored document id M22 minted and returned. */
  readonly documentId: string;
}

/**
 * The minimal `m25.denial.opened` payload M27 reads (§82 / D20). M25 emits this on a claim denial; M27
 * subscribes to mine the MAC rejection code for the auto-rule-suggestion workflow. `suggestedFromCostReportId`
 * is the cost report the binding attributes the denial to (e.g. the most-recent submitted report for the
 * denial's ProviderEntity) — provenance only; the suggestion itself is anonymized (no tenant identifier).
 */
export interface DenialOpenedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  /** The MAC / payer rejection code the rule library is matched against. */
  readonly mcrefRejectionCode: string;
  /** The cost report the denial is attributed to (binding-resolved). */
  readonly suggestedFromCostReportId: string;
}

/**
 * The minimal M40 `provider_entity_offboarded` payload M27 reads (§2.2). On offboard, M27 closes every
 * still-open (offboard-eligible) cost report for the ProviderEntity.
 */
export interface ProviderEntityOffboardedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
}

// ── the structured per-topic consume report (for the §4.10 fan-out test) ─────────────────────────────────

/** What handling one upstream event did — the effects applied + the concrete ids touched. */
export interface UpstreamConsumeReport {
  readonly eventName: string;
  /** The effect kinds the topic projected to (in order). */
  readonly effects: readonly M27SubscriptionEffect["kind"][];
  /** The cost-report / submission / rule ids the handler acted on (for the fan-out assertion). */
  readonly actedOnIds: readonly string[];
}

// ── per-topic handlers (PURE projection + port fan-out) ──────────────────────────────────────────────────

/**
 * M22 `document.aggregate_type` → the M27 artifact kind it materializes, or `null` when the rendered
 * document is not one of M27's three. Pure and total over arbitrary input (fail-closed: an unrecognized
 * aggregate type is another module's document, never a guess).
 */
const M27_ARTIFACT_KIND_BY_AGGREGATE_TYPE: Readonly<Record<string, M27ArtifactKind>> =
  Object.freeze({
    cost_report_ecr: "ecr",
    cost_report_pi: "pi",
    cost_report_supporting_doc: "supporting_doc",
  });

export function artifactKindForAggregateType(aggregateType: string): M27ArtifactKind | null {
  return M27_ARTIFACT_KIND_BY_AGGREGATE_TYPE[aggregateType] ?? null;
}

/**
 * `m22.document.rendered` → record the ECR / PI / supporting-doc back-reference onto `ecr_submission` and
 * emit `m27.artifact.stored_back_reference` (§4.4 / §4.10). FAIL-CLOSED: the handler acts only when the
 * rendered document is an M27 artifact (`sourceModule === 'm27'` AND a recognized `aggregateType`) — a
 * document another module requested is a deliberate no-op, never a stray back-ref write.
 */
export async function handleDocumentRendered(
  event: DocumentRenderedEvent,
  ports: M27ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const empty: UpstreamConsumeReport = {
    eventName: "m22.document.rendered",
    effects: [],
    actedOnIds: [],
  };
  if (event.sourceModule !== "m27") return empty;
  const artifactKind = artifactKindForAggregateType(event.aggregateType);
  if (artifactKind === null) return empty;

  const target = resolveArtifactBackRefTarget(artifactKind);
  await ports.recordArtifactBackReference({
    submissionId: event.aggregateId,
    documentId: event.documentId,
    target,
    triggeringEventId: event.eventId,
  });
  await ports.outbox.emitArtifactStoredBackReference({
    submissionId: event.aggregateId,
    artifactKind,
    documentId: event.documentId,
  });
  return {
    eventName: "m22.document.rendered",
    effects: ["artifact_back_reference"],
    actedOnIds: [event.aggregateId],
  };
}

/**
 * `m25.denial.opened` → match the MAC rejection code against the rule library and, if UNCOVERED, create a
 * `draft_suggestion` rule (via the pure {@link suggestRuleFromRejection}) + emit
 * `m27.validation.rule_suggestion_created` (§82 / D20 / §4.10). FAIL-CLOSED on every off-path:
 *  • a blank/whitespace rejection code yields no suggestion (`suggestRuleFromRejection` → `null`) → no-op;
 *  • a code the library already covers → no duplicate suggestion (no-op);
 *  • only a genuinely uncovered code produces the anonymized draft + the emit.
 */
export async function handleDenialOpened(
  event: DenialOpenedEvent,
  ports: M27ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const noop: UpstreamConsumeReport = {
    eventName: "m25.denial.opened",
    effects: [],
    actedOnIds: [],
  };

  // Pure derivation first: a blank code is nothing to suggest (fail-closed; never fabricates a rule).
  const rule = suggestRuleFromRejection(event.mcrefRejectionCode);
  if (rule === null) return noop;

  const covered = await ports.isRejectionCodeCovered({
    rejectionCode: event.mcrefRejectionCode,
    suggestedRuleCode: rule.ruleCode,
  });
  if (covered) return noop;

  const { draftRuleId } = await ports.createDraftSuggestionRule({
    rule,
    sourceRejectionCode: event.mcrefRejectionCode.trim(),
    suggestedFromCostReportId: event.suggestedFromCostReportId,
    triggeringEventId: event.eventId,
  });
  await ports.outbox.emitRuleSuggestionCreated({
    draftRuleId,
    sourceRejectionCode: event.mcrefRejectionCode.trim(),
    suggestedFromCostReportId: event.suggestedFromCostReportId,
    anonymized: true,
  });
  return {
    eventName: "m25.denial.opened",
    effects: ["rule_suggestion"],
    actedOnIds: [draftRuleId],
  };
}

/** The §2.2 lifecycle event a ProviderEntity offboard fires against an open cost report. */
const OFFBOARD_EVENT: CostReportTransitionEvent = "offboard";

/**
 * `provider_entity_offboarded` (M40) → close every still-open (offboard-eligible) cost report for the
 * ProviderEntity, each transitioning to terminal `closed` and emitting `m27.cost_report.closed` (§2.2 /
 * §4.10). FAIL-CLOSED: a report whose state has NO legal `offboard` edge (e.g. `submitted` / `accepted` —
 * those are the M34 offboarding-gate cases, never auto-closed) is SKIPPED via the pure `canTransition`
 * guard; only the offboard-eligible states (`draft` / `populating` / `ready_for_review`) are closed.
 */
export async function handleProviderEntityOffboarded(
  event: ProviderEntityOffboardedEvent,
  ports: M27ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const open = await ports.listOpenCostReportsForProvider({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
  });

  const closedIds: string[] = [];
  for (const report of open) {
    // Pure guard: skip any report whose state cannot legally `offboard` (fail-closed, never throws here).
    if (!canTransition(report.state, OFFBOARD_EVENT)) continue;
    const toState = applyTransition(report.state, OFFBOARD_EVENT); // → "closed"
    await ports.closeCostReport({
      costReportId: report.costReportId,
      fromState: report.state,
      toState,
    });
    await ports.outbox.emitCostReportClosed({
      costReportId: report.costReportId,
      providerEntityId: event.providerEntityId,
    });
    closedIds.push(report.costReportId);
  }

  return {
    eventName: "provider_entity_offboarded",
    effects: closedIds.length > 0 ? ["close_cost_reports"] : [],
    actedOnIds: closedIds,
  };
}
