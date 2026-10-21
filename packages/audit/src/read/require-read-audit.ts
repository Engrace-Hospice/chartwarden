// @chartwarden/audit — read-audit completeness declaration (M4-T03, M4 spec §2.5, §3.4).
//
// §2.5 "Read-audit completeness" is a build-time lint: EVERY PHI resource route must either
// emit a read event (call `auditPhiRead`/`auditListRead`) or carry an explicit, justified
// `auditRead: none` waiver — so a missing read trail is a caught omission, never a silent gap.
//
// This module is the declaration surface that lint consumes: a PHI read route declares its
// intent with `declareReadAudit()`, and the build-time check / M4 boot calls
// `assertReadAuditDeclared()` to refuse any PHI read route that declared neither. (Wiring the
// scan over the actual route table lands with the route inventory in M4-T06, §4; this is the
// contract it enforces against.)

/** How a PHI read route satisfies the §2.5 read-audit-completeness rule. */
export type ReadAuditMode =
  /** The route emits a read event (`auditPhiRead`/`auditListRead`). */
  | { readonly auditRead: true }
  /** The route is exempt — must say WHY (e.g. "no PHI surfaced; counts only"). */
  | { readonly auditRead: "none"; readonly justification: string };

/** A route's declared read-audit intent. `routeId` is the stable `METHOD /path` identifier. */
export interface ReadAuditDeclaration {
  readonly routeId: string;
  readonly mode: ReadAuditMode;
}

const declarations = new Map<string, ReadAuditDeclaration>();

/** Thrown when a `none` waiver omits its mandatory justification (an empty waiver is not a waiver). */
export class ReadAuditDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadAuditDeclarationError";
  }
}

/**
 * Declare how a PHI read route satisfies the read-audit-completeness rule. A `none` waiver must
 * carry a non-empty justification. Re-declaring the same `routeId` overwrites the prior entry.
 */
export function declareReadAudit(routeId: string, mode: ReadAuditMode): void {
  if (mode.auditRead === "none" && mode.justification.trim() === "") {
    throw new ReadAuditDeclarationError(
      `read-audit waiver for '${routeId}' must include a justification`,
    );
  }
  declarations.set(routeId, { routeId, mode });
}

/** The declared read-audit intent for `routeId`, or `undefined` if none was declared. */
export function getReadAuditDeclaration(routeId: string): ReadAuditDeclaration | undefined {
  return declarations.get(routeId);
}

/**
 * The §2.5 build-time check: throw if any of `routeIds` (the PHI read routes) declared neither
 * an `auditRead` emission nor a justified waiver. Returns the route ids that emit a read event.
 */
export function assertReadAuditDeclared(routeIds: readonly string[]): string[] {
  const missing = routeIds.filter((id) => !declarations.has(id));
  if (missing.length > 0) {
    throw new ReadAuditDeclarationError(
      `PHI read route(s) missing a read-audit declaration: ${missing.join(", ")}`,
    );
  }
  return routeIds.filter((id) => declarations.get(id)!.mode.auditRead === true);
}

/** Test/boot reset hook — clears all declared read-audit intents. */
export function resetReadAuditDeclarations(): void {
  declarations.clear();
}
