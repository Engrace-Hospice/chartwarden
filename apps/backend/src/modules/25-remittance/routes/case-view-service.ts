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
import {
  type TimelineItem,
  nextDeadline,
  noticeDayOf,
  representativeFlag,
  sortTimeline,
  windowUnconfirmed,
} from "../domain";
import type { AppealTier } from "../domain";
import type { M25ReadActor } from "./actor";
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
  /** Payer (commercial / Medicare Advantage) appeal levels, only when the actor holds `payer_appeal.read`. */
  readonly includePayerAppeals?: boolean;
  /** Beneficiary-filed appeals, only when the actor holds `beneficiary_appeal.read` (milestone 13a). */
  readonly includeBeneficiaryAppeals?: boolean;
}

export interface DenialCaseView {
  readonly denialCaseId: string;
  /** The denial's claim, or null (a commercial denial has none). */
  readonly claimId: string | null;
  readonly patientId: string | null;
  /** `claim` when the denial's claim names a patient; `unattributed` for a claim-less (commercial) denial. */
  readonly patientAttribution: "claim" | "unattributed";
  readonly generatedAt: string;
  readonly nextDeadline: TimelineItem | null;
  readonly items: TimelineItem[];
  readonly truncated: boolean;
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
  /** The same timeline keyed on the DENIAL: works for a denial with no claim (milestone 12a-1). */
  getDenialCaseView(
    actor: M25ReadActor,
    denialCaseId: string,
    options: CaseViewOptions,
  ): Promise<DenialCaseView>;
}

const OPEN_ADR = ["received", "in_assembly", "in_review"];
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d));

type CaseViewTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** Timeline items for payer appeal levels and their recorded deadlines. */
async function payerAppealItems(
  tx: CaseViewTx,
  rows: (typeof schema.payerAppealCase.$inferSelect)[],
  now: Date,
): Promise<{ items: TimelineItem[]; truncated: boolean }> {
  if (rows.length === 0) return { items: [], truncated: false };
  const RD = schema.recordedDeadline;
  const recorded = await tx
    .select()
    .from(RD)
    .where(
      inArray(
        RD.payerAppealCaseId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(RD.dueOn))
    .limit(CASE_VIEW_ITEM_CAP + 1);
  const cases: TimelineItem[] = rows.map((r) => {
    const open = r.state === "draft" && r.deadlineAt !== null;
    return {
      id: r.id,
      kind: "payer_appeal",
      at: iso(r.createdAt),
      label: `${r.levelLabel} (payer appeal)`,
      state: r.state,
      tier: null,
      relatedId: r.priorLevelCaseId,
      deadlineAt: open && r.deadlineAt ? iso(r.deadlineAt) : null,
      deadlineSource: open ? "computed" : null,
      windowConfirmed: r.windowVerified,
    };
  });
  const deadlines: TimelineItem[] = recorded.slice(0, CASE_VIEW_ITEM_CAP).map((d) => {
    const view = viewRecordedDeadline(d, now);
    return {
      id: d.id,
      kind: "recorded_deadline",
      at: iso(d.createdAt),
      label: d.label,
      state: view.status,
      tier: null,
      relatedId: d.payerAppealCaseId,
      deadlineAt: d.satisfiedOn === null ? view.dueAt : null,
      deadlineSource: d.satisfiedOn === null ? "recorded" : null,
      windowConfirmed: true,
    };
  });
  return { items: [...cases, ...deadlines], truncated: recorded.length > CASE_VIEW_ITEM_CAP };
}

/**
 * Timeline items for beneficiary-filed appeals and their recorded deadlines. A beneficiary appeal carries NO computed deadline:
 * only what a person typed from a notice shows, and the representative-status badge is derived from typed dates. The label is
 * the tier as the notice names it, never a name or a note.
 */
async function beneficiaryAppealItems(
  tx: CaseViewTx,
  rows: (typeof schema.beneficiaryAppeal.$inferSelect)[],
  now: Date,
): Promise<TimelineItem[]> {
  if (rows.length === 0) return [];
  const RD = schema.recordedDeadline;
  const RA = schema.representativeAppointment;
  const apptIds = [
    ...new Set(
      rows.flatMap((r) => (r.representativeAppointmentId ? [r.representativeAppointmentId] : [])),
    ),
  ];
  const appts = apptIds.length > 0 ? await tx.select().from(RA).where(inArray(RA.id, apptIds)) : [];
  const recorded = await tx
    .select()
    .from(RD)
    .where(
      inArray(
        RD.beneficiaryAppealId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(RD.dueOn))
    .limit(CASE_VIEW_ITEM_CAP + 1);
  const today = noticeDayOf(now);
  const appeals: TimelineItem[] = rows.map((r) => {
    const appt = appts.find((a) => a.id === r.representativeAppointmentId);
    return {
      id: r.id,
      kind: "beneficiary_appeal",
      at: iso(r.createdAt),
      label: `Beneficiary appeal - ${r.tierLabel}`,
      state: r.state,
      tier: null,
      relatedId: r.denialCaseId,
      deadlineAt: null,
      deadlineSource: null,
      windowConfirmed: true,
      flags: {
        representativeStatus: representativeFlag(
          {
            filerKind: r.filerKind,
            appointment: appt ? { state: appt.state, validThroughOn: appt.validThroughOn } : null,
          },
          today,
        ),
      },
    };
  });
  const deadlines: TimelineItem[] = recorded.slice(0, CASE_VIEW_ITEM_CAP).map((d) => {
    const view = viewRecordedDeadline(d, now);
    return {
      id: d.id,
      kind: "recorded_deadline",
      at: iso(d.createdAt),
      label: d.label,
      state: view.status,
      tier: null,
      relatedId: d.beneficiaryAppealId,
      deadlineAt: d.satisfiedOn === null ? view.dueAt : null,
      deadlineSource: d.satisfiedOn === null ? "recorded" : null,
      windowConfirmed: true,
    };
  });
  return [...appeals, ...deadlines];
}

export function buildDrizzleCaseViewService(
  db: DbClient,
  ports: { readonly claims?: ClaimFactsPort } = {},
): CaseViewService {
  return {
    async getCaseView(actor, claimId, options) {
      return withOrgContext(db, actor, async (tx) => {
        // The claim must resolve under RLS and inside the actor's provider scope, else it reads as absent (404). A claim
        // that is real but has no ADR / appeal / audit yet is a legitimate empty view (200). The patient named for the
        // read audit is this resolved claim's, so an out-of-scope claim is never attributed.
        const claim = await (ports.claims ?? m23ClaimFactsPort).byId(tx, claimId);
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

        if (options.includePayerAppeals) {
          const PC = schema.payerAppealCase;
          const sc = scoped(PC.providerEntityId);
          const payer = cap(
            await tx
              .select()
              .from(PC)
              .where(and(eq(PC.claimId, claimId), ...(sc ? [sc] : [])))
              .orderBy(asc(PC.createdAt))
              .limit(CASE_VIEW_ITEM_CAP + 1),
          );
          const built = await payerAppealItems(tx, payer, now);
          items.push(...built.items);
          if (built.truncated) truncated = true;
        }

        if (options.includeBeneficiaryAppeals) {
          const BA = schema.beneficiaryAppeal;
          const sc = scoped(BA.providerEntityId);
          const beneficiary = cap(
            await tx
              .select()
              .from(BA)
              .where(and(eq(BA.claimId, claimId), ...(sc ? [sc] : [])))
              .orderBy(asc(BA.createdAt))
              .limit(CASE_VIEW_ITEM_CAP + 1),
          );
          items.push(...(await beneficiaryAppealItems(tx, beneficiary, now)));
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

    async getDenialCaseView(actor, denialCaseId, options) {
      // The denial must resolve under RLS and inside the actor's provider scope, else it reads as absent (404).
      const denial = await withOrgContext(db, actor, async (tx) => {
        const DC = schema.denialCase;
        const sc = providerEntityScopeCondition(DC.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select({ id: DC.id, claimId: DC.claimId })
          .from(DC)
          .where(sc ? and(eq(DC.id, denialCaseId), sc) : eq(DC.id, denialCaseId))
          .limit(1);
        if (!rows[0]) throw new NotFoundError("denial case");
        return rows[0];
      });
      // A denial with a claim carries the claim-keyed timeline (Medicare chain, ADR, audits); its payer levels are added below.
      const fromClaim = denial.claimId
        ? await this.getCaseView(actor, denial.claimId, { ...options, includePayerAppeals: false })
        : null;
      const payer = options.includePayerAppeals
        ? await withOrgContext(db, actor, async (tx) => {
            const PC = schema.payerAppealCase;
            const sc = providerEntityScopeCondition(PC.providerEntityId, actor.providerEntityScope);
            const rows = await tx
              .select()
              .from(PC)
              .where(
                sc ? and(eq(PC.denialCaseId, denialCaseId), sc) : eq(PC.denialCaseId, denialCaseId),
              )
              .orderBy(asc(PC.createdAt))
              .limit(CASE_VIEW_ITEM_CAP + 1);
            const built = await payerAppealItems(tx, rows.slice(0, CASE_VIEW_ITEM_CAP), new Date());
            return {
              items: built.items,
              truncated: rows.length > CASE_VIEW_ITEM_CAP || built.truncated,
            };
          })
        : { items: [] as TimelineItem[], truncated: false };
      const now = new Date();
      const items = sortTimeline([...(fromClaim?.items ?? []), ...payer.items]);
      return {
        denialCaseId,
        claimId: denial.claimId,
        patientId: fromClaim?.patientId ?? null,
        patientAttribution: fromClaim?.patientId ? ("claim" as const) : ("unattributed" as const),
        generatedAt: now.toISOString(),
        nextDeadline: nextDeadline(items, now),
        items,
        truncated: (fromClaim?.truncated ?? false) || payer.truncated,
      };
    },
  };
}
