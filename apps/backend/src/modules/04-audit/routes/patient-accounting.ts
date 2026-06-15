// apps/backend/src/modules/04-audit/routes/patient-accounting.ts — M4-T09 the §164.528 / 42 CFR
// §2.13 patient accounting-of-disclosures route with scope differentiation (M4 spec §7, §10.3).
//
// `GET /api/v1/audit/patients/:patientId/accounting?scope=hipaa_528|part_2_13|all` turns the
// read/disclosure trail into the patient's regulated accounting. Two guards (§7.1): the base
// `requirePermission('audit.disclosure_report')` and the `audit_accounting_scope_allowed` ABAC
// predicate that gates `?scope=all` on the dedicated `audit.disclosure_report_all_scopes` key.
//
// The scope drives the lookback (§7.1): HIPAA §164.528 is clamped to a 6-year window (§14 D7);
// Part 2 §2.13 is the patient's lifetime (no clamp). The route owns that policy and hands the
// resolved window to the @wardenx/audit accounting query (the only sanctioned `audit_event`
// reader — never a direct schema SELECT). The accounting request is ITSELF audited at the
// matching retention class (§2.6 side effect): `compliance` for HIPAA, `compliance_42cfr_part2`
// for Part 2 / all — through the mandated `audit()` surface (the field denylist runs there).
import {
  type AccountingScope,
  type AuditContext,
  type AuditExecutor,
  type AuditQuery,
  audit,
} from "@wardenx/audit";
import { requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AUDIT_ACCOUNTING_SCOPE_PREDICATE } from "../abac/audit-accounting-predicate";
import { AccountingParamsSchema, AccountingQuerySchema, parse } from "./audit-typebox";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The injection surface for the accounting route (mirrors `AuditRouteDeps`). */
export interface PatientAccountingDeps {
  /** Read surface over `audit_event` (in-memory in the slice; Drizzle/withOrgContext in prod). */
  query: AuditQuery;
  /** Audit sink for the "accounting requested" side-effect event (audit() runs the denylist). */
  audit: AuditExecutor;
}

/** Six years in whole calendar years — the §164.528 / §14 D7 HIPAA lookback clamp. */
const HIPAA_LOOKBACK_YEARS = 6;

/** The org-scoped actor (org binding is server-side: the context, never the query/body). */
function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** Build the audit context for the "accounting requested" event from the request. */
function auditContextFor(request: FastifyRequest): AuditContext {
  const ctx = request.context;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    actorKind: "user",
    actorRole: ctx.roles[0],
    correlationId: ctx.correlationId,
    requestId: String(request.id),
    sourceIp: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

/** Read the requested scope from the query for the ABAC target (defaults to the narrow scope). */
function scopeOf(request: { query?: unknown }): AccountingScope {
  const q = request.query as { scope?: unknown } | undefined;
  const scope = q?.scope;
  return scope === "part_2_13" || scope === "all" ? scope : "hipaa_528";
}

/**
 * Resolve the accounting window for `scope` at `now` (§7.1): HIPAA is clamped to the last 6
 * years, Part 2 / all are the patient's lifetime (epoch → now). Optional `from`/`to` (calendar
 * dates) NARROW within the scope window — they can never widen HIPAA past its clamp. Returns
 * inclusive ISO-8601 bounds the query filters `createdAt` against.
 */
export function computeLookbackForScope(
  scope: AccountingScope,
  now: Date,
  from?: string,
  to?: string,
): { from: string; to: string } {
  const epochIso = new Date(0).toISOString();
  const nowIso = now.toISOString();
  const hipaaFloor = new Date(now);
  hipaaFloor.setUTCFullYear(hipaaFloor.getUTCFullYear() - HIPAA_LOOKBACK_YEARS);

  let lowerIso = scope === "hipaa_528" ? hipaaFloor.toISOString() : epochIso;
  let upperIso = nowIso;

  // Narrow within the scope window: a user `from` (start of that day) can only move the floor
  // later; a user `to` (end of that day) can only move the ceiling earlier.
  if (from !== undefined) {
    const userFromIso = `${from}T00:00:00.000Z`;
    if (userFromIso > lowerIso) lowerIso = userFromIso;
  }
  if (to !== undefined) {
    const userToIso = `${to}T23:59:59.999Z`;
    if (userToIso < upperIso) upperIso = userToIso;
  }
  return { from: lowerIso, to: upperIso };
}

/** True when the scope writes its accounting-request audit at the Part 2 retention class (§7.1). */
function isPartTwoScope(scope: AccountingScope): boolean {
  return scope === "part_2_13" || scope === "all";
}

const reportPermission = requirePermission("audit.disclosure_report") as PreHandler;
const scopeGate = requireAbac("audit.disclosure_report", AUDIT_ACCOUNTING_SCOPE_PREDICATE, {
  getTarget: (request) => ({ scope: scopeOf(request) }),
}) as unknown as PreHandler;

/**
 * Mount `GET /api/v1/audit/patients/:patientId/accounting` (§7.1). Behind the base permission +
 * the `?scope=all` ABAC gate; computes the scope window, runs the accounting query, and audits
 * the request itself at the matching retention class before returning the report.
 */
export function registerPatientAccountingRoute(
  app: FastifyInstance,
  deps: PatientAccountingDeps,
): void {
  app.get(
    "/api/v1/audit/patients/:patientId/accounting",
    { preHandler: [reportPermission, scopeGate] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(AccountingParamsSchema, request.params);
      const q = parse(AccountingQuerySchema, request.query);
      const scope: AccountingScope = q.scope ?? "hipaa_528";

      const window = computeLookbackForScope(scope, new Date(), q.from, q.to);
      const report = await deps.query.accounting(organizationId, patientId, {
        scope,
        from: window.from,
        to: window.to,
        cursor: q.cursor,
        limit: q.limit,
      });

      // §2.6 side effect: the accounting request is itself audited at the matching retention
      // class — Part 2 requests are retained under the stricter Part 2 schedule (§7.1).
      const partTwo = isPartTwoScope(scope);
      await audit(deps.audit, auditContextFor(request), {
        eventType: partTwo
          ? "audit.disclosure_report_generated_part_2"
          : "audit.disclosure_report_generated_hipaa",
        resourceKind: "patient",
        resourceId: patientId,
        outcome: "success",
        severity: "info",
        retentionClass: partTwo ? "compliance_42cfr_part2" : "compliance",
        context: {
          scope,
          lookbackFrom: window.from,
          lookbackTo: window.to,
          resultCount: report.disclosures.length,
        },
      });

      return report;
    },
  );
}
