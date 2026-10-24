// apps/backend/src/modules/25-remittance/routes/payer-appeal-service.ts - M25 milestone 12a-1: the PAYER APPEAL CASE, one
// row per level of a commercial (or Medicare Advantage plan) payer's own path, keyed on the DENIAL (a commercial denial has no
// claim). It never touches the Medicare appeal_case chain. A payer appeal REFUSES a denial whose remittance advice is
// Medicare (or Medicaid, or absent). The case snapshots the path revision and the level's window, so a later path edit never
// moves a deadline; a deadline is computed only from a complete window and a notice date a person typed, otherwise the case
// shows "No due date" until one is recorded. Every transition is a conditional UPDATE (version and state in the WHERE).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  DEFAULT_DEADLINE_ZONE,
  type LevelWindow,
  type PayerAppealState,
  type PayerDeadlineState,
  type PayerDecisionRefusal,
  type PayerKindRefusal,
  type PayerOpenRefusal,
  canTransitionDenial,
  canTransitionPayerAppeal,
  checkPayerDecision,
  checkPayerKind,
  checkPayerOpen,
  derivePayerLevelDeadline,
  dispositionNeedsManualReview,
  isKnownZone,
  isRealDay,
  levelWindow,
  noticeDayOf,
  payerDeadlineState,
  payerDecisionOverdue,
  resolvePayerPath,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import type { AppealSourcePorts } from "./appeal-packet-sources";
import { patientOfClaim } from "./claim-patient";
import { VersionConflictError } from "./concurrency";
import { isUniqueViolation } from "./denial-route-service";
import { type PayerSeam, buildSeamPayerSeam } from "./payer-seam";
import { type RecordedDeadlineView, viewRecordedDeadline } from "./recorded-deadline-view";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export const NO_PATH_PROMPT =
  "No appeal path recorded for this payer - add it from your contract or the payer's denial notice";
export const NO_DUE_DATE_PROMPT = "No due date - enter it from the notice";
export const AWAITING_VERIFICATION_PROMPT =
  "Appeal path awaiting verification - no due date is computed from it; enter the date from the notice, or ask a second person to verify the path";
export const PAYER_UNRESOLVED_PROMPT =
  "Payer not resolved from the payer directory - the appeal path cannot be looked up";

export interface PayerAppealCaseView {
  readonly id: string;
  readonly denialCaseId: string;
  readonly claimId: string | null;
  readonly payerId: string;
  readonly program: string;
  readonly pathId: string | null;
  readonly pathRevision: number | null;
  readonly levelOrdinal: number | null;
  readonly levelKind: string;
  readonly levelLabel: string;
  readonly priorLevelCaseId: string | null;
  readonly state: string;
  readonly noticeDatedOn: string | null;
  readonly deadlineAt: string | null;
  readonly deadlineZone: string | null;
  readonly deadlineSource: string;
  readonly deadlineState: PayerDeadlineState;
  /** False when the deadline came from a path that was not verified when the case opened (the badge). */
  readonly windowVerified: boolean;
  readonly derivation: {
    readonly presumedReceiptOn: string | null;
    readonly calendarLastDay: string;
    readonly lastFilingDay: string;
  } | null;
  /** The visible prompt when nothing gives a due date. */
  readonly prompt: string | null;
  /** True when the level was opened under a path that was still an unverified draft (no deadline is computed from it). */
  readonly pathAwaitingVerification: boolean;
  /** The claim's patient when the denial has a claim; a claim-less (commercial) denial has none. */
  readonly patientId: string | null;
  readonly patientAttribution: "claim" | "unattributed";
  readonly payerReference: string | null;
  readonly externalReviewerName: string | null;
  readonly decisionOutcome: string | null;
  readonly dispositionKind: string | null;
  readonly dispositionNote: string | null;
  readonly needsManualReview: boolean;
  readonly decisionOverdue: boolean;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly closedAt: string | null;
  readonly version: number;
  readonly deadlines: RecordedDeadlineView[];
}

export interface PayerAppealDenialView {
  readonly denialCaseId: string;
  readonly payerId: string | null;
  /** From the M40 seam; null = not resolved (shown, never guessed). */
  readonly payerName: string | null;
  readonly payerKind: string | null;
  /** The remittance advice's payer kind, the program guard's input. */
  readonly adviceKind: string | null;
  /** Why a payer appeal cannot be opened for this denial, or null when it can. */
  readonly refusal: PayerKindRefusal | null;
  /** Medicare Advantage coverage hint: hospice for MA enrollees is paid by Original Medicare through the MAC. */
  readonly maHint: boolean;
  /** True when the payer could not be resolved through the seam (nothing is guessed, no path is looked up). */
  readonly payerUnresolved: boolean;
  readonly patientId: string | null;
  readonly patientAttribution: "claim" | "unattributed";
  readonly path: {
    readonly id: string;
    readonly status: string;
    readonly verified: boolean;
    readonly revision: number;
    readonly program: string;
    readonly levels: {
      readonly ordinal: number;
      readonly levelKind: string;
      readonly levelLabel: string;
      readonly whoFiles: string;
      readonly windowComplete: boolean;
    }[];
  } | null;
  readonly pathPrompt: string | null;
  readonly cases: PayerAppealCaseView[];
}

export interface PayerAppealOpenInput {
  readonly program?: string;
  readonly contractLabel?: string | null;
  readonly levelOrdinal?: number;
  readonly levelLabel?: string;
  readonly levelKind?: string;
  /** The date printed on the notice the level's clock runs from (typed). */
  readonly noticeDate?: string;
  readonly priorLevelCaseId?: string;
}

export interface PayerAppealMoveInput {
  readonly payerReference?: string | null;
  readonly externalReviewerName?: string | null;
  readonly outcome?: string;
  readonly dispositionKind?: string | null;
  readonly dispositionNote?: string | null;
}

export type PayerAppealMove = "submit" | "begin_review" | "decide" | "close" | "withdraw";

export interface PayerAppealService {
  getForDenial(actor: M25ReadActor, denialCaseId: string): Promise<PayerAppealDenialView>;
  getCase(actor: M25ReadActor, id: string): Promise<PayerAppealCaseView | null>;
  open(
    actor: M25WriteActor,
    denialCaseId: string,
    input: PayerAppealOpenInput,
  ): Promise<{ id: string; version: number; deadlineSource: string }>;
  recordNotice(
    actor: M25WriteActor,
    id: string,
    noticeDate: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number; deadlineSource: string }>;
  move(
    actor: M25WriteActor,
    id: string,
    move: PayerAppealMove,
    input: PayerAppealMoveInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface PayerAppealPorts {
  readonly payers?: PayerSeam;
  /** M22 / M23 seams; only used to name a claim's patient for the read audit. */
  readonly sources?: AppealSourcePorts;
  readonly providerZones?: (tx: DbClient, providerEntityId: string) => Promise<readonly string[]>;
}

const unprocessable = (code: string, message: string) => new ChartWardenError(code, message, 422);
const conflict = (code: string, message: string) => new ChartWardenError(code, message, 409);

const KIND_MESSAGES: Readonly<Record<PayerKindRefusal, string>> = {
  MEDICARE_PAYER:
    "this denial is from Medicare; it takes the Medicare appeal tiers, not a payer appeal",
  MEDICAID_PAYER: "Medicaid appeals are not handled here",
  NO_PAYER_ADVICE:
    "this denial has no remittance advice naming a payer, so a payer appeal cannot be opened",
};
const OPEN_MESSAGES: Readonly<Record<PayerOpenRefusal, string>> = {
  LEVEL_LABEL_REQUIRED: "no appeal path is recorded for this payer: name the level you are filing",
  LEVEL_KIND_INVALID: "the level kind must be internal, external_review or other",
};
const DECISION_MESSAGES: Readonly<Record<PayerDecisionRefusal, string>> = {
  OUTCOME_REQUIRED: "record the outcome: favorable, partial or unfavorable",
  DISPOSITION_INVALID: "the disposition must be decision, remand, dismissal or other",
  DISPOSITION_KIND_REQUIRED: "choose the disposition the note describes",
  DISPOSITION_NOTE_REQUIRED: "describe the disposition when it is 'other'",
};

const MOVE_TARGET: Readonly<Record<PayerAppealMove, PayerAppealState>> = {
  submit: "submitted",
  begin_review: "under_review",
  decide: "decided",
  close: "closed",
  withdraw: "withdrawn",
};

/** The program a payer's M40 kind implies; `other` and `commercial` are commercial. */
const programOf = (kind: string): "commercial" | "medicare_advantage" =>
  kind === "medicare_advantage" ? "medicare_advantage" : "commercial";

/** A caller-chosen program must agree with a payer kind the directory states (`other` accepts either). */
const programMatchesKind = (program: string, kind: string): boolean =>
  kind === "other" || program === programOf(kind);

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function buildDrizzlePayerAppealService(
  db: DbClient,
  ports: PayerAppealPorts = {},
): PayerAppealService {
  const payers = ports.payers ?? buildSeamPayerSeam();
  const PC = schema.payerAppealCase;
  const PE = schema.payerAppealCaseEvent;
  const PP = schema.payerAppealPath;
  const PL = schema.payerAppealPathLevel;
  const DC = schema.denialCase;
  const RA = schema.remittanceAdvice;
  const RL = schema.remittanceLine;
  const RD = schema.recordedDeadline;

  async function zonesFor(tx: Tx, providerEntityId: string): Promise<readonly string[]> {
    const zones = (
      ports.providerZones
        ? await ports.providerZones(tx as unknown as DbClient, providerEntityId)
        : []
    ).filter(isKnownZone);
    return zones.length > 0 ? zones : [DEFAULT_DEADLINE_ZONE];
  }

  async function loadDenial(tx: Tx, actor: M25ReadActor, id: string) {
    const scope = providerEntityScopeCondition(DC.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(DC)
      .where(scope ? and(eq(DC.id, id), scope) : eq(DC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("denial case");
    return rows[0];
  }

  /** The payer the denial's 835 named (id and kind), or null for a denial with no advice. */
  async function adviceOf(tx: Tx, remittanceLineId: string | null) {
    if (!remittanceLineId) return null;
    const rows = await tx
      .select({ payerId: RA.payerId, payerKind: RA.payerKind })
      .from(RL)
      .innerJoin(RA, eq(RA.id, RL.remittanceAdviceId))
      .where(eq(RL.id, remittanceLineId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function pathFor(tx: Tx, payerId: string, program: string, contractLabel: string | null) {
    const paths = await tx
      .select()
      .from(PP)
      .where(and(eq(PP.payerId, payerId), ne(PP.status, "retired")));
    const resolution = resolvePayerPath(paths, {
      payerId,
      program,
      contractLabel,
      asOf: noticeDayOf(new Date()),
    });
    if (resolution.kind === "none") return { resolution, levels: [] as (typeof PL.$inferSelect)[] };
    const levels = await tx
      .select()
      .from(PL)
      .where(eq(PL.pathId, resolution.path.id))
      .orderBy(asc(PL.ordinal));
    return { resolution, levels };
  }

  const windowOf = (r: typeof PC.$inferSelect): LevelWindow | null =>
    levelWindow({
      filingWindowDays: r.windowDays,
      anchorKind: r.anchorKind,
      receiptPresumptionDays: r.receiptPresumptionDays,
      dayBasis: r.dayBasis,
      roll: r.roll,
    });

  /** The status of each path a set of cases was opened under (a draft path means "awaiting verification"). */
  async function pathStatuses(tx: Tx, rows: (typeof PC.$inferSelect)[]) {
    const ids = [...new Set(rows.flatMap((r) => (r.pathId ? [r.pathId] : [])))];
    if (ids.length === 0) return new Map<string, string>();
    const found = await tx
      .select({ id: PP.id, status: PP.status })
      .from(PP)
      .where(inArray(PP.id, ids));
    return new Map(found.map((f) => [f.id, f.status]));
  }

  function caseView(
    r: typeof PC.$inferSelect,
    recorded: (typeof RD.$inferSelect)[],
    now: Date,
    ctx: { pathStatus: string | undefined; patientId: string | null },
  ): PayerAppealCaseView {
    const awaiting = ctx.pathStatus === "draft" && r.windowDays === null;
    const open = recorded.filter((d) => d.satisfiedOn === null);
    const state = payerDeadlineState({ computedAt: r.deadlineAt, openRecordedCount: open.length });
    const derived =
      r.deadlineAt && r.noticeDatedOn && r.deadlineZone
        ? derivePayerLevelDeadline(windowOf(r), r.noticeDatedOn, [r.deadlineZone])
        : null;
    return {
      id: r.id,
      denialCaseId: r.denialCaseId,
      claimId: r.claimId,
      payerId: r.payerId,
      program: r.program,
      pathId: r.pathId,
      pathRevision: r.pathRevision,
      levelOrdinal: r.levelOrdinal,
      levelKind: r.levelKind,
      levelLabel: r.levelLabel,
      priorLevelCaseId: r.priorLevelCaseId,
      state: r.state,
      noticeDatedOn: r.noticeDatedOn,
      deadlineAt: iso(r.deadlineAt),
      deadlineZone: r.deadlineZone,
      deadlineSource: r.deadlineSource,
      deadlineState: state,
      windowVerified: r.windowVerified,
      derivation: derived
        ? {
            presumedReceiptOn: derived.presumedReceiptOn,
            calendarLastDay: derived.calendarLastDay,
            lastFilingDay: derived.lastFilingDay,
          }
        : null,
      prompt:
        state === "none" && r.state === "draft"
          ? awaiting
            ? AWAITING_VERIFICATION_PROMPT
            : NO_DUE_DATE_PROMPT
          : null,
      pathAwaitingVerification: awaiting,
      patientId: ctx.patientId,
      patientAttribution: ctx.patientId ? "claim" : "unattributed",
      payerReference: r.payerReference,
      externalReviewerName: r.externalReviewerName,
      decisionOutcome: r.decisionOutcome,
      dispositionKind: r.dispositionKind,
      dispositionNote: r.dispositionNote,
      needsManualReview: dispositionNeedsManualReview(r.dispositionKind),
      decisionOverdue: payerDecisionOverdue({
        decisionDays: r.decisionDays,
        submittedOn: r.submittedAt ? noticeDayOf(r.submittedAt) : null,
        state: r.state,
        today: noticeDayOf(now),
      }),
      submittedAt: iso(r.submittedAt),
      decidedAt: iso(r.decidedAt),
      closedAt: iso(r.closedAt),
      version: r.version,
      deadlines: recorded.map((d) => viewRecordedDeadline(d, now)),
    };
  }

  async function casesOfDenial(
    tx: Tx,
    actor: M25ReadActor,
    denialCaseId: string,
    patientId: string | null,
  ) {
    const scope = providerEntityScopeCondition(PC.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(PC)
      .where(
        scope ? and(eq(PC.denialCaseId, denialCaseId), scope) : eq(PC.denialCaseId, denialCaseId),
      )
      .orderBy(asc(PC.createdAt));
    const recorded =
      rows.length > 0
        ? await tx
            .select()
            .from(RD)
            .where(
              inArray(
                RD.payerAppealCaseId,
                rows.map((r) => r.id),
              ),
            )
            .orderBy(asc(RD.dueOn))
        : [];
    const now = new Date();
    const statuses = await pathStatuses(tx, rows);
    return rows.map((r) =>
      caseView(
        r,
        recorded.filter((d) => d.payerAppealCaseId === r.id),
        now,
        { pathStatus: r.pathId ? statuses.get(r.pathId) : undefined, patientId },
      ),
    );
  }

  async function event(
    tx: Tx,
    actor: M25WriteActor,
    caseId: string,
    eventKind: string,
    payload?: object,
  ) {
    await tx.insert(PE).values({
      organizationId: actor.organizationId,
      payerAppealCaseId: caseId,
      eventKind,
      actorMembershipId: actor.membershipId,
      ...(payload ? { eventPayload: payload } : {}),
    });
  }

  return {
    async getForDenial(actor, denialCaseId) {
      const head = await withOrgContext(db, actor, async (tx) => {
        const denial = await loadDenial(tx, actor, denialCaseId);
        return { claimId: denial.claimId, advice: await adviceOf(tx, denial.remittanceLineId) };
      });
      const { advice } = head;
      const patientId = await patientOfClaim(ports.sources, actor.organizationId, head.claimId);
      const refusal = checkPayerKind(advice?.payerKind);
      // The seam is called outside any transaction; failing closed reads as "not resolved", never a guessed payer.
      const payer = advice ? await payers.resolve(actor.organizationId, advice.payerId) : null;
      const payerUnresolved = advice !== null && payer === null;
      const looked =
        advice && refusal === null && payer
          ? await withOrgContext(db, actor, (tx) =>
              pathFor(tx, advice.payerId, programOf(payer.kind), null),
            )
          : null;
      const cases = await withOrgContext(db, actor, (tx) =>
        casesOfDenial(tx, actor, denialCaseId, patientId),
      );
      const found = looked && looked.resolution.kind !== "none" ? looked : null;
      const verified = found?.resolution.kind === "path";
      const pathPrompt =
        refusal !== null
          ? null
          : payerUnresolved
            ? PAYER_UNRESOLVED_PROMPT
            : found === null
              ? NO_PATH_PROMPT
              : verified
                ? null
                : AWAITING_VERIFICATION_PROMPT;
      return {
        denialCaseId,
        payerId: advice?.payerId ?? null,
        payerName: payer?.name ?? null,
        payerKind: payer?.kind ?? null,
        adviceKind: advice?.payerKind ?? null,
        refusal,
        maHint: payer?.kind === "medicare_advantage",
        payerUnresolved,
        patientId,
        patientAttribution: patientId ? ("claim" as const) : ("unattributed" as const),
        path:
          found && found.resolution.kind !== "none"
            ? {
                id: found.resolution.path.id,
                status: found.resolution.path.status,
                verified,
                revision: found.resolution.path.revision,
                program: found.resolution.path.program,
                levels: found.levels.map((l) => ({
                  ordinal: l.ordinal,
                  levelKind: l.levelKind,
                  levelLabel: l.levelLabel,
                  whoFiles: l.whoFiles,
                  windowComplete: levelWindow(l) !== null,
                })),
              }
            : null,
        pathPrompt,
        cases,
      };
    },

    async getCase(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(PC.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(PC)
          .where(scope ? and(eq(PC.id, id), scope) : eq(PC.id, id))
          .limit(1);
        if (!rows[0]) return null;
        const recorded = await tx
          .select()
          .from(RD)
          .where(eq(RD.payerAppealCaseId, id))
          .orderBy(asc(RD.dueOn));
        const statuses = await pathStatuses(tx, rows);
        const patientId = await patientOfClaim(
          ports.sources,
          actor.organizationId,
          rows[0].claimId,
        );
        return caseView(rows[0], recorded, new Date(), {
          pathStatus: rows[0].pathId ? statuses.get(rows[0].pathId) : undefined,
          patientId,
        });
      });
    },

    async open(actor, denialCaseId, input) {
      const day = input.noticeDate;
      if (day !== undefined && (!isRealDay(day) || day > noticeDayOf(new Date()))) {
        throw unprocessable(
          "NOTICE_DATE_INVALID",
          "the notice date must be a real date, not in the future",
        );
      }
      // The payer directory is read BEFORE the transaction opens (a slow seam must not hold row locks); the transaction
      // re-reads the advice and refuses if the payer moved in between.
      const pre = await withOrgContext(db, actor, async (tx) => {
        const denial = await loadDenial(tx, actor, denialCaseId);
        return adviceOf(tx, denial.remittanceLineId);
      });
      const preRefusal = checkPayerKind(pre?.payerKind);
      if (preRefusal || !pre) {
        throw conflict(
          preRefusal ?? "NO_PAYER_ADVICE",
          KIND_MESSAGES[preRefusal ?? "NO_PAYER_ADVICE"],
        );
      }
      const seamPayer = await payers.resolve(actor.organizationId, pre.payerId);
      // No program is defaulted when the payer cannot be resolved: an unresolved payer needs an explicit program.
      if (input.program === undefined && !seamPayer) {
        throw unprocessable("PAYER_UNRESOLVED", PAYER_UNRESOLVED_PROMPT);
      }
      const program = input.program ?? programOf(seamPayer?.kind ?? "other");
      if (program !== "commercial" && program !== "medicare_advantage") {
        throw unprocessable(
          "PROGRAM_INVALID",
          "the program must be commercial or medicare_advantage",
        );
      }
      if (seamPayer && !programMatchesKind(program, seamPayer.kind)) {
        throw unprocessable(
          "PROGRAM_KIND_MISMATCH",
          "the program does not match the payer's type in the payer directory",
        );
      }
      try {
        return await withOrgContext(db, actor, async (tx) => {
          const denial = await loadDenial(tx, actor, denialCaseId);
          const advice = await adviceOf(tx, denial.remittanceLineId);
          if (!advice || advice.payerId !== pre.payerId || advice.payerKind !== pre.payerKind) {
            throw conflict("PAYER_CHANGED", "the denial's payer changed; reload and try again");
          }
          let prior: typeof PC.$inferSelect | undefined;
          if (input.priorLevelCaseId) {
            prior = (
              await tx.select().from(PC).where(eq(PC.id, input.priorLevelCaseId)).limit(1)
            )[0];
            if (!prior || prior.denialCaseId !== denialCaseId)
              throw new NotFoundError("prior payer appeal level");
            if (prior.state !== "decided" && prior.state !== "closed") {
              throw conflict(
                "PRIOR_LEVEL_OPEN",
                "the prior level must be decided before the next level opens",
              );
            }
          }
          const { resolution, levels } = await pathFor(
            tx,
            advice.payerId,
            program,
            clean(input.contractLabel),
          );
          const wantedOrdinal =
            input.levelOrdinal ?? (prior?.levelOrdinal != null ? prior.levelOrdinal + 1 : 1);
          // A draft path supplies the level's name and kind, never a window: no deadline is derived from an unverified path.
          const pathLevel =
            resolution.kind !== "none"
              ? levels.find((l) => l.ordinal === wantedOrdinal)
              : undefined;
          if (resolution.kind !== "none" && !pathLevel && input.levelLabel === undefined) {
            throw unprocessable(
              "LEVEL_NOT_IN_PATH",
              "the recorded path has no such level; name the level you are filing",
            );
          }
          const openRefusal = checkPayerOpen({
            hasPathLevel: pathLevel !== undefined,
            levelLabel: input.levelLabel,
            levelKind: input.levelKind,
          });
          if (openRefusal) throw unprocessable(openRefusal, OPEN_MESSAGES[openRefusal]);

          const window = pathLevel && resolution.kind === "path" ? levelWindow(pathLevel) : null;
          const derived = derivePayerLevelDeadline(
            window,
            day ?? null,
            await zonesFor(tx, denial.providerEntityId),
          );
          const inserted = await tx
            .insert(PC)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: denial.providerEntityId,
              denialCaseId,
              claimId: denial.claimId,
              payerId: advice.payerId,
              program,
              pathId: pathLevel && resolution.kind !== "none" ? resolution.path.id : null,
              pathRevision:
                pathLevel && resolution.kind !== "none" ? resolution.path.revision : null,
              levelOrdinal: pathLevel ? pathLevel.ordinal : null,
              levelKind: pathLevel ? pathLevel.levelKind : (input.levelKind as string),
              levelLabel: (pathLevel ? pathLevel.levelLabel : (input.levelLabel as string)).trim(),
              windowDays: window?.windowDays ?? null,
              anchorKind: window?.anchorKind ?? null,
              receiptPresumptionDays: window?.receiptPresumptionDays ?? null,
              dayBasis: window?.dayBasis ?? null,
              roll: window?.roll ?? null,
              decisionDays: pathLevel?.decisionDays ?? null,
              priorLevelCaseId: prior?.id ?? null,
              state: "draft",
              noticeDatedOn: day ?? null,
              deadlineAt: derived?.deadlineAt ?? null,
              deadlineZone: derived?.zone ?? null,
              deadlineSource: derived ? "path_rule" : "none",
              // The path's verified state is snapshotted at opening, whether or not a deadline is computed yet, so a
              // notice date typed later keeps the same badge.
              windowVerified: resolution.kind === "path",
              createdByMembershipId: actor.membershipId,
            })
            .returning({ id: PC.id, version: PC.version, deadlineSource: PC.deadlineSource });
          const id = inserted[0]!.id;
          await event(tx, actor, id, "created", {
            levelOrdinal: pathLevel?.ordinal ?? null,
            deadlineSource: inserted[0]!.deadlineSource,
          });
          if (canTransitionDenial(denial.state, "appealed")) {
            await tx
              .update(DC)
              .set({ state: "appealed", version: denial.version + 1 })
              .where(and(eq(DC.id, denialCaseId), eq(DC.version, denial.version)));
          }
          return inserted[0]!;
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw conflict(
            "PAYER_APPEAL_IN_FLIGHT",
            "a level of this denial's payer appeal is already in progress",
          );
        }
        throw e;
      }
    },

    async recordNotice(actor, id, noticeDate, ifMatch) {
      if (!isRealDay(noticeDate) || noticeDate > noticeDayOf(new Date())) {
        throw unprocessable(
          "NOTICE_DATE_INVALID",
          "the notice date must be a real date, not in the future",
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(PC.providerEntityId, actor.providerEntityScope);
        const cur = (
          await tx
            .select()
            .from(PC)
            .where(scope ? and(eq(PC.id, id), scope) : eq(PC.id, id))
            .limit(1)
        )[0];
        if (!cur) throw new NotFoundError("payer appeal case");
        if (cur.state !== "draft")
          throw conflict("INVALID_STATE", "the notice date can be recorded only on a draft level");
        if (cur.deadlineSource === "path_rule") {
          throw conflict(
            "DEADLINE_FROZEN",
            "this level's deadline is already computed and cannot move",
          );
        }
        const derived = derivePayerLevelDeadline(
          windowOf(cur),
          noticeDate,
          await zonesFor(tx, cur.providerEntityId),
        );
        const updated = await tx
          .update(PC)
          .set({
            noticeDatedOn: noticeDate,
            ...(derived
              ? {
                  deadlineAt: derived.deadlineAt,
                  deadlineZone: derived.zone,
                  deadlineSource: "path_rule",
                }
              : {}),
            version: sql`${PC.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(PC.id, id),
              eq(PC.version, ifMatch),
              eq(PC.state, "draft"),
              eq(PC.deadlineSource, "none"),
            ),
          )
          .returning({ id: PC.id, version: PC.version, deadlineSource: PC.deadlineSource });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await event(tx, actor, id, "notice_recorded", {
          deadlineSource: updated[0].deadlineSource,
        });
        return updated[0];
      });
    },

    async move(actor, id, move, input, ifMatch) {
      const to = MOVE_TARGET[move];
      if (move === "decide") {
        const refusal = checkPayerDecision(input);
        if (refusal) throw unprocessable(refusal, DECISION_MESSAGES[refusal]);
      }
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(PC.providerEntityId, actor.providerEntityScope);
        const cur = (
          await tx
            .select()
            .from(PC)
            .where(scope ? and(eq(PC.id, id), scope) : eq(PC.id, id))
            .limit(1)
        )[0];
        if (!cur) throw new NotFoundError("payer appeal case");
        if (!canTransitionPayerAppeal(cur.state as PayerAppealState, to)) {
          throw conflict("INVALID_STATE", `a ${cur.state} level cannot move to ${to}`);
        }
        const reviewer = clean(input.externalReviewerName);
        if (reviewer && cur.levelKind !== "external_review") {
          throw unprocessable(
            "REVIEWER_NOT_EXTERNAL",
            "a reviewer name belongs only on an external review level",
          );
        }
        const now = new Date();
        const updated = await tx
          .update(PC)
          .set({
            state: to,
            ...(input.payerReference !== undefined
              ? { payerReference: clean(input.payerReference) }
              : {}),
            ...(reviewer ? { externalReviewerName: reviewer } : {}),
            ...(move === "submit" ? { submittedAt: now } : {}),
            ...(move === "decide"
              ? {
                  decisionOutcome: input.outcome,
                  dispositionKind: input.dispositionKind ?? null,
                  dispositionNote: clean(input.dispositionNote),
                  decidedAt: now,
                }
              : {}),
            ...(move === "close" || move === "withdraw" ? { closedAt: now } : {}),
            version: sql`${PC.version} + 1`,
            updatedAt: now,
          })
          .where(and(eq(PC.id, id), eq(PC.version, ifMatch), eq(PC.state, cur.state)))
          .returning({ id: PC.id, version: PC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await event(tx, actor, id, to, move === "decide" ? { outcome: input.outcome } : undefined);
        return updated[0];
      });
    },
  };
}
