// @wardenx/messaging - in-memory TemplateService (M36 WP 2.8): the DB-free double the route tests run on. Same rules as
// the Drizzle service (validation lives in template-model.ts and is shared); state is per instance.
import { NotFoundError } from "@wardenx/types";
import {
  type PlatformTemplate,
  TEMPLATE_LIMITS,
  type TemplateFields,
  type TemplateOverlay,
  type TemplateScope,
  type TemplateView,
  effectiveForOrg,
  isServable,
  limitReachedError,
  prepareOverlay,
  prepareTemplate,
  prepareTemplatePatch,
  titleKey,
  titleTakenError,
} from "./template-model";
import { PLATFORM_MESSAGE_TEMPLATES } from "./template-seed";
import type {
  OverlayInput,
  TemplateActor,
  TemplateAdminView,
  TemplateInput,
  TemplatePatch,
  TemplateService,
} from "./template-service";

interface Row extends TemplateFields {
  readonly id: string;
  readonly scope: Exclude<TemplateScope, "platform">;
  readonly organizationId: string;
  readonly ownerUserId: string | null;
}
interface StoredOverlay extends OverlayInput {
  readonly updatedAt: string;
}

const view = (row: Row): TemplateView => ({
  id: row.id,
  scope: row.scope,
  templateKey: null,
  category: row.category,
  title: row.title,
  body: row.body,
  customized: false,
});

const SCOPE_ORDER: Readonly<Record<TemplateScope, number>> = { platform: 0, org: 1, personal: 2 };
const byScopeThenTitle = (a: TemplateView, b: TemplateView): number =>
  SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.title.localeCompare(b.title);

export function createInMemoryTemplateService(
  options: { platform?: readonly PlatformTemplate[]; now?: () => Date } = {},
): TemplateService {
  const platform = options.platform ?? PLATFORM_MESSAGE_TEMPLATES;
  const now = options.now ?? (() => new Date());
  let counter = 0;
  const rows = new Map<string, Row>();
  const overlays = new Map<string, StoredOverlay>(); // `${org}|${templateId}`

  const ownRow = (actor: TemplateActor, id: string, scope: Row["scope"]): Row => {
    const row = rows.get(id);
    if (
      !row ||
      row.organizationId !== actor.organizationId ||
      row.scope !== scope ||
      (scope === "personal" && row.ownerUserId !== actor.userId)
    ) {
      throw new NotFoundError("template", id);
    }
    return row;
  };

  const scopeRows = (actor: TemplateActor, scope: Row["scope"]): Row[] =>
    [...rows.values()].filter(
      (r) =>
        r.organizationId === actor.organizationId &&
        r.scope === scope &&
        (scope === "org" || r.ownerUserId === actor.userId),
    );

  const assertTitleFree = (
    actor: TemplateActor,
    scope: Row["scope"],
    title: string,
    exceptId?: string,
  ): void => {
    const key = titleKey(title);
    if (scopeRows(actor, scope).some((r) => r.id !== exceptId && titleKey(r.title) === key)) {
      throw titleTakenError();
    }
  };

  const create = (
    actor: TemplateActor,
    scope: Row["scope"],
    input: TemplateInput,
  ): TemplateView => {
    const fields = prepareTemplate(input);
    const limit =
      scope === "personal" ? TEMPLATE_LIMITS.personalPerUser : TEMPLATE_LIMITS.sharedPerOrg;
    if (scopeRows(actor, scope).length >= limit) {
      throw limitReachedError();
    }
    assertTitleFree(actor, scope, fields.title);
    counter += 1;
    const row: Row = {
      ...fields,
      id: `tpl-${counter}`,
      scope,
      organizationId: actor.organizationId,
      ownerUserId: scope === "personal" ? actor.userId : null,
    };
    rows.set(row.id, row);
    return view(row);
  };

  const update = (
    actor: TemplateActor,
    scope: Row["scope"],
    id: string,
    patch: TemplatePatch,
  ): TemplateView => {
    const existing = ownRow(actor, id, scope);
    const fields = prepareTemplatePatch(existing, patch);
    assertTitleFree(actor, scope, fields.title, id);
    const next: Row = { ...existing, ...fields };
    rows.set(id, next);
    return view(next);
  };

  const platformFor = (id: string): PlatformTemplate => {
    const found = platform.find((p) => p.id === id);
    if (!found) throw new NotFoundError("template", id);
    return found;
  };

  const overlaysOf = (actor: TemplateActor): TemplateOverlay[] =>
    platform.flatMap((p) => {
      const stored = overlays.get(`${actor.organizationId}|${p.id}`);
      return stored ? [{ templateId: p.id, ...stored }] : [];
    });

  return {
    async list(actor) {
      const mine = [...scopeRows(actor, "org"), ...scopeRows(actor, "personal")]
        .filter(isServable)
        .map(view);
      return [...effectiveForOrg(platform, overlaysOf(actor)), ...mine].sort(byScopeThenTitle);
    },
    async get(actor, id) {
      const found = (await this.list(actor)).find((t) => t.id === id);
      if (!found) throw new NotFoundError("template", id);
      return found;
    },
    async createPersonal(actor, input) {
      return create(actor, "personal", input);
    },
    async updatePersonal(actor, id, patch) {
      return update(actor, "personal", id, patch);
    },
    async deletePersonal(actor, id) {
      rows.delete(ownRow(actor, id, "personal").id);
    },
    async adminList(actor): Promise<TemplateAdminView> {
      return {
        platform: platform.map((p) => {
          const stored = overlays.get(`${actor.organizationId}|${p.id}`);
          return {
            id: p.id,
            templateKey: p.templateKey,
            category: p.category,
            floorTitle: p.title,
            floorBody: p.body,
            requiredPhrases: p.requiredPhrases,
            overlay: stored ?? null,
          };
        }),
        shared: scopeRows(actor, "org").map(view).sort(byScopeThenTitle),
      };
    },
    async createShared(actor, input) {
      return create(actor, "org", input);
    },
    async updateShared(actor, id, patch) {
      return update(actor, "org", id, patch);
    },
    async deleteShared(actor, id) {
      rows.delete(ownRow(actor, id, "org").id);
    },
    async putOverlay(actor, templateId, overlay) {
      const base = platformFor(templateId);
      const prepared = prepareOverlay(base, overlay);
      overlays.set(`${actor.organizationId}|${templateId}`, {
        ...prepared,
        updatedAt: now().toISOString(),
      });
    },
    async deleteOverlay(actor, templateId) {
      platformFor(templateId);
      overlays.delete(`${actor.organizationId}|${templateId}`);
    },
  };
}
