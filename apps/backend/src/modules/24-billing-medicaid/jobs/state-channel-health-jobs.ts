// apps/backend/src/modules/24-billing-medicaid/jobs/state-channel-health-jobs.ts — the M24 §4.9
// `state-channel-health` cron (§7.8: "the Oregon CCO clearinghouse goes down (the state-channel-health
// cron detects three consecutive failed health probes); M24 emits m24.medicaid_state_channel.unavailable;
// M36 alerts ops … on health recovery the queue drains automatically").
//
// F-172 (#248, m1 group) — `registerM24CronWorkers`/`scheduleM24Jobs` (jobs/index.ts) never actually ran
// this cron: `M24_CRON_QUEUES.stateChannelHealth` is declared in the queue catalog and NOTHING constructs a
// Worker or a repeatable schedule for it, and no `run*` handler for it exists anywhere in `m24-jobs.ts`
// either — not merely unwired, genuinely unbuilt. This file is that build.
//
// SCOPING (checked against the code, not guessed): unlike M23's MAC-portal health (`organizationId: null`,
// a MAC jurisdiction serves many tenants off ONE platform-wide bearer/URL pair from env), M24's Oregon
// gateway resolves a health probe against `state_medicaid_trading_partner_credential` — a row keyed
// `(organizationId, providerEntityId, serviceState, channel)`, §3.3, the M23 `mac_submitter_credential`
// mirror — and `OregonGatewayPort.healthy(credentials)` (`@wardenx/medicaid-adapters`'s launch-gateway.ts)
// does a REAL `GET {credentials.portalUrl}/health` with `credentials.clientSecret` as the bearer token:
// the base URL AND the auth token are both per-credential-row, so two different tenants' rows can answer
// differently (a misconfigured/expired credential is a per-tenant fact; a genuine OHA MMIS outage happens
// to be a per-tenant fact that is the SAME for every tenant hitting it, but the MECHANISM is per-credential
// either way). The catalog's `organizationId: OrgId` (non-nullable) on both events is therefore CORRECT —
// this is the opposite of M23's platform-singleton shape, not a copy-paste of it. The event's own
// `OregonMedicaidAdapter.healthy()` (no credentials) is a DIFFERENT, deliberately platform/adapter-scoped
// method ("report 'gateway wired' rather than probing a specific PE's endpoint … used directly by the M24
// worker's state-channel-health cron, not through this boundary" — that file's own comment); this cron
// uses `OregonGatewayPort.healthy(credentials)` directly, exactly as that comment names.
//
// The module spec's own §4.11 payload for both events is `{ state, channel, lastSeenUpAt/downedAt,
// recoveredAt }` — no `providerEntityId` — so multiple provider entities within one org holding credentials
// for the same (state, channel) collapse onto one reported fact; the breaker is tracked per credential row
// (accurate) but the EMITTED payload matches the catalog's declared shape exactly (org+state+channel).
//
// Only Oregon has a live gateway today (WA/ID/CA/NV are Phase-1 deny-stubs whose `healthy()` ignores
// credentials and always answers `ok:false` — probing them would report "always down" forever with no
// transition ever to observe past the first tick, which is not useful signal); the probe port returns
// `null` — "nothing to report", not "down" — for any state with no live gateway configured, so this cron
// is silent (never emits) for every non-Oregon credential row until that state's own adapter ships a real
// gateway. RULE 4: the composition root only constructs this worker when a real db handle + the §8.7
// cipher port both exist; absent either, no worker constructs (never a per-tick throw).
//
// TX-SAFETY (found while building this, not assumed): every read against an org-scoped, RLS-enforced table
// must run ON THE `tx` `withOrgContext` hands its callback — a port constructed with a captured, un-scoped
// `db` handle and called from OUTSIDE that callback runs on a connection with no `app.org_id` GUC set,
// which either 22P02s or (silently) returns zero rows depending on the pool's session history. Both this
// file's own reader ports thread `tx` explicitly through every call for exactly that reason — including the
// credential resolver, which does NOT reuse `submission-jobs.ts`'s `CredentialResolverPort`/
// `buildDrizzleCredentialResolver` (both capture a `db` handle at construction time and never take a `tx`
// argument at all, so `deps.credentials.resolve(...)` in `runClaimSubmit`/`runClaimPoll` runs outside the
// `withOrgContext` tx those functions otherwise thread everywhere else — a second genuine, pre-existing
// defect this build surfaced; reported, not fixed here, out of this task's scope).
import { type DbClient, schema } from "@wardenx/db";
import type { OregonGatewayPort, TradingPartnerCredentials } from "@wardenx/medicaid-adapters";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { type CredentialCipherPort, isUsableCipher } from "../credential-crypto";
import { M24_CRON_QUEUES, M24_JOB_SCHEDULES, M24_QUEUE_PARAMS } from "./queues";

const M24_STATE_CHANNEL_SYSTEM_USER_ID = "";

type Tx = DbClient;

/**
 * The REAL shape the composition root's bound outbox publisher requires (`bindCallerModule`'s return
 * type in `apps/backend/src/index.ts`) — `organizationId`/`aggregateKind`/`aggregateId` are required
 * top-level fields on every publish, not part of `payload`. Deliberately NOT `submission-jobs.ts`'s
 * narrower `WorkerOutboxPort` (`{eventName, payload}` only): that narrower shape is only assignable FROM
 * the real publisher because TS checks object-method parameters bivariantly, and every one of that file's
 * `deps.outbox.publish(tx, {eventName, payload})` call sites omits the three fields the real publisher
 * actually requires — a third genuine, pre-existing defect this build surfaced (reported, not fixed here)
 * that would throw at the Drizzle insert (`organization_id`/`aggregate_kind`/`aggregate_id` are all NOT
 * NULL on `outbox_event`) on every real `runClaimSubmit`/`runClaimPoll` publish. This file's own calls
 * declare the real required shape so they do not repeat it.
 */
export interface StateChannelOutboxPort {
  publish(
    tx: Tx,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The (org, PE, state) tuples with a currently-active trading-partner credential — the cron's fan-out
 * unit. Channel is resolved together with the decrypted credential (one active row per PE+state in
 * practice, §3.3's `byPeState` index), not listed separately here. */
export interface ActiveTradingPartnerPeStatesPort {
  listActivePeStatesForOrg(
    tx: Tx,
    organizationId: string,
    asOf: Date,
  ): Promise<readonly { readonly providerEntityId: string; readonly serviceState: string }[]>;
}

export function buildDrizzleActivePeStatesLister(): ActiveTradingPartnerPeStatesPort {
  const TP = schema.stateMedicaidTradingPartnerCredential;
  return {
    async listActivePeStatesForOrg(tx, organizationId, asOf) {
      const rows = await tx
        .select({ providerEntityId: TP.providerEntityId, serviceState: TP.serviceState })
        .from(TP)
        .where(
          and(
            eq(TP.organizationId, organizationId),
            lte(TP.activeFrom, asOf),
            or(isNull(TP.activeTo), gte(TP.activeTo, asOf)),
          ),
        );
      const seen = new Set<string>();
      const out: { providerEntityId: string; serviceState: string }[] = [];
      for (const r of rows) {
        const key = `${r.providerEntityId}:${r.serviceState}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
      return out;
    },
  };
}

/** Resolve + decrypt the PE's ACTIVE trading-partner credential for a state, ON the caller's `tx` (the
 * `buildDrizzleCredentialResolver` shape in `submission-jobs.ts`, corrected to take `tx` per call instead
 * of capturing a `db` handle at construction — see the file header). Fail-closed: null = no active row. */
export interface StateChannelCredentialResolverPort {
  resolve(
    tx: Tx,
    input: { organizationId: string; providerEntityId: string; serviceState: string },
  ): Promise<TradingPartnerCredentials | null>;
}

export function buildDrizzleStateChannelCredentialResolver(
  cipher: CredentialCipherPort,
): StateChannelCredentialResolverPort {
  const TP = schema.stateMedicaidTradingPartnerCredential;
  return {
    async resolve(tx, { organizationId, providerEntityId, serviceState }) {
      const rows = await tx
        .select()
        .from(TP)
        .where(
          and(
            eq(TP.organizationId, organizationId),
            eq(TP.providerEntityId, providerEntityId),
            eq(TP.serviceState, serviceState),
          ),
        );
      const now = new Date();
      const row = rows.find((r) => r.activeTo === null || r.activeTo >= now);
      if (!row) return null;
      return {
        providerEntityId,
        serviceState,
        channel: row.channel,
        mcoId: row.mcoId,
        tradingPartnerId: row.tradingPartnerId,
        clientId: row.clientId,
        clientSecret: isUsableCipher(row.clientSecretCipher)
          ? cipher.open(organizationId, row.clientSecretCipher as string)
          : null,
        sftpHost: row.sftpHost,
        sftpUser: row.sftpUser,
        sftpKey: isUsableCipher(row.sftpKeyCipher)
          ? cipher.open(organizationId, row.sftpKeyCipher as string)
          : null,
        portalUrl: row.portalUrl,
        additionalConfig: null,
      };
    },
  };
}

/** Probes one (state, credentials) pair. Returns `null` when no live gateway exists for `state` — "nothing
 * to report", never fabricated as "down". A thrown network/auth/parse error from the real gateway IS a
 * down observation (a bad `portalUrl`, an expired token, a genuine outage are all "not reachable"). */
export interface StateChannelHealthProbePort {
  probe(state: string, credentials: TradingPartnerCredentials): Promise<{ ok: boolean } | null>;
}

/** Only Oregon has a live gateway today (D14 — the other three Phase-1 states are deny-stubs with no real
 * endpoint to probe). A future state's own gateway plugs in the same way: extend the switch, never change
 * the port shape. */
export function buildStateChannelHealthProbe(
  oregonGateway: OregonGatewayPort | null,
): StateChannelHealthProbePort {
  return {
    async probe(state, credentials) {
      if (state !== "OR" || !oregonGateway) return null;
      try {
        const result = await oregonGateway.healthy(credentials);
        return { ok: result.ok };
      } catch {
        return { ok: false };
      }
    },
  };
}

/** Per-(org, PE, state, channel) breaker state. `up` is the last OBSERVED probe result; `reportedDown`
 * tracks whether an `.unavailable` has actually been EMITTED for the current down streak, distinct from
 * `up` — a streak can be down (up:false) for 1 or 2 ticks while still inside the §7.8 three-tick debounce
 * window, and `up:false` alone is not enough to tell "still debouncing" apart from "already reported and
 * steady down" (collapsing the two was a real bug this file's own live test caught: every tick after the
 * FIRST failure set `up:false`, so tick 2 read `!prev.up` as "already reported" and skipped the threshold
 * check entirely — no down streak could ever reach 3 and report). `consecutiveDownTicks` gates the FIRST
 * `.unavailable` report at 3 ("three consecutive failed health probes"); recovery is reported on the very
 * next successful probe with no debounce ("on health recovery the queue drains automatically") — but ONLY
 * when a down streak was actually reported; a streak that never crossed the threshold recovers silently
 * (nothing was ever told it was down). */
export interface StateChannelBreakerState {
  readonly up: boolean;
  readonly reportedDown: boolean;
  readonly consecutiveDownTicks: number;
  readonly lastUpAt: Date | null;
  readonly downedAt: Date | null;
}

const DOWN_REPORT_THRESHOLD = 3;

function breakerKey(
  organizationId: string,
  providerEntityId: string,
  state: string,
  channel: string,
): string {
  return `${organizationId}:${providerEntityId}:${state}:${channel}`;
}

/** Deterministic per-(org, state, channel) synthetic aggregate id — the `macPortalAggregateId` /
 * `LAG_PROBE_SINGLETON_AGGREGATE_ID` precedent extended with the org dimension, since this fact (unlike
 * MAC-portal health) is genuinely per-tenant. */
function stateChannelAggregateId(organizationId: string, state: string, channel: string): string {
  const hex = createHash("sha256")
    .update(`m24.medicaid_state_channel:${organizationId}:${state}:${channel}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface StateChannelHealthWorkerDeps {
  readonly db: DbClient;
  readonly activeOrgs: ActiveOrgListPort;
  readonly listPeStates: ActiveTradingPartnerPeStatesPort;
  readonly credentials: StateChannelCredentialResolverPort;
  readonly probe: StateChannelHealthProbePort;
  readonly outbox: StateChannelOutboxPort;
  now?: () => Date;
}

/**
 * `state-channel-health` (§4.9 cron, every 15 min per state per channel): fan out over every active org's
 * active trading-partner credentials, probe each (state, channel) pair's real gateway, and on a state
 * TRANSITION emit `m24.medicaid_state_channel.unavailable` (down, debounced 3 consecutive failures) or
 * `.recovered` (immediate on the next success) — the catalogued `declaredConsumers: ["m1"]` event (§4.11,
 * "M1 system_status") M1's platform status-page consumer binds to.
 *
 * Reads the credential list + resolves/decrypts credentials under `withOrgContext`, ON the tx the callback
 * hands back (a DB read + local decrypt, no network I/O); the actual HTTP probe runs OUTSIDE any
 * transaction (never hold a tx open across an external call); the outbox publish on a transition opens its
 * own short `withOrgContext` write.
 */
export async function runStateChannelHealth(
  deps: StateChannelHealthWorkerDeps,
  breaker: Map<string, StateChannelBreakerState>,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();

  for (const { organizationId } of orgs) {
    const peStates = await withOrgContext(
      deps.db,
      { organizationId, userId: M24_STATE_CHANNEL_SYSTEM_USER_ID },
      (tx) => deps.listPeStates.listActivePeStatesForOrg(tx, organizationId, now),
    );
    if (peStates.length === 0) continue;

    const resolved = await withOrgContext(
      deps.db,
      { organizationId, userId: M24_STATE_CHANNEL_SYSTEM_USER_ID },
      async (tx) => {
        const out: TradingPartnerCredentials[] = [];
        for (const { providerEntityId, serviceState } of peStates) {
          const credentials = await deps.credentials.resolve(tx, {
            organizationId,
            providerEntityId,
            serviceState,
          });
          if (credentials) out.push(credentials);
        }
        return out;
      },
    );

    for (const credentials of resolved) {
      const probed = await deps.probe.probe(credentials.serviceState, credentials);
      if (probed === null) continue; // no live gateway for this state — nothing to report, not "down"

      const key = breakerKey(
        organizationId,
        credentials.providerEntityId,
        credentials.serviceState,
        credentials.channel,
      );
      const prev = breaker.get(key);

      if (prev === undefined) {
        // First probe for this credential this process lifetime: seed state, no transition to report —
        // even a failing first tick is not yet a REPORTED outage (the §7.8 debounce starts counting here).
        breaker.set(key, {
          up: probed.ok,
          reportedDown: false,
          consecutiveDownTicks: probed.ok ? 0 : 1,
          lastUpAt: probed.ok ? now : null,
          downedAt: probed.ok ? null : now,
        });
        continue;
      }

      if (probed.ok) {
        if (!prev.reportedDown) {
          // Steady up, or a down streak that never crossed the debounce threshold — nothing was ever
          // reported, so recovering is silent too (there is nothing to say ".recovered" about).
          breaker.set(key, {
            up: true,
            reportedDown: false,
            consecutiveDownTicks: 0,
            lastUpAt: now,
            downedAt: null,
          });
          continue;
        }
        // Recovery — reported on the first successful probe after a REPORTED outage (no debounce up).
        const downedAt = prev.downedAt ?? now;
        const aggregateId = stateChannelAggregateId(
          organizationId,
          credentials.serviceState,
          credentials.channel,
        );
        await withOrgContext(
          deps.db,
          { organizationId, userId: M24_STATE_CHANNEL_SYSTEM_USER_ID },
          (tx) =>
            deps.outbox.publish(tx, {
              eventName: "m24.medicaid_state_channel.recovered",
              organizationId,
              aggregateKind: "medicaid_state_channel",
              aggregateId,
              payload: {
                organizationId,
                state: credentials.serviceState,
                channel: credentials.channel,
                downedAt: downedAt.toISOString(),
                recoveredAt: now.toISOString(),
              },
            }),
        );
        breaker.set(key, {
          up: true,
          reportedDown: false,
          consecutiveDownTicks: 0,
          lastUpAt: now,
          downedAt: null,
        });
        continue;
      }

      // probed.ok === false
      const consecutiveDownTicks = prev.consecutiveDownTicks + 1;
      const downedAt = prev.downedAt ?? now; // the TRUE outage start — the first failed tick, not this one
      if (prev.reportedDown) {
        // Already reported down; keep counting (never re-reports until it recovers first).
        breaker.set(key, { ...prev, consecutiveDownTicks, downedAt });
        continue;
      }
      if (consecutiveDownTicks < DOWN_REPORT_THRESHOLD) {
        // Still inside the §7.8 debounce window — hold state, do not report yet.
        breaker.set(key, { ...prev, up: false, consecutiveDownTicks, downedAt });
        continue;
      }
      const aggregateId = stateChannelAggregateId(
        organizationId,
        credentials.serviceState,
        credentials.channel,
      );
      await withOrgContext(
        deps.db,
        { organizationId, userId: M24_STATE_CHANNEL_SYSTEM_USER_ID },
        (tx) =>
          deps.outbox.publish(tx, {
            eventName: "m24.medicaid_state_channel.unavailable",
            organizationId,
            aggregateKind: "medicaid_state_channel",
            aggregateId,
            payload: {
              organizationId,
              state: credentials.serviceState,
              channel: credentials.channel,
              lastSeenUpAt: prev.lastUpAt ? prev.lastUpAt.toISOString() : null,
              downedAt: downedAt.toISOString(),
            },
          }),
      );
      breaker.set(key, {
        up: false,
        reportedDown: true,
        consecutiveDownTicks,
        lastUpAt: prev.lastUpAt,
        downedAt,
      });
    }
  }
}

/** Construct the `state-channel-health` cron worker (one Worker, concurrency per §4.9). Mirrors
 * `registerM23CronWorkers`'s `runMacPortalHealth` wiring shape. Nothing runs at import; a tick that finds
 * no active orgs, no active credentials, or no live gateway for any of them is a clean no-op. */
export function registerM24StateChannelHealthWorker(
  deps: StateChannelHealthWorkerDeps & { readonly connection: ConnectionOptions },
): Worker {
  const breaker = new Map<string, StateChannelBreakerState>();
  return new Worker(
    M24_CRON_QUEUES.stateChannelHealth,
    async () => runStateChannelHealth(deps, breaker),
    { connection: deps.connection, concurrency: M24_QUEUE_PARAMS.stateChannelHealth.concurrency },
  );
}

/** Register the §4.9 repeatable `state-channel-health` schedule (every 15 min, UTC). Returns the Queue so
 * the composition root can `close()` it. */
export async function scheduleM24StateChannelHealthJob(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M24_CRON_QUEUES.stateChannelHealth, { connection });
  await queue.add(
    "tick",
    {},
    { repeat: { pattern: M24_JOB_SCHEDULES.stateChannelHealth, tz: "UTC" } },
  );
  return queue;
}
