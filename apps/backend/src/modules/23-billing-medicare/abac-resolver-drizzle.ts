// apps/backend/src/modules/23-billing-medicare/abac-resolver-drizzle.ts — the REAL Drizzle-backed §4.7 ABAC
// fact loader for M23.
//
// Split out of `abac-predicates.ts` so the predicate-logic file (which names the actor's role-membership
// list — a field whose name collides with an M3 table const) carries NO central-schema import: the
// table-ownership scanner only flags a file that BOTH imports a `*schema*` path AND names another module's
// table const, so the Drizzle reads (which import `@chartwarden/db/schema`) live here, where the only table
// consts named are M23-OWNED (claim / noe_record / notr_record / validation_result). Each load opens ONE
// `withOrgContext(db, {organizationId, userId}, tx => …)` (the M1 @chartwarden/tenancy helper) so Postgres RLS
// scopes every statement to `app.org_id` (the M27 resolver precedent). A `null` return is an absent /
// cross-tenant row → the predicate fails closed. NO MBI / free-text PHI in the facts read (D13 / §8.7).
import { type BillingDb, type ClaimState, canonicalRuleKey } from "@chartwarden/billing";
import * as schema from "@chartwarden/db/schema";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

/** The org + acting user the resolver scopes each load to (the `withOrgContext` GUCs). */
export interface M23AbacReadContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** Provider + patient scope facts for a billing entity (claim / noe / notr). §4.7 scope predicates. */
export interface BillingEntityScopeFacts {
  readonly entityId: string;
  readonly organizationId: string;
  /** The ProviderEntity (CCN) the entity belongs to — the per-CCN scope every billing action is gated on. */
  readonly providerEntityId: string;
  /** The patient the entity bills for — the caseload axis of `claim_in_billing_manager_caseload`. */
  readonly patientId: string;
  /** The lifecycle state (claim only; `null` for noe/notr) — informational for scope predicates. */
  readonly state: ClaimState | null;
}

/** The rule key a `validation_result` recorded — the override-role axis of `override_role_eligible`. */
export interface ValidationResultRuleFacts {
  readonly validationResultId: string;
  readonly organizationId: string;
  readonly ruleKey: string;
}

/** The rule key a `validation_rule_config` overlay row carries — the regulatory-protection axis of
 *  `regulatory_required_rule_protected` for the PATCH/DELETE `:id` (ruleConfigId) target. */
export interface RuleConfigRuleFacts {
  readonly ruleConfigId: string;
  readonly organizationId: string;
  readonly ruleKey: string;
}

/**
 * Loads the org-scoped scope/rule facts the M23 predicates resolve (Drizzle under RLS in prod via
 * {@link buildDrizzleM23AbacResolver}; an in-memory stub in unit tests). Every load is against an
 * M23-OWNED table.
 */
export interface ReadingM23AbacResolver {
  /** Load a `claim`'s provider/patient/state facts; `null` for an absent / cross-tenant row → deny. */
  loadClaim(ctx: M23AbacReadContext, claimId: string): Promise<BillingEntityScopeFacts | null>;
  /** Load a `noe_record`'s provider/patient facts; `null` → deny. */
  loadNoe(ctx: M23AbacReadContext, noeId: string): Promise<BillingEntityScopeFacts | null>;
  /** Load a `notr_record`'s provider/patient facts; `null` → deny. */
  loadNotr(ctx: M23AbacReadContext, notrId: string): Promise<BillingEntityScopeFacts | null>;
  /** Load a `transfer_notice_record`'s provider/patient facts (8xC / 8xD); `null` or absent → deny. */
  loadTransferNotice?(
    ctx: M23AbacReadContext,
    transferNoticeId: string,
  ): Promise<BillingEntityScopeFacts | null>;
  /** Load a `dde_work_item`'s provider/patient facts (ADR-0052); `null` or absent → deny. */
  loadDdeWorkItem?(
    ctx: M23AbacReadContext,
    ddeWorkItemId: string,
  ): Promise<BillingEntityScopeFacts | null>;
  /** Load a `validation_result`'s rule key; `null` → deny. */
  loadValidationResult(
    ctx: M23AbacReadContext,
    validationResultId: string,
  ): Promise<ValidationResultRuleFacts | null>;
  /** Load a `validation_rule_config` overlay row's rule key (by `:id`, i.e. `ruleConfigId`); `null` → deny. */
  loadRuleConfig(
    ctx: M23AbacReadContext,
    ruleConfigId: string,
  ): Promise<RuleConfigRuleFacts | null>;
}

/**
 * The REAL Drizzle-backed `ReadingM23AbacResolver`. Each fact load opens ONE `withOrgContext` so Postgres RLS
 * scopes every statement to `app.org_id`. Each row is point-read by id (org + RLS scope the row); every table
 * read is M23-owned. The enum-case boundary stays in the repo layer; the scope predicates only key on the
 * provider/patient ids, so the raw DB `state` is narrowed lazily and never leaks.
 */
export function buildDrizzleM23AbacResolver(db: BillingDb): ReadingM23AbacResolver {
  const C = schema.claim;
  const NOE = schema.noeRecord;
  const NOTR = schema.notrRecord;
  const TN = schema.transferNoticeRecord;
  const DDE = schema.ddeWorkItem;
  const VR = schema.validationResult;
  const RC = schema.validationRuleConfig;

  return {
    async loadClaim(ctx, claimId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: C.id,
            organizationId: C.organizationId,
            providerEntityId: C.providerEntityId,
            patientId: C.patientId,
            state: C.state,
          })
          .from(C)
          .where(and(eq(C.organizationId, ctx.organizationId), eq(C.id, claimId)))
          .limit(1);
        if (!row) return null;
        return {
          entityId: row.id,
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          patientId: row.patientId,
          // The DB enum is UPPERCASE; the scope predicates do not key on state, so it stays informational.
          state: row.state.toLowerCase() as ClaimState,
        };
      });
    },

    async loadNoe(ctx, noeId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: NOE.id,
            organizationId: NOE.organizationId,
            providerEntityId: NOE.providerEntityId,
            patientId: NOE.patientId,
          })
          .from(NOE)
          .where(and(eq(NOE.organizationId, ctx.organizationId), eq(NOE.id, noeId)))
          .limit(1);
        if (!row) return null;
        return {
          entityId: row.id,
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          patientId: row.patientId,
          state: null,
        };
      });
    },

    async loadNotr(ctx, notrId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: NOTR.id,
            organizationId: NOTR.organizationId,
            providerEntityId: NOTR.providerEntityId,
            patientId: NOTR.patientId,
          })
          .from(NOTR)
          .where(and(eq(NOTR.organizationId, ctx.organizationId), eq(NOTR.id, notrId)))
          .limit(1);
        if (!row) return null;
        return {
          entityId: row.id,
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          patientId: row.patientId,
          state: null,
        };
      });
    },

    async loadTransferNotice(ctx, transferNoticeId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: TN.id,
            organizationId: TN.organizationId,
            providerEntityId: TN.providerEntityId,
            patientId: TN.patientId,
          })
          .from(TN)
          .where(and(eq(TN.organizationId, ctx.organizationId), eq(TN.id, transferNoticeId)))
          .limit(1);
        if (!row) return null;
        return {
          entityId: row.id,
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          patientId: row.patientId,
          state: null,
        };
      });
    },

    async loadDdeWorkItem(ctx, ddeWorkItemId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: DDE.id,
            organizationId: DDE.organizationId,
            providerEntityId: DDE.providerEntityId,
            patientId: DDE.patientId,
          })
          .from(DDE)
          .where(and(eq(DDE.organizationId, ctx.organizationId), eq(DDE.id, ddeWorkItemId)))
          .limit(1);
        if (!row) return null;
        return {
          entityId: row.id,
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          patientId: row.patientId,
          state: null,
        };
      });
    },

    async loadValidationResult(ctx, validationResultId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: VR.id,
            organizationId: VR.organizationId,
            ruleKey: VR.ruleKey,
          })
          .from(VR)
          .where(and(eq(VR.organizationId, ctx.organizationId), eq(VR.id, validationResultId)))
          .limit(1);
        if (!row) return null;
        return {
          validationResultId: row.id,
          organizationId: row.organizationId,
          ruleKey: canonicalRuleKey(row.ruleKey),
        };
      });
    },

    async loadRuleConfig(ctx, ruleConfigId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: RC.id,
            organizationId: RC.organizationId,
            ruleKey: RC.ruleKey,
          })
          .from(RC)
          .where(and(eq(RC.organizationId, ctx.organizationId), eq(RC.id, ruleConfigId)))
          .limit(1);
        if (!row) return null;
        return {
          ruleConfigId: row.id,
          organizationId: row.organizationId,
          ruleKey: canonicalRuleKey(row.ruleKey),
        };
      });
    },
  };
}
