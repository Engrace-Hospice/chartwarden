// apps/backend/src/modules/25-remittance/routes/case-view-service.ts - M25 milestone 7a-1: the ONE CASE VIEW. A
// read-only, claim-keyed timeline merging the ADR, any reopening, the whole appeal chain (every tier, linked by
// prior_tier_appeal_case_id), submission attempts, recorded deadlines and linked audit requests, with the next open
// deadline on top. Before this each lived on its own worklist. Reads run under `withOrgContext` (RLS) inside the actor's
// provider-entity scope, so an out-of-scope claim simply has no items. A deadline from a window that is not
// SME-confirmed is FLAGGED (windowConfirmed: false), never hidden. The view carries item LABELS (a recorded deadline's user-typed label, an ADR's MAC name) but not the longer free-text notes (source, scope and disposition notes).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError } from "@chartwarden/types";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { type TimelineItem, nextDeadline, sortTimeline, windowUnconfirmed } from "../domain";
import type { AppealTier } from "../domain";
import type { M25ReadActor } from "./actor";
import { medicaidClaimFactsPort } from "./medicaid-claim-facts";
import { viewRecordedDeadline } from "./recorded-deadline-view";
import { type ClaimFactsPort, m23ClaimFactsPort } from "./remittance-ports";
import { providerEntityScopeCondition } from "./scope";

/** Rows read per kind; a claim with more says so (`truncated`) instead of silently dropping them. */
export const CASE_VIEW_ITEM_CAP = 200;

export interface CaseViewOptions {
  /** Include ADRs / reopenings / audit requests only when the actor may read them. */
  readonly includeAdr: boolean;
  readonly includeReopening: boolean;
  readonly includeAudits: boolean;
}

export interface CaseView {
  readonly claimId: string;
  /** The claim's patient, so the read audit can attribute the read (null when no source port is bound). */
  readonly patientId: string | null;
  readonly generatedAt: string;
  readonly nextDeadline: TimelineItem | null;
  readonly items: TimelineItem[];
  readonly truncated: boolean;
}

export interface CaseViewService {
  getCaseView(actor: M25ReadActor, claimId: string, options: CaseViewOptions): Promise<CaseView>;
}

const OPEN_ADR = ["received", "in_assembly", "in_review"];
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d));

export function buildDrizzleCaseViewService(
  db: DbClient,
  ports: {
    readonly claims?: ClaimFactsPort;
    /** The Medicaid fallback lookup, keyed by organization (default: M24's seam). */
    readonly medicaidClaims?: (organizationId: string) => ClaimFactsPort;
  } = {},
): CaseViewService {
  return {
    async getCaseView(actor, claimId, options) {
      return withOrgContext(db, actor, async (tx) => {
        // The claim must resolve under RLS and inside the actor's provider scope, else it reads as absent (404). A claim
        // that is real but has no ADR / appeal / audit yet is a legitimate empty view (200). The patient named for the
        // read audit is this resolved claim's, so an out-of-scope claim is never attributed.
        // M23 (Medicare) first; a miss falls back to M24 (Medicaid) through its seam, so a Medicaid claim renders.
        const claim =
          (await (ports.claims ?? m23ClaimFactsPort).byId(tx, claimId)) ??
          (await (ports.medicaidClaims ?? medicaidClaimFactsPort)(actor.organizationId).byId(
            tx,
            claimId,
          ));
        const scope = actor.providerEntityScope;
        if (!claim || (scope !== undefined && !scope.includes(claim.providerEntityId))) {
          throw new NotFoundError("claim");
        }
        const now = new Date();
        const items: TimelineItem[] = [];
        let truncated = false;
        const cap = <T>(rows: T[]): T[] => {
          if (rows.length > CASE_VIEW_ITEM_CAP) truncated = true;
          return rows.slice(0, CASE_VIEW_ITEM_CAP);
        };
        const scoped = (column: Parameters<typeof providerEntityScopeCondition>[0]) =>
          providerEntityScopeCondition(column, actor.providerEntityScope);

        const AC = schema.appealCase;
        const appealScope = scoped(AC.providerEntityId);
        const appeals = cap(
          await tx
            .select()
            .from(AC)
            .where(and(eq(AC.claimId, claimId), ...(appealScope ? [appealScope] : [])))
            .orderBy(asc(AC.createdAt))
            .limit(CASE_VIEW_ITEM_CAP + 1),
        );
        for (const a of appeals) {
          items.push({
            id: a.id,
            kind: "appeal",
            at: iso(a.createdAt),
            label: `${a.tier} appeal`,
            state: a.state,
            tier: a.tier,
            relatedId: a.priorTierAppealCaseId,
            // The filing deadline matters only until the appeal is filed.
            deadlineAt: a.state === "draft" ? iso(a.tierDeadlineAt) : null,
            deadlineSource: a.state === "draft" ? "computed" : null,
            windowConfirmed: !windowUnconfirmed(a.tier as AppealTier),
          });
        }

        let adrIds: string[] = [];
        if (options.includeAdr) {
          const A = schema.adrCase;
          const sc = scoped(A.providerEntityId);
          const adrs = cap(
            await tx
              .select()
              .from(A)
              .where(and(eq(A.claimId, claimId), ...(sc ? [sc] : [])))
              .orderBy(asc(A.createdAt))
              .limit(CASE_VIEW_ITEM_CAP + 1),
          );
          adrIds = adrs.map((a) => a.id);
          for (const a of adrs) {
            const open = OPEN_ADR.includes(a.state);
            items.push({
              id: a.id,
              kind: "adr",
              at: iso(a.createdAt),
              label: `${a.reviewType === "re_adr" ? "Re-ADR" : "ADR"} - ${a.macName}`,
              state: a.state,
              tier: null,
              relatedId: a.denialCaseId,
              deadlineAt: open ? iso(a.responseDueAt) : null,
              deadlineSource: open ? "computed" : null,
              windowConfirmed: a.windowVerified,
            });
          }
        }

        let reopeningIds: string[] = [];
        if (options.includeReopening) {
          const R = schema.reopeningCase;
          const sc = scoped(R.providerEntityId);
          const reopenings = cap(
            await tx
              .select()
              .from(R)
              .where(and(eq(R.claimId, claimId), ...(sc ? [sc] : [])))
              .orderBy(asc(R.createdAt))
              .limit(CASE_VIEW_ITEM_CAP + 1),
          );
          reopeningIds = reopenings.map((r) => r.id);
          for (const r of reopenings) {
            const open = r.state === "draft" && r.dueAt !== null;
            items.push({
              id: r.id,
              kind: "reopening",
              at: iso(r.createdAt),
              label: `Reopening - ${r.macName}`,
              state: r.state,
              tier: null,
              relatedId: r.denialCaseId,
              deadlineAt: open && r.dueAt ? iso(r.dueAt) : null,
              deadlineSource: open ? "recorded" : null,
              windowConfirmed: true,
            });
          }
        }

        const SA = schema.submissionAttempt;
        const subjectConds = [
          appeals.length > 0
            ? inArray(
                SA.appealCaseId,
                appeals.map((a) => a.id),
              )
            : undefined,
          adrIds.length > 0 ? inArray(SA.adrCaseId, adrIds) : undefined,
          reopeningIds.length > 0 ? inArray(SA.reopeningCaseId, reopeningIds) : undefined,
        ].filter((c) => c !== undefined);
        if (subjectConds.length > 0) {
          const attempts = cap(
            await tx
              .select()
              .from(SA)
              .where(or(...subjectConds))
              .orderBy(asc(SA.createdAt))
              .limit(CASE_VIEW_ITEM_CAP + 1),
          );
          for (const s of attempts) {
            items.push({
              id: s.id,
              kind: "submission",
              at: iso(s.createdAt),
              label: `${s.purpose} attempt ${s.attemptNo}`,
              state: s.status,
              tier: null,
              relatedId: s.appealCaseId ?? s.adrCaseId ?? s.reopeningCaseId,
              deadlineAt: null,
              deadlineSource: null,
              windowConfirmed: true,
            });
          }
        }

        let auditIds: string[] = [];
        if (options.includeAudits) {
          const AR = schema.auditRequest;
          const ARC = schema.auditRequestClaim;
          const sc = scoped(AR.providerEntityId);
          const audits = cap(
            await tx
              .select({ ar: AR })
              .from(ARC)
              .innerJoin(AR, eq(AR.id, ARC.auditRequestId))
              .where(and(eq(ARC.claimId, claimId), isNull(ARC.removedAt), ...(sc ? [sc] : [])))
              .orderBy(asc(AR.createdAt))
              .limit(CASE_VIEW_ITEM_CAP + 1),
          );
          auditIds = audits.map((a) => a.ar.id);
          for (const { ar } of audits) {
            items.push({
              id: ar.id,
              kind: "audit_request",
              at: iso(ar.createdAt),
              label: `${ar.authorityKind.toUpperCase()} audit request`,
              state: ar.state,
              tier: null,
              relatedId: null,
              deadlineAt: null,
              deadlineSource: null,
              windowConfirmed: true,
            });
          }
        }

        const RD = schema.recordedDeadline;
        const deadlineConds = [
          appeals.length > 0
            ? inArray(
                RD.appealCaseId,
                appeals.map((a) => a.id),
              )
            : undefined,
          auditIds.length > 0 ? inArray(RD.auditRequestId, auditIds) : undefined,
        ].filter((c) => c !== undefined);
        if (deadlineConds.length > 0) {
          const deadlines = cap(
            await tx
              .select()
              .from(RD)
              .where(or(...deadlineConds))
              .orderBy(asc(RD.dueOn))
              .limit(CASE_VIEW_ITEM_CAP + 1),
          );
          for (const d of deadlines) {
            const view = viewRecordedDeadline(d, now);
            items.push({
              id: d.id,
              kind: "recorded_deadline",
              at: iso(d.createdAt),
              label: d.label,
              state: view.status,
              tier: null,
              relatedId: d.appealCaseId ?? d.auditRequestId,
              deadlineAt: d.satisfiedOn === null ? view.dueAt : null,
              deadlineSource: d.satisfiedOn === null ? "recorded" : null,
              windowConfirmed: true,
            });
          }
        }

        return {
          claimId,
          patientId: claim.patientId,
          generatedAt: now.toISOString(),
          nextDeadline: nextDeadline(items, now),
          items: sortTimeline(items),
          truncated,
        };
      });
    },
  };
}
