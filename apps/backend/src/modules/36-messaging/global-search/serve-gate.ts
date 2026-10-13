// WP 2.7b C3 (ADR-0058 decision 13, "Enablement and kill switches") - the three route gates that decide whether global search
// may ANSWER for this tenant right now. Each is a Fastify preHandler; they stash what they read per request so the service gets
// one typed `ServeContext` (the only thing that lets a query run) instead of re-reading.
//
//   platform  the ops kill switch, read from the org-NULL row ALONE (never forOrg). Absent or false -> 403
//             GLOBAL_SEARCH_DISABLED; a read error -> 503 (fail closed, never "off by accident of an exception").
//   tenant    `tenant_messaging_search_setting.enabled`; no row = OFF -> 403 GLOBAL_SEARCH_DISABLED.
//   serve     the index may be QUERIED: a purge is not pending (rows may linger after OFF), the active key version's state is
//             'ready' AND reconciled since the setting and the platform row last changed AND not expired (C2's `stillValid`),
//             otherwise 503 GLOBAL_SEARCH_INDEX_NOT_READY. Status alone is not enough (a flip invalidates a prior reconcile).
// Any unexpected failure (key provider, destroyed ring, database) is 503: no gate ever falls back to "allowed".
import { type DbClient, schema } from "@wardenx/db";
import type { SearchKeyProvider } from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { PlatformSearchFlag, PlatformSearchFlagState } from "./platform-flag";
import { RECHECK_AFTER_MS, stillValid } from "./reconcile";
import type { TenantSearchSetting, TenantSearchSettingStore } from "./tenant-setting-store";

const STATE = schema.messageSearchIndexStates;

export interface VersionPlan {
  readonly keyVersion: string;
  readonly tagBits: number;
  readonly headBuckets: ReadonlySet<number>;
}

/** What the service needs to run one query. Produced only by the `serve` gate. `versions[0]` is the active version. */
export interface ServeContext {
  readonly versions: readonly VersionPlan[];
}

export interface ServeGateDeps {
  readonly db: DbClient;
  readonly platformFlag: PlatformSearchFlag;
  readonly settings: TenantSearchSettingStore;
  readonly keys: SearchKeyProvider;
  readonly now?: () => number;
}

export type GateHandler = (request: FastifyRequest) => Promise<void>;

export interface ServeGates {
  readonly platform: GateHandler;
  readonly tenant: GateHandler;
  readonly serve: GateHandler;
  /** The context the `serve` gate produced for this request; 503 when the gates did not run (fail closed). */
  contextOf(request: FastifyRequest): ServeContext;
}

const disabled = () =>
  new WardenXError("GLOBAL_SEARCH_DISABLED", "global search is not enabled", 403);
const notReady = () =>
  new WardenXError("GLOBAL_SEARCH_INDEX_NOT_READY", "the search index is not ready", 503);
const unavailable = () =>
  new WardenXError("GLOBAL_SEARCH_UNAVAILABLE", "global search is unavailable", 503);

function orgOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** Typed refusals pass through; anything else is logged by NAME only (never a message: it could carry a query) and is a 503. */
function failClosed(request: FastifyRequest, error: unknown): never {
  if (error instanceof WardenXError || error instanceof UnauthorizedError) throw error;
  request.log.error(
    { reason: error instanceof Error ? error.name : "unknown" },
    "global search gate failed closed",
  );
  throw unavailable();
}

interface RequestState {
  platform?: PlatformSearchFlagState;
  setting?: TenantSearchSetting;
  serve?: ServeContext;
}

export function createServeGates(deps: ServeGateDeps): ServeGates {
  const states = new WeakMap<object, RequestState>();
  const stateOf = (request: FastifyRequest): RequestState => {
    const existing = states.get(request);
    if (existing) return existing;
    const created: RequestState = {};
    states.set(request, created);
    return created;
  };
  const now = deps.now ?? Date.now;

  return {
    async platform(request) {
      try {
        const { organizationId } = orgOf(request);
        const flag = await deps.platformFlag.read(organizationId);
        if (!flag.enabled) throw disabled();
        stateOf(request).platform = flag;
      } catch (error) {
        failClosed(request, error);
      }
    },

    async tenant(request) {
      try {
        const { organizationId } = orgOf(request);
        const setting = await deps.settings.read(organizationId);
        if (!setting.enabled) throw disabled();
        stateOf(request).setting = setting;
      } catch (error) {
        failClosed(request, error);
      }
    },

    async serve(request) {
      try {
        const { organizationId, userId } = orgOf(request);
        const { platform, setting } = stateOf(request);
        if (!platform || !setting) throw unavailable();
        // A pending purge refuses even though rows may still exist: a slow purge never leaves search answering.
        if (setting.purgeRequestedAt && !setting.purgeCompletedAt) throw notReady();

        const versions = await deps.keys.liveVersions(organizationId);
        const active = versions[0];
        if (!active) throw unavailable();
        const rows = await withOrgContext(deps.db, { organizationId, userId }, (tx) =>
          tx
            .select({
              keyVersion: STATE.keyVersion,
              tagBits: STATE.tagBits,
              status: STATE.status,
              reconciledAt: STATE.reconciledAt,
              headBuckets: STATE.headBuckets,
            })
            .from(STATE)
            .where(and(eq(STATE.organizationId, organizationId), inArray(STATE.keyVersion, [...versions]))),
        );
        const since = [setting.changedAt, platform.updatedAt];
        const usable = new Map(
          rows
            .filter((row) =>
              stillValid(
                { status: row.status as "building" | "ready" | "stale", reconciledAt: row.reconciledAt },
                since,
                now(),
                RECHECK_AFTER_MS,
              ),
            )
            .map((row) => [row.keyVersion, row]),
        );
        // The ACTIVE version must be servable; an older live version (rotation overlap) is queried only while it is too.
        if (!usable.has(active)) throw notReady();
        stateOf(request).serve = {
          versions: versions.flatMap((version) => {
            const row = usable.get(version);
            return row
              ? [
                  {
                    keyVersion: version,
                    tagBits: row.tagBits,
                    headBuckets: new Set(row.headBuckets),
                  },
                ]
              : [];
          }),
        };
      } catch (error) {
        failClosed(request, error);
      }
    },

    contextOf(request) {
      const context = states.get(request)?.serve;
      if (!context) throw unavailable();
      return context;
    },
  };
}
