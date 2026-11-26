// apps/backend/src/bootstrap/claims-billing-gate.ts — ADR-0110 the claims-billing add-on gate (M1 bootstrap).
//
// One place decides whether an org may START new claims-billing work, for routes (a preHandler appended at the
// M23/M24/M25/M41 mount boundary, after each route's own permission + ABAC handlers) and for workers (hold, don't
// fail). It reads the `ClaimsBillingEntitlementReader` seam (owner M35) with no cache: the route preHandler memoises
// the answer per request only. In-flight work never calls it.
//
// Enforcement mode, `CLAIMS_BILLING_ENFORCEMENT` = off | shadow | enforce (default enforce, CW-AC-24):
//   off      nothing is evaluated;
//   shadow   log-only: evaluated; a would-deny is logged (org id + route/queue only), recorded as a platform audit
//            finding (`recordFinding`, once per org, site and reason per window) and the work goes ahead;
//   enforce  a deny refuses the request (402 CLAIMS_BILLING_ADDON_REQUIRED) or holds the job.
// A failed entitlement read in `enforce` fails CLOSED (503 BILLING_ENTITLEMENT_UNAVAILABLE / hold); in `shadow` it is
// logged and recorded as a would-fail-closed finding and the work goes ahead. Running below `enforce` in production is
// a deliberate act (a written reason, audited at boot: ./claims-billing-gate-audit.ts). Boot refuses a non-`off` mode
// while the seam is still the deny-stub.
//
// What shadow would have blocked is the same decision `enforce` makes, exemptions included: a void claim a rule
// exempts is allowed in both modes and leaves no finding, so the findings are the evidence for a flip.
import {
  ChartWardenError,
  type ClaimsBillingDenyReason,
  type ClaimsBillingEntitlement,
  ForbiddenError,
} from "@chartwarden/types";
import { DelayedError } from "bullmq";
import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";
import {
  CLAIMS_BILLING_ENFORCEMENT_ENV,
  CLAIMS_BILLING_ENFORCEMENT_MODES,
  type ClaimsBillingEnforcementMode,
  DEFAULT_CLAIMS_BILLING_ENFORCEMENT,
  parseClaimsBillingEnforcement,
} from "./env";
import { claimsBillingEntitlementReaderDenyStub } from "./seams/providers";
import { getSeam } from "./seams/registry";

export {
  CLAIMS_BILLING_ENFORCEMENT_ENV,
  CLAIMS_BILLING_ENFORCEMENT_MODES,
  type ClaimsBillingEnforcementMode,
  DEFAULT_CLAIMS_BILLING_ENFORCEMENT,
  parseClaimsBillingEnforcement,
};

/** The 402 envelope code a refused new-work request carries; the reason is the first detail's `code`. */
export const CLAIMS_BILLING_ADDON_REQUIRED = "CLAIMS_BILLING_ADDON_REQUIRED";
export const BILLING_ENTITLEMENT_UNAVAILABLE = "BILLING_ENTITLEMENT_UNAVAILABLE";

type GateLog = (message: string, detail: Record<string, unknown>) => void;

/** What log-only mode would have done instead of letting the work through (never a patient or claim id). */
export type GateFindingOutcome = "would_deny" | "would_fail_closed";

/** The `reason` of a `would_fail_closed` finding: the entitlement read itself failed. */
export const ENTITLEMENT_UNAVAILABLE_REASON = "entitlement_unavailable";

export interface GateFinding extends GateSite {
  readonly organizationId: string;
  readonly outcome: GateFindingOutcome;
  readonly reason: ClaimsBillingDenyReason | typeof ENTITLEMENT_UNAVAILABLE_REASON;
}

/** Persists one finding (the composition root binds a platform audit write). A throw is logged and retried after FINDING_RETRY_MS. */
export type GateFindingSink = (finding: GateFinding) => Promise<void>;

/** A finding for the same org, site and reason is written once per window (the log line is not throttled). */
export const FINDING_DEDUPE_MS = 60 * 60_000;
/** After a failed write the same finding is tried again no sooner than this, so an audit outage is not a write per request. */
export const FINDING_RETRY_MS = 60_000;
// ponytail: per-process dedupe, oldest key evicted past this many; a durable counter if the volume ever matters.
export const MAX_FINDING_KEYS = 10_000;

let mode: ClaimsBillingEnforcementMode = DEFAULT_CLAIMS_BILLING_ENFORCEMENT;
let log: GateLog = () => {};
let findingSink: GateFindingSink | undefined;
const findingSeen = new Map<string, number>();

/**
 * Bind the mode, the logger and the finding sink (composition root, once at boot; tests may call it again). The sink is
 * rebound on every call, so a reconfigure without one drops the previous one.
 */
export function configureClaimsBillingGate(opts: {
  readonly mode: ClaimsBillingEnforcementMode;
  readonly log?: GateLog;
  readonly recordFinding?: GateFindingSink;
}): void {
  mode = opts.mode;
  if (opts.log) log = opts.log;
  findingSink = opts.recordFinding;
  findingSeen.clear();
}

export function claimsBillingEnforcementMode(): ClaimsBillingEnforcementMode {
  return mode;
}

/** Boot gate: a non-`off` mode needs the real reader registered (call after `validateSeams`). */
export function assertClaimsBillingSeamBound(current: ClaimsBillingEnforcementMode = mode): void {
  if (current === "off") return;
  if (getSeam("ClaimsBillingEntitlementReader") === claimsBillingEntitlementReaderDenyStub) {
    throw new Error(
      `${CLAIMS_BILLING_ENFORCEMENT_ENV}=${current} needs the ClaimsBillingEntitlementReader seam bound (a database boot); set it to 'off' or boot with a database`,
    );
  }
}

/**
 * CW-AC-24: `enforce` is the default, so a production deployment running anything else chose it on purpose (and gave a
 * reason, see `claimsBillingLogOnlyReasonProblem`). It still says so at boot, once, loudly. Null when there is nothing to say.
 */
export function claimsBillingEnforcementBootWarning(
  current: ClaimsBillingEnforcementMode,
  nodeEnv: string | undefined,
): string | null {
  if (nodeEnv !== "production" || current === "enforce") return null;
  const what =
    current === "off"
      ? "nothing is evaluated, logged or recorded, so there is no would_block evidence for a flip"
      : "it is only logged and recorded as an m23.claims_billing_gate.would_block audit finding";
  return `${CLAIMS_BILLING_ENFORCEMENT_ENV}=${current} on a production deployment: a tenant whose clearinghouse is not live (or whose subscription is suspended) is NOT refused new claims work; ${what}; unset it (or set 'enforce') to refuse`;
}

/** Where the decision was asked from — logged on a shadow would-deny (never a patient or claim id). */
export interface GateSite {
  readonly route?: string;
  readonly queue?: string;
}

export type GateVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: ClaimsBillingDenyReason };

/** What `enforce` would do with this request, before the mode decides whether to apply it. */
type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: ClaimsBillingDenyReason }
  | { readonly kind: "unavailable" };

const ALLOW: GateVerdict = { allow: true };

async function decide(
  organizationId: string,
  site: GateSite,
  exempt: ClaimsBillingExemption | undefined,
): Promise<Decision> {
  let entitlement: ClaimsBillingEntitlement;
  try {
    entitlement = await getSeam("ClaimsBillingEntitlementReader").entitlementForOrg(organizationId);
  } catch (err) {
    log("claims-billing entitlement read failed", {
      organizationId,
      ...site,
      mode,
      error: err instanceof Error ? err.message : String(err),
    });
    return (await isExempt(exempt, organizationId, site))
      ? { kind: "allow" }
      : { kind: "unavailable" };
  }
  if (entitlement.entitled) return { kind: "allow" };
  return (await isExempt(exempt, organizationId, site))
    ? { kind: "allow" }
    : { kind: "deny", reason: entitlement.reason };
}

/**
 * Log-only: record what `enforce` would have done. The log line is not throttled; the audit finding is written once
 * per org, site and reason per window, and a failed write is logged and retried after FINDING_RETRY_MS (never fatal here).
 */
async function recordLogOnlyFinding(finding: GateFinding): Promise<void> {
  if (finding.outcome === "would_deny") {
    log("claims-billing would deny (shadow)", {
      organizationId: finding.organizationId,
      ...(finding.route === undefined ? {} : { route: finding.route }),
      ...(finding.queue === undefined ? {} : { queue: finding.queue }),
      reason: finding.reason,
    });
  }
  if (!findingSink) return;
  const key = [
    finding.organizationId,
    finding.route ?? "",
    finding.queue ?? "",
    finding.reason,
  ].join("|");
  const now = Date.now();
  const last = findingSeen.get(key);
  if (last !== undefined && now - last < FINDING_DEDUPE_MS) return;
  if (findingSeen.size >= MAX_FINDING_KEYS) {
    const oldest = findingSeen.keys().next();
    if (!oldest.done) findingSeen.delete(oldest.value);
  }
  findingSeen.delete(key); // re-insert, so Map order is write order and the oldest key is the first
  findingSeen.set(key, now); // before the write, so two concurrent hits write one row
  try {
    await findingSink(finding);
  } catch (err) {
    // back-dated, so the next try is FINDING_RETRY_MS away rather than a write on every request while the audit write fails
    findingSeen.set(key, now - FINDING_DEDUPE_MS + FINDING_RETRY_MS);
    log("claims-billing finding not recorded", {
      organizationId: finding.organizationId,
      ...(finding.route === undefined ? {} : { route: finding.route }),
      ...(finding.queue === undefined ? {} : { queue: finding.queue }),
      reason: finding.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The mode-aware decision. `exempt` (a rule's carve-out, consulted only when the org would be refused or its read failed)
 * is part of the decision in every mode, so log-only records exactly what `enforce` would block. Throws ChartWardenError
 * 503 BILLING_ENTITLEMENT_UNAVAILABLE when the read fails in `enforce` (the caller fails closed); allows on a failed read
 * in `shadow` (logged and recorded).
 */
export async function claimsBillingVerdict(
  organizationId: string,
  site: GateSite,
  exempt?: ClaimsBillingExemption,
): Promise<GateVerdict> {
  if (mode === "off") return ALLOW;
  const decision = await decide(organizationId, site, exempt);
  if (decision.kind === "allow") return ALLOW;
  if (mode === "shadow") {
    await recordLogOnlyFinding(
      decision.kind === "deny"
        ? { organizationId, ...site, outcome: "would_deny", reason: decision.reason }
        : {
            organizationId,
            ...site,
            outcome: "would_fail_closed",
            reason: ENTITLEMENT_UNAVAILABLE_REASON,
          },
    );
    return ALLOW;
  }
  if (decision.kind === "deny") return { allow: false, reason: decision.reason };
  throw new ChartWardenError(
    BILLING_ENTITLEMENT_UNAVAILABLE,
    "the claims-billing entitlement could not be read; new claims work is refused until it can",
    503,
  );
}

/**
 * ADR-0110 D4 — the one call other backend code makes before starting NEW claims-billing work for an org. True when
 * the work may go ahead under the current mode (always true in `off` and `shadow`; `shadow` logs a would-deny). In
 * `enforce`, false when the org lacks the add-on, and it THROWS 503 BILLING_ENTITLEMENT_UNAVAILABLE when the read
 * fails: skip or defer the work then, never treat it as entitled.
 */
export async function isClaimsBillingEntitled(
  organizationId: string,
  site: GateSite = {},
): Promise<boolean> {
  return (await claimsBillingVerdict(organizationId, site)).allow;
}

/** Why new claims work is refused, in words that match the reason code (the envelope code stays the one 402). */
const REFUSAL_WORDING: Record<ClaimsBillingDenyReason, string> = {
  clearinghouse_not_chosen: "this organization has not chosen a clearinghouse for claims yet",
  clearinghouse_outside: "this organization bills outside ChartWarden",
  clearinghouse_not_active: "this organization's clearinghouse is set up but not active yet",
  clearinghouse_baa_revoked:
    "this organization's clearinghouse is out of service because its vendor BAA was revoked",
  clearinghouse_baa_expired:
    "this organization's clearinghouse is out of service because its recorded vendor BAA has ended",
  never_purchased: "this organization has not purchased the claims-billing add-on",
  lapsed: "this organization's claims-billing add-on has ended",
  subscription_suspended: "this organization's subscription is suspended",
  subscription_canceled: "this organization's subscription is canceled",
  subscription_paused: "this organization's subscription is paused",
};

export function claimsBillingAddonRequired(reason: ClaimsBillingDenyReason): ChartWardenError {
  const why = REFUSAL_WORDING[reason];
  return new ChartWardenError(
    CLAIMS_BILLING_ADDON_REQUIRED,
    `${why}; new claims work is not available`,
    402,
    [{ code: reason, message: why }],
  );
}

/**
 * A per-rule carve-out inside a new-work route (a void claim on the submit route): consulted only when the org would be
 * refused, and it must read what it decides on under the caller's org context (RLS), never from the request body.
 * A throw is treated as "not exempt", so a failed lookup in `enforce` gates as normal.
 */
export type ClaimsBillingExemption = () => Promise<boolean>;

async function isExempt(
  exempt: ClaimsBillingExemption | undefined,
  organizationId: string,
  site: GateSite,
): Promise<boolean> {
  if (!exempt) return false;
  try {
    if (!(await exempt())) return false;
  } catch (err) {
    log("claims-billing exemption lookup failed", {
      organizationId,
      ...site,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  log("claims-billing exemption applied", { organizationId, ...site });
  return true;
}

const UNMATCHED_ROUTE = "(unmatched route)";
const memo = new WeakMap<FastifyRequest, Promise<GateVerdict>>();

declare module "fastify" {
  interface FastifyContextConfig {
    /** Set by `withClaimsBillingGate` from the matching rule's `exempt`. */
    claimsBillingExemption?: RouteExemption;
  }
}

/** The route preHandler. Runs after the route's own guards, so `request.context` is already authorized. */
export async function claimsBillingPreHandler(request: FastifyRequest): Promise<void> {
  if (mode === "off") return;
  const organizationId = request.context?.organizationId;
  // An authenticated tenant route always has an org; reaching the gate without one is a wiring fault. Fail closed.
  if (!organizationId) {
    throw new ForbiddenError("claims-billing work needs an organization context");
  }
  let pending = memo.get(request);
  if (!pending) {
    const exemption = request.routeOptions.config?.claimsBillingExemption;
    pending = claimsBillingVerdict(
      organizationId,
      // the registered route template, never the raw URL (a path id or query string would land in the audit finding)
      { route: `${request.method} ${request.routeOptions.url ?? UNMATCHED_ROUTE}` },
      exemption ? () => exemption(request) : undefined,
    );
    memo.set(request, pending);
  }
  const verdict = await pending;
  if (!verdict.allow) throw claimsBillingAddonRequired(verdict.reason);
}

// ── route classification ────────────────────────────────────────────────────────────────────────────

export type RouteClass = "new_work" | "open";

/**
 * One ordered rule. `path` is an exact Fastify route path, or, ending in `/*`, that path and everything under it. `method` `*` matches
 * any method. The FIRST matching rule wins, so list the new-work exceptions before a broad open prefix.
 */
export interface RouteClassRule {
  readonly cls: RouteClass;
  readonly method: string;
  readonly path: string;
  /** new_work only: let a request through that the add-on would refuse (see ClaimsBillingExemption). */
  readonly exempt?: RouteExemption;
}

/** A rule's exemption, given the (already authorized) request. */
export type RouteExemption = (request: FastifyRequest) => Promise<boolean>;

/** An exemption decided on the route's `:id` record, read by `check` under the request's org. */
export function exemptByRouteId(
  check: (organizationId: string, id: string) => Promise<boolean>,
): RouteExemption {
  return async (request) => {
    const organizationId = request.context?.organizationId;
    const id = (request.params as { id?: unknown } | undefined)?.id;
    if (!organizationId || typeof id !== "string") return false;
    return check(organizationId, id);
  };
}

export function ruleMatches(rule: RouteClassRule, method: string, url: string): boolean {
  if (rule.method !== "*" && rule.method !== method) return false;
  if (rule.path.endsWith("/*")) {
    const base = rule.path.slice(0, -2);
    return url === base || url.startsWith(`${base}/`);
  }
  return url === rule.path;
}

/** The class of `method url`, or null when no rule matches (an unclassified route). */
export function classifyRoute(
  rules: readonly RouteClassRule[],
  method: string,
  url: string,
): RouteClass | null {
  return rules.find((r) => ruleMatches(r, method, url))?.cls ?? null;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function appendGate(opts: RouteOptions): void {
  const existing = opts.preHandler;
  const list = existing === undefined ? [] : Array.isArray(existing) ? [...existing] : [existing];
  opts.preHandler = [...list, claimsBillingPreHandler] as RouteOptions["preHandler"];
}

/**
 * Run `mount` with an `onRoute` hook that is active only while `mount` runs: every mutating route it registers that
 * `rules` classify `new_work` gets the gate appended AFTER its own preHandlers. Routes registered later (other
 * modules) are untouched. Fastify runs `onRoute` hooks synchronously inside `route()`, so the window is exact.
 */
export function withClaimsBillingGate(
  app: FastifyInstance,
  rules: readonly RouteClassRule[],
  mount: () => void,
): void {
  let active = true;
  app.addHook("onRoute", (opts) => {
    if (!active) return;
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    const rule = methods
      .filter((m) => !READ_METHODS.has(m))
      .map((m) => rules.find((r) => ruleMatches(r, m, opts.url)))
      .find((r) => r?.cls === "new_work");
    if (!rule) return;
    appendGate(opts);
    if (rule.exempt) opts.config = { ...opts.config, claimsBillingExemption: rule.exempt };
  });
  try {
    mount();
  } finally {
    active = false;
  }
}

// ── workers: hold, don't fail ───────────────────────────────────────────────────────────────────────────

/** How long a held job waits before it asks again. */
export const CLAIMS_BILLING_HOLD_MS = 15 * 60_000;

/**
 * For a sweep that owns its own rows (no BullMQ job to delay): may this org's queued new work go out now? Never throws:
 * a denied org or a failed read in `enforce` answers false (the rows stay queued and the next tick asks again).
 */
export async function claimsBillingAllowsWork(
  organizationId: string,
  site: GateSite,
): Promise<boolean> {
  try {
    return (await claimsBillingVerdict(organizationId, site)).allow;
  } catch {
    return false; // already logged by the verdict; fail closed without failing the sweep
  }
}

/** The slice of a BullMQ job the hold needs. */
export interface HoldableJob {
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

/**
 * ADR-0110 D7 — call first in a new-work job processor. Returns normally when the work may run (or `exempt` answers
 * true — a void claim). Otherwise moves the job
 * back to delayed (CLAIMS_BILLING_HOLD_MS) and throws BullMQ's DelayedError, which the worker treats as "not done, no
 * attempt spent": no retry counted, no DLQ.
 */
export async function holdUnlessClaimsBillingEntitled(
  job: HoldableJob,
  token: string | undefined,
  organizationId: string,
  queue: string,
  opts: { readonly exempt?: ClaimsBillingExemption; readonly now?: () => number } = {},
): Promise<void> {
  const { exempt, now = Date.now } = opts;
  const allowed = await claimsBillingVerdict(organizationId, { queue }, exempt).then(
    (v) => v.allow,
    () => false, // already logged; fail closed without failing the job
  );
  if (allowed) return;
  log("claims-billing job held", { organizationId, queue, holdMs: CLAIMS_BILLING_HOLD_MS });
  await job.moveToDelayed(now() + CLAIMS_BILLING_HOLD_MS, token);
  throw new DelayedError();
}
