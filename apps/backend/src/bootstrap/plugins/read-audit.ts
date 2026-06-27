// apps/backend/src/bootstrap/plugins/read-audit.ts — PHI read-audit coverage gate (M4 §2.5).
//
// "Read-audit completeness" (M4 spec §2.5): EVERY PHI read route must either emit a read event
// (auditPhiRead/auditListRead) or carry an explicit, justified waiver — a missing read trail is a
// caught omission, never a silent gap. The declaration contract has existed (declareReadAudit /
// assertReadAuditDeclared) but nothing enforced it, so the obligation was dormant (audit finding #4).
//
// This plugin makes it a FAIL-CLOSED BOOT GATE. An `onRoute` hook fires as each route registers; for
// any GOVERNED PHI read route (a GET/HEAD under an enforced path prefix) it requires the route to
// carry `config.auditRead` — an emission config or a `{ none: <justification> }` waiver — and refuses
// registration otherwise. The server therefore cannot boot while a PHI read route lacks its
// declaration. Coverage is keyed off the actually-registered (mounted) routes, so it can never drift
// from an out-of-date static list. Write routes are out of scope here — the M4 write-audit triggers
// (generateAuditTrigger) cover mutations at the table.
import { type RouteReadAudit, declareReadAudit, routeReadAuditMode } from "@wardenx/audit";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * PHI read-audit intent for this route (§2.5). REQUIRED on any GET/HEAD under an enforced PHI
     * prefix: an emission config (`{ resourceKind, patientIdParam?, fields? }`) or a justified
     * waiver (`{ none: "<why no PHI is surfaced>" }`).
     */
    auditRead?: RouteReadAudit;
  }
}

/** Thrown at route registration when a governed PHI read route omits its `config.auditRead` (§2.5). */
export class ReadAuditCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadAuditCoverageError";
  }
}

/** Normalize a route's method(s) to an array (Fastify allows a single method or a list). */
function methodsOf(method: string | string[]): string[] {
  return Array.isArray(method) ? method : [method];
}

/**
 * Is this a PHI read route the coverage rule governs? A read is GET or HEAD; "governed" means its
 * URL sits under one of the enforced PHI prefixes. Pure, so the predicate is unit-testable.
 */
export function isGovernedReadRoute(
  method: string | string[],
  url: string,
  prefixes: readonly string[],
): boolean {
  const isRead = methodsOf(method).some((m) => m === "GET" || m === "HEAD");
  if (!isRead) return false;
  return prefixes.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
}

/**
 * Install the read-audit coverage gate: an `onRoute` hook that refuses to register any governed PHI
 * read route lacking `config.auditRead`, and otherwise records its declaration so the §2.5 registry
 * reflects the mounted surface. Add this BEFORE the module routes are registered (the hook only sees
 * routes registered after it). `enforcedPrefixes` is the set of PHI path prefixes under coverage.
 */
export function applyReadAuditCoverage(
  app: FastifyInstance,
  opts: { enforcedPrefixes: readonly string[] },
): void {
  app.addHook("onRoute", (route) => {
    if (!isGovernedReadRoute(route.method, route.url, opts.enforcedPrefixes)) return;
    const method = methodsOf(route.method).join(",");
    const routeId = `${method} ${route.url}`;
    const mode = routeReadAuditMode(route.config?.auditRead);
    if (!mode) {
      throw new ReadAuditCoverageError(
        `PHI read route '${routeId}' must declare config.auditRead — an emission config { resourceKind, patientIdParam?, fields? } or a justified waiver { none: "…" } (§2.5 read-audit completeness)`,
      );
    }
    // Records the intent (and throws if a waiver omits its justification) so a boot-time
    // assertReadAuditDeclared() / the M4 accounting can see the mounted PHI read surface.
    declareReadAudit(routeId, mode);
  });
}
