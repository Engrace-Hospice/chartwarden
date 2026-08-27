#!/usr/bin/env bun
// scripts/check-request-body-contract.ts — F-034 / #94: does a route's PUBLISHED request body agree
// with the body its handler actually reads?
//
// `openapi:check` proves openapi.json was regenerated. `arch:openapi-coverage` counts whether a route
// carries an enrichment entry, and separately whether a mutating route carries a `body`. None of them
// asks the only question that makes a request contract true: **the handler and the contract must agree
// about whether there is a payload at all.** Two failures live in that gap, and both are silent:
//
//   A. The contract publishes a body the handler never reads. The caller is told a payload is required,
//      sends it, and gets a 200 — with the payload discarded. `PATCH /encounters/:id/selections`
//      publishes `{ selections, freeText }` as `required: true`, parses only its path params, bumps the
//      row version and returns 200: a clinician's note accepted and dropped (#114).
//   B. The handler reads a body the contract publishes none for. `client:gen` then types that body as
//      `never`, so the generated typed client cannot express the call at all and every caller must cast
//      at the boundary.
//
// Direction B is what #94 counted. Direction A is the one nobody had counted, and it is the more
// dangerous of the two: B fails loudly at the type level, A returns success.
//
// WHY THIS IS NOT `mutatingNoBody`. That metric asks "does this mutating route publish a body?", which
// is not the same question and cannot be driven to zero honestly: a payload-free action POST
// (`/claims/:id/submit`, `/plans/:id/activate`) correctly publishes none. Measuring presence rather
// than AGREEMENT made publishing `{}` the cheapest way to satisfy it — which is why this repo grew
// TypeBox schemas named `M35EmptyActionBody`, `M31EmptyBody` and `M25RemittanceEmptyBodySchema`, and
// 24 routes declaring `required: true` over an empty object. The metric produced the defect. This gate
// replaces that question with the one worth asking.
//
// Exceptions are REGISTERED, never inferred (the `deviceAttestationValid` rule): an entry carries its
// reason, and the gate FAILS when a registered route stops violating, so an entry cannot outlive it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_ENRICHMENTS } from "./openapi/enrichments";
import { type ScannedRoute, routeKey, scanRoutes } from "./openapi/scan-routes";

const CHECK_ONLY = !process.argv.includes("--list");

/**
 * Test-only scan root, honored by `check-design-tokens.ts` and `check-migration-numbering.ts` for the same
 * reason and unset in every real invocation (`arch:fitness` never sets it).
 *
 * It does two things here. It roots the scan at the planted-violation fixture — and it tells the gate the
 * scan is PARTIAL. A fixture tree holds one route file, so it sees none of the registered routes below and
 * every registry entry would read as stale: the fixture would go red without the planted route in it,
 * which is precisely the failure the `openapi-coverage` self-test warns about ("must fail on the RATCHET,
 * not merely on report staleness"). Staleness is asserted by the unit tests over `checkRoutes` instead,
 * where the registry can be varied directly.
 */
const FIXTURE_ROOT = process.env.WARDENX_FITNESS_ROOT;

/** Methods that can carry a request payload. GET/DELETE bodies are not a thing this codebase uses. */
const BODY_METHODS = new Set(["post", "put", "patch"]);

/**
 * How a handler can reach the request payload. `rawBodyOf` is the signature-verification path (a
 * webhook needs the unparsed bytes), and it counts: the route does receive a payload.
 */
const READS_BODY = /\brequest\.body\b|\breq\.body\b|\brawBodyOf\s*\(/;

interface Registered {
  readonly reason: string;
  /** Issue tracking the fix, when one is filed. */
  readonly issue?: string;
}

/**
 * Direction A — routes that publish a body their handler discards.
 *
 * Every entry here is a route where a caller is told to send a payload and the server throws it away.
 * They are the standing finding, not a passing state; the gate prints them on every run. Each needs a
 * DECISION (start reading it, or stop publishing it) that belongs to the module's owner, not to this
 * gate.
 */
const PUBLISHES_UNREAD: Record<string, Registered> = {
  "PATCH /api/v1/encounters/:encounterId/selections": {
    reason:
      "publishes { selections, freeText } required:true and parses only params — the clinician's " +
      "note is accepted with a 200 + version bump and discarded; nothing writes hearthnote_selection",
    issue: "#114",
  },
  "PATCH /api/v1/encounters/:encounterId/addenda/:addendumId/selections": {
    reason: "the addendum twin of the above, same schema, same discard",
    issue: "#114",
  },
  "POST /api/v1/assessments/:id/cosignatures": {
    reason:
      "publishes attestationConfirmed required:true and ignores it — the cosigner's attestation is " +
      "demanded by the contract and never checked; the discipline is derived from role keys instead",
    issue: "#117",
  },
  "POST /api/v1/admin/portal-accounts/:id/suspend": {
    reason: "publishes reason required:true and discards it — the suspension is recorded with none",
    issue: "#117",
  },
  "POST /api/v1/admin/portal-accounts/:id/reinstate": {
    reason: "publishes reason required:true and discards it — same shape as suspend",
    issue: "#117",
  },
  "POST /fhir/r4/CodeSystem/$validate-code": {
    reason:
      "publishes a FHIR Parameters resource (resourceType + parameter, required) and reads none — " +
      "a $validate-code that ignores its Parameters cannot be validating the code it was asked about",
    issue: "#117",
  },
};

/** Direction B — routes whose handler reads a body the contract publishes none for. */
const READS_UNPUBLISHED: Record<string, Registered> = {
  "POST /api/v1/webhooks/stripe": {
    reason:
      "reads rawBodyOf(request) because Stripe's signature is an HMAC over the UNPARSED bytes — the " +
      "payload is Stripe's contract, not ours, and publishing our own schema for it would invite a " +
      "caller to construct one. The route is unauthenticated by design and the signature is the only " +
      "credential; there is no client for which `never` is the wrong type here",
  },
};

// ── handler extraction ────────────────────────────────────────────────────────────────────────────────

/**
 * Strip comments and blank out string/template contents, so paren matching sees only code.
 *
 * This exists because the obvious version does not work: scanning for a matching `)` while treating `'`
 * as a string delimiter breaks on the first apostrophe in a prose comment (`// Stripe's TOS wants a
 * fast 200`), after which every paren is "inside a string" and the scan runs to EOF. That silently cost
 * 16 handlers — including the Stripe webhook, one of the routes this gate most needs to read. A gate
 * that cannot parse a handler must SAY so, not quietly skip it, so extraction failure is a hard error
 * below and this function is what keeps that from firing.
 *
 * Contents are replaced with spaces rather than removed, so every index still lines up.
 */
export function blankNonCode(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * The full text of one `app.<method>("<path>", …)` call, from its open paren to the matching close.
 * Returns null only when the route call cannot be found at all — an unbalanced scan is impossible once
 * comments and strings are blanked, and the caller treats null as a hard error.
 */
export function extractRouteCall(source: string, method: string, path: string): string | null {
  const code = blankNonCode(source);
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The path lives in a string, which is now blanked — so match against the ORIGINAL text for the
  // location, then walk the BLANKED text for the parens.
  const at = new RegExp(`app\\.${method}\\(\\s*"${esc}"`).exec(source);
  if (!at) return null;
  const open = code.indexOf("(", at.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────────────

export interface Disagreement {
  readonly key: string;
  readonly file: string;
  readonly kind: "publishes-unread" | "reads-unpublished" | "unreadable";
  readonly detail: string;
}

export function checkRoutes(
  routes: readonly ScannedRoute[],
  readFile: (file: string) => string,
  hasBody: (key: string) => boolean,
): { violations: Disagreement[]; registered: Disagreement[]; staleEntries: string[] } {
  const violations: Disagreement[] = [];
  const registered: Disagreement[] = [];
  const seen = new Set<string>();

  for (const route of routes) {
    const key = routeKey(route);
    const call = extractRouteCall(readFile(route.file), route.method, route.path);
    if (call === null) {
      violations.push({
        key,
        file: route.file,
        kind: "unreadable",
        detail: "could not locate the route call — the gate cannot judge this route",
      });
      continue;
    }
    const reads = READS_BODY.test(call);
    const publishes = hasBody(key);

    if (publishes && !reads) {
      const entry = PUBLISHES_UNREAD[key];
      const d: Disagreement = {
        key,
        file: route.file,
        kind: "publishes-unread",
        detail: entry ? `${entry.reason}${entry.issue ? ` (${entry.issue})` : ""}` : "",
      };
      if (entry) {
        seen.add(key);
        registered.push(d);
      } else {
        violations.push({
          ...d,
          detail:
            "publishes a request body the handler never reads — the caller's payload is discarded",
        });
      }
      continue;
    }
    if (!publishes && reads && BODY_METHODS.has(route.method)) {
      const entry = READS_UNPUBLISHED[key];
      const d: Disagreement = {
        key,
        file: route.file,
        kind: "reads-unpublished",
        detail: entry ? `${entry.reason}${entry.issue ? ` (${entry.issue})` : ""}` : "",
      };
      if (entry) {
        seen.add(key);
        registered.push(d);
      } else {
        violations.push({
          ...d,
          detail:
            "reads a request body the contract publishes none for — client:gen types it `never`, " +
            "so the generated client cannot express this call",
        });
      }
    }
  }

  // A registered entry that no longer violates is stale: it must not outlive its reason.
  const staleEntries = [...Object.keys(PUBLISHES_UNREAD), ...Object.keys(READS_UNPUBLISHED)].filter(
    (k) => !seen.has(k),
  );
  return { violations, registered, staleEntries };
}

function main(): void {
  const root = FIXTURE_ROOT ?? process.cwd();
  const routes = scanRoutes(root);
  const cache = new Map<string, string>();
  const readFile = (f: string): string => {
    if (!cache.has(f)) cache.set(f, readFileSync(join(root, f), "utf8"));
    return cache.get(f) as string;
  };
  const { violations, registered, staleEntries } = checkRoutes(routes, readFile, (key) =>
    Boolean(ROUTE_ENRICHMENTS[key]?.body),
  );

  if (registered.length > 0) {
    console.log(
      `request-body-contract: ${registered.length} REGISTERED disagreement(s) — the standing finding, not a passing state:`,
    );
    for (const r of [...registered].sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`  · ${r.key}\n      ${r.detail}`);
    }
    console.log("");
  }

  const problems: string[] = [];
  for (const v of violations.sort((a, b) => a.key.localeCompare(b.key))) {
    problems.push(`  ✗ ${v.key}\n      ${v.detail}\n      ${v.file}`);
  }
  for (const key of (FIXTURE_ROOT ? [] : staleEntries).sort()) {
    problems.push(
      `  ✗ ${key}\n      registered as a known disagreement, but the route no longer disagrees — delete the entry (an exception must not outlive its reason)`,
    );
  }

  if (problems.length > 0) {
    console.error(
      `✗ request-body-contract: ${problems.length} route(s) whose published request body disagrees with the handler:\n${problems.join("\n")}`,
    );
    process.exit(1);
  }
  console.log(
    `✓ request-body-contract: ${routes.length} routes — published body agrees with the handler (${registered.length} registered)`,
  );
  if (!CHECK_ONLY) process.exit(0);
}

if (import.meta.main) main();
