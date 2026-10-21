// apps/backend/src/modules/23-billing-medicare/routes/platform-admin-service.ts — M23 platform-admin commands
// (§4.1 #41 / #42, GAP-144).
//
//   loadWageIndexes   — the annual CMS hospice wage-index load into the PLATFORM-SHARED `wage_index_factor`. The
//                       app role cannot write that table (0078 REVOKE), so each row goes through the narrow
//                       SECURITY DEFINER bridge `billing_platform_load_wage_index` (migration 0450). Every row is
//                       validated with the same pure rule tenant entry uses BEFORE anything is written, and the
//                       whole file loads in ONE transaction: a bad row loads nothing.
//   registerPlatformRule — platform rules are CODE (`DEFAULT_BILLING_RULES`: each rule is a `check` function
//                       shipped with a release). There is no dynamic platform-rule store, and not even a tenant
//                       custom rule's predicate DSL is evaluated by any engine today, so a persisted "rule"
//                       would be dead data that never ran. A key that already exists is a 409; a new key is an
//                       honest 501 naming exactly what is missing — never a 2xx that registered nothing.
import { DEFAULT_BILLING_RULES, validateWageIndexEntry } from "@wardenx/billing";
import type { repositories } from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { ValidationError, ChartWardenError } from "@wardenx/types";
import { sql } from "drizzle-orm";
import type { M23WriteActor } from "./actor";
import type {
  LoadWageIndexesBody,
  LoadWageIndexesResult,
  RegisterPlatformRuleBody,
} from "./platform-admin-typebox";

type BillingDb = repositories.BillingDb;

/** How many per-row validation errors one 422 names (the rest are summarized by count). */
const MAX_REPORTED_ROW_ERRORS = 20;

export interface PlatformAdminRouteService {
  loadWageIndexes(actor: M23WriteActor, body: LoadWageIndexesBody): Promise<LoadWageIndexesResult>;
  registerPlatformRule(actor: M23WriteActor, body: RegisterPlatformRuleBody): Promise<never>;
}

export function buildDrizzlePlatformAdminService(
  db: BillingDb,
  deps: { readonly now?: () => Date } = {},
): PlatformAdminRouteService {
  const now = deps.now ?? (() => new Date());
  const platformRuleKeys: ReadonlySet<string> = new Set(DEFAULT_BILLING_RULES.map((r) => r.key));

  return {
    async loadWageIndexes(actor, body) {
      const today = now().toISOString().slice(0, 10);
      const rowErrors: { field: string; code: string; message: string }[] = [];
      const seen = new Set<string>();
      body.rows.forEach((row, i) => {
        const key = row.ccn.toUpperCase();
        if (seen.has(key)) {
          rowErrors.push({
            field: `rows[${i}].ccn`,
            code: "DUPLICATE",
            message: `CCN ${key} appears more than once in this load`,
          });
        }
        seen.add(key);
        const verdict = validateWageIndexEntry(
          {
            ccn: row.ccn,
            fiscalYearStarting: body.fiscalYearStarting,
            ...(row.cbsaCode !== undefined ? { cbsaCode: row.cbsaCode } : {}),
            factorDecimal: row.factorDecimal,
            sourceReference: body.sourceReference,
          },
          today,
        );
        if (!verdict.ok) {
          for (const message of verdict.errors) {
            rowErrors.push({ field: `rows[${i}]`, code: "INVALID", message });
          }
        }
      });
      if (rowErrors.length > 0) {
        throw new ValidationError(
          `${rowErrors.length} problem(s) in the wage-index file; nothing was loaded`,
          rowErrors.slice(0, MAX_REPORTED_ROW_ERRORS),
        );
      }

      return withOrgContext<BillingDb, LoadWageIndexesResult>(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          let inserted = 0;
          let updated = 0;
          for (const row of body.rows) {
            const res = await tx.execute(
              sql`SELECT billing_platform_load_wage_index(
                ${row.ccn.toUpperCase()}, ${body.fiscalYearStarting}, ${row.cbsaCode ?? null},
                ${row.factorDecimal}, ${body.sourceReference}
              ) AS inserted`,
            );
            const first = (res.rows as { inserted: boolean }[])[0];
            if (first?.inserted) inserted += 1;
            else updated += 1;
          }
          return {
            fiscalYearStarting: body.fiscalYearStarting,
            sourceReference: body.sourceReference,
            inserted,
            updated,
          };
        },
      );
    },

    async registerPlatformRule(_actor, body) {
      if (platformRuleKeys.has(body.ruleKey)) {
        throw new ChartWardenError(
          "PLATFORM_RULE_EXISTS",
          `platform rule '${body.ruleKey}' already exists in the code-defined registry`,
          409,
        );
      }
      throw new ChartWardenError(
        "PLATFORM_RULES_ARE_CODE_DEFINED",
        "platform validation rules are code-defined (each is a `check` function shipped with a release) and no dynamic platform-rule store or DSL evaluation engine exists; add the rule to packages/billing/src/rules and release it",
        501,
      );
    },
  };
}
