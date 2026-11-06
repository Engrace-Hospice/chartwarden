// apps/backend/src/bootstrap/claims-billing-gate.ts — ADR-0108 the claims-billing add-on gate (M1 bootstrap).
//
// One place decides whether an org may START new claims-billing work, for routes (a preHandler appended at the
// M23/M24/M25/M41 mount boundary, after each route's own permission + ABAC handlers) and for workers (hold, don't
// fail). It reads the `ClaimsBillingEntitlementReader` seam (owner M35) with no cache: the route preHandler memoises
// the answer per request only. In-flight work never calls it.
//
// Enforcement mode, `CLAIMS_BILLING_ENFORCEMENT` = off | shadow | enforce (default shadow):
//   off      nothing is evaluated;
//   shadow   evaluated; a would-deny is logged (org id + route/queue only) and the work goes ahead;
//   enforce  a deny refuses the request (402 CLAIMS_BILLING_ADDON_REQUIRED) or holds the job.
// A failed entitlement read in `enforce` fails CLOSED (503 BILLING_ENTITLEMENT_UNAVAILABLE / hold); in `shadow` it is
// logged and the work goes ahead. Boot refuses a non-`off` mode while the seam is still the deny-stub.
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
let mode: ClaimsBillingEnforcementMode = DEFAULT_CLAIMS_BILLING_ENFORCEMENT;
let log: GateLog = () => {};

/** Bind the mode and the logger (composition root, once at boot; tests may call it again). */
export function configureClaimsBillingGate(opts: {
  readonly mode: ClaimsBillingEnforcementMode;
  readonly log?: GateLog;
}): void {
  mode = opts.mode;
  if (opts.log) log = opts.log;
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
 * Owner decision (round 2, Q2): `shadow` stays the default, but a production deployment running anything other than `enforce`
 * should say so at boot (a refusal there is only logged), once, loudly. Null when there is nothing to say.
 */
export function claimsBillingEnforcementBootWarning(
  current: ClaimsBillingEnforcementMode,
  nodeEnv: string | undefined,
): string | null {
  if (nodeEnv !== "production" || current === "enforce") return null;
  return `${CLAIMS_BILLING_ENFORCEMENT_ENV}=${current} on a production deployment: a tenant whose clearinghouse is not live (or whose subscription is suspended) is NOT refused new claims work, only logged; set it to 'enforce' to refuse`;
}

/** Where the decision was asked from — logged on a shadow would-deny (never a patient or claim id). */
export interface GateSite {
  readonly route?: string;
  readonly queue?: string;
}

export type GateVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: ClaimsBillingDenyReason };

/**
 * The mode-aware decision. Throws ChartWardenError 503 BILLING_ENTITLEMENT_UNAVAILABLE when the read fails in
 * `enforce` (the caller fails closed); allows on a failed read in `shadow` (logged).
 */
export async function claimsBillingVerdict(
  organizationId: string,
  site: GateSite,
): Promise<GateVerdict> {
  if (mode === "off") return { allow: true };
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
    if (mode === "shadow") return { allow: true };
    throw new ChartWardenError(
      BILLING_ENTITLEMENT_UNAVAILABLE,
      "the claims-billing entitlement could not be read; new claims work is refused until it can",
      503,
    );
  }
  if (entitlement.entitled) return { allow: true };
  if (mode === "shadow") {
    log("claims-billing would deny (shadow)", {
      organizationId,
      ...site,
      reason: entitlement.reason,
    });
    return { allow: true };
  }
  return { allow: false, reason: entitlement.reason };
}

/**
 * ADR-0108 D4 — the one call other backend code makes before starting NEW claims-billing work for an org. True when
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

export function claimsBillingAddonRequired(reason: ClaimsBillingDenyReason): ChartWardenError {
  return new ChartWardenError(
    CLAIMS_BILLING_ADDON_REQUIRED,
    "this organization does not have the claims-billing add-on; new claims work is not available",
    402,
    [{ code: reason, message: "claims-billing add-on not active" }],
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

/** The verdict with an exemption folded in: a refused (or unreadable, in `enforce`) org passes when the work is exempt. */
async function verdictWithExemption(
  organizationId: string,
  site: GateSite,
  exempt: ClaimsBillingExemption | undefined,
): Promise<GateVerdict> {
  let verdict: GateVerdict;
  try {
    verdict = await claimsBillingVerdict(organizationId, site);
  } catch (err) {
    if (await isExempt(exempt, organizationId, site)) return { allow: true };
    throw err;
  }
  if (verdict.allow || !(await isExempt(exempt, organizationId, site))) return verdict;
  return { allow: true };
}

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
    pending = verdictWithExemption(
      organizationId,
      { route: `${request.method} ${request.routeOptions.url ?? request.url}` },
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
 * ADR-0108 D7 — call first in a new-work job processor. Returns normally when the work may run (or `exempt` answers
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
  const allowed = await verdictWithExemption(organizationId, { queue }, exempt).then(
    (v) => v.allow,
    () => false, // already logged; fail closed without failing the job
  );
  if (allowed) return;
  log("claims-billing job held", { organizationId, queue, holdMs: CLAIMS_BILLING_HOLD_MS });
  await job.moveToDelayed(now() + CLAIMS_BILLING_HOLD_MS, token);
  throw new DelayedError();
}
