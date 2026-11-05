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
} from "@chartwarden/types";
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

const memo = new WeakMap<FastifyRequest, Promise<GateVerdict>>();

/** The route preHandler. Runs after the route's own guards, so `request.context` is already authorized. */
export async function claimsBillingPreHandler(request: FastifyRequest): Promise<void> {
  if (mode === "off") return;
  const organizationId = request.context?.organizationId;
  // An authenticated tenant route always has an org; without one the route's own guards already refused.
  if (!organizationId) return;
  let pending = memo.get(request);
  if (!pending) {
    pending = claimsBillingVerdict(organizationId, {
      route: `${request.method} ${request.routeOptions.url ?? request.url}`,
    });
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
    const gated = methods.some(
      (m) => !READ_METHODS.has(m) && classifyRoute(rules, m, opts.url) === "new_work",
    );
    if (gated) appendGate(opts);
  });
  try {
    mount();
  } finally {
    active = false;
  }
}
