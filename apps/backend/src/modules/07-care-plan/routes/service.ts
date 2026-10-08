// apps/backend/src/modules/07-care-plan/routes/service.ts — M7-T05 the CarePlanRouteService + an
// in-memory slice (§4.1, §7.7). The route handlers compose over this; production injects a Drizzle-
// backed service (writes under `withOrgContext` so RLS scopes by `app.org_id`). The slice also exposes
// a CarePlanAbacResolver over the SAME dataset so M7's §4 ABAC predicates resolve a plan's patient
// without a cross-module schema import (the authoring predicates land in M7-T06). Pure-ish: no clock
// except the injected `now()` so version/sign timestamps are deterministic in tests.
//
// §7.7 optimistic concurrency: every mutable element row (problem/goal/intervention) carries a
// monotonic `version`; a PATCH that arrives with a stale `If-Match` version is refused with 412
// STALE_VERSION via the pure `checkOptimisticConcurrency` guard (lifecycle/validation.ts). The version
// sign-off path reuses the pure §2.3/D5 quorum core (`decideRecordSignature` / `resolveRequiredSignerSet`).
import type {
  CarePlanSignerRole,
  CarePlanVersionKind,
  GoalSource,
  GoalStatus,
  InterventionDiscipline,
  ProblemKind,
  ProblemSource,
  RequiredSignerSet,
} from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import {
  type AuthoringDisciplineScope,
  assertDisciplineScope,
  filterAnchoredToVisible,
  filterVisibleProblems,
  redactedSudProblemIds,
} from "../authoring/index";
import { CarePlanStateError } from "../lifecycle/errors";
import {
  assertActorHoldsSignerRole,
  assertMembershipNotAlreadySigned,
  decideRecordSignature,
  resolveRequiredSignerSet,
  resolveTightenedSignerSet,
} from "../lifecycle/required-signer-set";
import {
  checkGoalReferencesProblem,
  checkInterventionFrequency,
  checkInterventionReferencesProblem,
  checkOptimisticConcurrency,
  checkPatientStatedGoalVerbatim,
} from "../lifecycle/validation";

/** The per-caller §7.6 consent context a read carries (decided upstream by `sud_disclosure_allowed`). */
export interface CarePlanViewer {
  /** Whether this caller may see SUD-flagged problems (false ⇒ they are omitted). */
  readonly sudDisclosureAllowed: boolean;
}

// ── record shapes (in-memory; the Drizzle adapter projects rows to the SAME DTOs) ───────────────────

interface CarePlanRecord {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  status: "draft" | "active" | "discharged";
  activeVersionId: string | null;
  version: number;
}
interface VersionRecord {
  id: string;
  organizationId: string;
  planId: string;
  sequence: number;
  kind: CarePlanVersionKind;
  status: "draft" | "in_review" | "signed" | "superseded";
  idgMeetingId: string | null;
  requiredSignerSet: RequiredSignerSet;
  signatures: { signerRole: CarePlanSignerRole; signedAt: string; membershipId?: string }[];
  signedAt: string | null;
  stateSnapshot?: unknown;
  patientUnderstandingText?: string | null;
  version: number;
}
interface ProblemRecord {
  id: string;
  organizationId: string;
  planId: string;
  icd10Code: string | null;
  snomedCode: string | null;
  description: string;
  kind: ProblemKind;
  source: ProblemSource;
  sudRelated: boolean;
  status: "active" | "resolved" | "inactive";
  resolutionNote: string | null;
  version: number;
}
interface GoalRecord {
  id: string;
  organizationId: string;
  planId: string;
  problemId: string;
  originalText: string;
  revisedText: string | null;
  source: GoalSource;
  actingConsentId: string | null;
  measurableOutcome: string | null;
  status: GoalStatus;
  version: number;
}
interface InterventionRecord {
  id: string;
  organizationId: string;
  planId: string;
  problemId: string;
  goalRefs: string[];
  scopeText: string;
  frequencyText: string;
  frequencyValue: string;
  discipline: InterventionDiscipline;
  responsibleRole: string | null;
  status: "active" | "discontinued" | "completed";
  version: number;
}

/** A minimal mutation result every element route returns (`{ id, version, ... }`). */
export interface ElementResult {
  readonly id: string;
  readonly status: string;
  readonly version: number;
}

/** The org-scoped owner facts M7's ABAC predicates evaluate against (never client input). */
export interface CarePlanFacts {
  readonly patientId: string;
  readonly planId: string;
}

/** A problem's §7.6 SUD-confidentiality facts (the `sud_disclosure_allowed` predicate reads these). */
export interface ProblemFacts {
  readonly planId: string;
  readonly patientId: string;
  readonly sudRelated: boolean;
}

/** A version's §6 `signer_role_match` facts (the quorum the caller's signer roles must intersect). */
export interface VersionFacts {
  readonly planId: string;
  readonly requiredSignerSet: RequiredSignerSet;
}

/**
 * Loads a plan/problem/version's org-scoped owner facts for M7's §6 ABAC predicates (in-memory here;
 * Drizzle under `withOrgContext` in prod). Each loader fails closed (returns `null`) on an absent or
 * cross-tenant id, so the predicate denies rather than leaking existence.
 */
export interface CarePlanAbacResolver {
  loadPlan(organizationId: string, planId: string): Promise<CarePlanFacts | null>;
  loadProblem(organizationId: string, problemId: string): Promise<ProblemFacts | null>;
  loadVersion(organizationId: string, versionId: string): Promise<VersionFacts | null>;
}

/** The route-facing service the §4.1 handlers compose over (in-memory slice here; Drizzle in prod). */
export interface CarePlanRouteService {
  bootstrapCarePlan(
    org: string,
    patientId: string,
    admissionId: string,
    admissionActivatedAt?: string,
  ): Promise<unknown>;
  closeCarePlanForAdmission(
    org: string,
    admissionId: string,
    reason: string,
    dischargedAt: string,
  ): Promise<unknown>;
  /** Per-caller read (§7.6): pass `viewer` to omit SUD problems the caller may not see (fail-closed). */
  getCarePlanForPatient(
    org: string,
    patientId: string,
    viewer?: CarePlanViewer,
  ): Promise<unknown | null>;
  getSummary(org: string, planId: string, viewer?: CarePlanViewer): Promise<unknown>;
  listVersions(org: string, planId: string): Promise<unknown>;
  getVersion(org: string, planId: string, versionId: string): Promise<unknown | null>;
  getReadiness(org: string, planId: string): Promise<unknown>;
  getProposedChanges(org: string, planId: string, versionId: string): Promise<unknown>;
  getReviewStatus(org: string, planId: string, now?: string): Promise<unknown>;
  createVersion(
    org: string,
    planId: string,
    kind: CarePlanVersionKind,
    idgMeetingId: string | null,
  ): Promise<unknown>;
  finalizeVersion(
    org: string,
    planId: string,
    versionId: string,
    ifVersion: number,
    set: RequiredSignerSet | null,
  ): Promise<unknown>;
  signVersion(
    org: string,
    planId: string,
    versionId: string,
    ifVersion: number,
    signerRole: CarePlanSignerRole,
    at: string,
    actor: CarePlanSignActor,
    patientUnderstandingText?: string | null,
  ): Promise<unknown>;
  returnVersionToDraft(
    org: string,
    planId: string,
    versionId: string,
    ifVersion: number,
  ): Promise<unknown>;
  addProblem(org: string, planId: string, body: CreateProblemInput): Promise<ElementResult>;
  patchProblem(
    org: string,
    planId: string,
    problemId: string,
    ifVersion: number,
    body: PatchProblemInput,
  ): Promise<ElementResult>;
  resolveProblem(
    org: string,
    planId: string,
    problemId: string,
    ifVersion: number,
    note: string,
  ): Promise<ElementResult>;
  addGoal(
    org: string,
    planId: string,
    body: CreateGoalInput,
    dpoaConsentActive: boolean,
  ): Promise<ElementResult>;
  patchGoal(
    org: string,
    planId: string,
    goalId: string,
    ifVersion: number,
    body: PatchGoalInput,
  ): Promise<ElementResult>;
  /** §7.4: pass `authoring` to enforce `discipline_scope` server-side (403 unless caller's discipline matches). */
  addIntervention(
    org: string,
    planId: string,
    body: CreateInterventionInput,
    authoring?: AuthoringDisciplineScope,
  ): Promise<ElementResult>;
  patchIntervention(
    org: string,
    planId: string,
    interventionId: string,
    ifVersion: number,
    body: PatchInterventionInput,
  ): Promise<ElementResult>;
  discontinueIntervention(
    org: string,
    planId: string,
    interventionId: string,
    ifVersion: number,
    reason: string,
  ): Promise<ElementResult>;
}

export interface CarePlanSignActor {
  readonly userId: string;
  readonly membershipId: string;
  /** The authenticated actor's role keys (server-side; never a body field) — GAP-011. */
  readonly roles: readonly string[];
}

export interface CreateProblemInput {
  readonly icd10Code?: string;
  readonly snomedCode?: string;
  readonly description: string;
  readonly kind: ProblemKind;
  readonly source: ProblemSource;
  readonly sudRelated?: boolean;
}
export interface PatchProblemInput {
  readonly description?: string;
  readonly kind?: ProblemKind;
  readonly icd10Code?: string;
  readonly snomedCode?: string;
}
export interface CreateGoalInput {
  readonly problemId: string;
  readonly originalText: string;
  readonly source: GoalSource;
  readonly actingConsentId?: string;
  readonly measurableOutcome?: string;
}
export interface PatchGoalInput {
  readonly revisedText?: string;
  readonly measurableOutcome?: string;
  readonly status?: GoalStatus;
}
export interface CreateInterventionInput {
  readonly problemId: string;
  readonly goalRefs?: readonly string[];
  readonly scopeText: string;
  readonly frequencyText: string;
  readonly frequencyValue: string;
  readonly discipline: InterventionDiscipline;
  readonly responsibleRole?: string;
}
export interface PatchInterventionInput {
  readonly scopeText?: string;
  readonly frequencyText?: string;
  readonly frequencyValue?: string;
  readonly responsibleRole?: string;
}

/** Deterministic, I/O-free seed for the in-memory backend (slice + route tests). */
export interface CarePlanBackendSeed {
  readonly plans?: ReadonlyArray<{
    readonly id: string;
    readonly organizationId: string;
    readonly patientId: string;
    readonly admissionId?: string;
    readonly status?: "draft" | "active" | "discharged";
  }>;
  /** A fixed clock for sign timestamps (defaults to a stable instant so tests are deterministic). */
  readonly now?: () => string;
}

/** 409 TENANT_PLAN_EXISTS — a patient already has an active care plan (one-per-admission, §2.2.1). */
export class CarePlanAlreadyExistsError extends CarePlanStateError {
  constructor() {
    super("ONE_ACTIVE_PLAN_PER_ADMISSION", "patient already has an active care plan");
  }
}

/**
 * Build the in-memory CarePlanRouteService + its ABAC resolver over ONE shared dataset, so a route
 * write is visible to a subsequent ABAC scope read (proves the §7.7 / §4 wiring end-to-end without DB).
 */
export function createInMemoryCarePlanBackend(seed: CarePlanBackendSeed = {}): {
  service: CarePlanRouteService;
  resolver: CarePlanAbacResolver;
} {
  const plans = new Map<string, CarePlanRecord>();
  const versions = new Map<string, VersionRecord>();
  const problems = new Map<string, ProblemRecord>();
  const goals = new Map<string, GoalRecord>();
  const interventions = new Map<string, InterventionRecord>();
  const now = seed.now ?? (() => "2026-06-21T12:00:00.000Z");
  let seq = 0;
  const mintId = (prefix: string) => `${prefix}_${(++seq).toString(36)}`;

  for (const p of seed.plans ?? []) {
    plans.set(p.id, {
      id: p.id,
      organizationId: p.organizationId,
      patientId: p.patientId,
      admissionId: p.admissionId ?? mintId("adm"),
      status: p.status ?? "draft",
      activeVersionId: null,
      version: 1,
    });
  }

  /** Resolve a tenant-scoped plan or raise the non-leaking 404 (RLS-hidden rows look identical). */
  function plan(org: string, planId: string): CarePlanRecord {
    const row = plans.get(planId);
    if (!row || row.organizationId !== org) throw new NotFoundError("care_plan", planId);
    return row;
  }
  function version(org: string, planId: string, versionId: string): VersionRecord {
    plan(org, planId); // 404 if the plan is cross-tenant/absent
    const row = versions.get(versionId);
    if (!row || row.organizationId !== org || row.planId !== planId) {
      throw new NotFoundError("care_plan_version", versionId);
    }
    return row;
  }
  function problem(org: string, planId: string, problemId: string): ProblemRecord {
    plan(org, planId);
    const row = problems.get(problemId);
    if (!row || row.organizationId !== org || row.planId !== planId) {
      throw new NotFoundError("problem", problemId);
    }
    return row;
  }
  function goal(org: string, planId: string, goalId: string): GoalRecord {
    plan(org, planId);
    const row = goals.get(goalId);
    if (!row || row.organizationId !== org || row.planId !== planId) {
      throw new NotFoundError("goal", goalId);
    }
    return row;
  }
  function intervention(org: string, planId: string, interventionId: string): InterventionRecord {
    plan(org, planId);
    const row = interventions.get(interventionId);
    if (!row || row.organizationId !== org || row.planId !== planId) {
      throw new NotFoundError("intervention", interventionId);
    }
    return row;
  }

  const versionDto = (v: VersionRecord) => ({
    id: v.id,
    planId: v.planId,
    sequence: v.sequence,
    kind: v.kind,
    status: v.status,
    idgMeetingId: v.idgMeetingId,
    requiredSignerSet: v.requiredSignerSet,
    signatures: v.signatures,
    signedAt: v.signedAt,
    stateSnapshot: v.stateSnapshot ?? null,
    patientUnderstandingText: v.patientUnderstandingText ?? null,
    version: v.version,
  });

  const terminalProblemBlocker = {
    code: "TERMINAL_PROBLEM_REQUIRED",
    message: "at least one active terminal problem is required",
  } as const;

  const openVersionBlocker = {
    code: "OPEN_VERSION_REQUIRED",
    message: "no draft or in-review version is open",
  } as const;

  function activeTerminalProblemCount(planId: string): number {
    return [...problems.values()].filter(
      (p) => p.planId === planId && p.kind === "terminal" && p.status === "active",
    ).length;
  }

  function missingSignerSlots(
    set: RequiredSignerSet,
    signedRoles: ReadonlyArray<CarePlanSignerRole>,
  ): RequiredSignerSet {
    const remaining = [...signedRoles];
    const missing: { role: string; count: number }[] = [];
    for (const slot of set) {
      let need = slot.count;
      for (let i = remaining.length - 1; i >= 0 && need > 0; i--) {
        if (slot.role.split("|").includes(remaining[i]!)) {
          remaining.splice(i, 1);
          need--;
        }
      }
      if (need > 0) missing.push({ role: slot.role, count: need });
    }
    return missing;
  }

  function requireReadyToFinalize(v: VersionRecord): void {
    if (v.kind === "initial" && activeTerminalProblemCount(v.planId) < 1) {
      throw new CarePlanStateError("CARE_PLAN_NOT_READY", "care plan is not ready to finalize", [
        terminalProblemBlocker,
      ]);
    }
  }

  const service: CarePlanRouteService = {
    async bootstrapCarePlan(org, patientId, admissionId) {
      for (const p of plans.values()) {
        if (
          p.organizationId === org &&
          p.admissionId === admissionId &&
          p.status !== "discharged"
        ) {
          throw new CarePlanAlreadyExistsError();
        }
      }
      const id = mintId("cp");
      plans.set(id, {
        id,
        organizationId: org,
        patientId,
        admissionId,
        status: "draft",
        activeVersionId: null,
        version: 1,
      });
      // Open the initial draft version alongside the root (the §2.2.1 bootstrap bundle).
      const vId = mintId("cpv");
      versions.set(vId, {
        id: vId,
        organizationId: org,
        planId: id,
        sequence: 1,
        kind: "initial",
        status: "draft",
        idgMeetingId: null,
        requiredSignerSet: resolveRequiredSignerSet("initial"),
        signatures: [],
        signedAt: null,
        stateSnapshot: null,
        patientUnderstandingText: null,
        version: 1,
      });
      return { id, patientId, status: "draft", initialVersionId: vId, version: 1 };
    },

    async closeCarePlanForAdmission(org, admissionId, reason, dischargedAt) {
      const row = [...plans.values()].find(
        (p) => p.organizationId === org && p.admissionId === admissionId,
      );
      if (!row || row.status === "discharged") {
        return { closed: false, admissionId, reason, dischargedAt };
      }
      row.status = "discharged";
      row.version += 1;
      return { closed: true, id: row.id, admissionId, reason, dischargedAt, version: row.version };
    },

    async getCarePlanForPatient(org, patientId, viewer) {
      const row = [...plans.values()].find(
        (p) => p.organizationId === org && p.patientId === patientId,
      );
      if (!row) return null;
      const planVersions = [...versions.values()]
        .filter((v) => v.planId === row.id)
        .map(versionDto);
      // §7.6 per-caller SUD redaction: omit SUD problems (and their dependent goals/interventions)
      // unless `viewer.sudDisclosureAllowed`. No viewer ⇒ full set (system/internal read path).
      const allowSud = viewer?.sudDisclosureAllowed ?? true;
      const planProblems = [...problems.values()].filter((p) => p.planId === row.id);
      const hiddenIds = redactedSudProblemIds(planProblems, allowSud);
      return {
        id: row.id,
        patientId: row.patientId,
        status: row.status,
        activeVersionId: row.activeVersionId,
        version: row.version,
        versions: planVersions,
        problems: filterVisibleProblems(planProblems, allowSud),
        goals: filterAnchoredToVisible(
          [...goals.values()].filter((g) => g.planId === row.id),
          hiddenIds,
        ),
        interventions: filterAnchoredToVisible(
          [...interventions.values()].filter((i) => i.planId === row.id),
          hiddenIds,
        ),
        redacted: hiddenIds.length > 0,
      };
    },

    async getSummary(org, planId, viewer) {
      const p = plan(org, planId); // 404 if cross-tenant/absent
      const allowSud = viewer?.sudDisclosureAllowed ?? true;
      const planProblems = [...problems.values()].filter((x) => x.planId === p.id);
      const hiddenIds = redactedSudProblemIds(planProblems, allowSud);
      const visibleProblems = filterVisibleProblems(planProblems, allowSud);
      const activeProblems = visibleProblems
        .filter((x) => x.status === "active")
        .map((x) => ({ description: x.description, kind: x.kind }));
      const patientStatedGoals = filterAnchoredToVisible(
        [...goals.values()].filter((g) => g.planId === p.id && g.source !== "clinical"),
        hiddenIds,
      ).map((g) => ({ text: g.originalText, measurableOutcome: g.measurableOutcome }));
      const activeInterventions = filterAnchoredToVisible(
        [...interventions.values()].filter((i) => i.planId === p.id && i.status === "active"),
        hiddenIds,
      ).map((i) => ({
        layText: i.scopeText,
        discipline: i.discipline,
        frequencyText: i.frequencyText,
      }));
      return {
        planId: p.id,
        versionId: p.activeVersionId,
        activeProblems,
        patientStatedGoals,
        activeInterventions,
        redacted: hiddenIds.length > 0,
      };
    },

    async listVersions(org, planId) {
      plan(org, planId);
      const items = [...versions.values()]
        .filter((v) => v.planId === planId)
        .sort((a, b) => a.sequence - b.sequence)
        .map(versionDto);
      return { items, nextCursor: null };
    },

    async getVersion(org, planId, versionId) {
      return versionDto(version(org, planId, versionId));
    },

    async getReadiness(org, planId) {
      plan(org, planId);
      const open = [...versions.values()]
        .filter((v) => v.planId === planId && (v.status === "draft" || v.status === "in_review"))
        .sort((a, b) => a.sequence - b.sequence)[0];
      if (!open) {
        return {
          planId,
          openVersionId: null,
          canFinalize: false,
          canSign: false,
          blockers: [openVersionBlocker],
          signatures: { required: [], collected: [], missing: [] },
        };
      }
      const blockers =
        open.kind === "initial" && activeTerminalProblemCount(planId) < 1
          ? [terminalProblemBlocker]
          : [];
      const missing = missingSignerSlots(
        open.requiredSignerSet,
        open.signatures.map((s) => s.signerRole),
      );
      return {
        planId,
        openVersionId: open.id,
        openVersionStatus: open.status,
        canFinalize: open.status === "draft" && blockers.length === 0,
        canSign: open.status === "in_review" && blockers.length === 0 && missing.length > 0,
        blockers,
        signatures: {
          required: open.requiredSignerSet,
          collected: open.signatures,
          missing,
        },
      };
    },

    async getProposedChanges(org, planId, versionId) {
      const v = version(org, planId, versionId);
      return {
        versionId: v.id,
        kind: v.kind,
        meetingId: v.idgMeetingId,
        status: v.status,
        changes: [],
      };
    },

    async getReviewStatus(org, planId, nowIso) {
      const p = plan(org, planId);
      const open = [...versions.values()]
        .filter((v) => v.planId === planId && v.kind === "idg_review")
        .find((v) => v.status === "draft" || v.status === "in_review");
      return {
        planId: p.id,
        nextReviewDueAt: null,
        status: open ? "review_in_progress" : "not_due",
        overdueByDays: 0,
        openReviewVersionId: open?.id ?? null,
        canStartReview: !open && p.status !== "discharged",
        asOf: nowIso ?? now(),
      };
    },

    async createVersion(org, planId, kind, idgMeetingId) {
      const p = plan(org, planId);
      if (p.status === "discharged") {
        throw new CarePlanStateError("CARE_PLAN_CLOSED", "discharged care plans cannot be mutated");
      }
      if (
        [...versions.values()].some(
          (v) => v.planId === planId && (v.status === "draft" || v.status === "in_review"),
        )
      ) {
        throw new CarePlanStateError(
          "OPEN_VERSION_EXISTS",
          "a care plan may have only one draft or in-review version",
        );
      }
      const maxSeq = [...versions.values()]
        .filter((v) => v.planId === p.id)
        .reduce((m, v) => Math.max(m, v.sequence), 0);
      const id = mintId("cpv");
      const row: VersionRecord = {
        id,
        organizationId: org,
        planId: p.id,
        sequence: maxSeq + 1,
        kind,
        status: "draft",
        idgMeetingId,
        requiredSignerSet: resolveRequiredSignerSet(kind),
        signatures: [],
        signedAt: null,
        stateSnapshot: null,
        patientUnderstandingText: null,
        version: 1,
      };
      versions.set(id, row);
      return versionDto(row);
    },

    async finalizeVersion(org, planId, versionId, ifVersion, set) {
      const p = plan(org, planId);
      if (p.status === "discharged") {
        throw new CarePlanStateError("CARE_PLAN_CLOSED", "discharged care plans cannot be mutated");
      }
      const v = version(org, planId, versionId);
      checkOptimisticConcurrency(ifVersion, v.version);
      if (v.status !== "draft") {
        throw new CarePlanStateError(
          "ILLEGAL_TRANSITION",
          `version cannot finalize from '${v.status}'`,
        );
      }
      requireReadyToFinalize(v);
      if (set) {
        // A tenant may TIGHTEN the floor (add slots) but never loosen below it (§11 D5) — GAP-012.
        v.requiredSignerSet = [...resolveTightenedSignerSet(resolveRequiredSignerSet(v.kind), set)];
      }
      v.status = "in_review";
      v.stateSnapshot = {
        schemaVersion: "2026-08-m7-v1",
        problems: [...problems.values()]
          .filter((p) => p.planId === planId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((p) => ({
            id: p.id,
            icd10Code: p.icd10Code,
            snomedCode: p.snomedCode,
            description: p.description,
            kind: p.kind,
            source: p.source,
            sudRelated: p.sudRelated,
            status: p.status,
            resolutionNote: p.resolutionNote,
            version: p.version,
          })),
        goals: [...goals.values()]
          .filter((g) => g.planId === planId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((g) => ({
            id: g.id,
            problemId: g.problemId,
            originalText: g.originalText,
            revisedText: g.revisedText,
            source: g.source,
            actingConsentId: g.actingConsentId,
            measurableOutcome: g.measurableOutcome,
            status: g.status,
            version: g.version,
          })),
        interventions: [...interventions.values()]
          .filter((i) => i.planId === planId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((i) => ({
            id: i.id,
            problemId: i.problemId,
            goalRefs: i.goalRefs,
            scopeText: i.scopeText,
            frequencyText: i.frequencyText,
            frequencyValue: i.frequencyValue,
            discipline: i.discipline,
            responsibleRole: i.responsibleRole,
            status: i.status,
            version: i.version,
          })),
      };
      v.version += 1;
      return versionDto(v);
    },

    async signVersion(
      org,
      planId,
      versionId,
      ifVersion,
      signerRole,
      at,
      actor,
      patientUnderstandingText,
    ) {
      const p = plan(org, planId);
      if (p.status === "discharged") {
        throw new CarePlanStateError("CARE_PLAN_CLOSED", "discharged care plans cannot be mutated");
      }
      const v = version(org, planId, versionId);
      checkOptimisticConcurrency(ifVersion, v.version);
      if (v.status !== "in_review") {
        throw new CarePlanStateError(
          "ILLEGAL_TRANSITION",
          `version cannot be signed from '${v.status}'`,
        );
      }
      if (v.kind === "initial" && activeTerminalProblemCount(planId) < 1) {
        throw new CarePlanStateError("CARE_PLAN_NOT_READY", "care plan is not ready to sign", [
          terminalProblemBlocker,
        ]);
      }
      // GAP-011 — bind the claimed slot to the authenticated actor (role held; one slot per membership).
      assertActorHoldsSignerRole(actor.roles, signerRole);
      assertMembershipNotAlreadySigned(
        v.signatures.map((s) => s.membershipId ?? null),
        actor.membershipId,
      );
      if (patientUnderstandingText !== undefined) {
        v.patientUnderstandingText = patientUnderstandingText;
      }
      const alreadySigned = v.signatures.map((s) => s.signerRole);
      const decision = decideRecordSignature(v.requiredSignerSet, alreadySigned, signerRole);
      v.signatures = [
        ...v.signatures,
        { signerRole, signedAt: at, membershipId: actor.membershipId },
      ];
      if (decision.quorumMet) {
        if (p.activeVersionId && p.activeVersionId !== v.id) {
          const previous = versions.get(p.activeVersionId);
          if (previous?.status === "signed") {
            previous.status = "superseded";
          }
        }
        v.status = "signed";
        v.signedAt = at;
        p.status = "active";
        p.activeVersionId = v.id;
        p.version += 1;
      }
      v.version += 1;
      return versionDto(v);
    },

    async returnVersionToDraft(org, planId, versionId, ifVersion) {
      const v = version(org, planId, versionId);
      checkOptimisticConcurrency(ifVersion, v.version);
      if (v.status !== "in_review") {
        throw new CarePlanStateError(
          "ILLEGAL_TRANSITION",
          `version cannot return to draft from '${v.status}'`,
        );
      }
      v.status = "draft";
      v.signatures = []; // returning for edits clears prior signatures (D8)
      v.signedAt = null;
      v.stateSnapshot = null;
      v.version += 1;
      return versionDto(v);
    },

    async addProblem(org, planId, body) {
      plan(org, planId);
      const id = mintId("prob");
      problems.set(id, {
        id,
        organizationId: org,
        planId,
        icd10Code: body.icd10Code ?? null,
        snomedCode: body.snomedCode ?? null,
        description: body.description,
        kind: body.kind,
        source: body.source,
        sudRelated: body.sudRelated ?? false,
        status: "active",
        resolutionNote: null,
        version: 1,
      });
      return { id, status: "active", version: 1 };
    },

    async patchProblem(org, planId, problemId, ifVersion, body) {
      const row = problem(org, planId, problemId);
      checkOptimisticConcurrency(ifVersion, row.version);
      if (body.description !== undefined) row.description = body.description;
      if (body.kind !== undefined) row.kind = body.kind;
      if (body.icd10Code !== undefined) row.icd10Code = body.icd10Code;
      if (body.snomedCode !== undefined) row.snomedCode = body.snomedCode;
      row.version += 1;
      return { id: row.id, status: row.status, version: row.version };
    },

    async resolveProblem(org, planId, problemId, ifVersion, note) {
      const row = problem(org, planId, problemId);
      checkOptimisticConcurrency(ifVersion, row.version);
      row.status = "resolved";
      row.resolutionNote = note;
      row.version += 1;
      return { id: row.id, status: row.status, version: row.version };
    },

    async addGoal(org, planId, body, dpoaConsentActive) {
      plan(org, planId);
      checkGoalReferencesProblem(body.problemId);
      checkPatientStatedGoalVerbatim({
        source: body.source,
        originalText: body.originalText,
        isUpdate: false,
        mutatingOriginalText: false,
      });
      if (body.source === "agent_stated" && !dpoaConsentActive) {
        throw new CarePlanStateError(
          "DPOA_CONSENT_REQUIRED",
          "an agent-stated goal requires an active dpoa_healthcare consent",
        );
      }
      const id = mintId("goal");
      goals.set(id, {
        id,
        organizationId: org,
        planId,
        problemId: body.problemId,
        originalText: body.originalText,
        revisedText: null,
        source: body.source,
        actingConsentId: body.actingConsentId ?? null,
        measurableOutcome: body.measurableOutcome ?? null,
        status: "not_started",
        version: 1,
      });
      return { id, status: "not_started", version: 1 };
    },

    async patchGoal(org, planId, goalId, ifVersion, body) {
      const row = goal(org, planId, goalId);
      checkOptimisticConcurrency(ifVersion, row.version);
      // A verbatim-source goal's original_text is immutable; PATCH never carries it (schema omits it),
      // but enforce the rule defensively (D6 — the DB trigger is the backstop).
      checkPatientStatedGoalVerbatim({
        source: row.source,
        originalText: row.originalText,
        isUpdate: true,
        mutatingOriginalText: false,
      });
      if (body.revisedText !== undefined) row.revisedText = body.revisedText;
      if (body.measurableOutcome !== undefined) row.measurableOutcome = body.measurableOutcome;
      if (body.status !== undefined) row.status = body.status;
      row.version += 1;
      return { id: row.id, status: row.status, version: row.version };
    },

    async addIntervention(org, planId, body, authoring) {
      plan(org, planId);
      // §7.4 discipline_scope: an actor may author only their own discipline (IDG Coordinator excepted).
      // Defense in depth behind the route ABAC gate; skipped only on the internal/system write path.
      if (authoring) assertDisciplineScope(authoring, body.discipline);
      checkInterventionReferencesProblem(body.problemId);
      checkInterventionFrequency(body.frequencyValue);
      const id = mintId("intv");
      interventions.set(id, {
        id,
        organizationId: org,
        planId,
        problemId: body.problemId,
        goalRefs: [...(body.goalRefs ?? [])],
        scopeText: body.scopeText,
        frequencyText: body.frequencyText,
        frequencyValue: body.frequencyValue,
        discipline: body.discipline,
        responsibleRole: body.responsibleRole ?? null,
        status: "active",
        version: 1,
      });
      return { id, status: "active", version: 1 };
    },

    async patchIntervention(org, planId, interventionId, ifVersion, body) {
      const row = intervention(org, planId, interventionId);
      checkOptimisticConcurrency(ifVersion, row.version);
      if (body.scopeText !== undefined) row.scopeText = body.scopeText;
      if (body.frequencyText !== undefined) row.frequencyText = body.frequencyText;
      if (body.frequencyValue !== undefined) {
        checkInterventionFrequency(body.frequencyValue);
        row.frequencyValue = body.frequencyValue;
      }
      if (body.responsibleRole !== undefined) row.responsibleRole = body.responsibleRole;
      row.version += 1;
      return { id: row.id, status: row.status, version: row.version };
    },

    async discontinueIntervention(org, planId, interventionId, ifVersion, _reason) {
      const row = intervention(org, planId, interventionId);
      checkOptimisticConcurrency(ifVersion, row.version);
      row.status = "discontinued";
      row.version += 1;
      return { id: row.id, status: row.status, version: row.version };
    },
  };

  const resolver: CarePlanAbacResolver = {
    async loadPlan(org, planId) {
      const row = plans.get(planId);
      if (!row || row.organizationId !== org) return null;
      return { patientId: row.patientId, planId: row.id };
    },
    async loadProblem(org, problemId) {
      const row = problems.get(problemId);
      if (!row || row.organizationId !== org) return null;
      const plan = plans.get(row.planId);
      if (!plan) return null;
      return { planId: row.planId, patientId: plan.patientId, sudRelated: row.sudRelated };
    },
    async loadVersion(org, versionId) {
      const row = versions.get(versionId);
      if (!row || row.organizationId !== org) return null;
      return { planId: row.planId, requiredSignerSet: row.requiredSignerSet };
    },
  };

  return { service, resolver };
}
