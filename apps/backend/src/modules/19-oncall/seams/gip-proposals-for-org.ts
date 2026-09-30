// apps/backend/src/modules/19-oncall/seams/gip-proposals-for-org.ts — F-218/F-219 (#248). THE ONE M19
// published read of "a triage call proposed a GIP admission", shared by its two consumers:
//
//   • M14 (F-218) — `m19.triage_call.care_plan_change_indicated`. M19 emits it ONLY alongside
//     `gip_admission_proposed` (`dispositionPayloads`, changeKind `level_of_care_gip_proposed`), so the IDG
//     packet's "since last IDG" flagged-event block pulls it through this read
//     ({@link idgTriageCarePlanChangesForOrg}, a structural twin of the M6/M13/M30 flagged-event sources);
//   • M37 (F-219) — `m19.triage_call.gip_admission_proposed`. M37's intake worklist PULLS the open
//     proposals through {@link gipProposalsForOrg}. No `ipu_admission` row can exist at proposal time
//     (`admission_id`/`level_of_care_period_id`/`provider_entity_id` are NOT NULL and the LOC period is
//     created later by M11's order draft), so the entry is a PROPOSAL READ, never a row M37 writes.
//
// Both come from the SAME transition (`triage_call.disposition = 'gip_admission_proposed'`), so they share
// one query and one projection — a caller cannot see a proposal in one place and not the other.
//
// SEAM PULL, not an outbox push (hence `seamConsumers` on both catalog entries): the durable fact is the
// `triage_call` row itself, and a pull re-reads it at build/list time so there is no cache to invalidate.
//
// ORG-EXPLICIT: every read opens `withOrgContext` AND carries an explicit `organization_id` predicate (the
// F-164 seam precedent — RLS is the control, the predicate is the second lock), so it is callable from a
// cron/worker with no request. PHI-MINIMAL: ids, enums and instants only — `gipCriteriaSummary` (clinical
// free text), the caller's identity, answers, transcript and every cipher column NEVER cross this seam;
// `preferredFacility` (a facility name the clinician typed) crosses only to M37 (operational), never to M14.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, inArray, isNotNull, min } from "drizzle-orm";

const CALL = schema.triageCall;
const HIST = schema.triageCallStateHistory;

/** A read with no acting human (the empty-GUC system convention). */
const GIP_PROPOSALS_SYSTEM_USER_ID = "";

/** A patient id list this long is a caller bug (an IDG caseload is dozens). */
export const IDG_TRIAGE_CHANGES_MAX_PATIENTS = 500;
/** The M37 worklist page ceiling — a proposal list is a handful of rows, never a report. */
export const GIP_PROPOSALS_MAX_ROWS = 200;

/** One open GIP proposal, as M37's intake worklist renders it. */
export interface GipProposalFact {
  /** The M19 `triage_call.id` — the back-reference ("open the call" stays under M19's own gates). */
  readonly triageCallId: string;
  readonly patientId: string;
  readonly admissionId: string | null;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  /** When the disposition was selected (the call's first `documented_pending_encounter` transition). */
  readonly proposedAt: string;
  readonly preferredFacility: string | null;
  /** The call's own `triage_call_state` — a proposal stays on the worklist until M11/M6 act on it. */
  readonly callState: string;
}

const GIP = "gip_admission_proposed" as const;

function preferredFacilityOf(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const v = (data as Record<string, unknown>).preferredFacility;
  return typeof v === "string" && v.length > 0 ? v : null;
}

interface ProposalFilter {
  readonly patientIds?: readonly string[];
  /** Strictly after this instant. */
  readonly sinceIso?: string;
  readonly limit: number;
}

async function readProposals(
  db: DbClient,
  organizationId: string,
  filter: ProposalFilter,
): Promise<readonly GipProposalFact[]> {
  return withOrgContext(
    db,
    { organizationId, userId: GIP_PROPOSALS_SYSTEM_USER_ID },
    async (tx): Promise<readonly GipProposalFact[]> => {
      const t = tx as unknown as DbClient;
      const calls = await t
        .select({
          id: CALL.id,
          patientId: CALL.patientId,
          admissionId: CALL.admissionId,
          providerEntityId: CALL.providerEntityId,
          locationId: CALL.locationId,
          state: CALL.state,
          dispositionData: CALL.dispositionData,
          updatedAt: CALL.updatedAt,
        })
        .from(CALL)
        .where(
          and(
            eq(CALL.organizationId, organizationId),
            eq(CALL.disposition, GIP),
            isNotNull(CALL.patientId),
            ...(filter.patientIds ? [inArray(CALL.patientId, [...filter.patientIds])] : []),
          ),
        )
        .orderBy(asc(CALL.openedAt))
        .limit(filter.limit);
      if (calls.length === 0) return [];
      // The disposition transition is the call's FIRST move into `documented_pending_encounter`; the row's
      // own `updated_at` is only the fallback (a later encounter link / close rewrites it).
      const ids = calls.map((c) => c.id);
      const hist = await t
        .select({ callId: HIST.triageCallId, at: min(HIST.transitionedAt) })
        .from(HIST)
        .where(
          and(
            eq(HIST.organizationId, organizationId),
            inArray(HIST.triageCallId, ids),
            eq(HIST.toState, "documented_pending_encounter"),
          ),
        )
        .groupBy(HIST.triageCallId);
      const atByCall = new Map(hist.map((h) => [h.callId, h.at]));
      const since = filter.sinceIso ? Date.parse(filter.sinceIso) : Number.NEGATIVE_INFINITY;
      const out: GipProposalFact[] = [];
      for (const c of calls) {
        if (c.patientId === null) continue;
        const proposedAt = new Date(atByCall.get(c.id) ?? c.updatedAt);
        if (!(proposedAt.getTime() > since)) continue;
        out.push({
          triageCallId: c.id,
          patientId: c.patientId,
          admissionId: c.admissionId,
          providerEntityId: c.providerEntityId,
          locationId: c.locationId,
          proposedAt: proposedAt.toISOString(),
          preferredFacility: preferredFacilityOf(c.dispositionData),
          callState: c.state,
        });
      }
      return out;
    },
  );
}

/**
 * F-219 — the org's GIP proposals for M37's intake worklist, newest first. `abandoned`/`escalated_unresolved`
 * can never carry this disposition (`disposition` is the selected value, and those two are their own
 * terminal dispositions), so no state filter is needed beyond the disposition itself.
 */
export async function gipProposalsForOrg(
  db: DbClient,
  organizationId: string,
  options: { readonly limit?: number } = {},
): Promise<readonly GipProposalFact[]> {
  const limit = Math.min(
    Math.max(options.limit ?? GIP_PROPOSALS_MAX_ROWS, 1),
    GIP_PROPOSALS_MAX_ROWS,
  );
  const rows = await readProposals(db, organizationId, { limit: GIP_PROPOSALS_MAX_ROWS });
  return [...rows]
    .sort((a, b) => Date.parse(b.proposedAt) - Date.parse(a.proposedAt))
    .slice(0, limit);
}

/** One projected care-plan-change indication (structural twin of M14's `PacketFlaggedEventDigest`). */
export interface IdgTriageCarePlanChangeEvent {
  readonly kind: "triage_care_plan_change";
  /** The M19 `triage_call.id` — the back-reference. */
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly severity: "info" | "attention" | "urgent";
}

/**
 * F-218 — the care-plan-change indications (today: every GIP proposal, the only `changeKind` M19 emits) for
 * each patient in `patientIds`, strictly AFTER `sinceIso` (the earliest §1.1 cursor in the batch — M14's
 * builder re-filters per patient). Patients with none are absent. ONE batched read, never per patient.
 * `attention`: a GIP proposal is a level-of-care change the IDG must discuss, not an emergency.
 */
export async function idgTriageCarePlanChangesForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
  sinceIso: string,
): Promise<ReadonlyMap<string, readonly IdgTriageCarePlanChangeEvent[]>> {
  const ids = [...new Set(patientIds)];
  const out = new Map<string, IdgTriageCarePlanChangeEvent[]>();
  if (ids.length === 0) return out;
  if (ids.length > IDG_TRIAGE_CHANGES_MAX_PATIENTS) {
    throw new Error(
      `idgTriageCarePlanChangesForOrg: ${ids.length} patients exceeds the ${IDG_TRIAGE_CHANGES_MAX_PATIENTS} cap`,
    );
  }
  const rows = await readProposals(db, organizationId, {
    patientIds: ids,
    sinceIso,
    limit: GIP_PROPOSALS_MAX_ROWS * 10,
  });
  for (const r of rows) {
    const list = out.get(r.patientId) ?? [];
    list.push({
      kind: "triage_care_plan_change",
      sourceId: r.triageCallId,
      occurredAt: r.proposedAt,
      severity: "attention",
    });
    out.set(r.patientId, list);
  }
  return out;
}
