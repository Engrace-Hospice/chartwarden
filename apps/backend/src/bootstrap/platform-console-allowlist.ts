// apps/backend/src/bootstrap/platform-console-allowlist.ts - CW-AC-22: an address allowlist in front of the platform console's API.
//
// The platform console (the operator's cross-tenant surface: tenant lifecycle, onboarding, BAA register, pricing, billing admin, ops
// tooling) is reachable from anywhere that can reach its hostname. `PLATFORM_CONSOLE_ALLOWED_CIDRS` narrows it to the operators' own
// networks. Unset = no gate (today's behaviour, and the dev default). SET = fail closed: a request from an address outside the list is
// refused 403 and audited; a list that is set but unusable (a typo, a /0, a keyword, a range that admits the public internet) refuses EVERY
// console request, never opens it. Which routes are "the console" and how the variable is read live in ./platform-console-policy (pure).
//
// THE ADDRESS. `request.ip`, nothing else. Fastify derives it from the socket peer and walks X-Forwarded-For right to left only past
// hops listed in `TRUSTED_PROXY_CIDRS` (validated by trusted-proxies.ts), so a client cannot choose it by writing a header. No header is
// read here (`arch:request-header-auth`). The allowlist is meaningless without a valid trusted-proxy list behind a reverse proxy: with
// none, `request.ip` is the proxy's own address, so production refuses to boot with one and not the other (env.ts). It is also only as
// narrow as that list: a trusted range that is wider than the proxy lets any client inside it choose its own address.
//
// A ROUTE THAT IS NOT IN THE CONSOLE (`/api/v1/orgs`, `/api/v1/reporting/admin`, the rest of `/api/admin/external-interfaces`, M32, M38,
// and every tenant route) cannot be refused by prefix: a tenant administrator uses most of them too. From an address outside the list
// (or when the list is unusable) the request instead LOSES the caller's platform authority before any authorization runs
// (`stripPlatformAuthority`, @chartwarden/auth): its platform roles come off `request.context.roles` and the permission resolver stops
// counting their grants, so the route judges the caller as a tenant user with no platform role and answers what a tenant user would get.
// Every strip is audited. A request that held no platform role (every tenant user) is untouched and leaves no row.
//
// WHAT IT DOES NOT COVER (stated in compliance/controls.yaml CW-AC-22): the sign-in routes the operator uses on the same hostname and the
// static console shell; they hold no platform authority to withhold, and a network-level allow (nginx `allow`/`deny` on the vhost, a
// firewall) is the layer for them. It is the owner's change, not this file's.
import { type PlatformAuditExecutor, auditPlatformEvent } from "@chartwarden/audit";
import { stripPlatformAuthority } from "@chartwarden/auth";
import { ChartWardenError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type PlatformConsolePolicy, isPlatformConsoleRoute } from "./platform-console-policy";

export * from "./platform-console-policy";

/** What a refused or stripped request leaves behind: ids and the address, never a header, body or token. */
export interface PlatformConsoleRefusal {
  /** `address_not_allowed` / `allowlist_unusable`: a console route refused 403. `platform_authority_stripped`: any other route, served without the caller's platform authority. */
  readonly reason: "address_not_allowed" | "allowlist_unusable" | "platform_authority_stripped";
  readonly sourceIp: string;
  readonly method: string;
  /** The matched route template (`/api/v1/platform/tenants/:orgSlug`), never the concrete URL; `unmatched` when no route matched. */
  readonly route: string;
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly correlationId: string;
  readonly requestId: string;
  /** For a strip: the platform role keys the caller held (a role key is a catalog name, never a person's data). */
  readonly strippedRoleKeys?: readonly string[];
}

/** Records one refusal or strip (production: a platform-scoped audit row). May throw: the request is refused (or stripped) regardless. */
export type PlatformConsoleRefusalSink = (refusal: PlatformConsoleRefusal) => Promise<void>;

/** The audit event a refusal writes: platform-scoped (a refusal has no tenant), severity warn. */
export const PLATFORM_CONSOLE_REFUSED_EVENT = "m34.platform_console.access_refused";

/** The audit event a strip writes: platform-scoped, severity warn, outcome denied (the platform authority was denied, the request still ran). */
export const PLATFORM_AUTHORITY_STRIPPED_EVENT = "m34.platform_console.authority_stripped";

const WINDOW_MS = 60_000;
const ANONYMOUS_ROWS_PER_WINDOW = 60;
const SESSION_ROWS_PER_WINDOW = 300;
const ROWS_PER_USER_PER_WINDOW = 10;
const KEY_CAP = 5_000;
const AUDIT_WRITE_TIMEOUT_MS = 2_000;

export interface RefusalAuditorOptions {
  readonly now?: () => number;
  readonly windowMs?: number;
  /** Rows an anonymous flood may write in one window, across every source address. */
  readonly anonymousRowsPerWindow?: number;
  /** Rows refusals that carry a session may write in one window, across every user and address. */
  readonly sessionRowsPerWindow?: number;
  /** Rows one signed-in user may write in one window, across every address they come from. */
  readonly rowsPerUserPerWindow?: number;
  readonly writeTimeoutMs?: number;
}

interface Admission {
  readonly retention: "compliance" | "operational";
  /** Refusals held back since this key's previous row. */
  readonly suppressed: number;
  /** Give the slot back: the row was not written, so the next refusal for the key must try again (and log the failure again). */
  readonly undo: () => void;
}

type RowKey = { at: number; suppressed: number };

/** The audit write did not answer in time: its outcome is unknown (it may still commit). */
class AuditWriteTimeout extends Error {}

/**
 * Decides which refusals become audit rows. Volume: a refusal may not become one undeletable row per request, so each is held to one row per
 * (user, source address, reason) a minute, to {@link ROWS_PER_USER_PER_WINDOW} per signed-in user a minute (one user rotating addresses
 * cannot use up everyone's room), and to a ceiling a minute in all ({@link SESSION_ROWS_PER_WINDOW} with a session, under the compliance
 * retention class; {@link ANONYMOUS_ROWS_PER_WINDOW} without, a scan or a probe, under the operational class). A repeat inside the minute is
 * counted on that key's next row (`suppressedSincePreviousRow`); the first refusal a ceiling or user cap turns away in a window is one
 * process warning. State lives in the process and is lost on a restart; the clock is monotonic.
 */
function createRefusalThrottle(
  options: RefusalAuditorOptions,
): (r: PlatformConsoleRefusal) => Admission | null {
  const now = options.now ?? (() => performance.now());
  const windowMs = options.windowMs ?? WINDOW_MS;
  const anonymousCap = options.anonymousRowsPerWindow ?? ANONYMOUS_ROWS_PER_WINDOW;
  const sessionCap = options.sessionRowsPerWindow ?? SESSION_ROWS_PER_WINDOW;
  const userCap = options.rowsPerUserPerWindow ?? ROWS_PER_USER_PER_WINDOW;
  const rows = new Map<string, RowKey>();
  const perUser = new Map<string, number>();
  let windowStart = Number.NEGATIVE_INFINITY;
  let anonymousRows = 0;
  let sessionRows = 0;
  let warned = false;

  return (refusal) => {
    const at = now();
    if (at - windowStart >= windowMs) {
      windowStart = at;
      anonymousRows = 0;
      sessionRows = 0;
      warned = false;
      perUser.clear();
    }
    const user = refusal.userId;
    const key = `${user ?? "-"}|${refusal.sourceIp}|${refusal.reason}`;
    const previous = rows.get(key);
    if (previous && at - previous.at < windowMs) {
      rows.set(key, { at: previous.at, suppressed: previous.suppressed + 1 });
      return null; // a routine repeat: counted, not worth a warning
    }
    const userRows = user ? (perUser.get(user) ?? 0) : 0;
    const turnedAway = user
      ? sessionRows >= sessionCap || userRows >= userCap
      : anonymousRows >= anonymousCap;
    if (turnedAway) {
      if (previous) rows.set(key, { at: previous.at, suppressed: previous.suppressed + 1 });
      if (!warned) {
        warned = true;
        process.emitWarning(
          "platform console refusals are being held back from the audit log: a per-window limit was reached, so some refusals in this window have no row of their own",
        );
      }
      return null;
    }
    if (user) {
      sessionRows += 1;
      perUser.set(user, userRows + 1);
    } else {
      anonymousRows += 1;
    }
    if (!previous && rows.size >= KEY_CAP) {
      const oldest = rows.keys().next();
      if (!oldest.done) rows.delete(oldest.value);
    }
    rows.delete(key); // re-insert, so Map order is recency order and eviction drops the stalest key
    rows.set(key, { at, suppressed: 0 });
    const epoch = windowStart;
    return {
      retention: user ? "compliance" : "operational",
      suppressed: previous?.suppressed ?? 0,
      undo: () => {
        // Only this window's counters, and only down to zero: a failure that lands after a rollover or beside other writes in flight must not
        // lend the new window room it never had.
        if (windowStart === epoch) {
          if (user) {
            sessionRows = Math.max(0, sessionRows - 1);
            perUser.set(user, Math.max(0, (perUser.get(user) ?? 0) - 1));
          } else {
            anonymousRows = Math.max(0, anonymousRows - 1);
          }
        }
        // Refusals counted while the write was pending are not lost: the key is retried with them on its next row.
        const heldBack = (rows.get(key)?.suppressed ?? 0) + (previous?.suppressed ?? 0);
        if (previous || heldBack > 0) {
          rows.set(key, { at: previous?.at ?? Number.NEGATIVE_INFINITY, suppressed: heldBack });
        } else {
          rows.delete(key);
        }
      },
    };
  };
}

/**
 * The production sink: one platform-scoped `audit_event` row through the SECURITY DEFINER platform writer (the only way `chartwarden_app`
 * writes an org-less audit row). The row carries the address, the method, the matched route template and the operator's ids when the
 * request had a session: no header, body or token. With no database (a dev boot) the sink throws and the guard logs it. Which refusals
 * get a row is {@link createRefusalThrottle}'s; the write is bounded in time, so a database that stops answering cannot hold the response.
 */
export function platformConsoleRefusalAuditor(
  db: PlatformAuditExecutor | undefined,
  options: RefusalAuditorOptions = {},
): PlatformConsoleRefusalSink {
  const admit = createRefusalThrottle(options);
  const writeTimeoutMs = options.writeTimeoutMs ?? AUDIT_WRITE_TIMEOUT_MS;

  const write = async (refusal: PlatformConsoleRefusal, admission: Admission): Promise<void> => {
    if (!db) throw new Error("no database to audit the refusal into");
    const pending = auditPlatformEvent(db, {
      eventType:
        refusal.reason === "platform_authority_stripped"
          ? PLATFORM_AUTHORITY_STRIPPED_EVENT
          : PLATFORM_CONSOLE_REFUSED_EVENT,
      resourceKind: "platform_console",
      outcome: "denied",
      severity: "warn",
      correlationId: refusal.correlationId,
      retentionClass: admission.retention,
      context: {
        reason: refusal.reason,
        sourceIp: refusal.sourceIp,
        method: refusal.method,
        route: refusal.route,
        userId: refusal.userId,
        organizationId: refusal.organizationId,
        requestId: refusal.requestId,
        ...(refusal.strippedRoleKeys ? { strippedRoleKeys: refusal.strippedRoleKeys } : {}),
        ...(admission.suppressed > 0 ? { suppressedSincePreviousRow: admission.suppressed } : {}),
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new AuditWriteTimeout(`audit write did not answer within ${writeTimeoutMs} ms`)),
        writeTimeoutMs,
      );
    });
    try {
      await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  return async (refusal) => {
    const admission = admit(refusal);
    if (!admission) return;
    try {
      await write(refusal, admission);
    } catch (err) {
      // A write that definitely failed gives its slot back. One that merely timed out may still commit (the statement is not cancelled), so
      // it keeps the slot: handing it back would let a slow database turn every refusal into a row.
      if (!(err instanceof AuditWriteTimeout)) admission.undo();
      throw err;
    }
  };
}

export type PlatformConsoleGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<undefined>;

export interface PlatformConsoleGuardDeps {
  readonly policy: PlatformConsolePolicy;
  readonly onRefused: PlatformConsoleRefusalSink;
}

/**
 * The `onRequest` guard. Returns null for an open policy (no hook is added, so an unconfigured deployment behaves as before).
 * Register it AFTER `authenticate` and the rate limiter: the audit row then names the signed-in operator when there is one, and
 * `request.context.roles` is the roles the authenticate hook resolved (the strip works on them). Authorization runs in the route's
 * preHandlers, after every `onRequest` hook, so a strip made here is in place before any guard reads the roles.
 *
 * From an address the list admits: nothing happens, on any route. From any other address (or with an unusable list):
 *   - a console route is refused 403 and audited, as ever;
 *   - any other route is served with the caller's platform authority withheld, and the strip is audited. The strip is made FIRST and
 *     the audit write only after it, so a failed or slow audit can never leave the authority in place.
 */
export function createPlatformConsoleGuard(
  deps: PlatformConsoleGuardDeps,
): PlatformConsoleGuard | null {
  const { policy, onRefused } = deps;
  if (policy.kind === "open") return null;

  return async (request) => {
    // `request.ip` is the trusted-proxy-aware address (see the header); `request.context.ip` is the same value.
    const sourceIp = request.ip;
    if (policy.kind === "allowlist" && policy.allows(sourceIp)) return undefined;

    const route = request.routeOptions?.url;
    const consoleRoute = typeof route === "string" && isPlatformConsoleRoute(route);
    const context = request.context;
    const entryFor = (reason: PlatformConsoleRefusal["reason"]): PlatformConsoleRefusal => ({
      reason,
      sourceIp,
      method: request.method,
      route: typeof route === "string" ? route : "unmatched",
      userId: context?.userId || null,
      organizationId: context?.organizationId || null,
      correlationId: context?.correlationId ?? String(request.id),
      requestId: String(request.id),
    });
    // A failed audit write must not open the door, and must not stay silent: the refusal (or the strip) stands, the failure is logged.
    const record = async (entry: PlatformConsoleRefusal, failure: string): Promise<void> => {
      try {
        await onRefused(entry);
      } catch (err) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err), route: entry.route, sourceIp },
          failure,
        );
      }
    };

    if (!consoleRoute) {
      const held = context ? stripPlatformAuthority(context) : [];
      if (held.length > 0) {
        await record(
          { ...entryFor("platform_authority_stripped"), strippedRoleKeys: held },
          "platform authority strip could not be audited",
        );
      }
      return undefined;
    }

    await record(
      entryFor(policy.kind === "closed" ? "allowlist_unusable" : "address_not_allowed"),
      "platform console refusal could not be audited",
    );
    throw new ChartWardenError(
      "PLATFORM_CONSOLE_ADDRESS_NOT_ALLOWED",
      "the platform console is not available from this address",
      403,
    );
  };
}
