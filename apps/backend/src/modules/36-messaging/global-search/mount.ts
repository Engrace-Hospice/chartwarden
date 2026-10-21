// WP 2.7b C3 (ADR-0058, Accepted) - composes and mounts the global search route. ONE call from `mountMessagingRoutes`.
//
// The route does nothing until operators enable it, by four independent defaults:
//   * the tenant flag defaults OFF (a tenant with no row is OFF) and the platform flag is absent (= OFF);
//   * `keys` defaults to the throwing provider (every call fails closed); the composition root passes the ring-backed one;
//   * `rateLimit` defaults to a hook that answers 503 DEGRADED; the composition root passes the WP 2.14 limiter only on a shared store;
//   * nothing here reads or writes anything until a request passes all of the above.
import type { DbClient } from "@chartwarden/db";
import type { SearchKeyProvider } from "@chartwarden/messaging";
import type { FastifyInstance } from "fastify";
import { type MessageBodyCipher, createMessageBodyCipher } from "../messaging-write-core";
import { type Part2ChannelGate, createSeamPart2ChannelGate } from "../part2-channel-gate";
import {
  type GlobalSearchRateLimit,
  registerGlobalSearchRoutes,
} from "../routes/global-search-routes";
import { type NameExclusions, createNameExclusions } from "./name-exclusion";
import { createPlatformSearchFlag } from "./platform-flag";
import {
  type BodyReader,
  type IsRedactedOrPending,
  createBodyReader,
  neverRedacted,
} from "./ports";
import { type ChannelAuthority, createGlobalSearchService } from "./query-service";
import { createRoleGate } from "./role-gate";
import { createUnavailableSearchKeyProvider } from "./search-key-provider";
import { createServeGates } from "./serve-gate";
import { createTenantSearchSettingStore } from "./tenant-setting-store";
import type { ResponseFloorConfig } from "./timing-floor";

export interface GlobalSearchMountOptions {
  readonly keys?: SearchKeyProvider;
  /** Default: an exclusion set with NO name source, which fails closed (every query answers 503) rather than matching names. */
  readonly exclusions?: NameExclusions;
  readonly rateLimit?: GlobalSearchRateLimit;
  /** Tests only: override the response-time floor (default: production values, env-overridable outside production). */
  readonly responseFloor?: ResponseFloorConfig;
  readonly cipher?: MessageBodyCipher;
  readonly part2Gate?: Part2ChannelGate;
  /** Tests only: the body-opening port (a spy proves what was, and was not, opened). */
  readonly bodies?: BodyReader;
  /** Tests only: the access decider (default `effectivelyVisibleChannels`). */
  readonly authority?: ChannelAuthority;
  readonly isRedactedOrPending?: IsRedactedOrPending;
  /** Ids only. */
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export function mountGlobalSearchRoutes(
  app: FastifyInstance,
  db: DbClient,
  opts: GlobalSearchMountOptions = {},
): void {
  const keys = opts.keys ?? createUnavailableSearchKeyProvider();
  const cipher = opts.cipher ?? createMessageBodyCipher();
  const warn = opts.warn ?? ((message, context) => app.log.warn(context, message));
  registerGlobalSearchRoutes(app, {
    service: createGlobalSearchService({
      db,
      bodies: opts.bodies ?? createBodyReader(cipher),
      keys,
      exclusions: opts.exclusions ?? createNameExclusions({ db, keys }),
      part2Gate: opts.part2Gate ?? createSeamPart2ChannelGate(db),
      cipher,
      ...(opts.authority ? { authority: opts.authority } : {}),
      isRedactedOrPending: opts.isRedactedOrPending ?? neverRedacted,
      warn,
    }),
    gates: createServeGates({
      db,
      platformFlag: createPlatformSearchFlag(db),
      settings: createTenantSearchSettingStore(db),
      keys,
    }),
    roleGate: createRoleGate(db),
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.responseFloor ? { responseFloor: opts.responseFloor } : {}),
  });
}
