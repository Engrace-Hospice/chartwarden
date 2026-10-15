// M25 milestone 3 — which path a denial takes: an appeal, or a reopening the MAC handles itself (a 56900
// non-response is not appealable). PURE. The decision is data, not code: per-organization dated rules say what a
// MAC reason code / RARC / CARC means. A denial no rule matches is `undetermined` and stays appealable exactly as
// before, so an incomplete rule set never blocks work; an unverified rule is surfaced so the user confirms it.
export type DenialRoute = "appeal" | "reopening" | "undetermined";
export type RouteCodeKind = "mac_reason" | "rarc" | "carc";

export interface RouteRule {
  readonly id: string;
  /** null = applies to every MAC. */
  readonly macName: string | null;
  readonly codeKind: RouteCodeKind;
  readonly code: string;
  readonly route: "appeal" | "reopening";
  /** Day (YYYY-MM-DD) someone confirmed the rule against the MAC; null = not yet verified. */
  readonly verifiedOn: string | null;
  readonly effectiveFrom: string;
  readonly sourceNote: string | null;
  /** A tenant's own rule outranks the built-in default of the same specificity. Omitted = the tenant's. */
  readonly origin?: "org" | "platform";
}

export interface DenialRouteInput {
  readonly macName: string | null;
  /** The MAC's own reason code (e.g. FISS 56900); not a CARC, so entered or mapped separately. */
  readonly macReasonCode: string | null;
  readonly carcCode: string;
  readonly rarcCode: string | null;
  /** Day (YYYY-MM-DD) the rules are read as of. */
  readonly asOf: string;
}

export interface ResolvedRoute {
  readonly route: DenialRoute;
  readonly rule: RouteRule | null;
  readonly unverified: boolean;
}

const norm = (s: string | null): string => (s ?? "").trim().toUpperCase();
const KIND_RANK: Readonly<Record<RouteCodeKind, number>> = { mac_reason: 3, rarc: 2, carc: 1 };

function codeOf(input: DenialRouteInput, kind: RouteCodeKind): string {
  if (kind === "mac_reason") return norm(input.macReasonCode);
  return norm(kind === "rarc" ? input.rarcCode : input.carcCode);
}

function matches(rule: RouteRule, input: DenialRouteInput): boolean {
  if (rule.effectiveFrom > input.asOf) return false;
  if (rule.macName !== null && norm(rule.macName) !== norm(input.macName)) return false;
  const have = codeOf(input, rule.codeKind);
  return have !== "" && have === norm(rule.code);
}

/** Sort order, first wins: the code kind (MAC reason > RARC > CARC), MAC-specific, the tenant's own rule, the latest effective date, then id (stable). */
function precedence(a: RouteRule, b: RouteRule): number {
  // The code kind comes first: the MAC's own reason code is the strongest signal, so a MAC-specific CARC rule can
  // never silently switch off the protection a 56900 rule gives.
  const kind = KIND_RANK[b.codeKind] - KIND_RANK[a.codeKind];
  if (kind !== 0) return kind;
  const specific = Number(b.macName !== null) - Number(a.macName !== null);
  if (specific !== 0) return specific;
  const origin = Number(b.origin !== "platform") - Number(a.origin !== "platform");
  if (origin !== 0) return origin;
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

/**
 * The built-in default every tenant starts with: a 56900 (ADR non-response) is reopened with the MAC, not
 * appealed (CGS guidance). Unverified on purpose: the user sees "confirm with your MAC" until a tenant records
 * its own verified rule, which then outranks this one.
 */
export const PLATFORM_ROUTE_RULES: readonly RouteRule[] = [
  {
    id: "platform:56900",
    macName: null,
    codeKind: "mac_reason",
    code: "56900",
    route: "reopening",
    verifiedOn: null,
    effectiveFrom: "2000-01-01",
    sourceNote: "CGS: an ADR non-response (56900) is reopened with the MAC, not appealed",
    origin: "platform",
  },
];

export function resolveRoute(input: DenialRouteInput, rules: readonly RouteRule[]): ResolvedRoute {
  const winner = rules.filter((r) => matches(r, input)).sort(precedence)[0];
  if (!winner) return { route: "undetermined", rule: null, unverified: false };
  return { route: winner.route, rule: winner, unverified: winner.verifiedOn === null };
}
