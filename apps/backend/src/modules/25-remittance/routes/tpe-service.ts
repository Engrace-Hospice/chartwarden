// apps/backend/src/modules/25-remittance/routes/tpe-service.ts — M25 milestone 5: the TPE (Targeted Probe and
// Educate) program tracker. It RECORDS what the MAC sends: a program per provider entity and MAC, up to 3 rounds,
// each round's results letter (the MAC's error rate and result are official), education date, sampled claims linked
// to their ADRs, and the outcome (relief or referral, typed from the letter). Nothing is filed and nothing is
// computed that the rules leave open: per-MAC exit thresholds are per-organization rule data with NO default, and a
// round snapshots the threshold in force when its results are first recorded. Every command runs under
// `withOrgContext` (RLS) inside the actor's provider-entity scope; every change is If-Match. There are no events or
// alerts: the write-audit triggers are the trail, and ADR deadlines already alert through the ADR flow.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError, ChartWardenError } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  TPE_MAX_ROUNDS,
  TPE_REFERRAL_KINDS,
  type TpeProgramState,
  type TpeRuleRow,
  canTransitionTpeProgram,
  intervalWarning,
  noticeDayOf,
  parseNoticeDay,
  resolveTpeThreshold,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import { isUniqueViolation } from "./denial-route-service";
import { type ClaimFactsPort, m23ClaimFactsPort } from "./remittance-ports";
import { providerEntityScopeCondition } from "./scope";
import {
  type TpeClaimRow,
  type TpeProgramDetail,
  type TpeProgramRow,
  type TpeProgramSummary,
  type TpeRoundRow,
  detailOfProgram,
  summarizeProgram,
} from "./tpe-view";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface TpeProgramCreateInput {
  readonly providerEntityId: string;
  readonly macName: string;
  readonly openedOn: string;
}

export interface TpeResultsInput {
  /** The date on the MAC's results letter. */
  readonly resultsOn: string;
  /** The error rate the letter states, or null when the letter gives none. */
  readonly macErrorRatePct: number | null;
  readonly macResult: string;
}

export interface TpeEducationInput {
  readonly educationOn: string | null;
  readonly note?: string | null;
}

export interface TpeClaimInput {
  /** undefined = leave the link as it is; null = unlink. */
  readonly adrCaseId?: string | null;
  readonly result?: string;
}

export interface TpeOutcomeInput {
  readonly kind: "compliant" | "referred";
  readonly outcomeOn: string;
  /** Typed from the CMS letter; only on a compliant outcome. */
  readonly reliefUntil?: string | null;
  /** Required (non-empty) on a referral. */
  readonly referralKinds?: readonly string[];
}

export interface TpeRuleInput {
  readonly macName: string;
  readonly exitErrorRatePct: number;
  readonly sourceNote?: string;
  readonly verifiedOn?: string;
  readonly effectiveFrom?: string;
}

export interface TpeRuleView {
  readonly id: string;
  readonly macName: string;
  readonly exitErrorRatePct: number;
  readonly sourceNote: string | null;
  readonly verifiedOn: string | null;
  readonly effectiveFrom: string;
  readonly version: number;
}

type Versioned = { id: string; version: number };

export interface TpeService {
  listPrograms(
    actor: M25ReadActor,
    filter: { state?: string; providerEntityId?: string },
    limit: number,
  ): Promise<{ items: TpeProgramSummary[] }>;
  getProgram(actor: M25ReadActor, id: string): Promise<TpeProgramDetail | null>;
  createProgram(actor: M25WriteActor, input: TpeProgramCreateInput): Promise<Versioned>;
  createRound(
    actor: M25WriteActor,
    programId: string,
    noticeOn: string,
    ifMatch: number,
  ): Promise<Versioned & { roundNumber: number; warnings: string[] }>;
  setResults(
    actor: M25WriteActor,
    roundId: string,
    input: TpeResultsInput,
    ifMatch: number,
  ): Promise<Versioned>;
  setEducation(
    actor: M25WriteActor,
    roundId: string,
    input: TpeEducationInput,
    ifMatch: number,
  ): Promise<Versioned>;
  upsertClaim(
    actor: M25WriteActor,
    roundId: string,
    claimId: string,
    input: TpeClaimInput,
    ifMatch: number,
  ): Promise<Versioned>;
  recordOutcome(
    actor: M25WriteActor,
    programId: string,
    input: TpeOutcomeInput,
    ifMatch: number,
  ): Promise<Versioned>;
  closeProgram(actor: M25WriteActor, programId: string, ifMatch: number): Promise<Versioned>;
  listRules(actor: M25ReadActor): Promise<{ items: TpeRuleView[] }>;
  /** `ifMatch` guards an UPDATE of an existing rule (stale -> 409); creating a rule needs none. */
  upsertRule(actor: M25WriteActor, input: TpeRuleInput, ifMatch?: number): Promise<Versioned>;
}

export interface TpeServicePorts {
  readonly claims?: ClaimFactsPort;
  /**
   * True when the provider entity exists in the organization (M1 owns the table, so it is read through the
   * Foundation reader, not this module's schema). Required: without it a program could point at nothing.
   */
  readonly providerEntityExists: (
    tx: unknown,
    organizationId: string,
    providerEntityId: string,
  ) => Promise<boolean>;
}

const CLOSED = (): ChartWardenError =>
  new ChartWardenError("TPE_PROGRAM_CLOSED", "this TPE program is closed and cannot change", 409);

/** True when `day` is a real YYYY-MM-DD calendar date. */
const isRealDay = (day: string): boolean => {
  try {
    parseNoticeDay(day);
    return true;
  } catch {
    return false;
  }
};

function requireRealDay(day: string, code: string, what: string): void {
  if (!isRealDay(day)) throw new ChartWardenError(code, `${what} is not a real date`, 422);
}

function requireNotFuture(day: string, code: string, what: string): void {
  if (day > noticeDayOf(new Date())) {
    throw new ChartWardenError(code, `${what} cannot be in the future`, 422);
  }
}

/** A percentage with at most 2 decimals, inside 0 to 100. */
const isPct = (n: number): boolean =>
  Number.isFinite(n) && n >= 0 && n <= 100 && Math.round(n * 100) / 100 === n;

export function buildDrizzleTpeService(db: DbClient, ports: TpeServicePorts): TpeService {
  const claims = ports.claims ?? m23ClaimFactsPort;
  const PG = schema.tpeProgram;
  const RD = schema.tpeRound;
  const CL = schema.tpeRoundClaim;
  const RU = schema.tpeMacRule;
  const ADR = schema.adrCase;

  const programRow = (r: typeof PG.$inferSelect): TpeProgramRow => ({
    id: r.id,
    providerEntityId: r.providerEntityId,
    macName: r.macName,
    openedOn: r.openedOn,
    state: r.state,
    outcomeOn: r.outcomeOn,
    reliefUntil: r.reliefUntil,
    referralKinds: r.referralKinds,
    version: r.version,
  });

  /** Rules in force today (a future-dated rule does not apply yet). */
  async function rulesInForce(tx: Tx): Promise<TpeRuleRow[]> {
    const rows = await tx
      .select()
      .from(RU)
      .where(lte(RU.effectiveFrom, noticeDayOf(new Date())))
      .orderBy(desc(RU.effectiveFrom));
    return rows.map((r) => ({
      macName: r.macName,
      exitErrorRatePct: Number(r.exitErrorRatePct),
      verifiedOn: r.verifiedOn,
      sourceNote: r.sourceNote,
      effectiveFrom: r.effectiveFrom,
    }));
  }

  async function loadProgram(tx: Tx, actor: M25ReadActor, id: string) {
    const scope = providerEntityScopeCondition(PG.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(PG)
      .where(scope ? and(eq(PG.id, id), scope) : eq(PG.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("TPE program");
    return rows[0];
  }

  /** A round plus its program, the program inside the actor's scope; only an ACTIVE program takes round writes. */
  async function loadRound(tx: Tx, actor: M25ReadActor, roundId: string) {
    const rows = await tx.select().from(RD).where(eq(RD.id, roundId)).limit(1);
    if (!rows[0]) throw new NotFoundError("TPE round");
    const program = await loadProgram(tx, actor, rows[0].tpeProgramId).catch(() => {
      throw new NotFoundError("TPE round");
    });
    if (program.state === "closed") throw CLOSED();
    // A recorded outcome is final: results, education and sampled claims no longer change once it is in.
    if (program.state !== "active") {
      throw new ChartWardenError(
        "TPE_PROGRAM_NOT_ACTIVE",
        `a ${program.state} program's rounds can no longer change`,
        409,
      );
    }
    return { round: rows[0], program };
  }

  /** One guarded round update pinned to the caller's version; a concurrent writer makes it a 409. */
  async function updateRound(
    tx: Tx,
    round: typeof RD.$inferSelect,
    ifMatch: number,
    fields: Partial<typeof RD.$inferInsert>,
  ): Promise<Versioned> {
    const updated = await tx
      .update(RD)
      .set({ ...fields, version: sql`${RD.version} + 1` })
      .where(and(eq(RD.id, round.id), eq(RD.version, ifMatch)))
      .returning({ id: RD.id, version: RD.version });
    if (!updated[0]) throw new VersionConflictError(round.version);
    return updated[0];
  }

  /** The rounds, claims and ADR states of the given programs, loaded in three queries. */
  async function loadChildren(tx: Tx, programIds: string[]) {
    if (programIds.length === 0)
      return { rounds: [] as TpeRoundRow[], claimRows: [] as TpeClaimRow[] };
    const rounds = await tx.select().from(RD).where(inArray(RD.tpeProgramId, programIds));
    const roundIds = rounds.map((r) => r.id);
    const claimRows =
      roundIds.length === 0
        ? []
        : await tx
            .select()
            .from(CL)
            .where(inArray(CL.tpeRoundId, roundIds))
            .orderBy(asc(CL.createdAt));
    return { rounds, claimRows };
  }

  return {
    async listPrograms(actor, filter, limit) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          providerEntityScopeCondition(
            PG.providerEntityId,
            actor.providerEntityScope,
            filter.providerEntityId,
          ),
          filter.state ? eq(PG.state, filter.state) : undefined,
        ].filter((c) => c !== undefined);
        const programs = await tx
          .select()
          .from(PG)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(desc(PG.createdAt), asc(PG.id))
          .limit(limit);
        const { rounds, claimRows } = await loadChildren(
          tx,
          programs.map((p) => p.id),
        );
        const rules = await rulesInForce(tx);
        return {
          items: programs.map((p) =>
            summarizeProgram(
              programRow(p),
              rounds.filter((r) => r.tpeProgramId === p.id),
              claimRows,
              rules,
            ),
          ),
        };
      });
    },

    async getProgram(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(PG.providerEntityId, actor.providerEntityScope);
        const found = await tx
          .select()
          .from(PG)
          .where(scope ? and(eq(PG.id, id), scope) : eq(PG.id, id))
          .limit(1);
        if (!found[0]) return null;
        const { rounds, claimRows } = await loadChildren(tx, [id]);
        const adrIds = [...new Set(claimRows.flatMap((c) => (c.adrCaseId ? [c.adrCaseId] : [])))];
        const adrScope = providerEntityScopeCondition(
          ADR.providerEntityId,
          actor.providerEntityScope,
        );
        const adrRows =
          adrIds.length === 0
            ? []
            : await tx
                .select({ id: ADR.id, state: ADR.state })
                .from(ADR)
                .where(adrScope ? and(inArray(ADR.id, adrIds), adrScope) : inArray(ADR.id, adrIds));
        return detailOfProgram(
          programRow(found[0]),
          rounds,
          claimRows,
          await rulesInForce(tx),
          new Map(adrRows.map((a) => [a.id, a.state])),
        );
      });
    },

    async createProgram(actor, input) {
      const macName = input.macName.trim();
      if (!macName) throw new ChartWardenError("INVALID_MAC", "the MAC name is required", 422);
      requireRealDay(input.openedOn, "INVALID_OPENED_ON", "the program start date");
      requireNotFuture(input.openedOn, "OPENED_ON_IN_FUTURE", "the program start date");
      const scope = actor.providerEntityScope;
      if (scope !== undefined && !scope.includes(input.providerEntityId)) {
        throw new NotFoundError("provider entity");
      }
      return withOrgContext(db, actor, async (tx) => {
        if (!(await ports.providerEntityExists(tx, actor.organizationId, input.providerEntityId))) {
          throw new NotFoundError("provider entity");
        }
        try {
          const inserted = await tx
            .insert(PG)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: input.providerEntityId,
              macName,
              openedOn: input.openedOn,
            })
            .returning({ id: PG.id, version: PG.version });
          return inserted[0]!;
        } catch (e) {
          if (isUniqueViolation(e)) {
            throw new ChartWardenError(
              "TPE_PROGRAM_ACTIVE",
              "this provider entity already has an active TPE program with that MAC",
              409,
            );
          }
          throw e;
        }
      });
    },

    async createRound(actor, programId, noticeOn, ifMatch) {
      requireRealDay(noticeOn, "INVALID_NOTICE_DATE", "the round notice date");
      requireNotFuture(noticeOn, "NOTICE_DATE_IN_FUTURE", "the round notice date");
      return withOrgContext(db, actor, async (tx) => {
        const program = await loadProgram(tx, actor, programId);
        if (program.state === "closed") throw CLOSED();
        if (program.state !== "active") {
          throw new ChartWardenError(
            "TPE_PROGRAM_NOT_ACTIVE",
            `a ${program.state} program takes no further rounds`,
            409,
          );
        }
        const existing = await tx
          .select()
          .from(RD)
          .where(eq(RD.tpeProgramId, programId))
          .orderBy(asc(RD.roundNumber));
        if (existing.length >= TPE_MAX_ROUNDS) {
          throw new ChartWardenError(
            "TPE_ROUND_LIMIT",
            `a TPE program has at most ${TPE_MAX_ROUNDS} rounds`,
            409,
          );
        }
        const prev = existing[existing.length - 1];
        if (noticeOn < program.openedOn) {
          throw new ChartWardenError(
            "NOTICE_BEFORE_PROGRAM",
            "the round notice cannot be dated before the program opened",
            422,
          );
        }
        if (prev && noticeOn < prev.noticeOn) {
          throw new ChartWardenError(
            "NOTICE_BEFORE_PREVIOUS_ROUND",
            `the round notice cannot be dated before round ${prev.roundNumber}'s notice`,
            422,
          );
        }
        if (prev && prev.resultsOn === null) {
          throw new ChartWardenError(
            "TPE_PREVIOUS_ROUND_OPEN",
            `record the results of round ${prev.roundNumber} before starting the next round`,
            409,
          );
        }
        // The program version is the aggregate's lock: two people adding a round cannot both succeed.
        const locked = await tx
          .update(PG)
          .set({ version: sql`${PG.version} + 1` })
          .where(and(eq(PG.id, programId), eq(PG.version, ifMatch), eq(PG.state, "active")))
          .returning({ id: PG.id });
        if (!locked[0]) throw new VersionConflictError(program.version);
        const roundNumber = (prev?.roundNumber ?? 0) + 1;
        try {
          const inserted = await tx
            .insert(RD)
            .values({
              organizationId: actor.organizationId,
              tpeProgramId: programId,
              roundNumber,
              noticeOn,
            })
            .returning({ id: RD.id, version: RD.version });
          const warning = intervalWarning(prev?.educationOn ?? null, noticeOn);
          return { ...inserted[0]!, roundNumber, warnings: warning ? [warning] : [] };
        } catch (e) {
          if (isUniqueViolation(e)) throw new VersionConflictError(null);
          throw e;
        }
      });
    },

    async setResults(actor, roundId, input, ifMatch) {
      requireRealDay(input.resultsOn, "INVALID_RESULTS_DATE", "the results letter date");
      requireNotFuture(input.resultsOn, "RESULTS_DATE_IN_FUTURE", "the results letter date");
      if (input.macResult !== "compliant" && input.macResult !== "non_compliant") {
        throw new ChartWardenError(
          "INVALID_MAC_RESULT",
          "the result must be compliant or non_compliant",
          422,
        );
      }
      if (input.macErrorRatePct !== null && !isPct(input.macErrorRatePct)) {
        throw new ChartWardenError(
          "INVALID_ERROR_RATE",
          "the error rate is a percentage from 0 to 100 with at most 2 decimals",
          422,
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        const { round, program } = await loadRound(tx, actor, roundId);
        if (input.resultsOn < round.noticeOn) {
          throw new ChartWardenError(
            "RESULTS_BEFORE_NOTICE",
            "the results letter cannot be dated before the round notice",
            422,
          );
        }
        // The threshold is snapshotted when the results are first recorded, so a later rule edit never rewrites
        // history. A round recorded with no rule ("none") is re-resolved on a later edit, so a rule added since
        // is picked up; a round that already holds a rule's threshold keeps it. Rules apply as of the letter's date.
        const keep = round.thresholdSource === "org_rule";
        const resolved = keep
          ? null
          : resolveTpeThreshold(await rulesInForce(tx), program.macName, input.resultsOn);
        return updateRound(tx, round, ifMatch, {
          resultsOn: input.resultsOn,
          macErrorRatePct: input.macErrorRatePct === null ? null : input.macErrorRatePct.toFixed(2),
          macResult: input.macResult,
          ...(resolved
            ? {
                thresholdPct: resolved.pct === null ? null : resolved.pct.toFixed(2),
                thresholdSource: resolved.source,
                thresholdVerified: resolved.verified,
              }
            : {}),
        });
      });
    },

    async setEducation(actor, roundId, input, ifMatch) {
      if (input.educationOn !== null) {
        requireRealDay(input.educationOn, "INVALID_EDUCATION_DATE", "the education date");
      }
      return withOrgContext(db, actor, async (tx) => {
        const { round } = await loadRound(tx, actor, roundId);
        if (input.educationOn !== null && input.educationOn < round.noticeOn) {
          throw new ChartWardenError(
            "EDUCATION_BEFORE_NOTICE",
            "education cannot be dated before the round notice",
            422,
          );
        }
        return updateRound(tx, round, ifMatch, {
          educationOn: input.educationOn,
          educationNote: input.educationOn === null ? null : input.note?.trim() || null,
        });
      });
    },

    async upsertClaim(actor, roundId, claimId, input, ifMatch) {
      if (input.result !== undefined && !["pending", "no_error", "error"].includes(input.result)) {
        throw new ChartWardenError(
          "INVALID_CLAIM_RESULT",
          "the claim result must be pending, no_error or error",
          422,
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        const { round, program } = await loadRound(tx, actor, roundId);
        // The claim must exist for THIS org (RLS) and belong to the program's provider entity.
        const claim = await claims.byId(tx, claimId);
        if (!claim || claim.providerEntityId !== program.providerEntityId) {
          throw new NotFoundError("claim");
        }
        // A linked ADR must be visible under RLS, on the same claim, and inside the actor's provider scope; a
        // foreign key alone ignores RLS, so another tenant's id would otherwise be accepted.
        if (input.adrCaseId) {
          const adrScope = providerEntityScopeCondition(
            ADR.providerEntityId,
            actor.providerEntityScope,
          );
          const adr = await tx
            .select({ claimId: ADR.claimId })
            .from(ADR)
            .where(
              adrScope ? and(eq(ADR.id, input.adrCaseId), adrScope) : eq(ADR.id, input.adrCaseId),
            )
            .limit(1);
          if (!adr[0] || adr[0].claimId !== claimId) throw new NotFoundError("ADR case");
        }
        // The round's version is the lock for its sampled claims, so two people cannot overwrite each other.
        const locked = await updateRound(tx, round, ifMatch, {});
        const fields = {
          ...(input.adrCaseId !== undefined ? { adrCaseId: input.adrCaseId } : {}),
          ...(input.result !== undefined ? { result: input.result } : {}),
        };
        const existing = await tx
          .select({ id: CL.id })
          .from(CL)
          .where(and(eq(CL.tpeRoundId, roundId), eq(CL.claimId, claimId)))
          .limit(1);
        try {
          if (existing[0]) {
            if (Object.keys(fields).length > 0) {
              await tx
                .update(CL)
                .set({ ...fields, version: sql`${CL.version} + 1` })
                .where(eq(CL.id, existing[0].id));
            }
          } else {
            await tx.insert(CL).values({
              organizationId: actor.organizationId,
              tpeRoundId: roundId,
              claimId,
              ...fields,
            });
          }
        } catch (e) {
          if (isUniqueViolation(e)) throw new VersionConflictError(null);
          throw e;
        }
        return locked;
      });
    },

    async recordOutcome(actor, programId, input, ifMatch) {
      requireRealDay(input.outcomeOn, "INVALID_OUTCOME_DATE", "the outcome date");
      requireNotFuture(input.outcomeOn, "OUTCOME_DATE_IN_FUTURE", "the outcome date");
      const kinds = [...new Set(input.referralKinds ?? [])];
      if (kinds.some((k) => !(TPE_REFERRAL_KINDS as readonly string[]).includes(k))) {
        throw new ChartWardenError("INVALID_REFERRAL_KIND", "a referral type is not recognised", 422);
      }
      if (input.kind === "referred" && kinds.length === 0) {
        throw new ChartWardenError(
          "REFERRAL_KIND_REQUIRED",
          "name at least one referral type from the CMS letter",
          422,
        );
      }
      if (input.kind === "compliant" && kinds.length > 0) {
        throw new ChartWardenError(
          "REFERRAL_ON_COMPLIANT",
          "a compliant outcome carries no referral types",
          422,
        );
      }
      if (input.kind === "referred" && input.reliefUntil) {
        throw new ChartWardenError("RELIEF_ON_REFERRAL", "a referral carries no relief end date", 422);
      }
      if (input.reliefUntil) {
        requireRealDay(input.reliefUntil, "INVALID_RELIEF_DATE", "the relief end date");
        if (input.reliefUntil < input.outcomeOn) {
          throw new ChartWardenError(
            "RELIEF_BEFORE_OUTCOME",
            "the relief end date cannot be before the outcome date",
            422,
          );
        }
      }
      return withOrgContext(db, actor, async (tx) => {
        const program = await loadProgram(tx, actor, programId);
        if (program.state === "closed") throw CLOSED();
        if (input.outcomeOn < program.openedOn) {
          throw new ChartWardenError(
            "OUTCOME_BEFORE_PROGRAM",
            "the outcome cannot be dated before the program opened",
            422,
          );
        }
        if (!canTransitionTpeProgram(program.state as TpeProgramState, input.kind)) {
          throw new ChartWardenError(
            "INVALID_TRANSITION",
            `cannot transition from '${program.state}' to '${input.kind}'`,
            409,
          );
        }
        const updated = await tx
          .update(PG)
          .set({
            state: input.kind,
            outcomeOn: input.outcomeOn,
            reliefUntil: input.kind === "compliant" ? (input.reliefUntil ?? null) : null,
            referralKinds: input.kind === "referred" ? kinds : [],
            version: sql`${PG.version} + 1`,
          })
          .where(and(eq(PG.id, programId), eq(PG.version, ifMatch), eq(PG.state, program.state)))
          .returning({ id: PG.id, version: PG.version });
        if (!updated[0]) throw new VersionConflictError(program.version);
        return updated[0];
      });
    },

    async closeProgram(actor, programId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const program = await loadProgram(tx, actor, programId);
        if (program.state === "closed") throw CLOSED();
        const updated = await tx
          .update(PG)
          .set({ state: "closed", version: sql`${PG.version} + 1` })
          .where(and(eq(PG.id, programId), eq(PG.version, ifMatch), eq(PG.state, program.state)))
          .returning({ id: PG.id, version: PG.version });
        if (!updated[0]) throw new VersionConflictError(program.version);
        return updated[0];
      });
    },

    async listRules(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(RU).orderBy(asc(RU.macName), desc(RU.effectiveFrom));
        return {
          items: rows.map((r) => ({
            id: r.id,
            macName: r.macName,
            exitErrorRatePct: Number(r.exitErrorRatePct),
            sourceNote: r.sourceNote,
            verifiedOn: r.verifiedOn,
            effectiveFrom: r.effectiveFrom,
            version: r.version,
          })),
        };
      });
    },

    async upsertRule(actor, input, ifMatch) {
      const macName = input.macName.trim();
      if (!macName) throw new ChartWardenError("INVALID_MAC", "the MAC name is required", 422);
      if (!isPct(input.exitErrorRatePct)) {
        throw new ChartWardenError(
          "INVALID_THRESHOLD",
          "the exit error rate is a percentage from 0 to 100 with at most 2 decimals",
          422,
        );
      }
      for (const day of [input.verifiedOn, input.effectiveFrom]) {
        if (day !== undefined) requireRealDay(day, "INVALID_RULE_DATE", "a rule date");
      }
      return withOrgContext(db, actor, async (tx) => {
        const effectiveFrom = input.effectiveFrom ?? noticeDayOf(new Date());
        const fields = {
          exitErrorRatePct: input.exitErrorRatePct.toFixed(2),
          sourceNote: input.sourceNote?.trim() || null,
          verifiedOn: input.verifiedOn ?? null,
        };
        // MAC names match case-insensitively, so "cgs" edits the "CGS" rule instead of adding a second one.
        const existing = await tx
          .select({ id: RU.id })
          .from(RU)
          .where(
            and(
              sql`lower(btrim(${RU.macName})) = ${macName.toLowerCase()}`,
              eq(RU.effectiveFrom, effectiveFrom),
            ),
          )
          .limit(1);
        if (existing[0]) {
          const updated = await tx
            .update(RU)
            .set({ ...fields, version: sql`${RU.version} + 1` })
            .where(
              ifMatch === undefined
                ? eq(RU.id, existing[0].id)
                : and(eq(RU.id, existing[0].id), eq(RU.version, ifMatch)),
            )
            .returning({ id: RU.id, version: RU.version });
          if (!updated[0]) throw new VersionConflictError(null);
          return updated[0];
        }
        try {
          const inserted = await tx
            .insert(RU)
            .values({ organizationId: actor.organizationId, macName, effectiveFrom, ...fields })
            .returning({ id: RU.id, version: RU.version });
          return inserted[0]!;
        } catch (e) {
          // Two edits raced past the check above; the unique index is the backstop.
          if (isUniqueViolation(e)) throw new VersionConflictError(null);
          throw e;
        }
      });
    },
  };
}
