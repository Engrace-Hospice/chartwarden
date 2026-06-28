// apps/backend/src/modules/33-reporting/routes/write-service-drizzle.ts — the Drizzle-backed
// M33WriteRouteService (§4.1/§4.2 MUTATING surface, #8–#31).
//
// Implements the SAME {@link M33WriteRouteService} interface as the in-memory slice, but every method
// runs inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction on the PRIMARY so Postgres
// RLS scopes each statement to `app.org_id` (writes additionally require the §4.6 permission keys at the
// route). The authoring/management CRUD reads co-locate here on the primary (read-your-write: a tenant who
// just saved a definition/version must immediately see it) — the heavier replica-routed tile / dashboard /
// catalog reads stay on `withReportSession` in read-service-drizzle.ts.
//
// The §2.3 domain rules + the D9 immutable-version-chain are the shared pure helpers in write-service.ts;
// this adapter supplies the facts (the base's status, the view's definition-spec row_limit, the cron's next
// two fires, the recipient-membership check) from real rows / injected ports and projects the rows to the
// identical DTOs. The §4.10 `m33.*` outbox events are emitted through the injected (optional) outbox port.
import { type DbClient, schema } from "@wardenx/db";
import {
  ReportCatalogRepository,
  ReportDefinitionRepository,
  ReportScheduleRepository,
  ReportShareRepository,
  ReportViewRepository,
} from "@wardenx/reporting";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError } from "@wardenx/types";
import { desc, eq } from "drizzle-orm";
import type { M33WriteActor } from "./actor";
import { type CursorPage, paginate } from "./concurrency";
import {
  type CreateDefinitionArgs,
  type CreateScheduleArgs,
  type CreateViewArgs,
  type CreateVersionArgs,
  type CronPort,
  type DefinitionVersionView,
  type DefinitionView,
  type M33WriteRouteService,
  type RecipientReaderPort,
  type ReportSpec,
  type ScheduleRunView,
  type ScheduleView,
  type ShareView,
  type ShareViewArgs,
  type UpdateScheduleArgs,
  type UpdateViewArgs,
  type ViewView,
  type WriteOutboxPort,
  RecipientNotInOrgError,
  acceptAllRecipientReader,
  assertBaseActive,
  assertCronCadence,
  assertPdfRowLimit,
} from "./write-service";

/** The structural org-context transaction handle the repos write through. */
export type WriteTx = DbClient;

/** Deps the production M33 write service binds at boot (P2C). */
export interface M33WriteDrizzleDeps {
  /** The PRIMARY Drizzle client (RLS-enforced; the org-context tx runs on this). */
  readonly db: DbClient;
  /** Cron parsing (`next_run_at` + the §2.3 cadence guard). Boot binds `cron-parser`. */
  readonly cron: CronPort;
  /** §2.3 RECIPIENT_NOT_IN_ORG recipient validation (deny-stub accepts when omitted). */
  readonly recipients?: RecipientReaderPort;
  /** The §4.10 `m33.*` transactional-outbox emitter (optional; best-effort until the dispatcher binds). */
  readonly outbox?: WriteOutboxPort;
  /** Injected clock (deterministic timestamps in tests). */
  readonly now?: () => Date;
}

const toIso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function mapDefinition(row: schema.ReportDefinition): DefinitionView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    authorship: row.authorship,
    baseKey: row.baseKey,
    ownerMembershipId: row.ownerMembershipId ?? null,
    displayName: row.displayName,
    description: row.description ?? null,
    latestVersionId: row.latestVersionId ?? null,
    versionSeq: row.versionSeq,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    archivedAt: toIso(row.archivedAt),
  };
}

function mapVersion(row: schema.ReportDefinitionVersion): DefinitionVersionView {
  return {
    id: row.id,
    definitionId: row.definitionId,
    organizationId: row.organizationId,
    versionNumber: row.versionNumber,
    spec: row.spec as unknown as ReportSpec,
    status: row.status,
    publishedAt: toIso(row.publishedAt),
    supersededAt: toIso(row.supersededAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapView(row: schema.ReportView): ViewView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    definitionVersionId: row.definitionVersionId,
    ownerMembershipId: row.ownerMembershipId,
    displayName: row.displayName,
    pinnedFilters: (row.pinnedFilters ?? []) as unknown as Record<string, unknown>[],
    shareScope: row.shareScope,
    shareRoleKeys: row.shareRoleKeys ?? null,
    isOrgDefault: row.isOrgDefault,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapShare(row: schema.ReportShare): ShareView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    reportViewId: row.reportViewId,
    sharedWithMembershipId: row.sharedWithMembershipId ?? null,
    sharedWithRoleKey: row.sharedWithRoleKey ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    revokedAt: toIso(row.revokedAt),
  };
}

function mapSchedule(row: schema.ReportSchedule): ScheduleView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    reportViewId: row.reportViewId,
    ownerMembershipId: row.ownerMembershipId,
    cronExpression: row.cronExpression,
    tenantTimezone: row.tenantTimezone,
    format: row.format,
    recipientMembershipIds: row.recipientMembershipIds ?? [],
    deliveryChannel: row.deliveryChannel,
    nextRunAt: toIso(row.nextRunAt),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    cancelledAt: toIso(row.cancelledAt),
  };
}

function mapRun(row: schema.ReportScheduleRun): ScheduleRunView {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    organizationId: row.organizationId,
    scheduledFor: row.scheduledFor.toISOString(),
    status: row.status,
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    documentId: row.documentId ?? null,
    failureReason: row.failureReason ?? null,
    rowCount: row.rowCount ?? null,
  };
}

const withKey = <T extends { id: string; createdAt: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );

export function createDrizzleM33WriteBackend(deps: M33WriteDrizzleDeps): {
  service: M33WriteRouteService;
} {
  const recipients = deps.recipients ?? acceptAllRecipientReader;
  const now = deps.now ?? (() => new Date());

  /** Run `fn` inside the actor's own org-context tx (RLS scopes to `app.org_id`; never bypass). */
  const inOrgCtx = <T>(actor: M33WriteActor, fn: (tx: WriteTx) => Promise<T>): Promise<T> =>
    withOrgContext<WriteTx, T>(
      deps.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  /**
   * Emit a §4.10 `m33.*` event through the (optional) transactional-outbox port, on the CALLER'S tx so the
   * row commits in the same unit of work as the mutation. `organizationId`/`aggregateKind`/`aggregateId`
   * route the persisted `outbox_event` row (the org-scoped table requires both uuids non-null); the
   * `payload` is Value.Check'd against the registered catalog schema by the dispatcher (refuse-on-failure).
   */
  const emit = async (
    tx: WriteTx,
    input: {
      eventName: string;
      payload: Record<string, unknown>;
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
    },
  ): Promise<void> => {
    if (deps.outbox) await deps.outbox.publish(tx, input);
  };

  /** §2.3 RECIPIENT_NOT_IN_ORG — refuse a schedule whose recipients are not active org memberships. */
  const assertRecipientsInOrg = async (
    organizationId: string,
    ids: readonly string[],
  ): Promise<void> => {
    const foreign = await recipients.findForeignOrInactive(organizationId, ids);
    if (foreign.length > 0) throw new RecipientNotInOrgError(foreign);
  };

  /** Resolve the row_limit of the view's bound definition version (for §2.3 PDF_ROW_LIMIT_EXCEEDED). */
  const rowLimitOfView = async (tx: WriteTx, view: schema.ReportView): Promise<number | undefined> => {
    const version = await new ReportDefinitionRepository(tx).findVersionById(view.definitionVersionId);
    return version?.spec?.rowLimit;
  };

  /** Compute the cron's next two fires (for §2.3 cadence) + the persisted `next_run_at`. */
  const cronFires = (cronExpression: string, tenantTimezone: string): { first: Date; second: Date } => {
    const first = deps.cron.nextRunAfter(cronExpression, tenantTimezone, now());
    const second = deps.cron.nextRunAfter(cronExpression, tenantTimezone, first);
    return { first, second };
  };

  const service: M33WriteRouteService = {
    // ── definitions ──
    async createDefinition(actor, args: CreateDefinitionArgs) {
      return inOrgCtx(actor, async (tx) => {
        const base = await new ReportCatalogRepository(tx).findBaseByKey(args.baseKey);
        assertBaseActive(args.baseKey, base?.status ?? null);
        const repo = new ReportDefinitionRepository(tx);
        const def = await repo.createDefinition({
          organizationId: actor.organizationId,
          authorship: "tenant",
          baseKey: args.baseKey,
          ownerMembershipId: actor.membershipId,
          displayName: args.displayName,
          description: args.description ?? null,
          versionSeq: 0,
          status: "draft",
        });
        await repo.createVersion({
          definitionId: def.id,
          organizationId: actor.organizationId,
          versionNumber: 1,
          spec: args.spec as unknown as schema.ReportDefinitionSpec,
          status: "draft",
          createdByMembershipId: actor.membershipId,
        });
        return mapDefinition(def);
      });
    },
    async listDefinitions(actor, filter, cursor, limit) {
      const rows = await inOrgCtx(actor, async (tx) =>
        new ReportDefinitionRepository(tx).listDefinitions(actor.organizationId, {
          status: filter.status as schema.ReportDefinition["status"] | undefined,
          authorship: filter.authorship as schema.ReportDefinition["authorship"] | undefined,
        }),
      );
      const mapped = withKey(rows.map(mapDefinition));
      return paginate(mapped, cursor, limit) as CursorPage<DefinitionView>;
    },
    async getDefinition(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const row = await new ReportDefinitionRepository(tx).findDefinitionById(id);
        if (!row || row.organizationId !== actor.organizationId) {
          throw new NotFoundError("report definition");
        }
        return mapDefinition(row);
      });
    },
    async listVersions(actor, definitionId, cursor, limit) {
      const rows = await inOrgCtx(actor, async (tx) => {
        const repo = new ReportDefinitionRepository(tx);
        const def = await repo.findDefinitionById(definitionId);
        if (!def || def.organizationId !== actor.organizationId) {
          throw new NotFoundError("report definition");
        }
        return repo.listVersions(definitionId);
      });
      const mapped = withKey(rows.map(mapVersion));
      return paginate(mapped, cursor, limit) as CursorPage<DefinitionVersionView>;
    },
    async createVersion(actor, definitionId, args: CreateVersionArgs) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportDefinitionRepository(tx);
        const def = await repo.findDefinitionById(definitionId);
        if (!def || def.organizationId !== actor.organizationId) {
          throw new NotFoundError("report definition");
        }
        const base = await new ReportCatalogRepository(tx).findBaseByKey(def.baseKey);
        assertBaseActive(def.baseKey, base?.status ?? null);
        const latest = await repo.findLatestVersion(definitionId);
        const nextNumber = (latest?.versionNumber ?? 0) + 1;
        const version = await repo.createVersion({
          definitionId,
          organizationId: actor.organizationId,
          versionNumber: nextNumber,
          spec: args.spec as unknown as schema.ReportDefinitionSpec,
          status: "draft", // D9 — editing appends a new unpublished draft
          createdByMembershipId: actor.membershipId,
        });
        if (args.displayName || args.description !== undefined) {
          await repo.updateDefinition(definitionId, def.versionSeq, {
            displayName: args.displayName ?? def.displayName,
            description: args.description ?? def.description,
          });
        }
        return mapVersion(version);
      });
    },
    async publishVersion(actor, definitionId, versionId) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportDefinitionRepository(tx);
        const def = await repo.findDefinitionById(definitionId);
        if (!def || def.organizationId !== actor.organizationId) {
          throw new NotFoundError("report definition");
        }
        const version = await repo.findVersionById(versionId);
        if (!version || version.definitionId !== definitionId) {
          throw new NotFoundError("report definition version");
        }
        if (version.status === "superseded") {
          throw new ConflictError("a superseded version cannot be published");
        }
        const publishedAt = now();
        // D9 — supersede the prior latest.
        if (def.latestVersionId && def.latestVersionId !== versionId) {
          await repo.updateVersionStatus(def.latestVersionId, {
            status: "superseded",
            supersededAt: publishedAt,
          });
        }
        const newVersion = await repo.updateVersionStatus(versionId, {
          status: "published",
          publishedAt: version.publishedAt ?? publishedAt,
          publishedByMembershipId: actor.membershipId,
        });
        // optimistic-concurrency bump on the definition (stale → 409 retry).
        const newDef = await repo.updateDefinition(definitionId, def.versionSeq, {
          status: "published",
          latestVersionId: versionId,
        });
        if (!newDef) throw new ConflictError("the definition was modified concurrently; retry");
        await emit(tx, {
          eventName: "m33.report_definition.published",
          organizationId: actor.organizationId,
          aggregateKind: "report_definition",
          aggregateId: definitionId,
          payload: {
            definitionId,
            versionId,
            baseKey: def.baseKey,
            organizationId: actor.organizationId,
            publishedByMembershipId: actor.membershipId,
          },
        });
        return { definition: mapDefinition(newDef), version: mapVersion(newVersion) };
      });
    },
    async archiveDefinition(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportDefinitionRepository(tx);
        const def = await repo.findDefinitionById(id);
        if (!def || def.organizationId !== actor.organizationId) {
          throw new NotFoundError("report definition");
        }
        const archived = await repo.updateDefinition(id, def.versionSeq, {
          status: "archived",
          archivedAt: now(),
        });
        if (!archived) throw new ConflictError("the definition was modified concurrently; retry");
        return mapDefinition(archived);
      });
    },

    // ── saved views + sharing ──
    async listViews(actor, filter, cursor, limit) {
      const rows = await inOrgCtx(actor, async (tx) => {
        const repo = new ReportViewRepository(tx);
        return filter.scope === "org"
          ? repo.listOrgShared(actor.organizationId)
          : repo.listByOwner(actor.organizationId, actor.membershipId);
      });
      const mapped = withKey(rows.map(mapView));
      return paginate(mapped, cursor, limit) as CursorPage<ViewView>;
    },
    async createView(actor, args: CreateViewArgs) {
      return inOrgCtx(actor, async (tx) => {
        const row = await new ReportViewRepository(tx).create({
          organizationId: actor.organizationId,
          definitionVersionId: args.definitionVersionId,
          ownerMembershipId: actor.membershipId,
          displayName: args.displayName,
          pinnedFilters: (args.pinnedFilters ?? []) as unknown as schema.ReportFilter[],
          shareScope: args.shareScope ?? "private",
          shareRoleKeys: args.shareRoleKeys ? [...args.shareRoleKeys] : null,
          isOrgDefault: false,
          status: "active",
        });
        return mapView(row);
      });
    },
    async getView(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const row = await new ReportViewRepository(tx).findById(id);
        if (!row || row.organizationId !== actor.organizationId) {
          throw new NotFoundError("report view");
        }
        return mapView(row);
      });
    },
    async updateView(actor, id, args: UpdateViewArgs) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportViewRepository(tx);
        const existing = await repo.findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report view");
        }
        const row = await repo.update(id, {
          displayName: args.displayName ?? existing.displayName,
          pinnedFilters: (args.pinnedFilters ?? existing.pinnedFilters) as unknown as schema.ReportFilter[],
          shareScope: args.shareScope ?? existing.shareScope,
          shareRoleKeys: args.shareRoleKeys ? [...args.shareRoleKeys] : existing.shareRoleKeys,
        });
        return mapView(row);
      });
    },
    async shareView(actor, id, args: ShareViewArgs, canShareOrg) {
      return inOrgCtx(actor, async (tx) => {
        const viewRepo = new ReportViewRepository(tx);
        const existing = await viewRepo.findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report view");
        }
        if (args.shareScope === "org" && !canShareOrg) {
          throw new ConflictError("org-scope sharing requires the report.share.org permission");
        }
        const updated = await viewRepo.update(id, {
          shareScope: args.shareScope,
          shareRoleKeys: args.shareRoleKeys ? [...args.shareRoleKeys] : existing.shareRoleKeys,
        });
        let share: ShareView | null = null;
        if (args.shareScope === "role" && (args.shareRoleKeys?.length || args.sharedWithMembershipId)) {
          const row = await new ReportShareRepository(tx).create({
            organizationId: actor.organizationId,
            reportViewId: id,
            sharedWithMembershipId: args.sharedWithMembershipId ?? null,
            sharedWithRoleKey: args.shareRoleKeys?.[0] ?? null,
            status: "active",
          });
          share = mapShare(row);
        }
        if (args.shareScope === "org") {
          await emit(tx, {
            eventName: "m33.report_view.shared_org",
            organizationId: actor.organizationId,
            aggregateKind: "report_view",
            aggregateId: id,
            payload: {
              viewId: id,
              viewName: updated.displayName,
              sharedByMembershipId: actor.membershipId,
              organizationId: actor.organizationId,
            },
          });
        }
        return { view: mapView(updated), share };
      });
    },
    async setOrgDefault(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportViewRepository(tx);
        const existing = await repo.findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report view");
        }
        // exactly-one-default invariant (D17): clear the others, then promote this one to org-default.
        await repo.clearOrgDefault(actor.organizationId, id);
        const row = await repo.update(id, { isOrgDefault: true, shareScope: "org" });
        return mapView(row);
      });
    },
    async archiveView(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportViewRepository(tx);
        const existing = await repo.findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report view");
        }
        const row = await repo.update(id, { status: "archived", isOrgDefault: false });
        return mapView(row);
      });
    },

    // ── scheduled reports ──
    async listSchedules(actor, filter, cursor, limit) {
      const rows = await inOrgCtx(actor, async (tx) => {
        const all = await new ReportScheduleRepository(tx).listActiveForOrg(actor.organizationId);
        // listActiveForOrg returns active only; for a status filter we narrow, else all active.
        return filter.status && filter.status !== "active" ? [] : all;
      });
      const mapped = withKey(rows.map(mapSchedule));
      return paginate(mapped, cursor, limit) as CursorPage<ScheduleView>;
    },
    async createSchedule(actor, args: CreateScheduleArgs) {
      return inOrgCtx(actor, async (tx) => {
        const view = await new ReportViewRepository(tx).findById(args.reportViewId);
        if (!view || view.organizationId !== actor.organizationId) {
          throw new NotFoundError("report view");
        }
        await assertRecipientsInOrg(actor.organizationId, args.recipientMembershipIds);
        assertPdfRowLimit(args.format, await rowLimitOfView(tx, view));
        const { first, second } = cronFires(args.cronExpression, args.tenantTimezone);
        assertCronCadence(first, second);
        const row = await new ReportScheduleRepository(tx).create({
          organizationId: actor.organizationId,
          reportViewId: args.reportViewId,
          ownerMembershipId: actor.membershipId,
          cronExpression: args.cronExpression,
          tenantTimezone: args.tenantTimezone,
          format: args.format,
          recipientMembershipIds: [...args.recipientMembershipIds],
          deliveryChannel: "in_app",
          nextRunAt: first,
          status: "active",
        });
        await emit(tx, {
          eventName: "m33.report_schedule.created",
          organizationId: actor.organizationId,
          aggregateKind: "report_schedule",
          aggregateId: row.id,
          payload: {
            scheduleId: row.id,
            viewId: args.reportViewId,
            ownerMembershipId: actor.membershipId,
            cronExpression: args.cronExpression,
            recipientCount: args.recipientMembershipIds.length,
            organizationId: actor.organizationId,
          },
        });
        return mapSchedule(row);
      });
    },
    async getSchedule(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const row = await new ReportScheduleRepository(tx).findById(id);
        if (!row || row.organizationId !== actor.organizationId) {
          throw new NotFoundError("report schedule");
        }
        return mapSchedule(row);
      });
    },
    async updateSchedule(actor, id, args: UpdateScheduleArgs) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportScheduleRepository(tx);
        const existing = await repo.findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report schedule");
        }
        if (existing.status === "cancelled") {
          throw new ConflictError("a cancelled schedule cannot be edited");
        }
        const format = args.format ?? existing.format;
        if (args.recipientMembershipIds) {
          await assertRecipientsInOrg(actor.organizationId, args.recipientMembershipIds);
        }
        const view = await new ReportViewRepository(tx).findById(existing.reportViewId);
        assertPdfRowLimit(format, view ? await rowLimitOfView(tx, view) : undefined);
        let nextRunAt = existing.nextRunAt;
        const cronExpression = args.cronExpression ?? existing.cronExpression;
        const tenantTimezone = args.tenantTimezone ?? existing.tenantTimezone;
        if (args.cronExpression || args.tenantTimezone) {
          const { first, second } = cronFires(cronExpression, tenantTimezone);
          assertCronCadence(first, second);
          if (existing.status === "active") nextRunAt = first;
        }
        const row = await repo.update(id, {
          cronExpression,
          tenantTimezone,
          format,
          recipientMembershipIds: args.recipientMembershipIds
            ? [...args.recipientMembershipIds]
            : existing.recipientMembershipIds,
          nextRunAt,
        });
        return mapSchedule(row);
      });
    },
    async pauseSchedule(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportScheduleRepository(tx);
        const existing = await repo.findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report schedule");
        }
        if (existing.status === "cancelled") {
          throw new ConflictError("a cancelled schedule cannot be paused");
        }
        const row = await repo.update(id, { status: "paused", nextRunAt: null });
        return mapSchedule(row);
      });
    },
    async resumeSchedule(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportScheduleRepository(tx);
        const existing = await repo.findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report schedule");
        }
        if (existing.status === "cancelled") {
          throw new ConflictError("a cancelled schedule cannot be resumed");
        }
        const { first } = cronFires(existing.cronExpression, existing.tenantTimezone);
        const row = await repo.update(id, { status: "active", nextRunAt: first });
        return mapSchedule(row);
      });
    },
    async cancelSchedule(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const repo = new ReportScheduleRepository(tx);
        const existing = await repo.findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report schedule");
        }
        const row = await repo.update(id, {
          status: "cancelled",
          nextRunAt: null,
          cancelledAt: now(),
        });
        return mapSchedule(row);
      });
    },
    async deleteAllRuns(actor, id) {
      return inOrgCtx(actor, async (tx) => {
        const existing = await new ReportScheduleRepository(tx).findById(id);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("report schedule");
        }
        const deletedRows = await tx
          .delete(schema.reportScheduleRun)
          .where(eq(schema.reportScheduleRun.scheduleId, id))
          .returning({ id: schema.reportScheduleRun.id });
        return { scheduleId: id, deleted: deletedRows.length };
      });
    },
    async listScheduleRuns(actor, scheduleId, cursor, limit) {
      const rows = await inOrgCtx(actor, async (tx) => {
        const schedule = await new ReportScheduleRepository(tx).findById(scheduleId);
        if (!schedule || schedule.organizationId !== actor.organizationId) {
          throw new NotFoundError("report schedule");
        }
        return tx
          .select()
          .from(schema.reportScheduleRun)
          .where(eq(schema.reportScheduleRun.scheduleId, scheduleId))
          .orderBy(desc(schema.reportScheduleRun.scheduledFor))
          .limit(500);
      });
      const mapped = withKey(
        rows.map((r) => ({ ...mapRun(r), createdAt: r.scheduledFor.toISOString() })),
      );
      const page = paginate(mapped, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...r }) => r) };
    },
    async getScheduleRun(actor, runId) {
      return inOrgCtx(actor, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.reportScheduleRun)
          .where(eq(schema.reportScheduleRun.id, runId))
          .limit(1);
        if (!row || row.organizationId !== actor.organizationId) {
          throw new NotFoundError("report schedule run");
        }
        return mapRun(row);
      });
    },
  };

  return { service };
}
