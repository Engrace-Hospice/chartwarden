// apps/backend/src/modules/25-remittance/routes/playbook-service.ts - M25 milestone 9a-1: the denial-reason PLAYBOOK
// library and the per-denial panel. Every command runs under `withOrgContext` (RLS).
//
//   - A playbook is ORGANIZATION-AUTHORED guidance. There is no platform playbook and nothing is seeded: with none
//     published, a denial's panel returns `playbook: null` and the screen says so.
//   - A version is a draft until a DIFFERENT person publishes it (`checkPublish`); publishing retires the previous
//     published version in the same transaction. A published version is frozen by trigger, so a correction is a new
//     version.
//   - A step tick is advisory: this file writes ONLY denial_playbook_case_step for it. It never writes denial_case,
//     appeal_case, adr_case, a submission attempt or a case event and never bumps a case version; no guard reads a tick.
//   - Resolution reuses the routing rules' precedence (domain `pickCodeKeyed`) and the same MAC lookup
//     (`loadDenialCodes`), so a playbook and a route are read for the same MAC.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, type DocumentReader, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import {
  PLAYBOOK_CODE_KINDS,
  type PlaybookCodeKind,
  type PlaybookContentRefusal,
  type PlaybookStep,
  type PlaybookStepStatus,
  type PlaybookVersionStatus,
  checkPublish,
  checkRetire,
  normalizePlaybookCode,
  noticeDayOf,
  resolvePlaybook,
  validatePlaybookVersion,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import { isUniqueViolation, loadDenialCodes } from "./denial-route-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface PlaybookContentInput {
  readonly summary: string;
  readonly sourceNote: string;
  readonly sourceDocumentId?: string | null;
  readonly steps: readonly PlaybookStep[];
}

export interface PlaybookCreateInput extends PlaybookContentInput {
  readonly codeKind: PlaybookCodeKind;
  readonly code: string;
  readonly macName?: string | null;
  readonly title: string;
}

export interface PlaybookVersionView {
  readonly id: string;
  readonly versionNo: number;
  readonly status: PlaybookVersionStatus;
  readonly summary: string;
  readonly steps: readonly PlaybookStep[];
  readonly sourceNote: string;
  readonly sourceDocumentId: string | null;
  readonly authoredByMembershipId: string;
  readonly reviewedByMembershipId: string | null;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
  readonly effectiveFrom: string | null;
  readonly rowVersion: number;
}

export interface PlaybookListItem {
  readonly id: string;
  readonly codeKind: string;
  readonly code: string;
  readonly macName: string | null;
  readonly title: string;
  /** The version number currently published, or null when only drafts / retired versions exist. */
  readonly publishedVersionNo: number | null;
  readonly publishedAt: string | null;
  readonly hasDraft: boolean;
}

export interface PlaybookDetail
  extends Omit<PlaybookListItem, "publishedVersionNo" | "publishedAt" | "hasDraft"> {
  readonly versions: readonly PlaybookVersionView[];
}

export interface DenialPlaybookStepView {
  readonly key: string;
  readonly text: string;
  /** open when never ticked. */
  readonly status: "open" | PlaybookStepStatus;
  readonly markedAt: string | null;
  readonly markedByMembershipId: string | null;
}

export interface DenialPlaybookView {
  readonly denialCaseId: string;
  /** The most specific code the denial carries: what "no playbook for <code>" names. */
  readonly codeKind: PlaybookCodeKind | null;
  readonly code: string | null;
  readonly macName: string | null;
  readonly playbook: {
    readonly playbookId: string;
    readonly title: string;
    readonly codeKind: string;
    readonly code: string;
    readonly macName: string | null;
    readonly versionId: string;
    readonly versionNo: number;
    readonly summary: string;
    readonly sourceNote: string;
    readonly sourceDocumentId: string | null;
    readonly authoredByMembershipId: string;
    readonly reviewedByMembershipId: string;
    readonly publishedAt: string;
    readonly effectiveFrom: string;
    readonly steps: readonly DenialPlaybookStepView[];
  } | null;
}

export interface PlaybookService {
  listPlaybooks(actor: M25ReadActor): Promise<{ items: PlaybookListItem[] }>;
  getPlaybook(actor: M25ReadActor, playbookId: string): Promise<PlaybookDetail | null>;
  createPlaybook(
    actor: M25WriteActor,
    input: PlaybookCreateInput,
  ): Promise<{ id: string; versionId: string }>;
  createDraftVersion(
    actor: M25WriteActor,
    playbookId: string,
    input: PlaybookContentInput,
  ): Promise<{ id: string; versionNo: number; rowVersion: number }>;
  updateDraft(
    actor: M25WriteActor,
    versionId: string,
    input: PlaybookContentInput,
    ifMatch: number,
  ): Promise<{ id: string; rowVersion: number }>;
  publishVersion(
    actor: M25WriteActor,
    versionId: string,
    ifMatch: number,
  ): Promise<{ id: string; rowVersion: number; effectiveFrom: string }>;
  retireVersion(
    actor: M25WriteActor,
    versionId: string,
    ifMatch: number,
  ): Promise<{ id: string; rowVersion: number }>;
  getDenialPlaybook(actor: M25ReadActor, denialId: string): Promise<DenialPlaybookView>;
  setStepStatus(
    actor: M25WriteActor,
    denialId: string,
    stepKey: string,
    /** The version the person was looking at: a tick on any other version is refused (409). */
    versionId: string,
    status: "open" | PlaybookStepStatus,
  ): Promise<{ stepKey: string; status: "open" | PlaybookStepStatus }>;
}

const REFUSAL_MESSAGE: Readonly<Record<PlaybookContentRefusal, string>> = {
  SOURCE_NOTE_REQUIRED: "say where this guidance came from (a source note is required)",
  SOURCE_NOTE_TOO_LONG: "the source note is too long",
  SUMMARY_REQUIRED: "write a short summary",
  SUMMARY_TOO_LONG: "the summary is too long",
  STEPS_REQUIRED: "add at least one step",
  TOO_MANY_STEPS: "there are more steps than a playbook may hold",
  STEP_KEY_INVALID: "a step key is 1 to 32 lowercase letters, digits, dashes or underscores",
  STEP_KEY_DUPLICATE: "two steps share a key",
  STEP_TEXT_REQUIRED: "every step needs text",
  STEP_TEXT_TOO_LONG: "a step is too long",
};

function assertContent(input: PlaybookContentInput): void {
  const checked = validatePlaybookVersion(input);
  if (checked.ok) return;
  throw new ChartWardenError(
    "PLAYBOOK_INVALID",
    checked.reasons.map((r) => REFUSAL_MESSAGE[r]).join("; "),
    422,
  );
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const cleanContent = (input: PlaybookContentInput) => ({
  summary: input.summary.trim(),
  sourceNote: input.sourceNote.trim(),
  sourceDocumentId: input.sourceDocumentId ?? null,
  steps: input.steps.map((s) => ({ key: s.key, text: s.text.trim() })),
});

type VersionRow = typeof schema.denialPlaybookVersion.$inferSelect;

const versionView = (r: VersionRow): PlaybookVersionView => ({
  id: r.id,
  versionNo: r.versionNo,
  status: r.status as PlaybookVersionStatus,
  summary: r.summary,
  steps: r.steps,
  sourceNote: r.sourceNote,
  sourceDocumentId: r.sourceDocumentId,
  authoredByMembershipId: r.authoredByMembershipId,
  reviewedByMembershipId: r.reviewedByMembershipId,
  publishedAt: iso(r.publishedAt),
  retiredAt: iso(r.retiredAt),
  effectiveFrom: r.effectiveFrom,
  rowVersion: r.rowVersion,
});

/** The most specific code a denial carries (MAC reason > RARC > CARC), the one a missing playbook is named by. */
function mostSpecificCode(c: {
  macReasonCode: string | null;
  rarcCode: string | null;
  carcCode: string;
}): { codeKind: PlaybookCodeKind; code: string } | null {
  const order: readonly [PlaybookCodeKind, string | null][] = [
    ["mac_reason", c.macReasonCode],
    ["rarc", c.rarcCode],
    ["carc", c.carcCode],
  ];
  const hit = order.find(([, v]) => v !== null && v.trim() !== "");
  return hit ? { codeKind: hit[0], code: (hit[1] as string).trim().toUpperCase() } : null;
}

/** The one arm of M22's published document seam the library reads: is this document visible to the organization? */
export type PlaybookDocumentPort = Pick<DocumentReader, "documentMetadata">;

export function buildDrizzlePlaybookService(
  db: DbClient,
  deps: { readonly documents?: () => PlaybookDocumentPort } = {},
): PlaybookService {
  /** A source document must exist in the organization (the seam is RLS-scoped, so another tenant's id reads as absent). */
  async function assertSourceDocument(
    actor: M25ReadActor,
    id: string | null | undefined,
  ): Promise<void> {
    if (!id || !deps.documents) return;
    const found = await deps.documents().documentMetadata({
      documentId: id as never,
      organizationId: actor.organizationId as never,
    });
    if (!found) {
      throw new ChartWardenError(
        "PLAYBOOK_SOURCE_DOCUMENT_NOT_FOUND",
        "the source document was not found in your organization",
        422,
      );
    }
  }

  const PB = schema.denialPlaybook;
  const PV = schema.denialPlaybookVersion;
  const CS = schema.denialPlaybookCaseStep;

  async function loadVersion(tx: Tx, versionId: string): Promise<VersionRow> {
    // FOR UPDATE: publish / retire / edit read-then-write one row and must not interleave.
    const rows = await tx.select().from(PV).where(eq(PV.id, versionId)).limit(1).for("update");
    const row = rows[0];
    if (!row) throw new NotFoundError("playbook version");
    return row;
  }

  const conflictOnUnique = (e: unknown, code: string, message: string): never => {
    if (isUniqueViolation(e)) throw new ChartWardenError(code, message, 409);
    throw e;
  };

  /** The published versions joined to their key: what resolution reads. */
  async function publishedEntries(tx: Tx) {
    const rows = await tx
      .select({ playbook: PB, version: PV })
      .from(PV)
      .innerJoin(PB, eq(PB.id, PV.playbookId))
      .where(eq(PV.status, "published"));
    return rows.map((r) => ({
      id: r.version.id,
      macName: r.playbook.macName,
      codeKind: r.playbook.codeKind as PlaybookCodeKind,
      code: r.playbook.code,
      effectiveFrom: r.version.effectiveFrom ?? "9999-12-31",
      playbook: r.playbook,
      version: r.version,
    }));
  }

  async function denialPlaybook(
    tx: Tx,
    actor: M25ReadActor,
    denialId: string,
  ): Promise<DenialPlaybookView> {
    const codes = await loadDenialCodes(tx, denialId, actor.providerEntityScope);
    const named = mostSpecificCode(codes);
    const winner = resolvePlaybook(
      {
        macName: codes.macName,
        macReasonCode: codes.macReasonCode,
        carcCode: codes.carcCode,
        rarcCode: codes.rarcCode,
        asOf: noticeDayOf(new Date()),
      },
      await publishedEntries(tx),
    );
    const base = {
      denialCaseId: denialId,
      codeKind: named?.codeKind ?? null,
      code: named?.code ?? null,
      macName: codes.macName,
    };
    if (!winner) return { ...base, playbook: null };
    const ticks = await tx
      .select()
      .from(CS)
      .where(and(eq(CS.denialCaseId, denialId), eq(CS.playbookVersionId, winner.version.id)));
    const tickOf = new Map(ticks.map((t) => [t.stepKey, t]));
    const v = winner.version;
    return {
      ...base,
      playbook: {
        playbookId: winner.playbook.id,
        title: winner.playbook.title,
        codeKind: winner.playbook.codeKind,
        code: winner.playbook.code,
        macName: winner.playbook.macName,
        versionId: v.id,
        versionNo: v.versionNo,
        summary: v.summary,
        sourceNote: v.sourceNote,
        sourceDocumentId: v.sourceDocumentId,
        authoredByMembershipId: v.authoredByMembershipId,
        reviewedByMembershipId: v.reviewedByMembershipId as string,
        publishedAt: iso(v.publishedAt) as string,
        effectiveFrom: v.effectiveFrom as string,
        steps: v.steps.map((s) => {
          const t = tickOf.get(s.key);
          return {
            key: s.key,
            text: s.text,
            status: (t?.status ?? "open") as "open" | PlaybookStepStatus,
            markedAt: iso(t?.markedAt ?? null),
            markedByMembershipId: t?.markedByMembershipId ?? null,
          };
        }),
      },
    };
  }

  return {
    async listPlaybooks(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const playbooks = await tx
          .select()
          .from(PB)
          .orderBy(asc(PB.codeKind), asc(PB.code), asc(PB.macName));
        const versions = await tx
          .select({
            playbookId: PV.playbookId,
            status: PV.status,
            versionNo: PV.versionNo,
            publishedAt: PV.publishedAt,
          })
          .from(PV)
          .where(sql`${PV.status} in ('published','draft')`);
        return {
          items: playbooks.map((p) => {
            const mine = versions.filter((v) => v.playbookId === p.id);
            const published = mine.find((v) => v.status === "published");
            return {
              id: p.id,
              codeKind: p.codeKind,
              code: p.code,
              macName: p.macName,
              title: p.title,
              publishedVersionNo: published?.versionNo ?? null,
              publishedAt: iso(published?.publishedAt ?? null),
              hasDraft: mine.some((v) => v.status === "draft"),
            };
          }),
        };
      });
    },

    async getPlaybook(actor, playbookId) {
      return withOrgContext(db, actor, async (tx) => {
        const found = await tx.select().from(PB).where(eq(PB.id, playbookId)).limit(1);
        const p = found[0];
        if (!p) return null;
        const versions = await tx
          .select()
          .from(PV)
          .where(eq(PV.playbookId, p.id))
          .orderBy(desc(PV.versionNo));
        return {
          id: p.id,
          codeKind: p.codeKind,
          code: p.code,
          macName: p.macName,
          title: p.title,
          versions: versions.map(versionView),
        };
      });
    },

    async createPlaybook(actor, input) {
      const code = normalizePlaybookCode(input.code);
      const title = input.title.trim();
      if (!PLAYBOOK_CODE_KINDS.includes(input.codeKind) || code === null) {
        throw new ChartWardenError(
          "PLAYBOOK_CODE_INVALID",
          "the code is 1 to 16 letters or digits",
          422,
        );
      }
      if (title === "" || title.length > 120) {
        throw new ChartWardenError("PLAYBOOK_INVALID", "the title is 1 to 120 characters", 422);
      }
      assertContent(input);
      const content = cleanContent(input);
      await assertSourceDocument(actor, content.sourceDocumentId);
      const macName = input.macName?.trim() || null;
      return withOrgContext(db, actor, async (tx) => {
        try {
          const created = await tx
            .insert(PB)
            .values({
              organizationId: actor.organizationId,
              macName,
              codeKind: input.codeKind,
              code,
              title,
              createdByMembershipId: actor.membershipId,
            })
            .returning({ id: PB.id });
          const playbookId = (created[0] as { id: string }).id;
          const version = await tx
            .insert(PV)
            .values({
              organizationId: actor.organizationId,
              playbookId,
              versionNo: 1,
              authoredByMembershipId: actor.membershipId,
              lastEditedByMembershipId: actor.membershipId,
              authoredByUserId: actor.userId,
              lastEditedByUserId: actor.userId,
              ...content,
            })
            .returning({ id: PV.id });
          return { id: playbookId, versionId: (version[0] as { id: string }).id };
        } catch (e) {
          return conflictOnUnique(
            e,
            "PLAYBOOK_EXISTS",
            "a playbook for that code and MAC already exists; open it and add a version",
          );
        }
      });
    },

    async createDraftVersion(actor, playbookId, input) {
      assertContent(input);
      const content = cleanContent(input);
      await assertSourceDocument(actor, content.sourceDocumentId);
      return withOrgContext(db, actor, async (tx) => {
        const parent = await tx
          .select({ id: PB.id })
          .from(PB)
          .where(eq(PB.id, playbookId))
          .limit(1);
        if (!parent[0]) throw new NotFoundError("playbook");
        const latest = await tx
          .select({ n: sql<number>`coalesce(max(${PV.versionNo}), 0)::int` })
          .from(PV)
          .where(eq(PV.playbookId, playbookId));
        const versionNo = (latest[0]?.n ?? 0) + 1;
        try {
          const row = await tx
            .insert(PV)
            .values({
              organizationId: actor.organizationId,
              playbookId,
              versionNo,
              authoredByMembershipId: actor.membershipId,
              lastEditedByMembershipId: actor.membershipId,
              authoredByUserId: actor.userId,
              lastEditedByUserId: actor.userId,
              ...content,
            })
            .returning({ id: PV.id, versionNo: PV.versionNo, rowVersion: PV.rowVersion });
          return row[0] as { id: string; versionNo: number; rowVersion: number };
        } catch (e) {
          // The one-draft index (or the version number, when two drafts raced) refuses the second: no row lock is needed.
          return conflictOnUnique(
            e,
            "PLAYBOOK_DRAFT_EXISTS",
            "this playbook already has a draft; edit or publish it first",
          );
        }
      });
    },

    async updateDraft(actor, versionId, input, ifMatch) {
      assertContent(input);
      const content = cleanContent(input);
      await assertSourceDocument(actor, content.sourceDocumentId);
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadVersion(tx, versionId);
        if (cur.status !== "draft") {
          throw new ChartWardenError(
            "PLAYBOOK_NOT_A_DRAFT",
            "only a draft can be edited; write a new version instead",
            409,
          );
        }
        if (cur.rowVersion !== ifMatch) throw new VersionConflictError(cur.rowVersion);
        const updated = await tx
          .update(PV)
          .set({
            ...content,
            lastEditedByMembershipId: actor.membershipId,
            lastEditedByUserId: actor.userId,
            rowVersion: sql`${PV.rowVersion} + 1`,
          })
          .where(and(eq(PV.id, versionId), eq(PV.rowVersion, ifMatch)))
          .returning({ id: PV.id, rowVersion: PV.rowVersion });
        if (!updated[0]) throw new VersionConflictError(cur.rowVersion);
        return updated[0];
      });
    },

    async publishVersion(actor, versionId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadVersion(tx, versionId);
        if (cur.rowVersion !== ifMatch) throw new VersionConflictError(cur.rowVersion);
        const refusal = checkPublish({
          status: cur.status as PlaybookVersionStatus,
          authorMembershipId: cur.authoredByMembershipId,
          authorUserId: cur.authoredByUserId,
          lastEditorMembershipId: cur.lastEditedByMembershipId,
          lastEditorUserId: cur.lastEditedByUserId,
          publisherUserId: actor.userId,
          publisherMembershipId: actor.membershipId,
        });
        if (refusal === "NOT_A_DRAFT") {
          throw new ChartWardenError("PLAYBOOK_NOT_A_DRAFT", "only a draft can be published", 409);
        }
        if (refusal === "REVIEWER_IS_AUTHOR") {
          throw new ChartWardenError(
            "PLAYBOOK_REVIEWER_IS_AUTHOR",
            "someone other than the author must review and publish this playbook",
            409,
          );
        }
        // Defense in depth: the content was validated when saved; the version about to go live is validated again.
        assertContent({ summary: cur.summary, sourceNote: cur.sourceNote, steps: cur.steps });
        const now = new Date();
        // Retire the version being replaced first: one published version per playbook is a partial unique index.
        await tx
          .update(PV)
          .set({ status: "retired", retiredAt: now, rowVersion: sql`${PV.rowVersion} + 1` })
          .where(and(eq(PV.playbookId, cur.playbookId), eq(PV.status, "published")));
        const effectiveFrom = noticeDayOf(now);
        const published = await tx
          .update(PV)
          .set({
            status: "published",
            reviewedByMembershipId: actor.membershipId,
            reviewedByUserId: actor.userId,
            publishedAt: now,
            effectiveFrom,
            rowVersion: sql`${PV.rowVersion} + 1`,
          })
          // Separation of duties holds IN the statement, not only in the check above: the row is a draft and the actor
          // (from the authenticated context) is neither its author nor its last editor. The database CHECK and the
          // guard trigger back this up.
          .where(
            and(
              eq(PV.id, versionId),
              eq(PV.rowVersion, ifMatch),
              eq(PV.status, "draft"),
              ne(PV.authoredByMembershipId, actor.membershipId),
              ne(PV.lastEditedByMembershipId, actor.membershipId),
              ne(PV.authoredByUserId, actor.userId),
              ne(PV.lastEditedByUserId, actor.userId),
            ),
          )
          .returning({ id: PV.id, rowVersion: PV.rowVersion });
        if (!published[0]) throw new VersionConflictError(cur.rowVersion);
        return { ...published[0], effectiveFrom };
      });
    },

    async retireVersion(actor, versionId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadVersion(tx, versionId);
        if (cur.rowVersion !== ifMatch) throw new VersionConflictError(cur.rowVersion);
        if (checkRetire(cur.status as PlaybookVersionStatus) !== null) {
          throw new ChartWardenError(
            "PLAYBOOK_NOT_PUBLISHED",
            "only a published version can be retired",
            409,
          );
        }
        const updated = await tx
          .update(PV)
          .set({ status: "retired", retiredAt: new Date(), rowVersion: sql`${PV.rowVersion} + 1` })
          .where(and(eq(PV.id, versionId), eq(PV.rowVersion, ifMatch)))
          .returning({ id: PV.id, rowVersion: PV.rowVersion });
        if (!updated[0]) throw new VersionConflictError(cur.rowVersion);
        return updated[0];
      });
    },

    async getDenialPlaybook(actor, denialId) {
      return withOrgContext(db, actor, (tx) => denialPlaybook(tx, actor, denialId));
    },

    async setStepStatus(actor, denialId, stepKey, versionId, status) {
      return withOrgContext(db, actor, async (tx) => {
        const view = await denialPlaybook(tx, actor, denialId);
        if (!view.playbook) throw new NotFoundError("playbook for this denial");
        if (view.playbook.versionId !== versionId) {
          throw new ChartWardenError(
            "PLAYBOOK_VERSION_CHANGED",
            "the playbook for this denial changed; reload to see the version now in force",
            409,
          );
        }
        if (!view.playbook.steps.some((s) => s.key === stepKey)) {
          throw new NotFoundError("playbook step");
        }
        // The ONLY write: one advisory tick row. Nothing reads it.
        await tx
          .insert(CS)
          .values({
            organizationId: actor.organizationId,
            denialCaseId: denialId,
            playbookVersionId: view.playbook.versionId,
            stepKey,
            status,
            markedByMembershipId: actor.membershipId,
          })
          .onConflictDoUpdate({
            target: [CS.denialCaseId, CS.playbookVersionId, CS.stepKey],
            set: { status, markedByMembershipId: actor.membershipId, markedAt: new Date() },
          });
        return { stepKey, status };
      });
    },
  };
}
