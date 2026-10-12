#!/usr/bin/env bun
/**
 * WardenX — request-header authorization gate (F-028)
 * ---------------------------------------------------------------------------
 * A request header is whatever the caller typed. Reading one is fine; deciding an AUTHORIZATION
 * question from one — without verifying it against server-held state — hands the decision to the
 * party being gated.
 *
 * WHAT HAPPENED. Four commit-point routes across three modules gated a step-up (re-authentication)
 * requirement on `request.headers["x-step-up"] === "fresh"`:
 *
 *   POST /api/v1/idg/meetings/:id/adjourn                       (M14 — the D13 IDG commit point)
 *   POST /api/v1/visits/:visitId/start                          (M17 — self-attested EVV-missing start)
 *   POST /api/v1/evv/events/:eventId/correct                    (M18 — retroactive correction-of-record)
 *   POST /api/v1/evv/missing-resolutions/:id/supervisor-override (M18 — the D6 override)
 *
 * Any caller who could reach those routes could satisfy the step-up by sending the header. The
 * ceremony was optional for anyone who knew it existed. Meanwhile eight other modules gated the same
 * requirement correctly, through `requireStepUp(opKey)` → M3's `step_up_recent` predicate → M2's
 * `SessionContextResolver` seam → the real `session.last_step_up_at`.
 *
 * WHY NOTHING CAUGHT IT. Every gate the repo had was self-consistent about it: the routes carried
 * request/response contracts so `arch:openapi-coverage` counted them enriched; `openapi:check` proved
 * the contract was REGENERATED, not that it was TRUE; the typed client generated cleanly, because a
 * header nothing declares is simply a header the client cannot send. The published API and the code
 * agreed with each other and both were wrong about what the route required. It surfaced only when
 * type-checking `scripts/` broke a seed that had been passing the header as a typed parameter.
 *
 * WHAT THIS ENFORCES. Every `request.headers[...]` read in backend source names a header that is
 * REGISTERED below with a classification. There are exactly two legal classifications:
 *
 *   `verified`         — the value is checked against server-held state before it is believed
 *                        (a cryptographic signature, a constant-time secret compare, a server-minted
 *                        single-use token, a double-submit cookie).
 *   `not-authorization`— the value decides no authorization question at all (concurrency control,
 *                        telemetry, content negotiation). A forged value gets you a 412 or a bad log
 *                        line, not access.
 *
 * There is deliberately NO third classification for "trusted because the client is nice". A header
 * that would need one is the bug this gate exists to refuse. Registering a header is a one-line
 * change — the point is that it must be a DECISION, made in review, rather than a read that nobody
 * looked at twice.
 *
 * Scope is `apps/backend/src` (route handlers, plugins, guards). Tests are excluded: a test harness
 * legitimately drives its own fake authenticate hook off headers, and does so in several suites.
 *
 * Run:  bun run arch:request-header-auth   (in `arch:fitness`)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is a Bun extension and is `undefined` under Vitest, which imports this module
// directly for the gate's own test; `import.meta.url` is standard and resolves the same path in both.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_PREFIX = "apps/backend/src/";

/** This file quotes header names to describe them; it is not backend source. */
const EXEMPT_PREFIX = ["scripts/"];

export type HeaderClass = "verified" | "not-authorization";

export interface RegisteredHeader {
  readonly classification: HeaderClass;
  /** Why the read is safe — the server-side check, or why no authorization rides on it. */
  readonly reason: string;
}

/**
 * Every request header backend source may read, and why reading it is safe.
 *
 * Keys are lower-case: Fastify lower-cases incoming header names, so that is how they appear at
 * every read site. Adding an entry is how you assert the classification; the gate only checks that
 * you asserted one.
 */
export const REGISTERED_HEADERS: Readonly<Record<string, RegisteredHeader>> = {
  "if-match": {
    classification: "not-authorization",
    reason:
      "Optimistic concurrency (§7.7/§2.5). A wrong value is a 412 STALE_VERSION — it can lose you a write, never win you one.",
  },
  "idempotency-key": {
    classification: "not-authorization",
    reason:
      "Replay collapsing (§4.1.1). Scoped to the caller's own prior request; it grants nothing it did not already have.",
  },
  "x-wardenx-background": {
    classification: "not-authorization",
    reason:
      "GAP-002: marks a timer poll so it does not refresh the session idle clock. The timeout is still enforced; omitting the header only keeps the caller's OWN session alive, which any real request does anyway.",
  },
  "x-forwarded-for": {
    classification: "not-authorization",
    reason:
      "Realtime handshake throttle key only (ADR-0054 A8), read solely when TRUSTED_PROXY_CIDRS is set, last entry. A forged value can only move the caller into another rate bucket; it decides no access.",
  },
  "x-correlation-id": {
    classification: "not-authorization",
    reason: "Trace correlation only. Never read by a guard, a predicate, or a service decision.",
  },
  "user-agent": {
    classification: "not-authorization",
    reason: "Recorded on the audit trail as reported. Nothing branches on it.",
  },
  "x-csrf-token": {
    classification: "verified",
    reason:
      "Double-submit: compared against the `wardenx_csrf` COOKIE the server minted (bootstrap/plugins/csrf.ts). The header alone proves nothing.",
  },
  "stripe-signature": {
    classification: "verified",
    reason:
      "HMAC over the raw body, verified against the endpoint's webhook secret before the payload is believed (M35 webhooks.routes.ts).",
  },
  "x-dosespot-signature": {
    classification: "verified",
    reason:
      "HMAC-SHA256 of the raw body, constant-time compared against the tenant's webhook secret before the payload is believed (M12 webhooks/ingest.ts -> @wardenx/dosespot verifyWebhookEnvelope). Scheme per M12 spec 7.4; NOT yet checked against a real DoseSpot delivery (F-230).",
  },
  "x-dosespot-timestamp": {
    classification: "not-authorization",
    reason:
      "Replay-window freshness (+-5 min) only; authorization is the HMAC above plus the (org, event id) dedup key. Note the scheme does not sign the timestamp.",
  },
  "x-twilio-signature": {
    classification: "verified",
    reason:
      "Base64 HMAC-SHA1 over (exact public URL + sorted POST params) under the Twilio Auth Token, constant-time compared BEFORE the callback is believed (M36 webhooks/verify-twilio.ts, mounted by 36-messaging/delivery/webhook-mount.ts). Fails closed (503) when no Auth Token is configured. Scheme per M36 spec 4.9.2; NOT yet checked against a real Twilio delivery.",
  },
  "x-twilio-timestamp": {
    classification: "not-authorization",
    reason:
      "Replay-window freshness (+-300 s) only (M36 webhooks/replay-guard.ts); authorization is the HMAC above, and the status update is forward-only so a replay is a no-op. Spec 4.9.1 assumes Twilio sends it; unverified against a real delivery.",
  },
  "x-witness-attestation": {
    classification: "verified",
    reason:
      "A SERVER-MINTED, single-use witness token: `verifyWitnessToken` checks its claims and burns it, and `witnessTokenDigest` records what was burned (packages/emar). Bearer credential, not a self-assertion.",
  },
  "x-internal-service-token": {
    classification: "verified",
    reason:
      "Machine credential, compared in constant time against the provisioned secret (`timingSafeMatch`, bootstrap/plugins/authenticate.ts). Absent or wrong ⇒ the caller falls through to the ordinary session path with no system privilege.",
  },
  "x-internal-org-id": {
    classification: "not-authorization",
    reason:
      "Read only INSIDE the verified system-credential branch above, to name which org the machine caller acts for. Unreachable without the token.",
  },
};

/**
 * A generic accessor whose header name arrives as a PARAMETER, so no read site names a header.
 *
 * Keyed by file; the value lists the identifiers its callers pass. The gate resolves each of those
 * to its literal in the same file and requires the literal to be registered above — so the entry
 * cannot go stale, and adding a third caller with a new constant fails until that header is
 * classified. An accessor that is not listed here fails like any other unresolvable read.
 */
export const DYNAMIC_READERS: Readonly<Record<string, readonly string[]>> = {
  "apps/backend/src/bootstrap/plugins/authenticate.ts": [
    "SYSTEM_TOKEN_HEADER",
    "SYSTEM_ORG_HEADER",
  ],
};

export interface HeaderRead {
  readonly file: string;
  readonly line: number;
  readonly header: string;
  readonly text: string;
}

/**
 * `request.headers["x-foo"]` / `req.headers['x-foo']`, plus the indirect form where the name is a
 * module constant (`request.headers[CSRF_HEADER_NAME]`) — the constant's own value is resolved from
 * its declaration so the registry is keyed on real header names, not on identifiers.
 *
 * Anchored on `request`/`req` deliberately: `res.headers[...]` is a RESPONSE the server itself wrote,
 * which is not an input and cannot be forged by a caller.
 */
const DIRECT_RE = /\b(?:request|req)\.headers\[\s*["'`]([^"'`]+)["'`]\s*\]/g;
const INDIRECT_RE = /\b(?:request|req)\.headers\[\s*([A-Za-z_$][\w$]*)\s*\]/g;
const CONST_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["'`]([^"'`]+)["'`]/g;

/** A line that is wholly a comment. The routes DOCUMENT the header they no longer read. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Test files drive their own fake authenticate hooks off headers, legitimately and in many suites. */
function isTestFile(file: string): boolean {
  return file.includes("/__tests__/") || file.endsWith(".test.ts");
}

/** Every header name backend source reads off a REQUEST, with the site that reads it. */
export function findHeaderReads(root: string = REPO_ROOT): HeaderRead[] {
  const tracked = execFileSync("git", ["ls-files", "-z", SCAN_PREFIX], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (f) => f.endsWith(".ts") && !isTestFile(f) && !EXEMPT_PREFIX.some((p) => f.startsWith(p)),
    );

  const reads: HeaderRead[] = [];
  for (const file of tracked) {
    let src: string;
    try {
      src = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (!src.includes(".headers[")) continue;

    // Resolve string constants declared in this file, so `request.headers[CSRF_HEADER_NAME]`
    // reports the header it actually reads rather than the identifier.
    const consts = new Map<string, string>();
    for (const m of src.matchAll(CONST_RE)) {
      const [, name, value] = m;
      if (name && value) consts.set(name, value);
    }
    // A registered generic accessor stands in for the header names its callers pass.
    const dynamic = DYNAMIC_READERS[file];

    src.split("\n").forEach((text, i) => {
      if (isComment(text)) return;
      for (const m of text.matchAll(DIRECT_RE)) {
        const header = m[1];
        if (header)
          reads.push({ file, line: i + 1, header: header.toLowerCase(), text: text.trim() });
      }
      for (const m of text.matchAll(INDIRECT_RE)) {
        const ident = m[1];
        if (!ident) continue;
        const resolved = consts.get(ident);
        if (resolved !== undefined) {
          reads.push({ file, line: i + 1, header: resolved.toLowerCase(), text: text.trim() });
          continue;
        }
        if (dynamic) {
          // The parameter cannot be resolved here; the accessor's declared callers are checked
          // instead, each resolved against this file's own constants (an unresolvable one stays
          // unresolved and fails below, under its identifier).
          for (const callerConst of dynamic) {
            reads.push({
              file,
              line: i + 1,
              header: (consts.get(callerConst) ?? callerConst).toLowerCase(),
              text: `${text.trim()}   // via ${callerConst}`,
            });
          }
          continue;
        }
        // Unresolvable and undeclared: reported under the identifier so it cannot pass unexamined.
        reads.push({ file, line: i + 1, header: ident.toLowerCase(), text: text.trim() });
      }
    });
  }
  return reads;
}

/** Reads whose header is not registered — the gate's failure set. */
export function unregisteredReads(reads: readonly HeaderRead[]): HeaderRead[] {
  return reads.filter((r) => !(r.header in REGISTERED_HEADERS));
}

if (import.meta.main) {
  const reads = findHeaderReads();
  const bad = unregisteredReads(reads);
  const names = new Set(reads.map((r) => r.header));

  if (bad.length === 0) {
    console.log(
      `✓ request-header-auth: ${reads.length} header read(s) across ${names.size} registered header(s)`,
    );
    process.exit(0);
  }

  console.error(`✗ request-header-auth: ${bad.length} unregistered request-header read(s)\n`);
  for (const r of bad) console.error(`  ${r.file}:${r.line}  [${r.header}]  ${r.text}`);
  console.error(
    "\n  Every header backend source reads must be registered in REGISTERED_HEADERS\n" +
      "  (scripts/check-request-header-auth.ts) as one of:\n" +
      "\n" +
      "    verified          — the server checks the value against state it holds, before believing it\n" +
      "    not-authorization — nothing about who-may-do-what depends on the value\n" +
      "\n" +
      "  If neither fits, the read IS the bug: an authorization decision is being taken from a\n" +
      "  string the gated caller supplied. Resolve the fact server-side instead — `requireStepUp`,\n" +
      "  an ABAC predicate, or `request.context` (see apps/backend/src/bootstrap/step-up.ts).",
  );
  process.exit(1);
}
