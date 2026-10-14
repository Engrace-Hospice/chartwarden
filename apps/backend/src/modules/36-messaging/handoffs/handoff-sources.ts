// apps/backend/src/modules/36-messaging/handoffs/handoff-sources.ts - WP 3.5: the open work a sender can hand off, read
// from the owning modules' seams. Used by the pre-fill (a pure READ) and again by the offer to verify that every item the
// client names is real and open (the server, not the client, is the authority: ADR-0062 D12).
//
// IMPORTANT: `openSfvs` and `getPendingRefillsForPatient` ignore their organization argument and depend on the AMBIENT
// request tenant context (RLS), so these reads run only inside a request. The expiry tick and the offboarding sweep never
// call them. One source failing lists only that kind as unavailable; it never fails the others, and an offer that needs an
// unavailable kind is refused (fail closed).
import { HANDOFF_VISIT_HORIZON_HOURS } from "@wardenx/messaging";
import type { HandoffItemKind } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";

export const HANDOFF_SOURCE_CONCURRENCY = 8;
const MS_PER_HOUR = 3_600_000;

export interface HandoffSourcePorts {
  nextVisit(
    orgId: string,
    patientId: string,
    asOfIso: string,
  ): Promise<{ visitId: string; status: string; scheduledStartedAt: string } | null>;
  pendingRefills(
    orgId: string,
    patientId: string,
  ): Promise<readonly { id: string; status: string; requestedAt: string }[]>;
  openSfvs(
    patientId: string,
  ): Promise<
    readonly { sfvId: string | null; sfvStatus: string | null; sfvDueAt: string | null }[]
  >;
  activeTasks(
    orgId: string,
    userId: string,
    patientIds: readonly string[],
  ): Promise<readonly { id: string; patientId: string; status: string; dueAt: Date | null }[]>;
}

export interface PrefillItem {
  readonly kind: HandoffItemKind;
  readonly ref_id: string;
  readonly status?: string | undefined;
  readonly occurred_at?: string | undefined;
}

export interface PrefillPatient {
  readonly patient_id: string;
  readonly items: readonly PrefillItem[];
  readonly unavailable_sources: readonly HandoffItemKind[];
}

export interface PrefillResult {
  readonly patients: readonly PrefillPatient[];
}

export interface SourceContext {
  readonly orgId: string;
  readonly userId: string;
  readonly now: Date;
}

/** The default ports: the registered seams (M17 visits, M12 refill inbox, M10 HOPE) plus the module's own task store. */
export function createSeamSourcePorts(
  activeTasks: HandoffSourcePorts["activeTasks"],
): HandoffSourcePorts {
  return {
    async nextVisit(orgId, patientId, asOfIso) {
      const v = await getSeam("VisitReader").nextScheduledVisitForPatient(
        orgId as never,
        patientId as never,
        asOfIso,
      );
      return v
        ? {
            visitId: v.visitId as string,
            status: v.status as string,
            scheduledStartedAt: v.scheduledStartedAt,
          }
        : null;
    },
    async pendingRefills(orgId, patientId) {
      const rows = await getSeam("RefillInboxProvider").getPendingRefillsForPatient(
        orgId,
        patientId,
      );
      return rows.map((r) => ({
        id: r.id as string,
        status: r.status as string,
        requestedAt: r.requestedAt,
      }));
    },
    async openSfvs(patientId) {
      const rows = await getSeam("HopeJ2051Provider").openSfvs(patientId as never);
      return rows.map((r) => ({
        sfvId: r.sfvId as string | null,
        sfvStatus: r.sfvStatus as string | null,
        sfvDueAt: r.sfvDueAt,
      }));
    },
    activeTasks,
  };
}

/** Runs `fn` over `inputs` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  inputs: readonly T[],
  limit: number,
  fn: (input: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      const index = next++;
      out[index] = await fn(inputs[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return out;
}

interface PatientWork {
  readonly items: PrefillItem[];
  readonly unavailable: HandoffItemKind[];
}

async function collectForPatient(
  ports: HandoffSourcePorts,
  ctx: SourceContext,
  patientId: string,
): Promise<PatientWork> {
  const horizon = ctx.now.getTime() + HANDOFF_VISIT_HORIZON_HOURS * MS_PER_HOUR;
  const [visit, refills, sfvs] = await Promise.allSettled([
    ports.nextVisit(ctx.orgId, patientId, ctx.now.toISOString()),
    ports.pendingRefills(ctx.orgId, patientId),
    ports.openSfvs(patientId),
  ]);
  const items: PrefillItem[] = [{ kind: "patient", ref_id: patientId }];
  const unavailable: HandoffItemKind[] = [];
  if (visit.status === "rejected") unavailable.push("visit");
  else if (visit.value && Date.parse(visit.value.scheduledStartedAt) <= horizon)
    items.push({
      kind: "visit",
      ref_id: visit.value.visitId,
      status: visit.value.status,
      occurred_at: visit.value.scheduledStartedAt,
    });
  if (refills.status === "rejected") unavailable.push("refill_request");
  else
    for (const r of refills.value)
      items.push({
        kind: "refill_request",
        ref_id: r.id,
        status: r.status,
        occurred_at: r.requestedAt,
      });
  if (sfvs.status === "rejected") unavailable.push("symptom_followup");
  else
    for (const s of sfvs.value)
      if (s.sfvId)
        items.push({
          kind: "symptom_followup",
          ref_id: s.sfvId,
          ...(s.sfvStatus ? { status: s.sfvStatus } : {}),
          ...(s.sfvDueAt ? { occurred_at: s.sfvDueAt } : {}),
        });
  return { items, unavailable };
}

/**
 * The sender's open work on the given patients. The caller has already checked every patient is on the sender's caseload.
 * Tasks come from one batched read; if it fails every patient lists `task` as unavailable.
 */
export async function collectOpenWork(
  ports: HandoffSourcePorts,
  ctx: SourceContext,
  patientIds: readonly string[],
): Promise<PrefillResult> {
  const unique = [...new Set(patientIds)];
  const [perPatient, tasks] = await Promise.all([
    mapLimit(unique, HANDOFF_SOURCE_CONCURRENCY, (id) => collectForPatient(ports, ctx, id)),
    ports.activeTasks(ctx.orgId, ctx.userId, unique).then(
      (rows) => ({ ok: true as const, rows }),
      () => ({ ok: false as const, rows: [] }),
    ),
  ]);
  return {
    patients: unique.map((patientId, i) => {
      const work = perPatient[i] as PatientWork;
      const taskItems: PrefillItem[] = tasks.rows
        .filter((t) => t.patientId === patientId)
        .map((t) => ({
          kind: "task",
          ref_id: t.id,
          status: t.status,
          ...(t.dueAt ? { occurred_at: t.dueAt.toISOString() } : {}),
        }));
      return {
        patient_id: patientId,
        items: [...work.items, ...taskItems],
        unavailable_sources: tasks.ok ? work.unavailable : [...work.unavailable, "task"],
      };
    }),
  };
}
