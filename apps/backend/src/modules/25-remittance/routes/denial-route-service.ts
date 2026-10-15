// apps/backend/src/modules/25-remittance/routes/denial-route-service.ts — M25 milestone 3: which path a denial
// takes. The route is COMPUTED on read by the pure `resolveRoute` from the organization's dated rules plus the
// built-in default (a 56900 non-response is reopened with the MAC, not appealed), never stored, so a rule edit
// cannot leave a stale route behind. A denial carries no MAC of its own: the MAC comes from the ADR logged
// against it (or its claim), so a MAC-specific rule applies only once an ADR names the MAC. `resolveDenialRoute`
// is exported for the appeal guard, which runs inside the appeal's own transaction. Every command runs under
// `withOrgContext` (RLS) and inside the actor's provider-entity scope.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import {
  PLATFORM_ROUTE_RULES,
  type ResolvedRoute,
  type RouteCodeKind,
  type RouteRule,
  noticeDayOf,
  resolveRoute,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const CODE_KINDS: readonly RouteCodeKind[] = ["mac_reason", "rarc", "carc"];
const MAC_REASON_CODE = /^[A-Za-z0-9]{1,16}$/;

export interface DenialRouteView {
  readonly route: ResolvedRoute["route"];
  /** True when the deciding rule has not been verified against the MAC: the screen says "confirm with your MAC". */
  readonly unverified: boolean;
  readonly rule: {
    readonly id: string;
    readonly origin: "org" | "platform";
    readonly macName: string | null;
    readonly codeKind: string;
    readonly code: string;
    readonly route: string;
    readonly verifiedOn: string | null;
    readonly sourceNote: string | null;
  } | null;
  readonly macReasonCode: string | null;
  /** The MAC the rules were read for (from the ADR logged on this denial/claim); null = only MAC-agnostic rules applied. */
  readonly macName: string | null;
}

export interface RouteRuleInput {
  readonly macName?: string;
  readonly codeKind: RouteCodeKind;
  readonly code: string;
  readonly route: "appeal" | "reopening";
  readonly sourceNote?: string;
  readonly verifiedOn?: string;
  readonly effectiveFrom?: string;
}

export interface RouteRuleView {
  readonly id: string;
  readonly macName: string | null;
  readonly codeKind: string;
  readonly code: string;
  readonly route: string;
  readonly sourceNote: string | null;
  readonly verifiedOn: string | null;
  readonly effectiveFrom: string;
  readonly version: number;
}

export interface DenialRouteService {
  getRoute(actor: M25ReadActor, denialId: string): Promise<DenialRouteView>;
  setMacReasonCode(
    actor: M25WriteActor,
    denialId: string,
    code: string | null,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  listRules(actor: M25ReadActor): Promise<{ items: RouteRuleView[] }>;
  upsertRule(
    actor: M25WriteActor,
    input: RouteRuleInput,
  ): Promise<{ id: string; version: number }>;
}

/** Rules in force today: the organization's (newest first) plus the built-in default, which a tenant rule outranks. */
async function rulesInForce(tx: Tx): Promise<RouteRule[]> {
  const MR = schema.denialRouteRule;
  const rows = await tx
    .select()
    .from(MR)
    .where(lte(MR.effectiveFrom, noticeDayOf(new Date())))
    .orderBy(desc(MR.effectiveFrom));
  const own: RouteRule[] = rows.map((r) => ({
    id: r.id,
    macName: r.macName,
    codeKind: r.codeKind as RouteCodeKind,
    code: r.code,
    route: r.route as "appeal" | "reopening",
    verifiedOn: r.verifiedOn,
    effectiveFrom: r.effectiveFrom,
    sourceNote: r.sourceNote,
    origin: "org",
  }));
  return [...own, ...PLATFORM_ROUTE_RULES];
}

/**
 * Resolve a denial's route inside the caller's transaction. `macNameHint` lets a caller that already knows the MAC
 * (the reopening being opened against a specific ADR) override the lookup. Throws NotFound when the denial is not
 * visible to this org/scope.
 */
export async function resolveDenialRoute(
  tx: Tx,
  denialCaseId: string,
  providerEntityScope: readonly string[] | undefined,
  macNameHint?: string | null,
): Promise<DenialRouteView> {
  const DC = schema.denialCase;
  const ADR = schema.adrCase;
  const scope = providerEntityScopeCondition(DC.providerEntityId, providerEntityScope);
  const rows = await tx
    .select({
      carcCode: DC.carcCode,
      rarcCode: DC.rarcCode,
      macReasonCode: DC.macReasonCode,
      claimId: DC.claimId,
    })
    .from(DC)
    .where(scope ? and(eq(DC.id, denialCaseId), scope) : eq(DC.id, denialCaseId))
    .limit(1);
  const denial = rows[0];
  if (!denial) throw new NotFoundError("denial case");
  let macName = macNameHint?.trim() || null;
  if (!macName) {
    const adr = await tx
      .select({ macName: ADR.macName })
      .from(ADR)
      .where(
        denial.claimId
          ? sql`${ADR.denialCaseId} = ${denialCaseId} OR ${ADR.claimId} = ${denial.claimId}`
          : eq(ADR.denialCaseId, denialCaseId),
      )
      .orderBy(desc(ADR.createdAt))
      .limit(1);
    macName = adr[0]?.macName ?? null;
  }
  const resolved = resolveRoute(
    {
      macName,
      macReasonCode: denial.macReasonCode,
      carcCode: denial.carcCode,
      rarcCode: denial.rarcCode,
      asOf: noticeDayOf(new Date()),
    },
    await rulesInForce(tx),
  );
  const rule = resolved.rule;
  return {
    route: resolved.route,
    unverified: resolved.unverified,
    rule: rule && {
      id: rule.id,
      origin: rule.origin ?? "org",
      macName: rule.macName,
      codeKind: rule.codeKind,
      code: rule.code,
      route: rule.route,
      verifiedOn: rule.verifiedOn,
      sourceNote: rule.sourceNote,
    },
    macReasonCode: denial.macReasonCode,
    macName,
  };
}

/** True when `day` is a real YYYY-MM-DD calendar date (the schema only checks the shape). */
const isRealDay = (day: string): boolean => {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
};

export function buildDrizzleDenialRouteService(db: DbClient): DenialRouteService {
  const DC = schema.denialCase;
  const RR = schema.denialRouteRule;

  return {
    async getRoute(actor, denialId) {
      return withOrgContext(db, actor, (tx) =>
        resolveDenialRoute(tx, denialId, actor.providerEntityScope),
      );
    },

    async setMacReasonCode(actor, denialId, code, ifMatch) {
      const normalized = code === null ? null : code.trim().toUpperCase();
      if (normalized !== null && !MAC_REASON_CODE.test(normalized)) {
        throw new WardenXError(
          "INVALID_MAC_REASON_CODE",
          "the MAC reason code is 1 to 16 letters or digits",
          422,
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(DC.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select({ version: DC.version })
          .from(DC)
          .where(scope ? and(eq(DC.id, denialId), scope) : eq(DC.id, denialId))
          .limit(1);
        const cur = rows[0];
        if (!cur) throw new NotFoundError("denial case");
        const updated = await tx
          .update(DC)
          .set({ macReasonCode: normalized, version: cur.version + 1 })
          .where(and(eq(DC.id, denialId), eq(DC.version, ifMatch)))
          .returning({ id: DC.id, version: DC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        return updated[0];
      });
    },

    async listRules(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(RR)
          .orderBy(asc(RR.codeKind), asc(RR.code), desc(RR.effectiveFrom));
        return {
          items: rows.map((r) => ({
            id: r.id,
            macName: r.macName,
            codeKind: r.codeKind,
            code: r.code,
            route: r.route,
            sourceNote: r.sourceNote,
            verifiedOn: r.verifiedOn,
            effectiveFrom: r.effectiveFrom,
            version: r.version,
          })),
        };
      });
    },

    async upsertRule(actor, input) {
      const code = input.code.trim().toUpperCase();
      if (!CODE_KINDS.includes(input.codeKind) || !MAC_REASON_CODE.test(code)) {
        throw new WardenXError("INVALID_ROUTE_CODE", "the rule code is 1 to 16 letters or digits", 422);
      }
      for (const day of [input.verifiedOn, input.effectiveFrom]) {
        if (day !== undefined && !isRealDay(day)) {
          throw new WardenXError("INVALID_RULE_DATE", "a rule date is not a real date", 422);
        }
      }
      const macName = input.macName?.trim() || null;
      return withOrgContext(db, actor, async (tx) => {
        const effectiveFrom = input.effectiveFrom ?? noticeDayOf(new Date());
        const fields = {
          route: input.route,
          sourceNote: input.sourceNote?.trim() || null,
          verifiedOn: input.verifiedOn ?? null,
        };
        // MAC names and codes match case-insensitively, so "cgs" / "56900" edit the existing rule, not a twin.
        const existing = await tx
          .select({ id: RR.id })
          .from(RR)
          .where(
            and(
              sql`lower(btrim(coalesce(${RR.macName}, ''))) = ${(macName ?? "").toLowerCase()}`,
              eq(RR.codeKind, input.codeKind),
              sql`upper(btrim(${RR.code})) = ${code}`,
              eq(RR.effectiveFrom, effectiveFrom),
            ),
          )
          .limit(1);
        if (existing[0]) {
          const updated = await tx
            .update(RR)
            .set({ ...fields, version: sql`${RR.version} + 1` })
            .where(eq(RR.id, existing[0].id))
            .returning({ id: RR.id, version: RR.version });
          return updated[0]!;
        }
        const inserted = await tx
          .insert(RR)
          .values({
            organizationId: actor.organizationId,
            macName,
            codeKind: input.codeKind,
            code,
            effectiveFrom,
            ...fields,
          })
          .returning({ id: RR.id, version: RR.version });
        return inserted[0]!;
      });
    },
  };
}
