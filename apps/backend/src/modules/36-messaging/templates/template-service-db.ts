// apps/backend/src/modules/36-messaging/templates/template-service-db.ts - M36 WP 2.8 message templates and saved
// replies over Drizzle (migration 1086). The in-memory twin is packages/messaging templates/in-memory-template-service.ts;
// validation (lint, bounds, the overlay floor) is the shared pure code in template-model.ts, run here BEFORE any write.
//
// Everything runs under `withOrgContext` (RLS on app.org_id is the backstop); org and actor come from the server-side
// request context. RLS keeps a tenant out of another tenant and out of writing the platform scope; "personal" is private
// to its owner by the `owner_user_id = actor` filter in this file (RLS keys only on org, like every M36 table).
// Every id that is not the caller's to touch answers the same 404 a random id gets, including a non-uuid string.
import { type DbClient, schema } from "@wardenx/db";
import {
  type OverlayInput,
  type PlatformTemplate,
  TEMPLATE_LIMITS,
  type TemplateActor,
  type TemplateAdminView,
  type TemplateCategory,
  type TemplateInput,
  type TemplateOverlay,
  type TemplatePatch,
  type TemplateService,
  type TemplateView,
  effectiveForOrg,
  isServable,
  limitReachedError,
  prepareOverlay,
  prepareTemplate,
  prepareTemplatePatch,
  titleTakenError,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, asc, eq, sql } from "drizzle-orm";

const T = schema.messageTemplates;
const O = schema.tenantMessageTemplateOverlays;
type Row = typeof T.$inferSelect;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

const toPlatform = (row: Row): PlatformTemplate => ({
  id: row.id,
  templateKey: row.templateKey ?? "",
  category: row.category,
  title: row.title,
  body: row.body,
  requiredPhrases: row.requiredPhrases,
});

const toView = (row: Row): TemplateView => ({
  id: row.id,
  scope: row.scope,
  templateKey: null,
  category: row.category,
  title: row.title,
  body: row.body,
  customized: false,
});

const SCOPE_ORDER = { platform: 0, org: 1, personal: 2 } as const;
const byScopeThenTitle = (a: TemplateView, b: TemplateView): number =>
  SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.title.localeCompare(b.title);

/** A unique-index violation (drizzle may wrap the pg error in `cause`) on one of the title indexes. */
function isTitleCollision(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string; cause?: unknown } | null;
  if (!e) return false;
  if (e.code === UNIQUE_VIOLATION) return /_title_uk$/.test(e.constraint ?? "");
  return e.cause ? isTitleCollision(e.cause) : false;
}

export function createDbTemplateService(db: DbClient): TemplateService {
  const run = async <R>(actor: TemplateActor, fn: (tx: Tx) => Promise<R>): Promise<R> => {
    try {
      return await withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        (tx) => fn(tx as unknown as Tx),
      );
    } catch (error) {
      if (isTitleCollision(error)) throw titleTakenError();
      throw error;
    }
  };

  const platformRows = async (tx: Tx): Promise<PlatformTemplate[]> =>
    (await tx.select().from(T).where(eq(T.scope, "platform")).orderBy(asc(T.templateKey))).map(
      toPlatform,
    );

  const overlaysOf = async (tx: Tx, actor: TemplateActor): Promise<TemplateOverlay[]> =>
    (await tx.select().from(O).where(eq(O.organizationId, actor.organizationId))).map((o) => ({
      templateId: o.templateId,
      title: o.title,
      body: o.body,
      isEnabled: o.isEnabled,
    }));

  const sharedRows = (tx: Tx, actor: TemplateActor): Promise<Row[]> =>
    tx
      .select()
      .from(T)
      .where(and(eq(T.scope, "org"), eq(T.organizationId, actor.organizationId)));

  const personalRows = (tx: Tx, actor: TemplateActor): Promise<Row[]> =>
    tx
      .select()
      .from(T)
      .where(
        and(
          eq(T.scope, "personal"),
          eq(T.organizationId, actor.organizationId),
          eq(T.ownerUserId, actor.userId),
        ),
      );

  async function listIn(tx: Tx, actor: TemplateActor): Promise<TemplateView[]> {
    const [platform, overlays, shared, personal] = await Promise.all([
      platformRows(tx),
      overlaysOf(tx, actor),
      sharedRows(tx, actor),
      personalRows(tx, actor),
    ]);
    return [
      ...effectiveForOrg(platform, overlays),
      ...[...shared, ...personal].filter(isServable).map(toView),
    ].sort(byScopeThenTitle);
  }

  /** The caller's own row of `scope` (a shared row for 'org', their private row for 'personal'), locked, or 404. */
  async function ownRow(
    tx: Tx,
    actor: TemplateActor,
    id: string,
    scope: "org" | "personal",
  ): Promise<Row> {
    if (!UUID.test(id)) throw new NotFoundError("template", id);
    const [row] = await tx
      .select()
      .from(T)
      .where(
        and(
          eq(T.id, id),
          eq(T.scope, scope),
          eq(T.organizationId, actor.organizationId),
          scope === "personal" ? eq(T.ownerUserId, actor.userId) : sql`true`,
        ),
      )
      .for("update");
    if (!row) throw new NotFoundError("template", id);
    return row;
  }

  async function createIn(
    tx: Tx,
    actor: TemplateActor,
    scope: "org" | "personal",
    input: TemplateInput,
  ): Promise<TemplateView> {
    const fields = prepareTemplate(input);
    const existing = await (scope === "org" ? sharedRows(tx, actor) : personalRows(tx, actor));
    const limit = scope === "org" ? TEMPLATE_LIMITS.sharedPerOrg : TEMPLATE_LIMITS.personalPerUser;
    if (existing.length >= limit) throw limitReachedError();
    const [row] = await tx
      .insert(T)
      .values({
        organizationId: actor.organizationId,
        scope,
        ownerUserId: scope === "personal" ? actor.userId : null,
        createdByUserId: actor.userId,
        category: fields.category,
        title: fields.title,
        body: fields.body,
      })
      .returning();
    return toView(row as Row);
  }

  async function updateIn(
    tx: Tx,
    actor: TemplateActor,
    scope: "org" | "personal",
    id: string,
    patch: TemplatePatch,
  ): Promise<TemplateView> {
    const existing = await ownRow(tx, actor, id, scope);
    const fields = prepareTemplatePatch(existing, patch);
    const [row] = await tx
      .update(T)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(T.id, existing.id))
      .returning();
    return toView(row as Row);
  }

  async function platformById(tx: Tx, id: string): Promise<PlatformTemplate> {
    if (!UUID.test(id)) throw new NotFoundError("template", id);
    const [row] = await tx
      .select()
      .from(T)
      .where(and(eq(T.id, id), eq(T.scope, "platform")));
    if (!row) throw new NotFoundError("template", id);
    return toPlatform(row);
  }

  return {
    list: (actor) => run(actor, (tx) => listIn(tx, actor)),

    async get(actor, id) {
      const found = (await run(actor, (tx) => listIn(tx, actor))).find((t) => t.id === id);
      if (!found) throw new NotFoundError("template", id);
      return found;
    },

    createPersonal: (actor, input) => run(actor, (tx) => createIn(tx, actor, "personal", input)),
    updatePersonal: (actor, id, patch) =>
      run(actor, (tx) => updateIn(tx, actor, "personal", id, patch)),
    deletePersonal: (actor, id) =>
      run(actor, async (tx) => {
        const row = await ownRow(tx, actor, id, "personal");
        await tx.delete(T).where(eq(T.id, row.id));
      }),

    adminList: (actor): Promise<TemplateAdminView> =>
      run(actor, async (tx) => {
        const [platform, overlays, shared] = await Promise.all([
          tx.select().from(T).where(eq(T.scope, "platform")).orderBy(asc(T.templateKey)),
          tx.select().from(O).where(eq(O.organizationId, actor.organizationId)),
          sharedRows(tx, actor),
        ]);
        const byTemplate = new Map(overlays.map((o) => [o.templateId, o] as const));
        return {
          platform: platform.map((p) => {
            const o = byTemplate.get(p.id);
            return {
              id: p.id,
              templateKey: p.templateKey ?? "",
              category: p.category as TemplateCategory,
              floorTitle: p.title,
              floorBody: p.body,
              requiredPhrases: p.requiredPhrases,
              overlay: o
                ? {
                    title: o.title,
                    body: o.body,
                    isEnabled: o.isEnabled,
                    updatedAt: o.updatedAt.toISOString(),
                  }
                : null,
            };
          }),
          shared: shared.map(toView).sort(byScopeThenTitle),
        };
      }),

    createShared: (actor, input) => run(actor, (tx) => createIn(tx, actor, "org", input)),
    updateShared: (actor, id, patch) => run(actor, (tx) => updateIn(tx, actor, "org", id, patch)),
    deleteShared: (actor, id) =>
      run(actor, async (tx) => {
        const row = await ownRow(tx, actor, id, "org");
        await tx.delete(T).where(eq(T.id, row.id));
      }),

    putOverlay: (actor, templateId, overlay: OverlayInput) =>
      run(actor, async (tx) => {
        const base = await platformById(tx, templateId);
        const prepared = prepareOverlay(base, overlay);
        await tx
          .insert(O)
          .values({
            organizationId: actor.organizationId,
            templateId,
            title: prepared.title,
            body: prepared.body,
            isEnabled: prepared.isEnabled,
            configuredByUserId: actor.userId,
          })
          .onConflictDoUpdate({
            target: [O.organizationId, O.templateId],
            set: {
              title: prepared.title,
              body: prepared.body,
              isEnabled: prepared.isEnabled,
              configuredByUserId: actor.userId,
              updatedAt: new Date(),
            },
          });
      }),

    deleteOverlay: (actor, templateId) =>
      run(actor, async (tx) => {
        await platformById(tx, templateId);
        await tx
          .delete(O)
          .where(and(eq(O.organizationId, actor.organizationId), eq(O.templateId, templateId)));
      }),
  };
}
