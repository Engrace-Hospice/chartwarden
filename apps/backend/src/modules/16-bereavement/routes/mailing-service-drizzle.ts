// apps/backend/src/modules/16-bereavement/routes/mailing-service-drizzle.ts — the Drizzle-backed mailing program service (ADR-0109 D10, routes 42-51).
//
// Every method runs inside one `withOrgContext` transaction (RLS on `app.org_id`). State changes are compare-and-set UPDATEs guarded by the row's
// `version` AND status, so two staff members cannot both claim one run, and the `If-Match` header (never a body field) names the version the caller read.
//
//   generate        draft | failed -> generating in one CAS, then the batch is SELECTED SET-BASED in the same transaction: every contact of every active plan
//                   goes through the pure `decideMailingEligibility` and is upserted as an item (included / excluded + reason) in chunks. Only after the commit is
//                   the render handed to the `m16-mailing-generate` worker (a lost enqueue is re-sent by the sweep). Empty wording is refused: no default ships.
//   confirm-mailed  re-checks the SAME rule over the contacts already rendered into the PDF; whoever is no longer eligible (an opt-out, a closure, a death since the
//                   render) is flagged `excluded_after_render` and is never logged as mailed. The run then moves to `mailed` and `mailing_run_mailed` is published in
//                   the same transaction. The sweep writes the contact-log activity rows afterwards.
//   download        mints the batch's short-lived URL through the M22 `OrgDocumentAccessProvider` seam (which writes the access-ledger row first).
//
// NO NAME OR ADDRESS passes through this file: items hold ids, the PDF holds the people.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  BereavedContactRelationship,
  BereavementMailingContent,
  BereavementMailingExclusionReason,
  BereavementMailingItemStatus,
  BereavementMailingKey,
  OrgDocumentAccessProvider,
} from "@chartwarden/types";
import { BEREAVEMENT_BUILT_MAILING_KEYS } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import { BereavementStateError, checkVersion } from "../lifecycle/index";
import { assertMailingContentComplete, normalizeMailingContent } from "../mailings/content";
import { decideMailingEligibility } from "../mailings/eligibility";
import type { MailingGenerateEnqueuePort } from "../mailings/enqueue-port";
import { type MailingFactsContext, loadMailingCandidates } from "../mailings/facts-drizzle";
import type { M16ReadActor, M16WriteActor } from "./actor";
import { type Cursor, clampLimit, decodeCheckedCursor, toCursorPage } from "./concurrency";
import type {
  M16MailingService,
  MailingConfigView,
  MailingItemCounts,
  MailingItemView,
  MailingRunView,
  MailingScheduleView,
} from "./mailing-service";
import type { WriteOutboxPort } from "./write-service";

type ConfigRow = typeof schema.bereavementMailingConfig.$inferSelect;
type RunRow = typeof schema.bereavementMailingRun.$inferSelect;

/** Rows per bulk INSERT when selecting a batch (a run can cover thousands of contacts). */
const ITEM_UPSERT_CHUNK = 500;
/** List page sizes (runs and items). */
const RUN_PAGE = { defaultSize: 25, maxSize: 100 } as const;
const ITEM_PAGE = { defaultSize: 100, maxSize: 500 } as const;
const NO_RECIPIENTS = "NO_RECIPIENTS";

export interface M16MailingDeps {
  /** The catalog-validating tx publisher (callerModule `m16`). */
  readonly outbox: WriteOutboxPort;
  /** Hands a claimed run to the `m16-mailing-generate` worker (BullMQ in prod). */
  readonly enqueue: MailingGenerateEnqueuePort;
  /** M22's org-level download seam; defaults to the registry's `OrgDocumentAccessProvider`. */
  readonly orgDocuments?: () => OrgDocumentAccessProvider;
  /** Is an email channel bound for this tenant? Defaults to false: the email channel is not built (see mailings/eligibility.ts). */
  readonly emailChannelAvailable?: boolean;
  readonly now?: () => Date;
}

const iso = (d: Date): string => d.toISOString();
const dateOnly = (d: string | Date): string =>
  typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);

const staleVersion = (): BereavementStateError =>
  new BereavementStateError("STALE_VERSION", "the mailing run has moved on; re-read it and retry");

const EMPTY_COUNTS: MailingItemCounts = {
  included: 0,
  excluded: 0,
  logged: 0,
  excludedAfterRender: 0,
};

function scheduleOf(raw: unknown): MailingScheduleView {
  const r = (raw ?? {}) as { monthDays?: unknown; monthDay?: unknown };
  return {
    ...(Array.isArray(r.monthDays)
      ? { monthDays: r.monthDays.filter((v): v is string => typeof v === "string") }
      : {}),
    ...(typeof r.monthDay === "string" ? { monthDay: r.monthDay } : {}),
  };
}

const contentOf = (raw: unknown): BereavementMailingContent =>
  (raw ?? {}) as BereavementMailingContent;

function configView(key: BereavementMailingKey, row: ConfigRow | undefined): MailingConfigView {
  if (row === undefined) {
    return {
      mailingKey: key,
      configured: false,
      enabled: false,
      leadDays: 10,
      schedule: {},
      audienceRelationships: null,
      content: {},
      version: 0,
      updatedAt: null,
    };
  }
  return {
    mailingKey: key,
    configured: true,
    enabled: row.enabled,
    leadDays: row.leadDays,
    schedule: scheduleOf(row.scheduleJsonb),
    audienceRelationships: (row.audienceRelationships ?? null) as
      | readonly BereavedContactRelationship[]
      | null,
    content: contentOf(row.contentJsonb),
    version: row.version,
    updatedAt: iso(row.updatedAt),
  };
}

function runView(row: RunRow, counts: MailingItemCounts): MailingRunView {
  return {
    runId: row.id,
    runKind: row.runKind,
    mailingKey: row.mailingKey ?? null,
    occurrenceKey: row.occurrenceKey,
    scheduledFor: dateOnly(row.scheduledFor),
    status: row.status,
    content: contentOf(row.contentJsonb),
    recipientCount: row.recipientCount,
    excludedCount: row.excludedCount,
    failureCode: row.failureCode ?? null,
    hasDocument: row.renderedDocumentId !== null,
    generatedAt: row.generatedAt ? iso(row.generatedAt) : null,
    mailedAt: row.mailedAt ? iso(row.mailedAt) : null,
    itemCounts: counts,
    version: row.version,
    createdAt: iso(row.createdAt),
  };
}

export function buildDrizzleM16MailingService(
  db: DbClient,
  deps: M16MailingDeps,
): M16MailingService {
  const CONFIG = schema.bereavementMailingConfig;
  const RUN = schema.bereavementMailingRun;
  const ITEM = schema.bereavementMailingItem;
  const CONTACT = schema.bereavedContact;
  const now = deps.now ?? (() => new Date());
  const orgDocuments = deps.orgDocuments ?? (() => getSeam("OrgDocumentAccessProvider"));
  const scope = (actor: M16ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });
  const asTx = (scoped: unknown): DbClient => scoped as DbClient;

  async function runOr404(tx: DbClient, runId: string): Promise<RunRow> {
    const [row] = await tx.select().from(RUN).where(eq(RUN.id, runId)).limit(1);
    if (!row) throw new BereavementStateError("MAILING_RUN_NOT_FOUND", "mailing run not found");
    return row;
  }

  /** Item counts for a set of runs, one grouped query. */
  async function countsFor(
    tx: DbClient,
    runIds: readonly string[],
  ): Promise<Map<string, MailingItemCounts>> {
    const out = new Map<string, MailingItemCounts>();
    if (runIds.length === 0) return out;
    const rows = await tx
      .select({ runId: ITEM.runId, status: ITEM.status, n: sql<number>`count(*)::int` })
      .from(ITEM)
      .where(inArray(ITEM.runId, [...runIds]))
      .groupBy(ITEM.runId, ITEM.status);
    for (const r of rows) {
      const c = out.get(r.runId) ?? EMPTY_COUNTS;
      out.set(r.runId, {
        included: c.included + (r.status === "included" ? r.n : 0),
        excluded: c.excluded + (r.status === "excluded" ? r.n : 0),
        logged: c.logged + (r.status === "logged" ? r.n : 0),
        excludedAfterRender:
          c.excludedAfterRender + (r.status === "excluded_after_render" ? r.n : 0),
      });
    }
    return out;
  }

  async function viewOf(tx: DbClient, row: RunRow): Promise<MailingRunView> {
    return runView(row, (await countsFor(tx, [row.id])).get(row.id) ?? EMPTY_COUNTS);
  }

  /** The run's audience filter: the CURRENT config's (a memorial run has no mailing key and so no audience). */
  async function factsContext(tx: DbClient, run: RunRow): Promise<MailingFactsContext> {
    let audience: BereavedContactRelationship[] | null = null;
    if (run.mailingKey !== null) {
      const [cfg] = await tx
        .select({ audience: CONFIG.audienceRelationships })
        .from(CONFIG)
        .where(eq(CONFIG.mailingKey, run.mailingKey))
        .limit(1);
      audience = (cfg?.audience ?? null) as BereavedContactRelationship[] | null;
    }
    return { audience, emailChannelAvailable: deps.emailChannelAvailable ?? false };
  }

  /**
   * SET-BASED batch selection (inside the claiming transaction): decide every contact of every active plan with the pure rule and upsert the items in
   * chunks. Re-selecting a run (a retry after `failed`) is idempotent: every earlier `included` item is first reset to excluded (so one that dropped out of the
   * candidate set cannot stay in the batch) and ordinals are cleared; the upsert then rewrites each candidate. The worker numbers the letters it renders.
   */
  async function selectBatch(tx: DbClient, run: RunRow): Promise<MailingItemCounts> {
    const candidates = await loadMailingCandidates(
      tx,
      { kind: "active_plans" },
      await factsContext(tx, run),
    );
    await tx
      .update(ITEM)
      .set({
        status: "excluded",
        exclusionReason: "plan_not_active",
        ordinal: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(ITEM.runId, run.id), eq(ITEM.status, "included")));
    await tx
      .update(ITEM)
      .set({ ordinal: null })
      .where(and(eq(ITEM.runId, run.id), isNotNull(ITEM.ordinal)));

    const rows = candidates.map((c) => {
      const decision = decideMailingEligibility(c.facts);
      const base = {
        organizationId: run.organizationId,
        providerEntityId: c.providerEntityId,
        locationId: c.locationId,
        runId: run.id,
        planId: c.planId,
        bereavedContactId: c.contactId,
      };
      return decision.eligible
        ? {
            ...base,
            channel: decision.channel,
            status: "included" as const,
            exclusionReason: null,
            ordinal: null,
          }
        : {
            ...base,
            channel: "postal" as const,
            status: "excluded" as const,
            exclusionReason: decision.reason,
            ordinal: null,
          };
    });
    for (let i = 0; i < rows.length; i += ITEM_UPSERT_CHUNK) {
      await tx
        .insert(ITEM)
        .values(rows.slice(i, i + ITEM_UPSERT_CHUNK))
        .onConflictDoUpdate({
          target: [ITEM.runId, ITEM.bereavedContactId],
          set: {
            channel: sql`excluded.channel`,
            status: sql`excluded.status`,
            exclusionReason: sql`excluded.exclusion_reason`,
            ordinal: sql`excluded.ordinal`,
            updatedAt: sql`now()`,
          },
        });
    }
    return (await countsFor(tx, [run.id])).get(run.id) ?? EMPTY_COUNTS;
  }

  return {
    async listConfigs(actor) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const rows = await asTx(scoped).select().from(CONFIG);
        const byKey = new Map(rows.map((r) => [r.mailingKey, r]));
        return BEREAVEMENT_BUILT_MAILING_KEYS.map((key) => configView(key, byKey.get(key)));
      });
    },

    async putConfig(actor, mailingKey, input) {
      if (!(BEREAVEMENT_BUILT_MAILING_KEYS as readonly string[]).includes(mailingKey)) {
        throw new BereavementStateError(
          "MAILING_KEY_NOT_AVAILABLE",
          "this mailing is not available yet (the decedent-birthday mailing is deferred)",
        );
      }
      const content = normalizeMailingContent(input.content);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [existing] = await tx
          .select()
          .from(CONFIG)
          .where(eq(CONFIG.mailingKey, mailingKey))
          .limit(1);
        checkVersion(input.expectedVersion, existing?.version ?? 0);
        const at = now();
        const values = {
          enabled: input.enabled,
          leadDays: input.leadDays,
          scheduleJsonb: input.schedule ?? {},
          audienceRelationships:
            input.audienceRelationships === null ? null : [...input.audienceRelationships],
          contentJsonb: content,
          configuredByMembershipId: actor.membershipId,
          updatedAt: at,
        };
        if (existing === undefined) {
          const [created] = await tx
            .insert(CONFIG)
            // version 0 means "never configured"; the first write is version 1 (the caller's If-Match was 0)
            .values({ organizationId: actor.organizationId, mailingKey, ...values, version: 1 })
            .onConflictDoNothing()
            .returning();
          if (!created) throw staleVersion(); // a concurrent first write won
          return configView(mailingKey, created);
        }
        const [updated] = await tx
          .update(CONFIG)
          .set({ ...values, version: existing.version + 1 })
          .where(and(eq(CONFIG.id, existing.id), eq(CONFIG.version, existing.version)))
          .returning();
        if (!updated) throw staleVersion();
        return configView(mailingKey, updated);
      });
    },

    async listRuns(actor, input) {
      const limit = clampLimit(input.limit, RUN_PAGE);
      const after: Cursor | null = decodeCheckedCursor(input.cursor, "date");
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const rows = await tx
          .select()
          .from(RUN)
          .where(
            and(
              input.status === undefined ? undefined : eq(RUN.status, input.status),
              after === null
                ? undefined
                : or(
                    lt(RUN.scheduledFor, after.a),
                    and(eq(RUN.scheduledFor, after.a), lt(RUN.id, after.id)),
                  ),
            ),
          )
          .orderBy(desc(RUN.scheduledFor), desc(RUN.id))
          .limit(limit + 1);
        const counts = await countsFor(
          tx,
          rows.slice(0, limit).map((r) => r.id),
        );
        return toCursorPage(
          rows,
          limit,
          (row) => ({ a: dateOnly(row.scheduledFor), id: row.id }),
          (row) => runView(row, counts.get(row.id) ?? EMPTY_COUNTS),
        );
      });
    },

    async getRun(actor, runId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [row] = await tx.select().from(RUN).where(eq(RUN.id, runId)).limit(1);
        return row ? viewOf(tx, row) : null;
      });
    },

    async listItems(actor, runId, input) {
      const limit = clampLimit(input.limit, ITEM_PAGE);
      const afterCursor = decodeCheckedCursor(input.cursor, "integer");
      const afterOrdinal = Number(afterCursor?.a ?? Number.NaN);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [run] = await tx.select({ id: RUN.id }).from(RUN).where(eq(RUN.id, runId)).limit(1);
        if (!run) return null;
        // Ordinal order puts every never-included item (ordinal NULL) last; the cursor keys on (position, id) where position is the ordinal or a large sentinel.
        const position = sql<number>`coalesce(${ITEM.ordinal}, 2147483647)`;
        const rows = await tx
          .select({
            itemId: ITEM.id,
            contactId: ITEM.bereavedContactId,
            planId: ITEM.planId,
            relationshipCode: CONTACT.relationshipCode,
            channel: ITEM.channel,
            status: ITEM.status,
            exclusionReason: ITEM.exclusionReason,
            ordinal: ITEM.ordinal,
            position,
          })
          .from(ITEM)
          .innerJoin(CONTACT, eq(CONTACT.id, ITEM.bereavedContactId))
          .where(
            and(
              eq(ITEM.runId, runId),
              input.status === undefined ? undefined : eq(ITEM.status, input.status),
              Number.isFinite(afterOrdinal)
                ? or(
                    sql`${position} > ${afterOrdinal}`,
                    and(
                      sql`${position} = ${afterOrdinal}`,
                      sql`${ITEM.id} > ${afterCursor?.id ?? ""}::uuid`,
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(position), asc(ITEM.id))
          .limit(limit + 1);
        return toCursorPage(
          rows,
          limit,
          (row) => ({ a: String(row.position), id: row.itemId }),
          (row): MailingItemView => ({
            itemId: row.itemId,
            contactId: row.contactId,
            planId: row.planId,
            relationshipCode: row.relationshipCode as BereavedContactRelationship,
            channel: row.channel,
            status: row.status as BereavementMailingItemStatus,
            exclusionReason: (row.exclusionReason ??
              null) as BereavementMailingExclusionReason | null,
            ordinal: row.ordinal ?? null,
          }),
        );
      });
    },

    async updateRunContent(actor, runId, input) {
      const content = normalizeMailingContent(input.content);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const run = await runOr404(tx, runId);
        checkVersion(input.expectedVersion, run.version);
        if (run.status !== "draft") {
          throw new BereavementStateError(
            "MAILING_RUN_NOT_EDITABLE",
            `the wording of a ${run.status} run can no longer be changed`,
          );
        }
        const [row] = await tx
          .update(RUN)
          .set({ contentJsonb: content, version: run.version + 1, updatedAt: now() })
          .where(and(eq(RUN.id, run.id), eq(RUN.version, run.version), eq(RUN.status, "draft")))
          .returning();
        if (!row) throw staleVersion();
        return viewOf(tx, row);
      });
    },

    async generateRun(actor, runId, input) {
      const claimed = await withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const run = await runOr404(tx, runId);
        checkVersion(input.expectedVersion, run.version);
        if (run.status !== "draft" && run.status !== "failed") {
          throw new BereavementStateError(
            "MAILING_RUN_NOT_GENERATABLE",
            `a ${run.status} run cannot be generated`,
          );
        }
        assertMailingContentComplete(contentOf(run.contentJsonb));
        const at = now();
        // The compare-and-set claim: only one caller moves the run to `generating`.
        const [row] = await tx
          .update(RUN)
          .set({
            status: "generating",
            failureCode: null,
            generatedByMembershipId: actor.membershipId,
            generatedAt: null,
            version: run.version + 1,
            updatedAt: at,
          })
          .where(
            and(
              eq(RUN.id, run.id),
              eq(RUN.version, run.version),
              inArray(RUN.status, ["draft", "failed"]),
            ),
          )
          .returning();
        if (!row) throw staleVersion();

        const counts = await selectBatch(tx, row);
        const nobody = counts.included === 0;
        const [settled] = await tx
          .update(RUN)
          .set({
            recipientCount: counts.included,
            excludedCount: counts.excluded,
            ...(nobody ? { status: "failed" as const, failureCode: NO_RECIPIENTS } : {}),
          })
          .where(eq(RUN.id, row.id))
          .returning();
        if (!settled) throw staleVersion();
        return { row: settled, view: await viewOf(tx, settled), enqueue: !nobody };
      });
      // After the commit (the worker must see the claim). A lost enqueue is re-sent by the sweep's stale-`generating` pass.
      if (claimed.enqueue) {
        await deps.enqueue.enqueue({
          organizationId: actor.organizationId,
          runId: claimed.row.id,
          version: claimed.row.version,
        });
      }
      return claimed.view;
    },

    async downloadRun(actor, runId) {
      const run = await withOrgContext(db, scope(actor), async (scoped) =>
        runOr404(asTx(scoped), runId),
      );
      if ((run.status !== "ready" && run.status !== "mailed") || run.renderedDocumentId === null) {
        throw new BereavementStateError(
          "MAILING_RUN_NOT_READY",
          `a ${run.status} run has no batch to download`,
        );
      }
      let minted: Awaited<ReturnType<OrgDocumentAccessProvider["mintOrgDownloadUrl"]>>;
      try {
        minted = await orgDocuments().mintOrgDownloadUrl({
          organizationId: actor.organizationId as never,
          documentId: run.renderedDocumentId as never,
          allowedAggregateTypes: ["bereavement_mailing_batch"],
          accessorMembershipId: actor.membershipId,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "NotImplementedError") {
          throw new BereavementStateError(
            "MAILING_DOWNLOAD_UNAVAILABLE",
            "batch download is not available: no document store is bound",
          );
        }
        throw error;
      }
      if ("denied" in minted) {
        throw new BereavementStateError(
          "MAILING_RUN_NOT_READY",
          "the batch document is not available for download",
        );
      }
      return { runId: run.id, url: minted.url, expiresAt: minted.expiresAt };
    },

    async confirmMailed(actor, runId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const run = await runOr404(tx, runId);
        checkVersion(input.expectedVersion, run.version);
        if (run.status !== "ready") {
          throw new BereavementStateError(
            "MAILING_RUN_NOT_READY",
            `only a ready run can be confirmed mailed (this one is ${run.status})`,
          );
        }
        // Re-check the contacts already rendered into the PDF, with the rule that selected them, against TODAY's facts.
        const included = await tx
          .select({ id: ITEM.id, contactId: ITEM.bereavedContactId })
          .from(ITEM)
          .where(and(eq(ITEM.runId, run.id), eq(ITEM.status, "included")));
        const candidates = await loadMailingCandidates(
          tx,
          { kind: "contacts", contactIds: included.map((i) => i.contactId) },
          await factsContext(tx, run),
        );
        const reasonByContact = new Map<string, BereavementMailingExclusionReason>();
        const seen = new Set<string>();
        for (const c of candidates) {
          seen.add(c.contactId);
          const decision = decideMailingEligibility(c.facts);
          if (!decision.eligible) reasonByContact.set(c.contactId, decision.reason);
        }
        const flagged = new Map<BereavementMailingExclusionReason, string[]>();
        for (const item of included) {
          const reason = seen.has(item.contactId)
            ? reasonByContact.get(item.contactId)
            : ("contact_not_engageable" as const);
          if (reason === undefined) continue;
          flagged.set(reason, [...(flagged.get(reason) ?? []), item.id]);
        }
        let flaggedCount = 0;
        for (const [reason, ids] of flagged) {
          for (let i = 0; i < ids.length; i += ITEM_UPSERT_CHUNK) {
            const chunk = ids.slice(i, i + ITEM_UPSERT_CHUNK);
            await tx
              .update(ITEM)
              .set({
                status: "excluded_after_render",
                exclusionReason: reason,
                updatedAt: sql`now()`,
              })
              .where(and(inArray(ITEM.id, chunk), eq(ITEM.status, "included")));
            flaggedCount += chunk.length;
          }
        }

        const at = now();
        const [row] = await tx
          .update(RUN)
          .set({
            status: "mailed",
            mailedAt: at,
            mailedByMembershipId: actor.membershipId,
            recipientCount: included.length - flaggedCount,
            version: run.version + 1,
            updatedAt: at,
          })
          .where(and(eq(RUN.id, run.id), eq(RUN.version, run.version), eq(RUN.status, "ready")))
          .returning();
        if (!row) throw staleVersion();
        await deps.outbox.publish(tx, {
          organizationId: actor.organizationId,
          eventName: "m16.bereavement.mailing_run_mailed",
          aggregateKind: "bereavement_mailing_run",
          aggregateId: row.id,
          payload: {
            runId: row.id,
            runKind: row.runKind,
            mailingKey: row.mailingKey ?? null,
            occurrenceKey: row.occurrenceKey,
            scheduledFor: dateOnly(row.scheduledFor),
            recipientCount: row.recipientCount,
            excludedCount: row.excludedCount,
            excludedAfterRenderCount: flaggedCount,
          },
        });
        return viewOf(tx, row);
      });
    },

    async cancelRun(actor, runId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const run = await runOr404(tx, runId);
        checkVersion(input.expectedVersion, run.version);
        if (run.status !== "draft" && run.status !== "ready" && run.status !== "failed") {
          throw new BereavementStateError(
            "MAILING_RUN_NOT_CANCELLABLE",
            `a ${run.status} run cannot be cancelled`,
          );
        }
        const [row] = await tx
          .update(RUN)
          .set({ status: "cancelled", version: run.version + 1, updatedAt: now() })
          .where(
            and(
              eq(RUN.id, run.id),
              eq(RUN.version, run.version),
              inArray(RUN.status, ["draft", "ready", "failed"]),
            ),
          )
          .returning();
        if (!row) throw staleVersion();
        return viewOf(tx, row);
      });
    },
  };
}
