// apps/backend/src/modules/25-remittance/routes/payer-appeal-path-service.ts - M25 milestone 12a-1: the organization's PAYER
// APPEAL PATHS. A path is DATA a person writes from a contract or notice (nothing is seeded, no platform default). It is
// born a draft; a SECOND membership verifies it, which activates and freezes it (the database trigger enforces the
// author != verifier rule atomically; the checks here only give a friendly error first). Edit = retire the draft and write
// a new one. The payer's name comes through the M40 seam (fail closed): an unresolved payer cannot be written or activated.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  type PathHeaderInput,
  type PathLevelInput,
  type PathRefusal,
  type PathVerifyRefusal,
  checkPathInput,
  checkPathVerify,
  noticeDayOf,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import { isUniqueViolation } from "./denial-route-service";
import { type PayerSeam, buildSeamPayerSeam } from "./payer-seam";

export interface PathLevelView extends PathLevelInput {
  readonly id: string;
  readonly ordinal: number;
}

export interface PathView {
  readonly id: string;
  readonly payerId: string;
  readonly payerName: string;
  readonly program: string;
  readonly contractLabel: string | null;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly sourceNote: string;
  readonly sourceDocumentId: string | null;
  readonly authoredByMembershipId: string;
  readonly verifiedOn: string | null;
  readonly verifiedByMembershipId: string | null;
  readonly supersedesPathId: string | null;
  readonly revision: number;
  readonly version: number;
  readonly levels: PathLevelView[];
}

export interface PathCreateInput extends PathHeaderInput {
  readonly sourceDocumentId?: string | null;
  readonly supersedesPathId?: string | null;
  readonly levels: readonly PathLevelInput[];
}

export interface PayerAppealPathService {
  listPaths(
    actor: M25ReadActor,
    filter: { payerId?: string; status?: string },
  ): Promise<{ items: PathView[] }>;
  getPath(actor: M25ReadActor, id: string): Promise<PathView | null>;
  createPath(
    actor: M25WriteActor,
    input: PathCreateInput,
  ): Promise<{ id: string; version: number }>;
  verifyPath(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  retirePath(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface PayerAppealPathPorts {
  readonly payers?: PayerSeam;
}

const unprocessable = (code: string, message: string) => new ChartWardenError(code, message, 422);

const PATH_MESSAGES: Readonly<Record<PathRefusal, string>> = {
  PROGRAM_INVALID: "the program must be commercial or medicare_advantage",
  EFFECTIVE_DATE_INVALID: "the effective date is not a real date",
  SOURCE_NOTE_REQUIRED: "say where this path came from (the contract, manual page or notice)",
  NO_LEVELS: "a path needs at least one level",
  TOO_MANY_LEVELS: "the path has too many levels",
  LEVEL_KIND_INVALID: "a level kind must be internal, external_review or other",
  LEVEL_LABEL_REQUIRED: "name each level as the contract names it",
  WHO_FILES_INVALID: "who files must be provider, member, either or unknown",
  LEVEL_SOURCE_NOTE_REQUIRED: "say where each level came from",
  WINDOW_INCOMPLETE:
    "a filing window needs its days, anchor and day basis together, or none of them",
  WINDOW_OUT_OF_RANGE: "the filing window must be a whole number of days within the allowed range",
  ANCHOR_INVALID: "the anchor is not one of the allowed kinds",
  BASIS_INVALID: "the day basis is not one of the allowed kinds",
  ROLL_REQUIRED: "a business-day basis needs a roll direction (none, back or forward)",
  ROLL_NOT_ALLOWED: "a roll direction applies only to a business-day basis",
  ROLL_INVALID: "the roll direction is not one of the allowed kinds",
  RECEIPT_OUT_OF_RANGE: "the receipt presumption must be a whole number of days within range",
  DECISION_DAYS_OUT_OF_RANGE: "the decision days must be a whole number of days within range",
  TEXT_TOO_LONG: "a text field is too long",
};

const VERIFY_MESSAGES: Readonly<Record<PathVerifyRefusal, string>> = {
  VERIFIER_IS_AUTHOR: "a path is verified by someone other than the person who wrote it",
  NOT_DRAFT: "only a draft path can be verified",
  NO_LEVELS: "a path with no levels cannot be activated",
};

const payerUnresolved = () =>
  unprocessable(
    "PAYER_UNRESOLVED",
    "the payer could not be resolved from the payer directory; try again, or pick the payer from the lookup",
  );

export function buildDrizzlePayerAppealPathService(
  db: DbClient,
  ports: PayerAppealPathPorts = {},
): PayerAppealPathService {
  const payers = ports.payers ?? buildSeamPayerSeam();
  const P = schema.payerAppealPath;
  const L = schema.payerAppealPathLevel;

  const levelView = (r: typeof L.$inferSelect): PathLevelView => ({
    id: r.id,
    ordinal: r.ordinal,
    levelKind: r.levelKind as PathLevelInput["levelKind"],
    levelLabel: r.levelLabel,
    whoFiles: r.whoFiles as PathLevelInput["whoFiles"],
    filingWindowDays: r.filingWindowDays,
    anchorKind: r.anchorKind as PathLevelInput["anchorKind"],
    receiptPresumptionDays: r.receiptPresumptionDays,
    dayBasis: r.dayBasis as PathLevelInput["dayBasis"],
    roll: r.roll as PathLevelInput["roll"],
    decisionDays: r.decisionDays,
    formLabel: r.formLabel,
    channelNote: r.channelNote,
    sourceNote: r.sourceNote,
  });

  const pathView = (r: typeof P.$inferSelect, levels: (typeof L.$inferSelect)[]): PathView => ({
    id: r.id,
    payerId: r.payerId,
    payerName: r.payerNameSnapshot,
    program: r.program,
    contractLabel: r.contractLabel,
    status: r.status,
    effectiveFrom: r.effectiveFrom,
    sourceNote: r.sourceNote,
    sourceDocumentId: r.sourceDocumentId,
    authoredByMembershipId: r.authoredByMembershipId,
    verifiedOn: r.verifiedOn,
    verifiedByMembershipId: r.verifiedByMembershipId,
    supersedesPathId: r.supersedesPathId,
    revision: r.revision,
    version: r.version,
    levels: levels.filter((l) => l.pathId === r.id).map(levelView),
  });

  async function loadPath(tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0], id: string) {
    const rows = await tx.select().from(P).where(eq(P.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundError("payer appeal path");
    return rows[0];
  }

  return {
    async listPaths(actor, filter) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          ...(filter.payerId ? [eq(P.payerId, filter.payerId)] : []),
          ...(filter.status ? [eq(P.status, filter.status)] : []),
        ];
        const rows = await tx
          .select()
          .from(P)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(desc(P.effectiveFrom), desc(P.createdAt))
          .limit(200);
        const levels =
          rows.length > 0
            ? await tx
                .select()
                .from(L)
                .where(
                  inArray(
                    L.pathId,
                    rows.map((r) => r.id),
                  ),
                )
                .orderBy(asc(L.ordinal))
            : [];
        return { items: rows.map((r) => pathView(r, levels)) };
      });
    },

    async getPath(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(P).where(eq(P.id, id)).limit(1);
        if (!rows[0]) return null;
        const levels = await tx.select().from(L).where(eq(L.pathId, id)).orderBy(asc(L.ordinal));
        return pathView(rows[0], levels);
      });
    },

    async createPath(actor, input) {
      const refusal = checkPathInput(input, input.levels);
      if (refusal) throw unprocessable(`PATH_${refusal}`, PATH_MESSAGES[refusal]);
      const payer = await payers.resolve(actor.organizationId, input.payerId);
      if (!payer) throw payerUnresolved();
      try {
        return await withOrgContext(db, actor, async (tx) => {
          let revision = 1;
          if (input.supersedesPathId) {
            const prior = await loadPath(tx, input.supersedesPathId);
            revision = prior.revision + 1;
          }
          const inserted = await tx
            .insert(P)
            .values({
              organizationId: actor.organizationId,
              payerId: input.payerId,
              payerNameSnapshot: payer.name,
              program: input.program,
              contractLabel: input.contractLabel?.trim() || null,
              status: "draft",
              effectiveFrom: input.effectiveFrom,
              sourceNote: input.sourceNote.trim(),
              sourceDocumentId: input.sourceDocumentId ?? null,
              authoredByMembershipId: actor.membershipId,
              supersedesPathId: input.supersedesPathId ?? null,
              revision,
            })
            .returning({ id: P.id, version: P.version });
          const pathId = inserted[0]!.id;
          await tx.insert(L).values(
            input.levels.map((l, i) => ({
              organizationId: actor.organizationId,
              pathId,
              ordinal: i + 1,
              levelKind: l.levelKind,
              levelLabel: l.levelLabel.trim(),
              whoFiles: l.whoFiles,
              filingWindowDays: l.filingWindowDays,
              anchorKind: l.anchorKind,
              receiptPresumptionDays: l.receiptPresumptionDays,
              dayBasis: l.dayBasis,
              roll: l.roll,
              decisionDays: l.decisionDays,
              formLabel: l.formLabel?.trim() || null,
              channelNote: l.channelNote?.trim() || null,
              sourceNote: l.sourceNote.trim(),
            })),
          );
          return inserted[0]!;
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ChartWardenError(
            "PATH_EXISTS",
            "a path for this payer, program, contract and effective date already exists; retire it or pick another date",
            409,
          );
        }
        throw e;
      }
    },

    async verifyPath(actor, id, ifMatch) {
      // The payer directory is read before the transaction opens (a slow seam must not hold row locks).
      const head = await withOrgContext(db, actor, (tx) => loadPath(tx, id));
      if (!(await payers.resolve(actor.organizationId, head.payerId))) throw payerUnresolved();
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadPath(tx, id);
        const levelCount = (await tx.select({ id: L.id }).from(L).where(eq(L.pathId, id))).length;
        const refusal = checkPathVerify({
          status: cur.status,
          authorMembershipId: cur.authoredByMembershipId,
          verifierMembershipId: actor.membershipId,
          levelCount,
        });
        if (refusal) {
          throw new ChartWardenError(`PATH_${refusal}`, VERIFY_MESSAGES[refusal], 409);
        }
        // People, not membership ids: a second membership of the author's own user is refused (the trigger enforces it too).
        const M = schema.memberships;
        const people = await tx
          .select({ id: M.id, userId: M.userId })
          .from(M)
          .where(inArray(M.id, [cur.authoredByMembershipId, actor.membershipId]));
        const authorUser = people.find((x) => x.id === cur.authoredByMembershipId)?.userId;
        const verifierUser = people.find((x) => x.id === actor.membershipId)?.userId;
        if (authorUser !== undefined && authorUser === verifierUser) {
          throw new ChartWardenError(
            "PATH_VERIFIER_IS_AUTHOR",
            VERIFY_MESSAGES.VERIFIER_IS_AUTHOR,
            409,
          );
        }
        // One conditional UPDATE: the version and draft status are checked in the statement itself, and the
        // database trigger re-checks the verifier and the levels under the row lock.
        const updated = await tx
          .update(P)
          .set({
            status: "active",
            verifiedOn: noticeDayOf(new Date()),
            verifiedByMembershipId: actor.membershipId,
            version: sql`${P.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(P.id, id), eq(P.version, ifMatch), eq(P.status, "draft")))
          .returning({ id: P.id, version: P.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        return updated[0];
      });
    },

    async retirePath(actor, id, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadPath(tx, id);
        if (cur.status === "retired") {
          throw new ChartWardenError("PATH_RETIRED", "this path is already retired", 409);
        }
        const updated = await tx
          .update(P)
          .set({ status: "retired", version: sql`${P.version} + 1`, updatedAt: new Date() })
          .where(and(eq(P.id, id), eq(P.version, ifMatch), sql`${P.status} <> 'retired'`))
          .returning({ id: P.id, version: P.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        return updated[0];
      });
    },
  };
}
