// apps/backend/src/modules/32-ai-platform/routes/m32-typebox.ts — M32-T07 (§4.1) request schemas.
//
// TypeBox request bodies, path params and list queries for the §4.1 AI Platform routes. Named
// `m32-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one — the M21-T01 gotcha, where even the WORD "alerts" in a comment tripped `arch:tables`.
//
// THE STRING-LITERAL UNIONS MIRROR the frozen `@wardenx/types` unions (`packages/types/src/ai-platform.ts`,
// M32-T01), which themselves mirror the `@wardenx/db` pgEnums and the §3 CHECK vocabularies. The DB wins
// on conflict. A wire enum published as `Type.String()` is a silent lie (the M30 lesson) — a bare string
// here becomes a 500 from the driver on a typo, at the moment an operator is trying to activate a kill
// switch, instead of a 422 naming the field.
//
// ── FOUR THINGS NOTHING HERE ACCEPTS, AND WHY EACH ABSENCE IS THE CONTROL ───────────────────────────
//
//   1. NO ORGANIZATION ID AND NO ACTING MEMBERSHIP. Both are server-side (./actor.ts). The ONE thing a
//      caller may say about scope is R7/R8's `scope: 'platform' | 'tenant'`, which resolves through
//      `killSwitchScopeOf` to either NULL or the SESSION's org — never to a supplied id. §8.3's spoofing
//      controls ARE those absences.
//   2. NO PROMPT, RESPONSE OR CHART-CONTEXT PAYLOAD. §3.6 makes all three DEK-enveloped cipher columns
//      written by the invocation pipeline, and §4.1's "internal-only" note keeps `aiSdk.invoke` off the
//      REST surface entirely. A body that could carry one would be a route that writes a disclosure with
//      no ledger row.
//   3. NO `status` ON AN EVALUATION RUN CREATE. §3.2.11 inserts every run `pending`; a body that could
//      set `passed` would let an operator mint the D10 evidence a stage-3 transition then cites.
//   4. NO `resolvedContentHash` ON A PROMPT ACTIVATION. The service READS the artifact and computes it
//      (prompts/service.ts). A caller supplying both a path and its digest is asserting they agree, and
//      verifying that assertion against the bytes is the only thing that makes the pin mean anything.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}

/** Validate a request BODY at the route boundary. Deliberately does NOT run `Value.Convert`: a JSON body
 *  already carries real types, and coercing would silently repair genuinely wrong input. */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/** Validate a request QUERY, converting the declared scalars first (`?limit=25` arrives as "25"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const UuidOrNull = Type.Union([Type.String({ format: "uuid" }), Type.Null()]);
const Instant = Type.String({ format: "date-time" });
const InstantOpt = Type.Optional(Type.String({ format: "date-time" }));
/** Operator prose that lands in a governance ledger. Never PHI; the cap is the column's practical max. */
const Prose = (min: number, max: number) => Type.String({ minLength: min, maxLength: max });
const ProseOrNull = (max: number) => Type.Union([Type.String({ maxLength: max }), Type.Null()]);
const Lit = <T extends string>(...members: readonly T[]) =>
  Type.Union(members.map((m) => Type.Literal(m)));

// ── §3.1 vocabulary mirrors (`packages/types/src/ai-platform.ts` is the source of truth) ─────────────

/** `ai_capability_lifecycle_state`. */
export const CapabilityLifecycleState = Lit(
  "PROPOSED",
  "DESIGN_REVIEW",
  "EVALUATION",
  "PILOT",
  "APPROVED",
  "MONITORING",
  "DEPRECATED",
  "RETIRED",
);

/** `ai_capability_risk_tier`. */
export const CapabilityRiskTier = Lit("high", "medium", "low");

/** `ai_capability_owning_role` — who may SIGN a lifecycle edge (§2.2). */
export const CapabilityOwningRole = Lit(
  "ai_safety_owner",
  "clinical_reviewer",
  "ai_engineer",
  "privacy_officer",
);

/** `ai_lifecycle_approval_kind` — the STAGE a ledger entry records, not its outcome. */
export const LifecycleApprovalKind = Lit(
  "stage_1_proposal",
  "stage_2_design_review",
  "stage_3_evaluation",
  "stage_4_pilot",
  "stage_5_ga",
  "reapproval",
  "deprecation",
  "retirement",
  "incident_demotion",
);

/** `ai_routing_mode` — what a TENANT may choose (§5.3). Narrower than `ai_routing_preference`. */
export const RoutingMode = Lit("default", "prefer_local", "local_only");

/** `ai_routing_preference` — M2's `TenantConfiguration` value the `default` mode inherits. */
export const RoutingPreference = Lit("prefer_cloud", "prefer_local", "cloud_only", "local_only");

/** `ai_routing_override_reason` (§3.2.13). */
export const RoutingOverrideReason = Lit(
  "tenant_sovereignty",
  "tenant_cost",
  "tenant_pilot",
  "fallback_after_outage",
);

/** `ai_kill_switch_reason` (D8). */
export const KillSwitchReason = Lit(
  "sev1_hallucination",
  "sev2_hallucination",
  "cost_cap_reached",
  "vendor_outage_exceeded_sla",
  "prompt_injection_detected",
  "manual_safety_pause",
  "misuse_detected",
  "bias_drift_severe",
  "lifecycle_demotion",
);

/**
 * The kill-switch actor kinds a HUMAN route may claim.
 *
 * The four `automated_*` kinds are DELIBERATELY absent: §3.2.12 allows them a NULL membership id, and a
 * body that could name one would let a human file a stop as though a monitor had raised it — erasing the
 * accountability §8.3 exists to keep. The §4.8 workers write those kinds, and they do not come through
 * this file.
 */
export const KillSwitchHumanActorKind = Lit("ai_safety_owner", "incident_commander");

/** R7/R8's scope selector — resolved through `killSwitchScopeOf` (./actor.ts), never to a supplied org. */
export const KillSwitchScope = Lit("platform", "tenant");

/** `ai_hallucination_severity` — `critical` is D16's SEV-1 trigger. */
export const HallucinationSeverity = Lit("critical", "high", "medium", "low");

/** `ai_hallucination_kind`. */
export const HallucinationKind = Lit(
  "fabricated_medication",
  "misattributed_symptom",
  "fake_diagnosis",
  "fabricated_quote",
  "misquoted_patient",
  "wrong_dose",
  "fake_clinical_recommendation",
  "other",
);

/** `ai_hallucination_triage_status` (D9's queue). */
export const HallucinationTriageStatus = Lit(
  "open",
  "investigating",
  "root_cause_identified",
  "mitigated",
  "closed",
  "escalated_to_clinical_safety",
);

/** `ai_hallucination_triage_disposition`. */
export const HallucinationTriageDisposition = Lit(
  "prompt_iteration_required",
  "model_rollback_required",
  "edge_case_acknowledged",
  "false_alarm",
);

/** `ai_evaluation_run_stage` — which governance gate the run is evidence for (D10). */
export const EvaluationRunStage = Lit(
  "stage_3_evaluation",
  "stage_4_pilot",
  "reapproval",
  "drift_response",
  "post_incident",
);

/** `ai_evaluation_run_status`. */
export const EvaluationRunStatus = Lit("pending", "in_progress", "passed", "failed", "aborted");

/** `ai_invocation_status`. */
export const InvocationStatus = Lit(
  "completed",
  "failed",
  "timed_out",
  "killed",
  "capability_unavailable",
);

// ── path params ─────────────────────────────────────────────────────────────────────────────────────

export const CapabilityIdParams = Type.Object({ capabilityId: Uuid });
export const InvocationIdParams = Type.Object({ invocationId: Uuid });
export const ReportIdParams = Type.Object({ reportId: Uuid });
export const RunIdParams = Type.Object({ runId: Uuid });
/** R29/R30 key a template by the CAPABILITY KEY, not by an id — §4.5's cache is keyed the same way. */
export const CapabilityKeyParams = Type.Object({
  capabilityKey: Type.String({ minLength: 1, maxLength: 120 }),
});

// ── R1 — register a capability (§3.2.1) ─────────────────────────────────────────────────────────────

export const RegisterCapabilityBody = Type.Object({
  capabilityKey: Type.String({ minLength: 1, maxLength: 120 }),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  description: Prose(1, 4000),
  riskTier: CapabilityRiskTier,
  defaultBackendKey: Type.String({ minLength: 1, maxLength: 120 }),
  allowedBackendKeys: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1 }),
  fallbackChainKeys: Type.Array(Type.String({ minLength: 1, maxLength: 120 })),
  tenantOverrideAllowed: Type.Boolean(),
  tenantOptInRequired: Type.Boolean(),
  clinicianOptOutSupported: Type.Boolean(),
  clinicalReviewRequired: Type.Boolean(),
  /** §3.2.1's `owning_role` — who OWNS the capability, distinct from who signs this registration. */
  owningRole: CapabilityOwningRole,
  /** The SIGNER's role for the registration ledger entry — checked against §2.2's edge, not trusted. */
  actorRole: CapabilityOwningRole,
  rationaleText: Prose(1, 4000),
  /** PROPOSED serves nothing, so §3.2.1's template CHECK does not bind yet — hence nullable. */
  currentPromptTemplateKey: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
  stageArtifacts: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// ── R4 — walk a §2.2 edge ───────────────────────────────────────────────────────────────────────────

export const TransitionCapabilityBody = Type.Object({
  toState: CapabilityLifecycleState,
  approvalKind: LifecycleApprovalKind,
  actorRole: CapabilityOwningRole,
  rationaleText: Prose(1, 4000),
  /** D10 evidence. `null` where the edge does not require it — the service checks WHICH edges do. */
  linkedEvaluationRunId: UuidOrNull,
  reason: Type.Optional(Type.String({ maxLength: 400 })),
  stageArtifacts: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// ── R5 — publish a calibration (§3.2.3) ─────────────────────────────────────────────────────────────

export const PublishCalibrationBody = Type.Object({
  backendKey: Type.String({ minLength: 1, maxLength: 120 }),
  /** Typed `PerCapabilityThresholds` — the SHAPE is the capability's own (§2.5), so this is opaque. */
  thresholds: Type.Record(Type.String(), Type.Unknown()),
  baselineMetrics: Type.Record(Type.String(), Type.Unknown()),
  baselineSetAt: Instant,
  baselineEvaluationRunId: UuidOrNull,
  /** Required iff there is an incumbent to supersede — the RULE decides; this only carries it. */
  supersededReason: ProseOrNull(1000),
});

// ── R7 / R8 — the kill switch (§3.2.12, D8) ─────────────────────────────────────────────────────────

export const ActivateKillSwitchBody = Type.Object({
  scope: KillSwitchScope,
  reason: KillSwitchReason,
  actorKind: KillSwitchHumanActorKind,
  /** The operator's own words. Required for a human actor (§3.2.12) — the rule enforces the minimum. */
  activationMessage: Prose(1, 2000),
});

export const DeactivateKillSwitchBody = Type.Object({
  scope: KillSwitchScope,
  actorKind: KillSwitchHumanActorKind,
  /** §4.1 R8: "requires resolution narrative". Not optional and not nullable. */
  resolutionNarrative: Prose(1, 2000),
});

// ── R10 / R11 — tenant opt-in (§5.3, W4) ────────────────────────────────────────────────────────────

/**
 * §5.3.1's four acknowledgments, as EVIDENCE rather than as flags.
 *
 * Each reference is nullable because W4.1 VALIDATES them upstream (the `AiOptInEvidenceResolver`), and a
 * required field would turn "the admin left the BAA reference blank" into a 422 that says nothing about
 * why the opt-in is refused. The refusal that matters — "this BAA does not resolve" — comes from the
 * evidence resolver and names the specific gate.
 */
export const OptInAcknowledgmentsBody = Type.Object({
  baaReference: ProseOrNull(200),
  zdrContractReference: ProseOrNull(200),
  clinicalReviewerMembershipId: UuidOrNull,
  clinicalReviewerAttestationText: ProseOrNull(4000),
  disclosureAccountingAcknowledged: Type.Boolean(),
  /** §10.10 — the trade-off body AS SHOWN, frozen. A boolean here would record that a checkbox was
   *  ticked; the text records what the admin was actually shown when they ticked it. */
  calibrationTradeOffAcknowledged: ProseOrNull(4000),
});

export const RecordTenantOptInBody = Type.Object({
  capabilityId: Uuid,
  routingMode: RoutingMode,
  pilotEnrollment: Type.Boolean(),
  acknowledgments: OptInAcknowledgmentsBody,
  /** M2's `TenantConfiguration.ai_routing_preference` — the `default` routing mode inherits it. */
  orgRoutingPreference: RoutingPreference,
});

export const RevokeTenantOptInBody = Type.Object({
  /** §10.6: a reason is ACCEPTED, never required — a tenant must be able to walk out without explaining. */
  reason: Type.Optional(ProseOrNull(1000)),
  /** `pause` keeps the acknowledgment evidence; `withdraw` does not. Defaulted to `withdraw` at the
   *  route, because R11's own wording is "revokes" and a DELETE that silently paused would leave a
   *  tenant believing they had stopped. */
  mode: Type.Optional(Lit("pause", "withdraw")),
});

// ── R13 — clinician opt-out (§5.4) ──────────────────────────────────────────────────────────────────

export const RecordClinicianOptOutBody = Type.Object({
  capabilityId: Uuid,
  reason: Type.Optional(ProseOrNull(1000)),
});

// ── R16 — the disclosure-ledger search ──────────────────────────────────────────────────────────────

export const InvocationSearchQuery = Type.Object({
  capabilityId: Type.Optional(Uuid),
  capabilityKey: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  backendKey: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  status: Type.Optional(InvocationStatus),
  patientId: Type.Optional(Uuid),
  from: InstantOpt,
  to: InstantOpt,
  /** Narrow to rows that reached a `kind='cloud'` backend — the §164.528 disclosure subset. */
  disclosuresOnly: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

// ── R18 / R20 — hallucination report and triage (§3.2.10, D9) ───────────────────────────────────────

export const FileHallucinationReportBody = Type.Object({
  capabilityId: Uuid,
  /** `null` when the clinician cannot name the call — §3.2.10: the reports that matter most are often
   *  the ones where provenance is already broken. */
  invocationId: UuidOrNull,
  severity: HallucinationSeverity,
  hallucinationKind: HallucinationKind,
  /**
   * §5.5's narrative. DENYLISTED and DEK-enveloped before it reaches the store (§3.4/§3.6), which is why
   * the widget's placeholder tells the clinician not to include PHI: the linked invocation already
   * carries the chart context, and a second copy in a report body is a second thing to erase.
   */
  reporterNarrative: Prose(1, 1000),
  providerEntityId: Type.Optional(Uuid),
});

export const TriageHallucinationReportBody = Type.Object({
  toStatus: HallucinationTriageStatus,
  /** Required by every edge that claims the report was understood; `null` on `investigating` and on an
   *  escalation, where the point is precisely that M32 has NOT reached a disposition. */
  disposition: Type.Union([HallucinationTriageDisposition, Type.Null()]),
  /** A pointer at the mitigation (a PR, an incident id). Never PHI. */
  mitigationActionRef: ProseOrNull(400),
  /** W5.5 — the AI Safety Owner may CONFIRM or correct the reporter's severity. */
  severity: HallucinationSeverity,
});

export const HallucinationQueueQuery = Type.Object({
  capabilityId: Type.Optional(Uuid),
  status: Type.Optional(HallucinationTriageStatus),
});

// ── R21 / R22 — token ledger + forecast ─────────────────────────────────────────────────────────────

export const TokenLedgerQuery = Type.Object({
  capabilityId: Type.Optional(Uuid),
  from: InstantOpt,
  to: InstantOpt,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const TokenForecastQuery = Type.Object({
  capabilityId: Type.Optional(Uuid),
});

// ── R23 / R24 — routing overrides (§3.2.13, W8) ─────────────────────────────────────────────────────

export const SetRoutingOverrideBody = Type.Object({
  capabilityId: Uuid,
  backendKeyPreference: Type.String({ minLength: 1, maxLength: 120 }),
  overrideReason: RoutingOverrideReason,
  effectiveAt: InstantOpt,
  /** `null` = open-ended. §3.2.13's EXCLUDE governs which rows may COEXIST, not which one is current. */
  expiresAt: Type.Optional(Type.Union([Instant, Type.Null()])),
});

// ── R26 / R27 — evaluation runs (§3.2.11, D10) ──────────────────────────────────────────────────────

export const QueueEvaluationRunBody = Type.Object({
  capabilityId: Uuid,
  backendId: Uuid,
  datasetVersionRef: Type.String({ minLength: 1, maxLength: 200 }),
  mlflowRunId: Type.String({ minLength: 1, maxLength: 200 }),
  stage: EvaluationRunStage,
  summaryMetrics: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const EvaluationRunQuery = Type.Object({
  capabilityId: Type.Optional(Uuid),
  status: Type.Optional(EvaluationRunStatus),
});

// ── R30 — activate a prompt template (§3.2.5 / §4.5) ────────────────────────────────────────────────

export const ActivatePromptTemplateBody = Type.Object({
  templateKey: Type.String({ minLength: 1, maxLength: 200 }),
  /** §3.2.5's version is an INTEGER, and R30 is insert-and-deprecate rather than a status flip. */
  version: Type.Integer({ minimum: 1 }),
  templateFilesystemRef: Type.String({ minLength: 1, maxLength: 500 }),
  /** The caller's CLAIM about the artifact's digest — verified against the bytes (absence note 4). */
  templateContentHash: Type.String({ minLength: 16, maxLength: 128 }),
  compatibleBackendKeys: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1 }),
  inputSchemaRef: Type.String({ minLength: 1, maxLength: 300 }),
  outputSchemaRef: Type.String({ minLength: 1, maxLength: 300 }),
  /** D18's two prefixes — what a consumer's boot validator matches its prohibited zone against. */
  outputEntityTargetPrefix: Type.String({ minLength: 1, maxLength: 120 }),
  outputTypePrefix: Type.String({ minLength: 1, maxLength: 120 }),
  approvedByMembershipId: Uuid,
  clinicalReviewerAttestation: Prose(1, 4000),
});

// ── R31 — drift ─────────────────────────────────────────────────────────────────────────────────────

export const DriftQuery = Type.Object({
  /** §4.1's "last N hours". Bounded at 30 days: §4.8 sweeps every 15 minutes, so a wider window is a
   *  report, not a dashboard, and R27 already answers it by stage. */
  withinHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
});

// ── list queries ────────────────────────────────────────────────────────────────────────────────────

export const CapabilityListQuery = Type.Object({
  lifecycleState: Type.Optional(CapabilityLifecycleState),
  riskTier: Type.Optional(CapabilityRiskTier),
  /** §2.4's Phase-1 "hot" set — the capabilities the wave actually stands up. */
  hotPhase1: Type.Optional(Type.Boolean()),
});

export type RegisterCapabilityInput = Static<typeof RegisterCapabilityBody>;
export type TransitionCapabilityInput = Static<typeof TransitionCapabilityBody>;
export type PublishCalibrationInput = Static<typeof PublishCalibrationBody>;
export type ActivateKillSwitchInput = Static<typeof ActivateKillSwitchBody>;
export type DeactivateKillSwitchInput = Static<typeof DeactivateKillSwitchBody>;
export type RecordTenantOptInInput = Static<typeof RecordTenantOptInBody>;
export type RevokeTenantOptInInput = Static<typeof RevokeTenantOptInBody>;
export type RecordClinicianOptOutInput = Static<typeof RecordClinicianOptOutBody>;
export type FileHallucinationReportInput = Static<typeof FileHallucinationReportBody>;
export type TriageHallucinationReportInput = Static<typeof TriageHallucinationReportBody>;
export type SetRoutingOverrideInput = Static<typeof SetRoutingOverrideBody>;
export type QueueEvaluationRunInput = Static<typeof QueueEvaluationRunBody>;
export type ActivatePromptTemplateInput = Static<typeof ActivatePromptTemplateBody>;
